import type { AppState } from '../types.js';
import { getTaskByIdentifier } from '../repositories/taskRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import { createApiError } from './api.js';
import { getExecutionOwnershipState } from './executionSessionService.js';
import { commitGitChanges } from './gitService.js';
import { resolveSessionWorkspace } from './sessionWorkspaceService.js';

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
  verificationFresh: boolean | null;
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

function buildBlockers(input: {
  sessionStatus: string;
  ownedChangedFiles: string[];
  ownershipDrift: TaskCommitPlan['ownershipDrift'];
  verificationFresh: boolean | null;
}) {
  const blockers: TaskCommitPlanBlocker[] = [];
  if (input.sessionStatus !== 'active') {
    blockers.push({ code: 'EXECUTION_SESSION_NOT_ACTIVE', message: 'Task-aware commit requires an active execution session.' });
  }
  if (input.ownedChangedFiles.length === 0) {
    blockers.push({ code: 'TASK_COMMIT_NO_OWNED_CHANGES', message: 'No current working-tree changes belong to this execution session.' });
  }
  if (input.ownershipDrift.length > 0) {
    blockers.push({
      code: 'EXECUTION_OWNERSHIP_DRIFT',
      message: `${input.ownershipDrift.length} owned file(s) changed outside the last known execution revision.`,
      details: { files: input.ownershipDrift },
    });
  }
  if (input.verificationFresh !== true) {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_NOT_FRESH',
      message: 'Fresh verification bound to the current owned file revisions is required before scoped commit.',
    });
  }
  return blockers;
}

export function buildTaskCommitPlan(_state: AppState, args: Record<string, any>): TaskCommitPlan {
  const taskId = requireTaskId(args.taskId);
  const workspaceId = requireWorkspaceId(args.workspaceId);
  const workspace = resolveSessionWorkspace(workspaceId);
  if (!workspace) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });

  const session = listExecutionSessionsForTask(taskId).find((entry) => entry.workspaceId === workspaceId);
  if (!session) {
    throw createApiError(409, 'TASK_EXECUTION_SESSION_NOT_FOUND', 'No execution session for this task owns the selected workspace.', {
      affectedId: taskId,
      details: { workspaceId },
    });
  }
  if (session.projectId !== workspace.projectId) {
    throw createApiError(409, 'TASK_EXECUTION_PROJECT_MISMATCH', 'Execution session project does not match the selected workspace project.', {
      affectedId: taskId,
      details: { workspaceId, executionSessionId: session.id },
    });
  }

  const ownership = getExecutionOwnershipState(session.id, { repoRoot: workspace.root });
  const blockers = buildBlockers({
    sessionStatus: session.status,
    ownedChangedFiles: ownership.ownedChanges,
    ownershipDrift: ownership.ownershipDrift,
    verificationFresh: ownership.verificationFresh,
  });
  return {
    taskId,
    executionSessionId: session.id,
    workspaceId,
    ownedChangedFiles: ownership.ownedChanges,
    unrelatedChangedFiles: ownership.unrelatedChanges,
    scopeDrift: ownership.scopeDrift,
    ownershipDrift: ownership.ownershipDrift,
    verificationFresh: ownership.verificationFresh,
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
  const result = commitGitChanges(state, {
    localPath: workspace.root,
    message: args.message,
    files: plan.ownedChangedFiles,
    stageAll: false,
    dryRun: args.dryRun === true,
  });
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
