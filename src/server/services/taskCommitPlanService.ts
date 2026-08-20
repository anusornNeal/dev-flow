import type { AppState } from '../types.js';
import { getTaskByIdentifier } from '../repositories/taskRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import { createApiError } from './api.js';
import { getExecutionOwnershipState, getExecutionVerificationBatchState, type ExecutionVerificationBatchState } from './executionSessionService.js';
import { commitGitChanges } from './gitService.js';
import { renderTaskCommitMessage } from './projectGitWorkflowPolicyService.js';
import { resolveSessionWorkspace } from './sessionWorkspaceService.js';
import { computeLifecycleAuthoritySnapshot } from './lifecycleAuthorityService.js';

export type TaskCommitPlanBlocker = {
  code: string;
  message: string;
  details?: unknown;
};

export type TaskCommitPlan = {
  taskId: string;
  executionSessionId: string;
  workspaceId: string;
  ownedChangedFiles: string[];
  unrelatedChangedFiles: string[];
  scopeDrift: string[];
  ownershipDrift: Array<{ path: string; knownFileRevision: string; currentFileRevision: string }>;
  verifiedOwnershipDrift: Array<{ path: string; knownFileRevision: string; currentFileRevision: string }>;
  verificationFresh: boolean | null;
  verificationState: 'authoritative-fresh' | 'missing' | 'stale';
  verificationRecordedAt: string | null;
  commitAllowed: boolean;
  blockers: TaskCommitPlanBlocker[];
};

function requireTaskId(value: unknown) {
  const identifier = String(value || '').trim();
  if (!identifier) throw createApiError(400, 'TASK_ID_REQUIRED', 'taskId is required for a task-aware commit plan.');
  const task = getTaskByIdentifier(identifier, 'full');
  return (task?.id || identifier) as string;
}

function requireWorkspaceId(value: unknown) {
  const workspaceId = String(value || '').trim();
  if (!workspaceId) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'workspaceId is required for a task-aware commit plan.');
  return workspaceId;
}

function resolveVerificationState(verificationFresh: boolean | null): TaskCommitPlan['verificationState'] {
  return verificationFresh === true ? 'authoritative-fresh' : verificationFresh === null ? 'missing' : 'stale';
}

function buildBlockers(input: {
  sessionStatus: string;
  ownedChangedFiles: string[];
  ownershipDrift: TaskCommitPlan['ownershipDrift'];
  verificationFresh: boolean | null;
  verificationState: TaskCommitPlan['verificationState'];
  authorityOwnershipActive: boolean;
  verificationBatch: ExecutionVerificationBatchState | null;
  verificationRecordedAt: string | null;
}) {
  const blockers: TaskCommitPlanBlocker[] = [];
  if (!input.authorityOwnershipActive) {
    blockers.push({ code: 'LIFECYCLE_AUTHORITY_NOT_OWNED', message: 'Task-aware commit requires a unique active claim/ownership-epoch/execution authority.' });
  }
  if (input.sessionStatus !== 'active') {
    blockers.push({ code: 'EXECUTION_SESSION_NOT_ACTIVE', message: 'Task-aware commit requires an active execution session.' });
  }
  if (input.ownedChangedFiles.length === 0) {
    blockers.push({ code: 'TASK_COMMIT_NO_OWNED_CHANGES', message: 'No current working-tree changes belong to this execution session.' });
  }
  if (input.ownershipDrift.length > 0 && input.verificationFresh !== true) {
    blockers.push({
      code: 'EXECUTION_OWNERSHIP_DRIFT',
      message: `${input.ownershipDrift.length} owned file(s) changed outside the last known execution revision.`,
      details: { files: input.ownershipDrift },
    });
  }
  if (input.verificationBatch?.status === 'pending') {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE',
      message: `Verification batch '${input.verificationBatch.batchId}' still has pending required checks.`,
      details: { batchId: input.verificationBatch.batchId, pending: input.verificationBatch.pending },
    });
  } else if (input.verificationBatch?.status === 'failed') {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_BATCH_FAILED',
      message: `Verification batch '${input.verificationBatch.batchId}' contains failed required checks.`,
      details: { batchId: input.verificationBatch.batchId, failed: input.verificationBatch.failed },
    });
  } else if (input.verificationBatch?.status === 'stale') {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_BATCH_STALE',
      message: `Verification batch '${input.verificationBatch.batchId}' is stale for the current execution ownership revision.`,
      details: { batchId: input.verificationBatch.batchId, stale: input.verificationBatch.stale },
    });
  }
  if (input.verificationFresh !== true) {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_NOT_FRESH',
      message: input.verificationState === 'missing'
        ? 'Authoritative execution verification is missing for the current owned file revisions.'
        : 'Authoritative execution verification is stale for the current owned file revisions.',
      details: {
        verificationState: input.verificationState,
        verificationFresh: input.verificationFresh,
        verificationRecordedAt: input.verificationRecordedAt,
        ownershipDriftCount: input.ownershipDrift.length,
      },
    });
  }
  return blockers;
}

export function buildTaskCommitPlan(_state: AppState, args: Record<string, any>): TaskCommitPlan {
  const taskId = requireTaskId(args.taskId);
  const workspaceId = requireWorkspaceId(args.workspaceId);
  const workspace = resolveSessionWorkspace(workspaceId);
  if (!workspace) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });

  const authority = computeLifecycleAuthoritySnapshot(taskId, { workspaceId });
  if (authority.hardBlockers.length > 0) {
    throw createApiError(409, 'TASK_LIFECYCLE_AUTHORITY_CONFLICT', 'Task commit authority is ambiguous or violates a hard lifecycle identity invariant.', {
      affectedId: taskId,
      details: { workspaceId, classification: authority.classification, blockers: authority.hardBlockers },
    });
  }
  const taskWorkspaceSessions = listExecutionSessionsForTask(taskId).filter((entry) => entry.workspaceId === workspaceId);
  const currentSessionId = authority.execution.current?.id || null;
  const session = currentSessionId
    ? taskWorkspaceSessions.find((entry) => entry.id === currentSessionId) || null
    : taskWorkspaceSessions.length === 1 && taskWorkspaceSessions[0].status !== 'active'
      ? taskWorkspaceSessions[0]
      : null;
  if (!session) {
    throw createApiError(409, 'TASK_EXECUTION_SESSION_NOT_FOUND', 'No unique current execution authority or single terminal diagnostic session for this task owns the selected workspace.', {
      affectedId: taskId,
      details: { workspaceId, authorityClassification: authority.classification, activeSessionIds: authority.execution.activeSessionIds },
    });
  }

  const ownership = getExecutionOwnershipState(session.id, { repoRoot: workspace.root });
  const verificationState = resolveVerificationState(ownership.verificationFresh);
  const verificationRecordedAt = ownership.verificationRecordedAt || null;
  const verificationBatch = getExecutionVerificationBatchState(session.id);
  const blockers = buildBlockers({
    authorityOwnershipActive: authority.mutation.ownershipAuthorized,
    sessionStatus: session.status,
    ownedChangedFiles: ownership.ownedChanges,
    ownershipDrift: ownership.ownershipDrift,
    verificationFresh: ownership.verificationFresh,
    verificationState,
    verificationRecordedAt,
    verificationBatch,
  });
  return {
    taskId,
    executionSessionId: session.id,
    workspaceId,
    ownedChangedFiles: ownership.ownedChanges,
    unrelatedChangedFiles: ownership.unrelatedChanges,
    scopeDrift: ownership.scopeDrift,
    ownershipDrift: ownership.ownershipDrift,
    verifiedOwnershipDrift: ownership.verifiedOwnershipDrift,
    verificationFresh: ownership.verificationFresh,
    verificationState,
    verificationRecordedAt,
    commitAllowed: blockers.length === 0,
    blockers,
  };
}

export function commitTaskOwnedChanges(state: AppState, args: Record<string, any>) {
  const plan = buildTaskCommitPlan(state, args);
  if (!plan.commitAllowed) {
    throw createApiError(409, 'TASK_COMMIT_PLAN_BLOCKED', 'Task-owned commit is blocked until all commit-plan blockers are resolved.', {
      affectedId: plan.taskId,
      details: { workspaceId: plan.workspaceId, blockers: plan.blockers },
    });
  }
  const workspace = resolveSessionWorkspace(plan.workspaceId)!;
  const task = getTaskByIdentifier(args.taskId, 'full') || { id: plan.taskId };
  const message = renderTaskCommitMessage(args.message, task as any, { gitWorkflowPolicy: workspace.gitWorkflowPolicy } as any);
  const result = commitGitChanges(state, {
    localPath: workspace.root,
    message,
    files: plan.ownedChangedFiles,
    stageAll: false,
    dryRun: args.dryRun === true,
  }, { taskAware: true });
  const { root: _physicalRoot, ...safeResult } = result as any;
  return {
    ...safeResult,
    taskId: plan.taskId,
    executionSessionId: plan.executionSessionId,
    workspaceId: plan.workspaceId,
    committedFiles: plan.ownedChangedFiles,
    unrelatedChangesPreserved: plan.unrelatedChangedFiles,
  };
}
