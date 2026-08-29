// DVF-0685: finalization reuses authoritative coverage when relevant inputs remain unchanged.
import fs from 'node:fs';
import type { AppState } from '../types.js';
import { getTaskByIdentifier, getTasksByProjectId, saveTask } from '../repositories/taskRepository.js';
import { getProject } from '../repositories/projectRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import {
  getLatestTaskFinalizationOperation,
  getTaskFinalizationOperation,
  type TaskFinalizationOperationRecord,
} from '../repositories/taskFinalizationOperationRepository.js';
import { createApiError } from './api.js';
import { normalizeVerificationEvidence } from './taskGitWorkflowService.js';
import { projectTaskCompletionAfterFinalization, terminalizeTaskExecutionForFinalization } from './taskClaimService.js';
import { cleanupSessionWorkspace, getSessionWorkspaceMetadataForRecovery } from './sessionWorkspaceService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';
import { reconstructRecordedWorkspaceIntegration, type WorkspaceIntegrationSuccess } from './workspaceIntegrationService.js';
import { loadProjectVerificationImpactRules } from './projectCommandConfigService.js';
import type { VerificationPlan } from './verificationPlannerService.js';
import { getExecutionOwnershipState } from './executionSessionService.js';
import { resolveTaskVerificationCoverage, type TaskVerificationCoverageResolution } from './taskCommitPlanService.js';
import { summarizeQualityDebt, type TaskQualityDebtSummary } from './qualityDebtService.js';
import { withSyncLock } from './lockAndIdempotencyService.js';
import { assertTaskPrerequisitesSatisfied } from './taskDependencyService.js';
import {
  evaluatePostIntegrationRequirement,
  executeRevisionBoundPostIntegrationVerification,
  planCombinedVerification,
  postIntegrationRequirementsAttempted,
  type PostIntegrationRequirement,
  type TaskWorkspaceFinalizationCheck,
} from './taskWorkspaceFinalizationVerificationService.js';
import {
  assertOperationStillBound,
  executionContinuationForOperation,
  freezeDetachedIntegratedFinalizationOperation,
  freezeNewFinalizationOperation,
  isDetachedIntegratedOperation,
  operationContinuation,
  operationFailure,
  recoverRecordedIntegration,
  updateOperation,
  validateRecordedIntegration,
  type DetachedIntegratedFinalizationEvidence,
} from './taskWorkspaceFinalizationOperationService.js';
import {
  runTaskWorkspaceHappyPathTailWithFinalizer,
  type TaskWorkspaceHappyPathTailInput,
  type TaskWorkspaceHappyPathTailVerificationRunner,
} from './taskWorkspaceHappyPathTailService.js';

export {
  __classifyPostIntegrationCommandResultForTests,
  __evaluatePostIntegrationRequirementForTests,
  __postIntegrationRequirementsAttemptedForTests,
  __verificationImpactRuleCommandsForTests,
} from './taskWorkspaceFinalizationVerificationService.js';
export type { TaskWorkspaceFinalizationCheck } from './taskWorkspaceFinalizationVerificationService.js';
export type { DetachedIntegratedFinalizationEvidence } from './taskWorkspaceFinalizationOperationService.js';
export type {
  TaskWorkspaceHappyPathTailInput,
  TaskWorkspaceHappyPathTailVerificationRequest,
} from './taskWorkspaceHappyPathTailService.js';
export type OwnerBreakGlassFinalizationAuthority = {
  operationId: string;
  reason: string;
  actorLabel: string;
};

export type TaskWorkspaceFinalizationInput = {
  taskId: string;
  workspaceId: string;
  checks?: TaskWorkspaceFinalizationCheck[];
  completedChecklistIds?: string[];
  requireChecklistComplete?: boolean;
  operationId?: string;
  detachedIntegrated?: DetachedIntegratedFinalizationEvidence;
  ownerBreakGlass?: OwnerBreakGlassFinalizationAuthority;
  deferPostIntegrationVerification?: boolean;
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

function normalizeChecklistCompletionIds(task: any, value: unknown, supplied: boolean) {
  if (!supplied) return [] as string[];
  if (!Array.isArray(value)) {
    throw createApiError(400, 'FINALIZATION_CHECKLIST_IDS_INVALID', 'completedChecklistIds must be an array of checklist item ids.');
  }
  if (value.length > 100) {
    throw createApiError(400, 'FINALIZATION_CHECKLIST_IDS_TOO_MANY', 'completedChecklistIds is limited to 100 checklist item ids.');
  }
  const knownIds = new Set((Array.isArray(task?.checklist) ? task.checklist : []).map((item: any) => String(item?.id || '').trim()).filter(Boolean));
  const normalized = value.map((item) => String(item || '').trim());
  if (normalized.some((id) => !id || id.length > 200)) {
    throw createApiError(400, 'FINALIZATION_CHECKLIST_ID_INVALID', 'Each completed checklist id must be a non-empty string no longer than 200 characters.');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw createApiError(400, 'FINALIZATION_CHECKLIST_IDS_DUPLICATE', 'completedChecklistIds must not contain duplicate ids.');
  }
  const unknown = normalized.filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw createApiError(400, 'FINALIZATION_CHECKLIST_ID_UNKNOWN', 'completedChecklistIds contains ids that are not present on the selected task.', {
      affectedId: task?.id,
      details: { unknownChecklistIds: unknown.slice(0, 20) },
    });
  }
  return [...normalized].sort();
}

function projectChecklistCompletion(task: any, completedChecklistIds: string[]) {
  if (completedChecklistIds.length === 0 || !Array.isArray(task?.checklist)) return task;
  const completed = new Set(completedChecklistIds);
  return {
    ...task,
    checklist: task.checklist.map((item: any) => completed.has(String(item?.id || '').trim()) ? { ...item, completed: true } : item),
  };
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
    const effectiveChecks = [...(suppliedChecks.length > 0 ? suppliedChecks : persistedChecks)];
    const checklistIdsSupplied = Object.prototype.hasOwnProperty.call(input || {}, 'completedChecklistIds');
    const suppliedCompletedChecklistIds = normalizeChecklistCompletionIds(task, input.completedChecklistIds, checklistIdsSupplied);
    const persistedCompletedChecklistIds = Array.isArray(operation?.verification?.completedChecklistIds)
      ? [...operation.verification.completedChecklistIds].map((id: unknown) => String(id || '').trim()).filter(Boolean).sort()
      : [];
    if (operation && checklistIdsSupplied && JSON.stringify(suppliedCompletedChecklistIds) !== JSON.stringify(persistedCompletedChecklistIds)) {
      throw createApiError(409, 'FINALIZATION_CHECKLIST_OPERATION_MISMATCH', 'Finalization retry supplied different completed checklist ids than the frozen operation.');
    }
    const effectiveCompletedChecklistIds = operation ? persistedCompletedChecklistIds : suppliedCompletedChecklistIds;
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
    const projectedTask = projectChecklistCompletion(task, effectiveCompletedChecklistIds);
    const initialQualityDebt = collectInitialFinalizationQualityDebt(projectedTask, {
      ...input,
      checks: effectiveChecks,
      ownerBreakGlass: ownerBreakGlass || undefined,
    }, sourceCoverage);

    if (!operation) {
      const latestBeforeFreeze = getLatestTaskFinalizationOperation(task.id, workspaceId);
      const frozen = detachedIntegrated
        ? freezeDetachedIntegratedFinalizationOperation(task, workspaceId, effectiveChecks, effectiveCompletedChecklistIds, detachedIntegrated)
        : freezeNewFinalizationOperation(task, workspaceId, effectiveChecks, effectiveCompletedChecklistIds);
      if ('blocked' in frozen) return frozen.blocked;
      operation = frozen.operation;
      operation = updateOperation(operation, {
        verification: {
          ...(operation.verification || {}),
          submittedChecks: effectiveChecks,
          completedChecklistIds: effectiveCompletedChecklistIds,
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
    }    if (effectiveCompletedChecklistIds.length > 0) {
      const persistedTaskProjection = projectChecklistCompletion(task, effectiveCompletedChecklistIds);
      const checklistChanged = Array.isArray(task.checklist) && Array.isArray(persistedTaskProjection.checklist)
        && task.checklist.some((item: any, index: number) => Boolean(item?.completed) !== Boolean(persistedTaskProjection.checklist[index]?.completed));
      if (checklistChanged) {
        saveTask({ ...persistedTaskProjection, updatedAt: new Date().toISOString() });
        task = getTaskByIdentifier(task.id, 'full') || persistedTaskProjection;
      }
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
        validateRecordedIntegration(operation, integration);
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
      const plans = planCombinedVerification(_state, operation.projectId, integration, effectiveChecks, impactRules, coverageCommands);
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
            repoRevision: integration.baseHeadAfter,
            summary: 'Reused authoritative GREEN verification coverage because affected inputs, dependencies, command configuration, and environment are unchanged.',
            recordedAt: targetCoverage.recordedAt || undefined,
          }))
        : [];
      let evidenceChecks = effectiveChecks.length > 0 ? effectiveChecks : reusedCoverageChecks;
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

      if (postIntegration.required && input.deferPostIntegrationVerification !== true) {
        const automaticVerification = executeRevisionBoundPostIntegrationVerification(_state, project, operation.id, postIntegration);
        effectiveChecks.push(...automaticVerification.checks);
        evidenceChecks = effectiveChecks;
        postIntegration = evaluatePostIntegrationRequirement(integration, effectiveChecks, sourcePlan, combinedPlan, targetCoverage);
        const automaticQualityDebt = collectInitialFinalizationQualityDebt(projectedTask, {
          ...input,
          checks: effectiveChecks,
          ownerBreakGlass: ownerBreakGlass || undefined,
        }, targetCoverage);
        qualityDebt = [
          ...automaticQualityDebt,
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
        operation = updateOperation(operation, {
          phase: 'verification-cleared',
          status: 'active',
          verification: {
            ...(operation.verification || {}),
            submittedChecks: effectiveChecks,
            requirement: postIntegration,
            qualityDebt,
            qualityDebtSummary,
            verifyOnlyWorkspace: {
              repoRevision: automaticVerification.repoRevision,
              setup: automaticVerification.setup,
              checks: automaticVerification.checks,
              cleanup: automaticVerification.cleanup,
            },
          },
          failure: null,
        });
      }
      const postIntegrationAttempted = postIntegrationRequirementsAttempted(postIntegration, effectiveChecks);
      if (postIntegration.required && !postIntegrationAttempted) {
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
          const completedTask = projectChecklistCompletion(base, effectiveCompletedChecklistIds);
          return {
            ...completedTask,
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

export async function runTaskWorkspaceHappyPathTail(
  state: AppState,
  input: TaskWorkspaceHappyPathTailInput,
  runPostIntegrationVerification?: TaskWorkspaceHappyPathTailVerificationRunner,
) {
  return runTaskWorkspaceHappyPathTailWithFinalizer(
    state,
    input,
    finalizeTaskWorkspace,
    runPostIntegrationVerification,
  );
}
