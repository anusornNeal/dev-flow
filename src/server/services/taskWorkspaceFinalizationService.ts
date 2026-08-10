import type { AppState } from '../types.js';
import { getTaskByIdentifier, saveTask } from '../repositories/taskRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import { createApiError } from './api.js';
import { completeExecutionSession } from './executionSessionService.js';
import { syncTaskWithGit } from './taskGitWorkflowService.js';
import { clearTaskClaimWhenLeavingInProgress } from './taskClaimService.js';
import { cleanupSessionWorkspace, getSessionWorkspaceMetadataForRecovery } from './sessionWorkspaceService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';
import { integrateWorkspaceCommits } from './workspaceIntegrationService.js';

export type TaskWorkspaceFinalizationCheck = {
  name?: string;
  command: string;
  status: 'passed' | 'failed' | 'not-run';
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

  const evidenceTask = { ...task, branch: refreshedMetadata.baseBranch };
  let synced: ReturnType<typeof syncTaskWithGit>;
  try {
    synced = syncTaskWithGit(state, evidenceTask, {
      projectId: task.projectId,
      fetch: false,
      checks: input.checks,
    });
  } catch (error: any) {
    if (error?.payload?.code !== 'GIT_REMOTE_NOT_FOUND') throw error;
    synced = localOnlyEvidence(evidenceTask, refreshedMetadata.baseBranch, integration.baseHeadAfter, input.checks || []) as ReturnType<typeof syncTaskWithGit>;
  }
  const finalTask = clearTaskClaimWhenLeavingInProgress({
    ...synced.task,
    status: 'done',
    branch: refreshedMetadata.baseBranch,
    updatedAt: new Date().toISOString(),
  });
  appendFinalizationLog(finalTask, `Finalized managed workspace ${workspaceId} into ${refreshedMetadata.baseBranch}@${integration.baseHeadAfter.slice(0, 12)} with ${synced.verificationEvidence.length} passed verification check(s).`);
  saveTask(finalTask);

  const session = listExecutionSessionsForTask(task.id).find((entry) => entry.workspaceId === workspaceId && entry.status === 'active');
  if (session) {
    completeExecutionSession(session.id, {
      changedFiles: integration.changedFiles,
      verification: session.verification,
    });
  }

  const cleanup = cleanupSessionWorkspace(workspaceId);
  return {
    status: 'completed' as const,
    task: getTaskByIdentifier(task.id, 'full') || finalTask,
    integration,
    gitEvidence: synced.gitEvidence,
    verificationEvidence: synced.verificationEvidence,
    cleanup,
  };
}
