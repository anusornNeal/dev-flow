import type { AppState } from '../types.js';
import { getTaskByIdentifier, saveTask } from '../repositories/taskRepository.js';
import { createApiError } from './api.js';
import { normalizeVerificationEvidence } from './taskGitWorkflowService.js';
import { finalizeTaskLifecycleDisposition } from './taskClaimService.js';
import { cleanupSessionWorkspace, getSessionWorkspaceMetadataForRecovery } from './sessionWorkspaceService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';
import { integrateWorkspaceCommits, type WorkspaceIntegrationSuccess } from './workspaceIntegrationService.js';
import { loadProjectVerificationImpactRules } from './projectCommandConfigService.js';
import { planVerification, type VerificationPlan } from './verificationPlannerService.js';

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

export type TaskWorkspaceFinalizationInput = {
  taskId: string;
  workspaceId: string;
  checks?: TaskWorkspaceFinalizationCheck[];
  requireChecklistComplete?: boolean;
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

function appendFinalizationLog(task: any, message: string) {
  const now = new Date().toISOString();
  task.logs = [...(Array.isArray(task.logs) ? task.logs : []), {
    id: `log-workspace-finalize-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: now,
    message,
    type: 'update',
  }];
  task.updatedAt = now;
}

function verifyFinalizationInput(task: any, input: TaskWorkspaceFinalizationInput) {
  const requireChecklistComplete = input.requireChecklistComplete !== false;
  if (requireChecklistComplete && Array.isArray(task.checklist) && task.checklist.some((item: any) => !item?.completed)) {
    return { status: 'blocked' as const, code: 'CHECKLIST_INCOMPLETE' as const, message: 'Task checklist must be complete before workspace finalization.' };
  }
  const checks = Array.isArray(input.checks) ? input.checks : [];
  if (checks.length === 0) {
    return { status: 'blocked' as const, code: 'VERIFICATION_EVIDENCE_MISSING' as const, message: 'At least one verification check is required before workspace finalization.' };
  }
  const failed = checks.filter((check) => check?.status !== 'passed');
  if (failed.length > 0) {
    return { status: 'blocked' as const, code: 'VERIFICATION_NOT_PASSED' as const, message: 'All finalization verification checks must pass.', checks: failed };
  }
  return null;
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
) {
  const requestedCommands = Array.from(new Set([
    ...checks.map((check) => String(check.command || '').trim()),
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
  const missingCommands = hasFullEvidence
    ? []
    : combinedPlan.commands.filter((command) => !revisionBound.some((check) => check.command === command));
  const evidenceSatisfied = !required
    || (broadEvidenceRequired ? hasBroadEvidence : missingCommands.length === 0 && revisionBound.length > 0);

  let reason = 'Pre-integration evidence remains valid for the integrated state.';
  if (required && baseAdvanced) reason = 'The target branch advanced after the workspace base revision, so combined-state verification must be revision-bound to the integrated HEAD.';
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

type PostIntegrationFinalizationPhase = 'metadata' | 'verification-plan' | 'boundary-save' | 'evidence' | 'task-save' | 'execution-lifecycle' | 'cleanup';

function postIntegrationBoundaryLogId(workspaceId: string, repoRevision: string) {
  return `log-workspace-finalization-boundary-${workspaceId}-${repoRevision}`;
}

function hasPostIntegrationBoundary(task: any, workspaceId: string, repoRevision: string) {
  const id = postIntegrationBoundaryLogId(workspaceId, repoRevision);
  return Array.isArray(task?.logs) && task.logs.some((entry: any) => entry?.id === id);
}

function persistPostIntegrationBoundary(task: any, workspaceId: string, repoRevision: string) {
  if (hasPostIntegrationBoundary(task, workspaceId, repoRevision)) return task;
  const now = new Date().toISOString();
  const next = {
    ...task,
    logs: [...(Array.isArray(task.logs) ? task.logs : []), {
      id: postIntegrationBoundaryLogId(workspaceId, repoRevision),
      timestamp: now,
      message: `Post-integration finalization boundary accepted for workspace ${workspaceId} at ${repoRevision.slice(0, 12)}; no revision-bound verification continuation was required.`,
      type: 'update',
    }],
    updatedAt: now,
  };
  saveTask(next);
  return next;
}

function postIntegrationFinalizationContinuation(
  integration: WorkspaceIntegrationSuccess,
  phase: PostIntegrationFinalizationPhase,
  error: any,
  context: Record<string, unknown> = {},
) {
  const errorCode = String(error?.payload?.code || error?.code || 'POST_INTEGRATION_FINALIZATION_FAILED');
  const errorMessage = String(error?.payload?.message || error?.message || 'Post-integration finalization failed.').slice(0, 500);
  return {
    status: 'continuation' as const,
    code: 'POST_INTEGRATION_FINALIZATION_REQUIRED' as const,
    message: `Workspace integration succeeded, but finalization phase '${phase}' must be retried.`,
    continuation: {
      code: 'POST_INTEGRATION_FINALIZATION_REQUIRED' as const,
      phase,
      repoRevision: integration.baseHeadAfter,
      error: { code: errorCode, message: errorMessage },
      nextAction: {
        action: 'RETRY_FINALIZE_TASK_WORKSPACE' as const,
        tool: 'finalize_task_workspace' as const,
        reintegrate: false as const,
      },
    },
    integration,
    ...context,
  };
}

export function finalizeTaskWorkspace(_state: AppState, input: TaskWorkspaceFinalizationInput) {
  const taskId = String(input?.taskId || '').trim();
  const workspaceId = String(input?.workspaceId || '').trim();
  if (!taskId) throw createApiError(400, 'TASK_ID_REQUIRED', 'taskId is required for task workspace finalization.');
  if (!workspaceId) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'workspaceId is required for task workspace finalization.');
  const task = getTaskByIdentifier(taskId, 'full');
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
  const metadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
  if (!metadata) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
  if (metadata.projectId !== task.projectId) {
    throw createApiError(409, 'TASK_WORKSPACE_PROJECT_MISMATCH', 'Task and workspace belong to different projects.', {
      affectedId: task.id,
      details: { taskProjectId: task.projectId, workspaceProjectId: metadata.projectId },
    });
  }

  const blocked = verifyFinalizationInput(task, input);
  if (blocked) return blocked;

  const inspection = inspectWorkspaceRecovery(workspaceId);
  if (inspection.dirtyFiles.length > 0) {
    return { status: 'needs-recovery' as const, code: 'WORKSPACE_DIRTY' as const, inspection };
  }
  if (inspection.disposition === 'stale-registry' || inspection.disposition === 'needs-recovery') {
    return { status: 'needs-recovery' as const, code: 'WORKSPACE_RECOVERY_REQUIRED' as const, inspection };
  }

  const integration = integrateWorkspaceCommits(workspaceId, { task });
  if (integration.status === 'conflict') {
    return { status: 'needs-recovery' as const, code: 'INTEGRATION_CONFLICT' as const, integration };
  }

  const checks = input.checks || [];
  let phase: PostIntegrationFinalizationPhase = 'metadata';
  let sourcePlan: VerificationPlan | undefined;
  let combinedPlan: VerificationPlan | undefined;
  let postIntegration: PostIntegrationRequirement | undefined;
  let gitEvidence: any;
  let verificationEvidence: any[] = [];
  let finalTask: any = task;
  let workingTask: any = task;

  try {
    const refreshedMetadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
    if (!refreshedMetadata) throw createApiError(409, 'WORKSPACE_METADATA_LOST', 'Workspace metadata disappeared during finalization.', { affectedId: workspaceId });

    phase = 'verification-plan';
    const impactRules = loadProjectVerificationImpactRules(refreshedMetadata.projectRoot);
    const plans = planCombinedVerification(integration, checks, impactRules);
    sourcePlan = plans.sourcePlan;
    combinedPlan = plans.combinedPlan;
    postIntegration = evaluatePostIntegrationRequirement(integration, checks, sourcePlan, combinedPlan);
    const boundaryAlreadyAccepted = hasPostIntegrationBoundary(task, workspaceId, integration.baseHeadAfter);
    if (boundaryAlreadyAccepted && postIntegration.required) {
      postIntegration = {
        ...postIntegration,
        required: false,
        reason: 'A prior finalization attempt already cleared post-integration verification for this exact integrated revision.',
      };
    }
    if (postIntegration.required) {
      return {
        status: 'continuation' as const,
        code: 'POST_INTEGRATION_VERIFICATION_REQUIRED' as const,
        message: postIntegration.reason,
        continuation: {
          code: 'POST_INTEGRATION_VERIFICATION_REQUIRED' as const,
          repoRevision: postIntegration.repoRevision,
          requiredCommands: postIntegration.requiredCommands,
          missingCommands: postIntegration.missingCommands,
          broadEvidenceRequired: postIntegration.broadEvidenceRequired,
          requiredScope: postIntegration.requiredScope,
          nextAction: postIntegration.nextAction,
        },
        integration,
        sourcePlan,
        combinedPlan,
        postIntegration,
      };
    }

    phase = 'boundary-save';
    workingTask = persistPostIntegrationBoundary(task, workspaceId, integration.baseHeadAfter);
    finalTask = workingTask;

    phase = 'evidence';
    const alreadyDurable = workingTask.status === 'done'
      && workingTask.branch === refreshedMetadata.baseBranch
      && workingTask.gitEvidence?.commit === integration.baseHeadAfter
      && Array.isArray(workingTask.verificationEvidence);
    if (alreadyDurable) {
      finalTask = workingTask;
      gitEvidence = workingTask.gitEvidence;
      verificationEvidence = workingTask.verificationEvidence;
    } else {
      const evidenceTask = { ...workingTask, branch: refreshedMetadata.baseBranch };
      const synced = localOnlyEvidence(evidenceTask, refreshedMetadata.baseBranch, integration.baseHeadAfter, checks);
      gitEvidence = synced.gitEvidence;
      verificationEvidence = synced.verificationEvidence;
      finalTask = {
        ...synced.task,
        claim: undefined,
        status: 'done',
        branch: refreshedMetadata.baseBranch,
        updatedAt: new Date().toISOString(),
      };
      appendFinalizationLog(
        finalTask,
        `Finalized managed workspace ${workspaceId} into ${refreshedMetadata.baseBranch}@${integration.baseHeadAfter.slice(0, 12)} with ${verificationEvidence.length} passed verification check(s); combined impact covered ${integration.combinedChangedFiles.length} changed file(s).`,
      );
    }

    phase = 'execution-lifecycle';
    const finalized = finalizeTaskLifecycleDisposition(task.id, workspaceId, (base) => {
      const finalLogIds = new Set((Array.isArray(base.logs) ? base.logs : []).map((entry: any) => String(entry?.id || '')));
      const extraLogs = (Array.isArray(finalTask.logs) ? finalTask.logs : []).filter((entry: any) => !finalLogIds.has(String(entry?.id || '')));
      return {
        ...base,
        ...finalTask,
        claim: undefined,
        status: 'done',
        logs: [...(Array.isArray(base.logs) ? base.logs : []), ...extraLogs],
        updatedAt: new Date().toISOString(),
      };
    }, {
      changedFiles: integration.changedFiles,
      repoRevision: integration.baseHeadAfter,
    });
    finalTask = finalized.task;

    phase = 'cleanup';
    const cleanup = cleanupSessionWorkspace(workspaceId);
    return {
      status: 'completed' as const,
      task: getTaskByIdentifier(task.id, 'full') || finalTask,
      integration,
      sourcePlan,
      combinedPlan,
      postIntegration,
      gitEvidence,
      verificationEvidence,
      cleanup,
    };
  } catch (error: any) {
    return postIntegrationFinalizationContinuation(integration, phase, error, {
      ...(sourcePlan ? { sourcePlan } : {}),
      ...(combinedPlan ? { combinedPlan } : {}),
      ...(postIntegration ? { postIntegration } : {}),
      ...(gitEvidence ? { gitEvidence } : {}),
      ...(verificationEvidence.length > 0 ? { verificationEvidence } : {}),
      task: getTaskByIdentifier(task.id, 'full') || finalTask,
    });
  }
}
