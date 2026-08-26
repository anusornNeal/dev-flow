// DVF-0685: finalization reuses authoritative coverage when relevant inputs remain unchanged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AppState } from '../types.js';
import { getTaskByIdentifier, getTasksByProjectId } from '../repositories/taskRepository.js';
import { getProject } from '../repositories/projectRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import {
  createTaskFinalizationOperation,
  getLatestTaskFinalizationOperation,
  getTaskFinalizationOperation,
  updateTaskFinalizationOperation,
  type TaskFinalizationOperationRecord,
} from '../repositories/taskFinalizationOperationRepository.js';
import { createApiError } from './api.js';
import { normalizeVerificationEvidence } from './taskGitWorkflowService.js';
import { projectTaskCompletionAfterFinalization, terminalizeTaskExecutionForFinalization } from './taskClaimService.js';
import { cleanupSessionWorkspace, getSessionWorkspaceMetadataForRecovery } from './sessionWorkspaceService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';
import { integrateWorkspaceCommits, reconstructRecordedWorkspaceIntegration, type WorkspaceIntegrationSuccess } from './workspaceIntegrationService.js';
import { loadProjectVerificationImpactRules } from './projectCommandConfigService.js';
import { planVerification, type VerificationPlan } from './verificationPlannerService.js';
import {
  getExecutionOwnershipState,
  getExecutionSessionOwnershipEpoch,
} from './executionSessionService.js';
import { computeLifecycleAuthoritySnapshot } from './lifecycleAuthorityService.js';
import { resolveTaskVerificationCoverage, type TaskVerificationCoverageResolution } from './taskCommitPlanService.js';
import { summarizeQualityDebt, type TaskQualityDebtSummary } from './qualityDebtService.js';
import { withSyncLock } from './lockAndIdempotencyService.js';
import { evaluateExecutionContinuation } from './executionContinuationService.js';
import { assertTaskPrerequisitesSatisfied } from './taskDependencyService.js';

export type TaskWorkspaceFinalizationCheck = {
  name?: string;
  command: string;
  status: 'passed' | 'failed' | 'not-run';
  scope?: 'targeted' | 'broad' | 'full';
  repoRevision?: string;
  summary?: string;
  output?: string;
  recordedAt?: string;
};

export type DetachedIntegratedFinalizationEvidence = {
  sourceHead: string;
  baseRevision: string;
  baseBranch: string;
  executionSessionId: string | null;
  ownershipEpochId: string | null;
  candidateId?: string | null;
  candidateRepoRevision?: string | null;
  ownedFingerprint?: string | null;
  integration: WorkspaceIntegrationSuccess;
};

export type OwnerBreakGlassFinalizationAuthority = {
  operationId: string;
  reason: string;
  actorLabel: string;
};

export type TaskWorkspaceFinalizationInput = {
  taskId: string;
  workspaceId: string;
  checks?: TaskWorkspaceFinalizationCheck[];
  requireChecklistComplete?: boolean;
  operationId?: string;
  detachedIntegrated?: DetachedIntegratedFinalizationEvidence;
  ownerBreakGlass?: OwnerBreakGlassFinalizationAuthority;
};

type PostIntegrationRequirement = {
  required: boolean;
  reason: string;
  repoRevision: string;
  requiredCommands: string[];
  missingCommands: string[];
  broadEvidenceRequired: boolean;
  requiredScope: 'targeted' | 'broad-or-full';
  baseAdvanced: boolean;
  nextAction: {
    action: 'RUN_POST_INTEGRATION_VERIFICATION_AND_RETRY';
    tool: 'finalize_task_workspace';
    bindChecksToRepoRevision: true;
  };
};

function normalizeOwnerBreakGlassAuthority(value: unknown): OwnerBreakGlassFinalizationAuthority | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const operationId = String(input.operationId || '').trim();
  const reason = String(input.reason || '').trim();
  const actorLabel = String(input.actorLabel || '').trim();
  if (!operationId || !reason || !actorLabel) {
    throw createApiError(400, 'OWNER_BREAK_GLASS_AUDIT_CONTEXT_REQUIRED', 'Owner break-glass finalization requires operationId, reason, and actorLabel.');
  }
  return { operationId, reason, actorLabel };
}

type FinalizationQualityDebt = {
  code: 'CHECKLIST_INCOMPLETE' | 'VERIFICATION_EVIDENCE_MISSING' | 'VERIFICATION_NOT_PASSED' | 'POST_INTEGRATION_VERIFICATION_REQUIRED';
  source: 'checklist' | 'verification';
  message: string;
  details?: Record<string, unknown>;
};

function collectInitialFinalizationQualityDebt(
  task: any,
  input: TaskWorkspaceFinalizationInput,
  reusableCoverage: TaskVerificationCoverageResolution | null = null,
): FinalizationQualityDebt[] {
  const debt: FinalizationQualityDebt[] = [];
  const incompleteChecklistItems = Array.isArray(task.checklist)
    ? task.checklist.filter((item: any) => !item?.completed).map((item: any) => ({ id: item?.id, text: item?.text }))
    : [];
  if (incompleteChecklistItems.length > 0) {
    debt.push({
      code: 'CHECKLIST_INCOMPLETE',
      source: 'checklist',
      message: 'Task finalized with incomplete checklist items recorded as quality debt.',
      details: { incompleteChecklistItems, legacyRequireChecklistComplete: input.requireChecklistComplete !== false },
    });
  }
  const checks = Array.isArray(input.checks) ? input.checks : [];
  if (checks.length === 0) {
    if (!(reusableCoverage?.status === 'covered' && reusableCoverage.reusable)) {
      debt.push({
        code: 'VERIFICATION_EVIDENCE_MISSING',
        source: 'verification',
        message: 'Task finalized without fresh submitted verification or reusable authoritative coverage.',
      });
    }
    return debt;
  }
  const notPassed = checks.filter((check) => check?.status !== 'passed');
  if (notPassed.length > 0) {
    debt.push({
      code: 'VERIFICATION_NOT_PASSED',
      source: 'verification',
      message: 'Task finalized with failed or not-run verification recorded as quality debt.',
      details: { checks: notPassed },
    });
  }
  return debt;
}

function localOnlyEvidence(task: any, baseBranch: string, commit: string, checks: TaskWorkspaceFinalizationCheck[]) {
  const recordedAt = new Date().toISOString();
  const verificationEvidence = normalizeVerificationEvidence({ checks }, task);
  const gitEvidence = {
    evidenceSource: 'project-root',
    branch: baseBranch,
    commit,
    remote: 'origin',
    trackingBranch: null,
    remoteHead: null,
    ahead: 0,
    behind: 0,
    diverged: false,
    pushed: false,
    workingTreeClean: true,
    remoteFetchPerformed: false,
    remoteEvidenceReused: false,
    remoteFetchDurationMs: 0,
    remoteEvidenceObservedAt: recordedAt,
    remoteEvidenceAgeMs: 0,
    recordedAt,
  };
  return { gitEvidence, verificationEvidence, task: { ...task, gitEvidence, verificationEvidence, updatedAt: recordedAt } };
}

function planCombinedVerification(
  integration: WorkspaceIntegrationSuccess,
  checks: TaskWorkspaceFinalizationCheck[],
  impactRules: ReturnType<typeof loadProjectVerificationImpactRules>,
  coverageCommands: string[] = [],
) {
  const requestedCommands = Array.from(new Set([
    ...checks.map((check) => String(check.command || '').trim()),
    ...coverageCommands.map((command) => String(command || '').trim()),
    ...impactRules.flatMap((rule) => rule.commands.map((command) => String(command || '').trim())),
  ].filter(Boolean)));
  const sourcePlan = planVerification({
    changedFiles: integration.changedFiles,
    requestedCommands,
    impactRules,
  });
  const combinedPlan = planVerification({
    changedFiles: integration.combinedChangedFiles,
    requestedCommands,
    impactRules,
  });
  return { sourcePlan, combinedPlan };
}

function evaluatePostIntegrationRequirement(
  integration: WorkspaceIntegrationSuccess,
  checks: TaskWorkspaceFinalizationCheck[],
  sourcePlan: VerificationPlan,
  combinedPlan: VerificationPlan,
  coverage: TaskVerificationCoverageResolution | null = null,
): PostIntegrationRequirement {
  const baseAdvanced = integration.baseHeadBefore !== integration.baseRevision;
  const planEscalated = combinedPlan.risk !== sourcePlan.risk
    || combinedPlan.lane !== sourcePlan.lane
    || combinedPlan.requiresBroadVerify !== sourcePlan.requiresBroadVerify
    || combinedPlan.commands.some((command) => !sourcePlan.commands.includes(command));
  const required = baseAdvanced || combinedPlan.risk === 'high' || planEscalated;
  const revision = integration.baseHeadAfter;
  const revisionBound = checks.filter((check) => check.status === 'passed' && String(check.repoRevision || '').trim() === revision);
  const hasFullEvidence = revisionBound.some((check) => check.scope === 'full');
  const hasBroadEvidence = hasFullEvidence || revisionBound.some((check) => check.scope === 'broad');
  const broadEvidenceRequired = combinedPlan.requiresBroadVerify;
  const reusableCommands = new Set(coverage?.status === 'covered' && coverage.reusable ? coverage.coveredCommands : []);
  const missingCommands = hasFullEvidence
    ? []
    : combinedPlan.commands.filter((command) => !revisionBound.some((check) => check.command === command) && !reusableCommands.has(command));
  const reusableCoverageSatisfied = coverage?.status === 'covered'
    && coverage.reusable
    && missingCommands.length === 0
    && (combinedPlan.commands.length === 0 || combinedPlan.commands.every((command) => reusableCommands.has(command) || revisionBound.some((check) => check.command === command)));
  const noCommandsRequired = combinedPlan.commands.length === 0;
  const evidenceSatisfied = !required
    || (!broadEvidenceRequired && noCommandsRequired)
    || (missingCommands.length === 0
      && (broadEvidenceRequired ? hasBroadEvidence : revisionBound.length > 0 || reusableCoverageSatisfied));

  let reason = 'Pre-integration evidence remains valid for the integrated state.';
  if (required && evidenceSatisfied && reusableCoverageSatisfied) reason = 'Reusable authoritative verification coverage remains valid for the integrated affected inputs, dependencies, command configuration, and environment.';
  else if (required && baseAdvanced) reason = 'The target branch advanced after the workspace base revision and reusable coverage is incomplete, so combined-state verification must be revision-bound to the integrated HEAD.';
  else if (required && combinedPlan.risk === 'high') reason = 'High-risk combined changes require revision-bound post-integration verification.';
  else if (required && planEscalated) reason = 'Combined-state impact escalated the verification plan after integration.';

  return {
    required: required && !evidenceSatisfied,
    reason,
    repoRevision: revision,
    requiredCommands: combinedPlan.commands,
    missingCommands,
    broadEvidenceRequired,
    requiredScope: broadEvidenceRequired ? 'broad-or-full' : 'targeted',
    baseAdvanced,
    nextAction: {
      action: 'RUN_POST_INTEGRATION_VERIFICATION_AND_RETRY',
      tool: 'finalize_task_workspace',
      bindChecksToRepoRevision: true,
    },
  };
}

export type TaskFinalizationFaultBoundary =
  | 'after-freeze'
  | 'after-integration'
  | 'after-verification-clear'
  | 'after-evidence'
  | 'after-execution-terminalization'
  | 'after-task-projection'
  | 'before-cleanup'
  | 'after-cleanup';

let finalizationFaultBoundaryForTests: TaskFinalizationFaultBoundary | null = null;

export function __setTaskFinalizationFaultBoundaryForTests(boundary: TaskFinalizationFaultBoundary | null) {
  finalizationFaultBoundaryForTests = boundary;
}

function injectFinalizationFault(boundary: TaskFinalizationFaultBoundary) {
  if (finalizationFaultBoundaryForTests !== boundary) return;
  const error = new Error(`Injected task finalization fault at ${boundary}.`) as Error & { code?: string };
  error.code = 'TASK_FINALIZATION_FAULT_INJECTED';
  throw error;
}

function finalizationOperationIdentity(input: {
  taskId: string;
  workspaceId: string;
  executionSessionId: string | null;
  ownershipEpochId: string | null;
  sourceHead: string;
  baseRevision: string;
  baseBranch: string;
  candidateId: string | null;
  candidateRepoRevision: string | null;
  ownedFingerprint: string | null;
}) {
  const digest = crypto.createHash('sha256');
  for (const value of [
    input.taskId,
    input.workspaceId,
    input.executionSessionId || '',
    input.ownershipEpochId || '',
    input.sourceHead,
    input.baseRevision,
    input.baseBranch,
    input.candidateId || '',
    input.candidateRepoRevision || '',
    input.ownedFingerprint || '',
  ]) {
    digest.update(String(value));
    digest.update('\0');
  }
  return `finalize-${digest.digest('hex').slice(0, 32)}`;
}

function operationFailure(error: any, phase: string, boundary?: string) {
  return {
    phase,
    ...(boundary ? { boundary } : {}),
    code: String(error?.payload?.code || error?.code || 'TASK_FINALIZATION_FAILED').slice(0, 160),
    message: String(error?.payload?.message || error?.message || 'Task finalization failed.').slice(0, 500),
    observedAt: new Date().toISOString(),
  };
}

function updateOperation(
  operation: TaskFinalizationOperationRecord,
  patch: Parameters<typeof updateTaskFinalizationOperation>[1],
) {
  return updateTaskFinalizationOperation(operation.id, { ...patch, updatedAt: new Date().toISOString() }) || operation;
}

function executionContinuationForOperation(state: AppState, operation: TaskFinalizationOperationRecord) {
  if (!operation.executionSessionId) return null;
  try {
    return evaluateExecutionContinuation(state, operation.executionSessionId, { workspaceId: operation.workspaceId });
  } catch {
    return null;
  }
}

function operationContinuation(
  state: AppState,
  operation: TaskFinalizationOperationRecord,
  code: 'POST_INTEGRATION_FINALIZATION_REQUIRED' | 'POST_INTEGRATION_VERIFICATION_REQUIRED',
  message: string,
  context: Record<string, unknown> = {},
) {
  return {
    status: 'continuation' as const,
    code,
    message,
    operation: getTaskFinalizationOperation(operation.id) || operation,
    ...(executionContinuationForOperation(state, operation) ? { executionContinuation: executionContinuationForOperation(state, operation) } : {}),
    continuation: {
      code,
      operationId: operation.id,
      phase: (getTaskFinalizationOperation(operation.id) || operation).phase,
      error: (getTaskFinalizationOperation(operation.id) || operation).failure || undefined,
      nextAction: {
        action: 'RETRY_FINALIZE_TASK_WORKSPACE' as const,
        tool: 'finalize_task_workspace' as const,
        operationId: operation.id,
        reintegrate: false as const,
      },
    },
    ...context,
  };
}

function assertTaskFinalizationBranchAuthority(task: any, baseBranch: string, workspaceId: string) {
  const taskBranch = String(task?.branch || '').trim();
  if (!taskBranch || taskBranch === baseBranch) return;
  throw createApiError(409, 'TASK_WORKSPACE_BRANCH_AUTHORITY_MISMATCH', `Task '${task.displayId || task.id}' targets '${taskBranch}', but finalization is frozen to '${baseBranch}'.`, {
    affectedId: task.id,
    details: { taskBranch, workspaceBaseBranch: baseBranch, workspaceId },
  });
}

function freezeNewFinalizationOperation(task: any, workspaceId: string, submittedChecks: TaskWorkspaceFinalizationCheck[]) {
  const metadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
  if (!metadata) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
  if (metadata.projectId !== task.projectId) {
    throw createApiError(409, 'TASK_WORKSPACE_PROJECT_MISMATCH', 'Task and workspace belong to different projects.', {
      affectedId: task.id,
      details: { taskProjectId: task.projectId, workspaceProjectId: metadata.projectId },
    });
  }
  assertTaskFinalizationBranchAuthority(task, metadata.baseBranch, workspaceId);

  const inspection = inspectWorkspaceRecovery(workspaceId);
  if (inspection.dirtyFiles.length > 0) {
    return { blocked: { status: 'needs-recovery' as const, code: 'WORKSPACE_DIRTY' as const, inspection } };
  }
  if (inspection.disposition === 'stale-registry' || inspection.disposition === 'needs-recovery') {
    return { blocked: { status: 'needs-recovery' as const, code: 'WORKSPACE_RECOVERY_REQUIRED' as const, inspection } };
  }
  const sourceHead = String(inspection.sourceHead || '').trim();
  if (!sourceHead) throw createApiError(409, 'FINALIZATION_SOURCE_HEAD_REQUIRED', 'A committed source HEAD is required before finalization.', { affectedId: workspaceId });

  const active = listExecutionSessionsForTask(task.id).filter((entry) => entry.status === 'active');
  const scoped = active.filter((entry) => entry.workspaceId === workspaceId);
  const foreign = active.filter((entry) => entry.workspaceId !== workspaceId);
  if (scoped.length > 1 || foreign.length > 0) {
    throw createApiError(409, 'TASK_FINALIZATION_EXECUTION_AMBIGUOUS', 'Finalization requires one bounded execution authority for the selected workspace.', {
      affectedId: task.id,
      details: { workspaceId, scopedExecutionSessionIds: scoped.map((entry) => entry.id), foreignExecutionSessionIds: foreign.map((entry) => entry.id) },
    });
  }
  const execution = scoped[0] || null;
  const ownershipEpochId = execution
    ? getExecutionSessionOwnershipEpoch(execution.id).ownershipEpochId
    : String(task.claim?.ownershipEpochId || '').trim() || null;
  let authority: ReturnType<typeof computeLifecycleAuthoritySnapshot> | null = null;
  try {
    authority = computeLifecycleAuthoritySnapshot(task.id, { workspaceId });
  } catch {}
  const candidate = authority?.verification.candidate || null;
  const frozen = {
    taskId: task.id,
    workspaceId,
    executionSessionId: execution?.id || null,
    ownershipEpochId: ownershipEpochId || null,
    sourceHead,
    baseRevision: metadata.baseRevision,
    baseBranch: metadata.baseBranch,
    candidateId: candidate?.candidateId || null,
    candidateRepoRevision: candidate?.repoRevision || null,
    ownedFingerprint: authority?.verification.ownedFingerprint || null,
  };
  const id = finalizationOperationIdentity(frozen);
  const now = new Date().toISOString();
  const operation = createTaskFinalizationOperation({
    id,
    projectId: task.projectId,
    ...frozen,
    phase: 'frozen',
    status: 'active',
    verification: { submittedChecks },
    createdAt: now,
    updatedAt: now,
  });
  return { operation, metadata, inspection };
}

function freezeDetachedIntegratedFinalizationOperation(
  task: any,
  workspaceId: string,
  submittedChecks: TaskWorkspaceFinalizationCheck[],
  detached: DetachedIntegratedFinalizationEvidence,
) {
  const metadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
  if (metadata && fs.existsSync(metadata.root)) {
    throw createApiError(409, 'DETACHED_FINALIZATION_LIVE_WORKSPACE', 'Detached integrated finalization is allowed only when the selected managed workspace root is unavailable.', {
      affectedId: workspaceId,
    });
  }
  const integration = detached.integration;  assertTaskFinalizationBranchAuthority(task, detached.baseBranch, workspaceId);

  if (integration.workspaceId !== workspaceId
    || integration.sourceHead !== detached.sourceHead
    || integration.baseRevision !== detached.baseRevision
    || integration.baseBranch !== detached.baseBranch
    || integration.status !== 'succeeded'
    || integration.alreadyIntegrated !== true
    || integration.patchEquivalent === true) {
    throw createApiError(409, 'DETACHED_FINALIZATION_EVIDENCE_MISMATCH', 'Detached finalization requires exact already-integrated evidence bound to the selected task/workspace/base revision.', {
      affectedId: workspaceId,
      details: { integration },
    });
  }
  const frozen = {
    taskId: task.id,
    workspaceId,
    executionSessionId: detached.executionSessionId || null,
    ownershipEpochId: detached.ownershipEpochId || null,
    sourceHead: detached.sourceHead,
    baseRevision: detached.baseRevision,
    baseBranch: detached.baseBranch,
    candidateId: detached.candidateId || null,
    candidateRepoRevision: detached.candidateRepoRevision || null,
    ownedFingerprint: detached.ownedFingerprint || null,
  };
  const id = finalizationOperationIdentity(frozen);
  const now = new Date().toISOString();
  const operation = createTaskFinalizationOperation({
    id,
    projectId: task.projectId,
    ...frozen,
    phase: 'frozen',
    status: 'active',
    integration: integration as any,
    verification: {
      submittedChecks,
      detachedIntegrated: true,
      detachedEvidence: {
        sourceHead: detached.sourceHead,
        baseRevision: detached.baseRevision,
        baseBranch: detached.baseBranch,
        executionSessionId: detached.executionSessionId || null,
        ownershipEpochId: detached.ownershipEpochId || null,
      },
    },
    createdAt: now,
    updatedAt: now,
  });
  return { operation };
}

function isDetachedIntegratedOperation(operation: TaskFinalizationOperationRecord | null | undefined) {
  return operation?.verification?.detachedIntegrated === true;
}

function assertOperationStillBound(operation: TaskFinalizationOperationRecord, task: any, metadata: ReturnType<typeof getSessionWorkspaceMetadataForRecovery>) {  assertTaskFinalizationBranchAuthority(task, operation.baseBranch, operation.workspaceId);

  if (operation.taskId !== task.id || operation.projectId !== task.projectId) {
    throw createApiError(409, 'FINALIZATION_OPERATION_TASK_MISMATCH', 'Finalization operation is bound to another task/project.', {
      affectedId: operation.id,
      details: { operationTaskId: operation.taskId, taskId: task.id },
    });
  }
  if (metadata) {
    if (metadata.projectId !== operation.projectId || metadata.baseBranch !== operation.baseBranch) {
      throw createApiError(409, 'FINALIZATION_OPERATION_WORKSPACE_MISMATCH', 'Finalization workspace/project/base binding changed after the operation was frozen.', {
        affectedId: operation.id,
        details: { workspaceId: operation.workspaceId, baseBranch: operation.baseBranch },
      });
    }
    if (operation.phase === 'frozen') {
      const inspection = inspectWorkspaceRecovery(operation.workspaceId);
      const observedSourceHead = String(inspection.sourceHead || '').trim();
      if (observedSourceHead && observedSourceHead !== operation.sourceHead) {
        const project = getProject(operation.projectId);
        const reconstructed = project?.localPath
          ? (() => {
              try {
                return reconstructRecordedWorkspaceIntegration({
                  workspaceId: operation.workspaceId,
                  projectRoot: project.localPath!,
                  baseBranch: operation.baseBranch,
                  sourceBranch: metadata.branch,
                  baseRevision: operation.baseRevision,
                  sourceHead: operation.sourceHead,
                  strategy: metadata.gitWorkflowPolicy?.integrationStrategy || 'rebase-ff',
                });
              } catch {
                return null;
              }
            })()
          : null;
        if (!reconstructed) {
          throw createApiError(409, 'FINALIZATION_OPERATION_SOURCE_CHANGED', 'Workspace source HEAD changed after finalization identity was frozen.', {
            affectedId: operation.id,
            details: { expectedSourceHead: operation.sourceHead, observedSourceHead },
          });
        }
      }
    }
  }
}

function recoverRecordedIntegration(operation: TaskFinalizationOperationRecord, task: any) {
  if (operation.integration) return operation.integration as unknown as WorkspaceIntegrationSuccess;
  const metadata = getSessionWorkspaceMetadataForRecovery(operation.workspaceId);
  const project = getProject(operation.projectId);
  if (!project?.localPath) throw createApiError(409, 'FINALIZATION_PROJECT_ROOT_REQUIRED', 'Project root is unavailable for finalization integration recovery.', { affectedId: operation.id });
  if (metadata) {
    try {
      return reconstructRecordedWorkspaceIntegration({
        workspaceId: operation.workspaceId,
        projectRoot: project.localPath,
        baseBranch: operation.baseBranch,
        sourceBranch: metadata.branch,
        baseRevision: operation.baseRevision,
        sourceHead: operation.sourceHead,
        strategy: metadata.gitWorkflowPolicy?.integrationStrategy || 'rebase-ff',
      });
    } catch {}
    const integration = integrateWorkspaceCommits(operation.workspaceId, { task });
    if (integration.status === 'conflict') return integration as any;
    if (integration.sourceHead !== operation.sourceHead) {
      try {
        return reconstructRecordedWorkspaceIntegration({
          workspaceId: operation.workspaceId,
          projectRoot: project.localPath,
          baseBranch: operation.baseBranch,
          sourceBranch: metadata.branch,
          baseRevision: operation.baseRevision,
          sourceHead: operation.sourceHead,
          strategy: integration.strategy,
        });
      } catch {
        throw createApiError(409, 'FINALIZATION_OPERATION_SOURCE_CHANGED', 'Integration retry resolved a different source revision than the frozen finalization operation.', {
          affectedId: operation.id,
          details: { expectedSourceHead: operation.sourceHead, observedSourceHead: integration.sourceHead },
        });
      }
    }
    return integration;
  }
  return reconstructRecordedWorkspaceIntegration({
    workspaceId: operation.workspaceId,
    projectRoot: project.localPath,
    baseBranch: operation.baseBranch,
    sourceBranch: 'removed-workspace',
    baseRevision: operation.baseRevision,
    sourceHead: operation.sourceHead,
    strategy: 'rebase-ff',
  });
}

export type TaskWorkspaceFinalizationResult = {
  status: 'completed' | 'cleanup-pending' | 'continuation' | 'needs-recovery' | 'blocked';
  code?: string;
  message?: string;
  operation?: TaskFinalizationOperationRecord;
  continuation?: Record<string, any>;
  task?: any;
  inspection?: any;
  integration?: WorkspaceIntegrationSuccess | Record<string, any>;
  sourcePlan?: VerificationPlan;
  combinedPlan?: VerificationPlan;
  postIntegration?: PostIntegrationRequirement;
  gitEvidence?: any;
  verificationEvidence?: any[];
  qualityDebt?: TaskQualityDebtSummary;
  cleanup?: any;
  blockers?: unknown;
};

export function finalizeTaskWorkspace(_state: AppState, input: TaskWorkspaceFinalizationInput): TaskWorkspaceFinalizationResult {
  const taskId = String(input?.taskId || '').trim();
  const workspaceId = String(input?.workspaceId || '').trim();
  const requestedOperationId = String(input?.operationId || '').trim();
  const detachedIntegrated = input.detachedIntegrated;
  const suppliedOwnerBreakGlass = normalizeOwnerBreakGlassAuthority(input.ownerBreakGlass);
  if (!taskId) throw createApiError(400, 'TASK_ID_REQUIRED', 'taskId is required for task workspace finalization.');
  if (!workspaceId) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'workspaceId is required for task workspace finalization.');

  return withSyncLock(`task-finalization:${taskId}:${workspaceId}`, () => {
    let task = getTaskByIdentifier(taskId, 'full');
    if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
    assertTaskPrerequisitesSatisfied(task, getTasksByProjectId(task.projectId), 'finalization');

    let operation = requestedOperationId
      ? getTaskFinalizationOperation(requestedOperationId)
      : getLatestTaskFinalizationOperation(task.id, workspaceId);
    if (requestedOperationId && !operation) {
      throw createApiError(404, 'FINALIZATION_OPERATION_NOT_FOUND', `Finalization operation '${requestedOperationId}' was not found.`, { affectedId: requestedOperationId });
    }
    if (operation && (operation.taskId !== task.id || operation.workspaceId !== workspaceId)) {
      throw createApiError(409, 'FINALIZATION_OPERATION_SELECTOR_MISMATCH', 'Requested finalization operation does not match the selected task/workspace.', {
        affectedId: operation.id,
        details: { operationTaskId: operation.taskId, taskId: task.id, operationWorkspaceId: operation.workspaceId, workspaceId },
      });
    }

    if (!requestedOperationId && operation?.status === 'completed' && !isDetachedIntegratedOperation(operation)) {
      const metadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
      if (metadata) {
        const inspection = inspectWorkspaceRecovery(workspaceId);
        if (inspection.sourceHead && inspection.sourceHead !== operation.sourceHead) operation = null;
      }
    }

    const persistedChecks = Array.isArray(operation?.verification?.submittedChecks)
      ? operation.verification.submittedChecks as TaskWorkspaceFinalizationCheck[]
      : [];
    const suppliedChecks = Array.isArray(input.checks) ? input.checks : [];
    const effectiveChecks = suppliedChecks.length > 0 ? suppliedChecks : persistedChecks;
    const persistedOwnerBreakGlass = normalizeOwnerBreakGlassAuthority(operation?.verification?.ownerBreakGlass);
    if (suppliedOwnerBreakGlass && persistedOwnerBreakGlass
      && JSON.stringify(suppliedOwnerBreakGlass) !== JSON.stringify(persistedOwnerBreakGlass)) {
      throw createApiError(409, 'OWNER_BREAK_GLASS_OPERATION_MISMATCH', 'Finalization retry supplied a different owner break-glass authority than the frozen operation.');
    }
    const ownerBreakGlass = suppliedOwnerBreakGlass || persistedOwnerBreakGlass;
    const scopedActiveExecutions = listExecutionSessionsForTask(task.id)
      .filter((entry) => entry.status === 'active' && entry.workspaceId === workspaceId);
    const sourceExecutionSessionId = operation?.executionSessionId
      || (scopedActiveExecutions.length === 1 ? scopedActiveExecutions[0].id : null);
    const detachedMode = Boolean(detachedIntegrated || (operation && isDetachedIntegratedOperation(operation)));
    const sourceMetadataCandidate = detachedMode ? null : getSessionWorkspaceMetadataForRecovery(workspaceId);
    const sourceMetadata = sourceMetadataCandidate && fs.existsSync(sourceMetadataCandidate.root) ? sourceMetadataCandidate : null;
    const sourceOwnership = sourceExecutionSessionId && sourceMetadata
      ? getExecutionOwnershipState(sourceExecutionSessionId, { repoRoot: sourceMetadata.root })
      : null;
    const sourceCoverage = sourceExecutionSessionId && sourceMetadata
      ? resolveTaskVerificationCoverage(_state, {
          task,
          executionSessionId: sourceExecutionSessionId,
          workspaceId,
          verificationFresh: sourceOwnership?.verificationFresh ?? null,
        })
      : null;
    const initialQualityDebt = collectInitialFinalizationQualityDebt(task, {
      ...input,
      checks: effectiveChecks,
      ownerBreakGlass: ownerBreakGlass || undefined,
    }, sourceCoverage);

    if (!operation) {
      const latestBeforeFreeze = getLatestTaskFinalizationOperation(task.id, workspaceId);
      const frozen = detachedIntegrated
        ? freezeDetachedIntegratedFinalizationOperation(task, workspaceId, effectiveChecks, detachedIntegrated)
        : freezeNewFinalizationOperation(task, workspaceId, effectiveChecks);
      if ('blocked' in frozen) return frozen.blocked;
      operation = frozen.operation;
      operation = updateOperation(operation, {
        verification: {
          ...(operation.verification || {}),
          submittedChecks: effectiveChecks,
          qualityDebt: initialQualityDebt,
          ...(ownerBreakGlass ? { ownerBreakGlass } : {}),
        },
      });
      if (latestBeforeFreeze && latestBeforeFreeze.status !== 'completed' && latestBeforeFreeze.id !== operation.id) {
        throw createApiError(409, 'FINALIZATION_OPERATION_IDENTITY_CHANGED', 'An incomplete finalization operation already exists for a different frozen candidate/ownership identity.', {
          affectedId: latestBeforeFreeze.id,
          details: { existingOperationId: latestBeforeFreeze.id, requestedOperationId: operation.id },
        });
      }
      try {
        injectFinalizationFault('after-freeze');
      } catch (error: any) {
        operation = updateOperation(operation, { failure: operationFailure(error, operation.phase, 'after-freeze') });
        return operationContinuation(_state, operation, 'POST_INTEGRATION_FINALIZATION_REQUIRED', 'Finalization authority was frozen durably; retry the same operation.', { task });
      }
    } else {
      operation = updateOperation(operation, { retryCount: operation.retryCount + 1, failure: null });
      assertOperationStillBound(operation, task, isDetachedIntegratedOperation(operation) ? null : getSessionWorkspaceMetadataForRecovery(workspaceId));
    }

    if (operation.status === 'completed') {
      return {
        status: 'completed' as const,
        operation,
        task: getTaskByIdentifier(task.id, 'full') || task,
        integration: operation.integration,
        gitEvidence: operation.gitEvidence,
        verificationEvidence: Array.isArray(operation.verification?.evidence) ? operation.verification.evidence : [],
        qualityDebt: summarizeQualityDebt(Array.isArray(operation.verification?.qualityDebt) ? operation.verification.qualityDebt as any[] : []),
        cleanup: operation.cleanup || { removed: true, reason: 'already-completed' },
      };
    }

    let integration: WorkspaceIntegrationSuccess;
    let sourcePlan: VerificationPlan | undefined;
    let combinedPlan: VerificationPlan | undefined;
    let postIntegration: PostIntegrationRequirement | undefined;
    let gitEvidence: any = operation.gitEvidence;
    let verificationEvidence: any[] = Array.isArray(operation.verification?.evidence) ? operation.verification.evidence as any[] : [];
    let qualityDebt: FinalizationQualityDebt[] = initialQualityDebt;
    let qualityDebtSummary = summarizeQualityDebt(qualityDebt);

    try {
      if (operation.integration) {
        integration = operation.integration as unknown as WorkspaceIntegrationSuccess;
        const project = getProject(operation.projectId);
        if (!project?.localPath) throw createApiError(409, 'FINALIZATION_PROJECT_ROOT_REQUIRED', 'Project root is unavailable for recorded integration verification.', { affectedId: operation.id });
        reconstructRecordedWorkspaceIntegration({
          workspaceId: operation.workspaceId,
          projectRoot: project.localPath,
          baseBranch: operation.baseBranch,
          sourceBranch: getSessionWorkspaceMetadataForRecovery(operation.workspaceId)?.branch || 'removed-workspace',
          baseRevision: operation.baseRevision,
          sourceHead: operation.sourceHead,
          strategy: integration.strategy,
        });
      } else {
        const recovered = recoverRecordedIntegration(operation, task);
        if ((recovered as any).status === 'conflict') {
          operation = updateOperation(operation, {
            status: 'blocked',
            failure: { phase: 'integrated', code: 'INTEGRATION_CONFLICT', message: 'Workspace integration conflict requires explicit recovery.', observedAt: new Date().toISOString() },
          });
          return { status: 'needs-recovery' as const, code: 'INTEGRATION_CONFLICT' as const, integration: recovered, operation };
        }
        integration = recovered as WorkspaceIntegrationSuccess;
        operation = updateOperation(operation, { phase: 'integrated', status: 'active', integration: integration as any, failure: null });
      }
      injectFinalizationFault('after-integration');

      const project = getProject(operation.projectId);
      if (!project?.localPath) throw createApiError(409, 'FINALIZATION_PROJECT_ROOT_REQUIRED', 'Project root is unavailable for finalization verification planning.', { affectedId: operation.id });
      const impactRules = loadProjectVerificationImpactRules(project.localPath);
      const targetMetadataCandidate = detachedMode ? null : getSessionWorkspaceMetadataForRecovery(workspaceId);
      const targetMetadata = targetMetadataCandidate && fs.existsSync(targetMetadataCandidate.root) ? targetMetadataCandidate : null;
      const targetOwnership = operation.executionSessionId && targetMetadata
        ? getExecutionOwnershipState(operation.executionSessionId, { repoRoot: targetMetadata.root })
        : sourceOwnership;
      const targetCoverage = operation.executionSessionId && targetMetadata
        ? resolveTaskVerificationCoverage(_state, {
            task,
            executionSessionId: operation.executionSessionId,
            workspaceId,
            verificationFresh: targetOwnership?.verificationFresh ?? null,
          })
        : sourceCoverage;
      const coverageCommands = targetCoverage?.status === 'covered' && targetCoverage.reusable ? targetCoverage.coveredCommands : [];
      const plans = planCombinedVerification(integration, effectiveChecks, impactRules, coverageCommands);
      sourcePlan = plans.sourcePlan;
      combinedPlan = plans.combinedPlan;
      postIntegration = evaluatePostIntegrationRequirement(integration, effectiveChecks, sourcePlan, combinedPlan, targetCoverage);
      qualityDebt = [
        ...initialQualityDebt,
        ...(postIntegration.required ? [{
          code: 'POST_INTEGRATION_VERIFICATION_REQUIRED' as const,
          source: 'verification' as const,
          message: postIntegration.reason,
          details: {
            repoRevision: postIntegration.repoRevision,
            requiredCommands: postIntegration.requiredCommands,
            missingCommands: postIntegration.missingCommands,
            broadEvidenceRequired: postIntegration.broadEvidenceRequired,
            requiredScope: postIntegration.requiredScope,
          },
        }] : []),
      ];
      qualityDebtSummary = summarizeQualityDebt(qualityDebt);
      const reusedCoverageChecks: TaskWorkspaceFinalizationCheck[] = effectiveChecks.length === 0 && targetCoverage?.status === 'covered' && targetCoverage.reusable
        ? targetCoverage.coveredCommands.map((command) => ({
            name: `reused coverage: ${command}`,
            command,
            status: 'passed' as const,
            scope: 'targeted' as const,
            summary: 'Reused authoritative GREEN verification coverage because affected inputs, dependencies, command configuration, and environment are unchanged.',
            recordedAt: targetCoverage.recordedAt || undefined,
          }))
        : [];
      const evidenceChecks = effectiveChecks.length > 0 ? effectiveChecks : reusedCoverageChecks;
      operation = updateOperation(operation, {
        phase: 'verification-cleared',
        status: 'active',
        verification: {
          ...(operation.verification || {}),
          submittedChecks: effectiveChecks,
          requirement: postIntegration,
          evidence: verificationEvidence,
          coverage: { source: sourceCoverage, target: targetCoverage },
          qualityDebt,
          qualityDebtSummary,
          ...(ownerBreakGlass ? { ownerBreakGlass } : {}),
        },
        failure: null,
      });

      if (postIntegration.required) {
        return operationContinuation(
          _state,
          operation,
          'POST_INTEGRATION_VERIFICATION_REQUIRED',
          postIntegration.reason,
          {
            integration,
            sourcePlan,
            combinedPlan,
            postIntegration,
            task: getTaskByIdentifier(task.id, 'full') || task,
          },
        );
      }

      injectFinalizationFault('after-verification-clear');

      if (!operation.gitEvidence) {
        const evidenceTask = { ...task, branch: operation.baseBranch };
        const synced = localOnlyEvidence(evidenceTask, operation.baseBranch, integration.baseHeadAfter, evidenceChecks);
        gitEvidence = synced.gitEvidence;
        verificationEvidence = synced.verificationEvidence;
        operation = updateOperation(operation, {
          phase: 'evidence-recorded',
          status: 'active',
          gitEvidence,
          verification: { ...(operation.verification || {}), submittedChecks: effectiveChecks, requirement: postIntegration, coverage: { source: sourceCoverage, target: targetCoverage }, evidence: verificationEvidence },
          failure: null,
        });
      } else {
        gitEvidence = operation.gitEvidence;
        verificationEvidence = Array.isArray(operation.verification?.evidence) ? operation.verification.evidence as any[] : [];
        if (operation.phase === 'verification-cleared') operation = updateOperation(operation, { phase: 'evidence-recorded' });
      }
      injectFinalizationFault('after-evidence');

      if (operation.phase === 'evidence-recorded') {
        terminalizeTaskExecutionForFinalization(task.id, workspaceId, {
          changedFiles: integration.changedFiles,
          verification: verificationEvidence,
          repoRevision: integration.baseHeadAfter,
          executionSessionId: operation.executionSessionId,
          ownershipEpochId: operation.ownershipEpochId,
          operationId: operation.id,
        });
        operation = updateOperation(operation, { phase: 'execution-terminalized', status: 'active', failure: null });
      }
      injectFinalizationFault('after-execution-terminalization');

      task = getTaskByIdentifier(task.id, 'full') || task;
      if (operation.phase === 'execution-terminalized') {
        const projected = projectTaskCompletionAfterFinalization(task.id, workspaceId, (base) => {
          const logId = `log-workspace-finalized-${operation!.id}`;
          const logs = Array.isArray(base.logs) ? [...base.logs] : [];
          if (!logs.some((entry: any) => entry?.id === logId)) {
            const debtSummary = qualityDebt.length > 0 ? qualityDebt.map((entry) => entry.code).join(', ') : 'none';
            logs.push({
              id: logId,
              timestamp: new Date().toISOString(),
              message: `Finalized managed workspace ${workspaceId} into ${operation!.baseBranch}@${integration.baseHeadAfter.slice(0, 12)} with ${verificationEvidence.length} verification evidence item(s); quality debt: ${debtSummary}; operation ${operation!.id}.`,
              type: 'update',
            });
          }
          return {
            ...base,
            status: 'done',
            claim: undefined,
            branch: operation!.baseBranch,
            gitEvidence,
            verificationEvidence,
            logs,
            updatedAt: new Date().toISOString(),
          };
        });
        task = projected.task;
        operation = updateOperation(operation, { phase: 'task-projected', status: 'active', failure: null });
      }
      injectFinalizationFault('after-task-projection');

      if (isDetachedIntegratedOperation(operation)) {
        operation = updateOperation(operation, {
          phase: 'completed',
          status: 'completed',
          cleanup: operation.cleanup || { removed: true, reason: 'detached-workspace-already-unavailable' },
          failure: null,
          completedAt: new Date().toISOString(),
        });
        return {
          status: 'completed' as const,
          operation,
          task: getTaskByIdentifier(task.id, 'full') || task,
          integration,
          sourcePlan,
          combinedPlan,
          postIntegration,
          gitEvidence,
          verificationEvidence,
          qualityDebt: qualityDebtSummary,
          cleanup: operation.cleanup,
        };
      }

      const currentMetadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
      if (!currentMetadata) {
        operation = updateOperation(operation, {
          phase: 'completed',
          status: 'completed',
          cleanup: operation.cleanup || { removed: true, reason: 'workspace-already-absent' },
          failure: null,
          completedAt: new Date().toISOString(),
        });
        return {
          status: 'completed' as const,
          operation,
          task: getTaskByIdentifier(task.id, 'full') || task,
          integration,
          sourcePlan,
          combinedPlan,
          postIntegration,
          gitEvidence,
          verificationEvidence,
          qualityDebt: qualityDebtSummary,
          cleanup: operation.cleanup,
        };
      }

      injectFinalizationFault('before-cleanup');
      try {
        const cleanup = cleanupSessionWorkspace(workspaceId);
        injectFinalizationFault('after-cleanup');
        operation = updateOperation(operation, {
          phase: 'completed',
          status: 'completed',
          cleanup: cleanup as any,
          failure: null,
          completedAt: new Date().toISOString(),
        });
        return {
          status: 'completed' as const,
          operation,
          task: getTaskByIdentifier(task.id, 'full') || task,
          integration,
          sourcePlan,
          combinedPlan,
          postIntegration,
          gitEvidence,
          verificationEvidence,
          qualityDebt: qualityDebtSummary,
          cleanup,
        };
      } catch (cleanupError: any) {
        operation = updateOperation(operation, {
          phase: 'cleanup-pending',
          status: 'cleanup-pending',
          failure: operationFailure(cleanupError, 'cleanup-pending'),
        });
        return {
          status: 'cleanup-pending' as const,
          code: 'FINALIZATION_CLEANUP_PENDING' as const,
          message: 'Task is logically complete, but managed workspace cleanup remains pending and can be retried idempotently.',
          operation,
          task: getTaskByIdentifier(task.id, 'full') || task,
          integration,
          sourcePlan,
          combinedPlan,
          postIntegration,
          gitEvidence,
          verificationEvidence,
          qualityDebt: qualityDebtSummary,
          cleanup: { removed: false, workspaceId, error: operation.failure },
          ...(executionContinuationForOperation(_state, operation) ? { executionContinuation: executionContinuationForOperation(_state, operation) } : {}),
        };
      }
    } catch (error: any) {
      if (operation.phase === 'frozen' && !operation.integration) throw error;
      operation = updateOperation(operation, {
        status: operation.phase === 'cleanup-pending' ? 'cleanup-pending' : 'active',
        failure: operationFailure(error, operation.phase),
      });
      return operationContinuation(_state, operation, 'POST_INTEGRATION_FINALIZATION_REQUIRED', `Finalization operation '${operation.id}' paused at phase '${operation.phase}' and can be retried safely.`, {
        ...(integration! ? { integration: integration! } : {}),
        ...(sourcePlan ? { sourcePlan } : {}),
        ...(combinedPlan ? { combinedPlan } : {}),
        ...(postIntegration ? { postIntegration } : {}),
        ...(gitEvidence ? { gitEvidence } : {}),
        ...(verificationEvidence.length > 0 ? { verificationEvidence } : {}),
        task: getTaskByIdentifier(task.id, 'full') || task,
      });
    }
  });
}
