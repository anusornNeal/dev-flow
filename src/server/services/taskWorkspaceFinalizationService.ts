import type { AppState } from '../types.js';
import { getTaskByIdentifier, saveTask } from '../repositories/taskRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import { createApiError } from './api.js';
import { completeExecutionSession, recordExecutionLifecycleTransition } from './executionSessionService.js';
import { syncTaskWithGit } from './taskGitWorkflowService.js';
import { clearTaskClaimWhenLeavingInProgress } from './taskClaimService.js';
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
  const verificationEvidence = checks.map((check) => ({ ...check, recordedAt: check.recordedAt || recordedAt }));
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

export function finalizeTaskWorkspace(state: AppState, input: TaskWorkspaceFinalizationInput) {
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

  const refreshedMetadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
  if (!refreshedMetadata) throw createApiError(409, 'WORKSPACE_METADATA_LOST', 'Workspace metadata disappeared during finalization.', { affectedId: workspaceId });

  const checks = input.checks || [];
  const impactRules = loadProjectVerificationImpactRules(refreshedMetadata.projectRoot);
  const { sourcePlan, combinedPlan } = planCombinedVerification(integration, checks, impactRules);
  const postIntegration = evaluatePostIntegrationRequirement(integration, checks, sourcePlan, combinedPlan);
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

  const evidenceTask = { ...task, branch: refreshedMetadata.baseBranch };
  let synced: ReturnType<typeof syncTaskWithGit>;
  try {
    synced = syncTaskWithGit(state, evidenceTask, {
      projectId: task.projectId,
      fetch: false,
      checks,
    });
  } catch (error: any) {
    if (error?.payload?.code !== 'GIT_REMOTE_NOT_FOUND') throw error;
    synced = localOnlyEvidence(evidenceTask, refreshedMetadata.baseBranch, integration.baseHeadAfter, checks) as ReturnType<typeof syncTaskWithGit>;
  }
  const finalTask = clearTaskClaimWhenLeavingInProgress({
    ...synced.task,
    status: 'done',
    branch: refreshedMetadata.baseBranch,
    updatedAt: new Date().toISOString(),
  });
  appendFinalizationLog(
    finalTask,
    `Finalized managed workspace ${workspaceId} into ${refreshedMetadata.baseBranch}@${integration.baseHeadAfter.slice(0, 12)} with ${synced.verificationEvidence.length} passed verification check(s); combined impact covered ${integration.combinedChangedFiles.length} changed file(s).`,
  );
  saveTask(finalTask);

  const session = listExecutionSessionsForTask(task.id).find((entry) => entry.workspaceId === workspaceId && entry.status === 'active');
  const cleanup = cleanupSessionWorkspace(workspaceId);
  if (session) {
    if (session.lifecycle.stage === 'committed') {
      recordExecutionLifecycleTransition(session.id, {
        toStage: 'finalized',
        reasonCode: 'workspace-finalization-succeeded',
        evidence: {
          id: `workspace-finalization:${workspaceId}:${integration.baseHeadAfter}`,
          kind: 'workspace-finalization',
          status: 'completed',
          operationId: `finalize:${workspaceId}:${integration.baseHeadAfter}`,
        },
      });
    }
    completeExecutionSession(session.id, {
      changedFiles: integration.changedFiles,
      verification: session.verification,
    });
  }
  return {
    status: 'completed' as const,
    task: getTaskByIdentifier(task.id, 'full') || finalTask,
    integration,
    sourcePlan,
    combinedPlan,
    postIntegration,
    gitEvidence: synced.gitEvidence,
    verificationEvidence: synced.verificationEvidence,
    cleanup,
  };
}
