import crypto from 'node:crypto';
import { getProject } from '../repositories/projectRepository.js';
import { listExecutionSessionsForTask, listExecutionSessionsForWorkspace, queryExecutionSessions } from '../repositories/executionSessionRepository.js';
import { getTaskByIdentifier, getTasksByProjectId, saveTask } from '../repositories/taskRepository.js';
import {
  createOrReuseSessionWorkspace,
  findSessionWorkspaceRecoveryCandidatesForTask,
  listSessionWorkspaceMetadataForRecovery,
  isSessionWorkspaceCompatibleWithTask,
  resolveSessionWorkspaceForRecovery,
} from './sessionWorkspaceService.js';
import { createApiError } from './api.js';
import {
  bindExecutionSessionOwnershipEpoch,
  cancelExecutionSession,
  completeExecutionSession,
  createExecutionSession,
  expireExecutionSessionsForTaskWorkspace,
  getExecutionSessionOwnershipEpoch,
  recordExecutionLifecycleTransition,
  recordExecutionReconciliationEvidence,
} from './executionSessionService.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import { withDbTransaction } from '../../db/index.js';
import { withSyncLock } from './lockAndIdempotencyService.js';
import type { TaskClaim, TaskStatus } from '../../types.js';
import { computeLifecycleAuthoritySnapshot } from './lifecycleAuthorityService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';

const DEFAULT_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_CLAIM_TTL_MS = 60_000;
const MAX_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIMABLE_STATUSES = new Set<TaskStatus>(['backlog', 'todo', 'in-progress']);
const RELEASE_STATUSES = new Set<TaskStatus>(['backlog', 'todo']);

export type TaskClaimOwnerKind = TaskClaim['ownerKind'];

export type ClaimTaskInput = {
  sessionId: string;
  ownerKind?: TaskClaimOwnerKind;
  ownerLabel?: string;
  allowScopeConflict?: boolean;
  ttlMs?: number;
};

export type ClaimNextTaskInput = Omit<ClaimTaskInput, 'allowScopeConflict'> & {
  limit?: number;
};

export type ExpandTaskClaimScopeInput = {
  sessionId: string;
  paths: string[];
};

export type ReleaseTaskClaimInput = {
  sessionId: string;
  nextStatus?: TaskStatus;
  emergency?: boolean;
};

function sessionIdHash(sessionId: string) {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

function newOwnershipEpochId() {
  return `claim-epoch-${crypto.randomUUID()}`;
}

function normalizeOwnerKind(value: unknown): TaskClaimOwnerKind {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'antigravity' || normalized === 'agent') return normalized;
  return 'chat';
}

function normalizeOwnerLabel(value: unknown, ownerKind: TaskClaimOwnerKind, hash: string) {
  const supplied = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 32);
  if (supplied) return supplied;
  const prefix = ownerKind === 'chat' ? 'Chat' : ownerKind.charAt(0).toUpperCase() + ownerKind.slice(1);
  return `${prefix} ${hash.slice(0, 4).toUpperCase()}`;
}

function boundedTtlMs(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_CLAIM_TTL_MS;
  return Math.max(MIN_CLAIM_TTL_MS, Math.min(MAX_CLAIM_TTL_MS, Math.floor(numeric)));
}

function isActiveClaim(claim: unknown, nowMs = Date.now()): claim is TaskClaim {
  if (!claim || typeof claim !== 'object') return false;
  const candidate = claim as TaskClaim;
  return Boolean(candidate.sessionIdHash && candidate.workspaceId && candidate.expiresAt && Date.parse(candidate.expiresAt) > nowMs);
}

function normalizeScopePath(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function normalizedScopePaths(values: unknown): Set<string> {
  return new Set<string>((Array.isArray(values) ? values : [])
    .map(normalizeScopePath)
    .filter(Boolean));
}

function normalizedTargetFiles(task: any): Set<string> {
  return normalizedScopePaths(task?.targetFiles);
}

function normalizedReservedPaths(task: any): Set<string> {
  return normalizedScopePaths(task?.claim?.reservedPaths);
}

function effectiveClaimedScope(task: any, nowMs = Date.now()): Set<string> {
  const scope = normalizedTargetFiles(task);
  if (isActiveClaim(task?.claim, nowMs)) {
    for (const file of normalizedReservedPaths(task)) scope.add(file);
  }
  return scope;
}

function findScopeConflictsForPaths(taskId: string, requestedPaths: Set<string>, projectTasks: any[], nowMs: number) {
  if (requestedPaths.size === 0) return [];
  const conflicts: Array<{ taskId: string; displayId?: string; ownerLabel: string; files: string[] }> = [];
  for (const candidate of projectTasks) {
    if (candidate.id === taskId || !isActiveClaim(candidate.claim, nowMs)) continue;
    const overlap = [...effectiveClaimedScope(candidate, nowMs)].filter((file) => requestedPaths.has(file));
    if (overlap.length === 0) continue;
    conflicts.push({
      taskId: candidate.id,
      displayId: candidate.displayId,
      ownerLabel: candidate.claim.ownerLabel,
      files: overlap.sort(),
    });
  }
  return conflicts;
}

function findScopeConflicts(task: any, projectTasks: any[], nowMs: number) {
  return findScopeConflictsForPaths(task.id, normalizedTargetFiles(task), projectTasks, nowMs);
}

function normalizeRequestedScopePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw createApiError(400, 'TASK_SCOPE_PATHS_REQUIRED', 'paths must contain at least one repository-relative path.');
  }
  if (value.length > 100) {
    throw createApiError(400, 'TASK_SCOPE_PATHS_LIMIT', 'paths may contain at most 100 entries.');
  }
  const normalized = new Set<string>();
  for (const raw of value) {
    const supplied = String(raw || '').trim();
    const path = normalizeScopePath(supplied);
    const unsafe = !path
      || path.length > 500
      || path === '.'
      || path.startsWith('/')
      || /^[a-z]:\//.test(path)
      || path.split('/').some((segment) => segment === '..');
    if (unsafe) {
      throw createApiError(400, 'TASK_SCOPE_PATH_INVALID', `Scope path '${supplied || '<empty>'}' must be a bounded repository-relative path.`, {
        details: { path: supplied },
      });
    }
    normalized.add(path);
  }
  return [...normalized].sort();
}

const NEXT_TASK_DEFAULT_LIMIT = 50;
const NEXT_TASK_MAX_LIMIT = 100;
const NEXT_TASK_PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 };

function boundedNextTaskLimit(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NEXT_TASK_DEFAULT_LIMIT;
  return Math.max(1, Math.min(NEXT_TASK_MAX_LIMIT, Math.floor(numeric)));
}

function normalizedTags(task: any) {
  return (Array.isArray(task?.tags) ? task.tags : [])
    .map((tag: unknown) => String(tag || '').trim().toLowerCase())
    .filter(Boolean);
}

function isExplicitFinalGate(task: any) {
  return normalizedTags(task).includes('final-gate');
}

function hasBlockingDependency(task: any, projectTasks: any[]) {
  const dependencyTags = normalizedTags(task).filter((tag) => tag.startsWith('depends-on:') || tag.startsWith('blocked-by:'));
  if (dependencyTags.length === 0) return false;
  for (const tag of dependencyTags) {
    const identifier = tag.slice(tag.indexOf(':') + 1).trim();
    if (!identifier) return true;
    const dependency = projectTasks.find((candidate) =>
      String(candidate.id || '').toLowerCase() === identifier || String(candidate.displayId || '').toLowerCase() === identifier);
    if (!dependency || dependency.status !== 'done') return true;
  }
  return false;
}

function compareNextTaskOrder(left: any, right: any) {
  const priorityDelta = (NEXT_TASK_PRIORITY[String(left.priority || 'medium').toLowerCase()] ?? 1)
    - (NEXT_TASK_PRIORITY[String(right.priority || 'medium').toLowerCase()] ?? 1);
  if (priorityDelta !== 0) return priorityDelta;
  const createdDelta = String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
  if (createdDelta !== 0) return createdDelta;
  return String(left.displayId || left.id || '').localeCompare(String(right.displayId || right.id || ''));
}

function activeTaskExecutionsForWorkspace(task: any, workspaceId: string) {
  return listExecutionSessionsForTask(task.id)
    .filter((entry) => entry.workspaceId === workspaceId && entry.status === 'active');
}
function assertTaskExecutionScopeUnambiguous(task: any, workspaceId: string) {
  const activeForTask = listExecutionSessionsForTask(task.id).filter((entry) => entry.status === 'active');
  const scoped = activeForTask.filter((entry) => entry.workspaceId === workspaceId);
  const foreignWorkspace = activeForTask.filter((entry) => entry.workspaceId !== workspaceId);
  const foreignTask = listExecutionSessionsForWorkspace(workspaceId)
    .filter((entry) => entry.status === 'active' && entry.taskId !== task.id);
  if (scoped.length > 1 || foreignWorkspace.length > 0 || foreignTask.length > 0) {
    const executionSessionIds = [...new Set([
      ...scoped.map((entry) => entry.id),
      ...foreignWorkspace.map((entry) => entry.id),
      ...foreignTask.map((entry) => entry.id),
    ])].sort();
    throw createApiError(409, 'TASK_EXECUTION_RECONCILIATION_AMBIGUOUS', `Task '${task.displayId || task.id}' execution ownership is ambiguous and cannot be reconciled automatically.`, {
      affectedId: task.id,
      details: {
        workspaceId,
        executionSessionIds,
        foreignWorkspaceExecutionSessionIds: foreignWorkspace.map((entry) => entry.id),
        foreignTaskExecutionSessionIds: foreignTask.map((entry) => entry.id),
        nextAction: 'Inspect the bounded execution/workspace identities and reconcile explicitly; DevFlow will not choose newest/oldest heuristically.',
      },
    });
  }
  return scoped;
}

function reconcileScopedExpiredTaskExecutions(task: any, workspaceId: string, now = new Date()) {
  const nowMs = now.getTime();
  const expiredCandidates = activeTaskExecutionsForWorkspace(task, workspaceId)
    .filter((entry) => entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs);
  assertOwnershipRotationAllowed(task, expiredCandidates);
  if (expiredCandidates.length === 0) return [];
  return expireExecutionSessionsForTaskWorkspace(task.id, workspaceId, now);
}

function activeReconciledTaskExecutionsForWorkspace(task: any, workspaceId: string) {
  reconcileScopedExpiredTaskExecutions(task, workspaceId);
  return assertTaskExecutionScopeUnambiguous(task, workspaceId);
}


function unresolvedExecutionOperations(sessionId: string) {
  const checkpoint = getLatestExecutionCheckpoint(sessionId);
  return (checkpoint?.pendingOperations || [])
    .filter((entry) => entry.status === 'accepted' || entry.status === 'running');
}

function unresolvedTaskOperations(task: any) {
  return listExecutionSessionsForTask(task.id).flatMap((session) => unresolvedExecutionOperations(session.id).map((entry) => ({
    executionSessionId: session.id,
    executionStatus: session.status,
    ownershipEpochId: getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId,
    operationId: entry.operationId,
    evidenceId: entry.evidenceId,
    kind: entry.kind,
    status: entry.status,
  })));
}

function assertNoUnresolvedTaskOperations(task: any, action: string) {
  const operations = unresolvedTaskOperations(task);
  if (operations.length === 0) return;
  throw createApiError(409, 'TASK_LIFECYCLE_PENDING_OPERATION', `Task '${task.displayId || task.id}' cannot ${action} while durable lifecycle work is unresolved.`, {
    affectedId: task.id,
    details: {
      action,
      operationIds: operations.map((entry) => entry.operationId),
      operations,
      nextAction: 'Inspect the durable job result and retry only after terminal pending-operation reconciliation.',
    },
  });
}

function activeTaskExecutions(task: any) {
  return listExecutionSessionsForTask(task.id).filter((entry) => entry.status === 'active');
}

function disposeTaskLifecycleForStatusLocked(task: any, targetStatus: TaskStatus, reason: string) {
  if (targetStatus === 'in-progress') return { task, disposed: false, executionSessionIds: [] as string[] };
  assertNoUnresolvedTaskOperations(task, `move to '${targetStatus}'`);
  const active = activeTaskExecutions(task);
  if (!task.claim && active.length > 0) {
    throw createApiError(409, 'TASK_LIFECYCLE_RECONCILIATION_REQUIRED', `Task '${task.displayId || task.id}' has active execution ownership without a claim; lifecycle reconciliation is required before changing status.`, {
      affectedId: task.id,
      details: { targetStatus, executionSessionIds: active.map((entry) => entry.id) },
    });
  }
  if (!task.claim) return { task, disposed: false, executionSessionIds: [] as string[] };
  const claimWorkspaceId = String(task.claim.workspaceId || '').trim();
  const foreign = active.filter((entry) => entry.workspaceId !== claimWorkspaceId);
  if (foreign.length > 0) {
    throw createApiError(409, 'TASK_EXECUTION_OWNERSHIP_AMBIGUOUS', `Task '${task.displayId || task.id}' has active execution ownership outside its claimed workspace.`, {
      affectedId: task.id,
      details: { claimWorkspaceId, executionSessionIds: foreign.map((entry) => entry.id) },
    });
  }
  for (const session of active) cancelExecutionSession(session.id);
  const now = new Date().toISOString();
  const disposedTask = {
    ...task,
    claim: undefined,
    updatedAt: now,
    logs: [...(Array.isArray(task.logs) ? task.logs : []), {
      id: `log-task-lifecycle-dispose-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: now,
      message: `Lifecycle ownership disposed before status transition to ${targetStatus}: ${reason}.`,
      type: 'update',
    }],
  };
  return { task: disposedTask, disposed: true, executionSessionIds: active.map((entry) => entry.id) };
}

export function taskHasLifecycleOwnership(task: any) {
  if (!task?.id) return false;
  return Boolean(task.claim) || activeTaskExecutions(task).length > 0;
}

export function mutateTaskStatusWithLifecycle(
  taskId: string,
  targetStatus: TaskStatus,
  buildTask: (task: any) => any,
  options: { reason?: string } = {},
) {
  const initial = getTaskByIdentifier(taskId, 'full');
  if (!initial) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
  if (!initial.projectId) throw createApiError(400, 'TASK_PROJECT_REQUIRED', 'Task must belong to a project before lifecycle mutation.', { affectedId: initial.id });
  const reason = String(options.reason || 'coordinated task status mutation').trim().slice(0, 240) || 'coordinated task status mutation';
  return withSyncLock(`task-claim:${initial.projectId}`, () => {
    const authority = computeLifecycleAuthoritySnapshot(initial.id, { workspaceId: initial.claim?.workspaceId });
    if (authority.hardBlockers.length > 0) {
      throw createApiError(409, 'TASK_LIFECYCLE_AUTHORITY_CONFLICT', `Task '${initial.displayId || initial.id}' has ambiguous lifecycle authority and cannot change status automatically.`, {
        affectedId: initial.id,
        details: { classification: authority.classification, blockers: authority.hardBlockers },
      });
    }
    return withDbTransaction(() => {
      const current = getTaskByIdentifier(taskId, 'full');
      if (!current) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
      const disposition = disposeTaskLifecycleForStatusLocked(current, targetStatus, reason);
      const next = buildTask(disposition.task);
      if (!next || String(next.id || '') !== current.id || next.status !== targetStatus) {
        throw createApiError(409, 'TASK_LIFECYCLE_MUTATION_INVALID', 'Lifecycle status mutation must preserve task identity and persist the requested target status.', {
          affectedId: current.id,
          details: { targetStatus, returnedTaskId: next?.id, returnedStatus: next?.status },
        });
      }
      saveTask(next);
      return { task: getTaskByIdentifier(current.id, 'full') || next, disposed: disposition.disposed, executionSessionIds: disposition.executionSessionIds };
    });
  });
}

function isActionableDeletionWorkspace(workspaceId: string) {
  const inspection = inspectWorkspaceRecovery(workspaceId);
  return inspection.disposition === 'needs-recovery'
    || inspection.disposition === 'stale-registry'
    || inspection.disposition === 'committed-not-integrated'
    || inspection.state === 'integration-required';
}

function taskDeletionWorkspaceBlockers(task: any) {
  const discovery = findSessionWorkspaceRecoveryCandidatesForTask(task.projectId, task.displayId || task.id, 100);
  if (discovery.truncated) {
    return [{
      taskId: task.id,
      displayId: task.displayId,
      reason: 'workspace-discovery-truncated',
      workspaceIds: discovery.workspaces.map((entry) => entry.workspaceId),
    }];
  }
  if (discovery.legacyMatches.length > 0 || discovery.exactMatches.length > 1) {
    return [{
      taskId: task.id,
      displayId: task.displayId,
      reason: discovery.legacyMatches.length > 0 ? 'workspace-identity-legacy-ambiguous' : 'workspace-identity-ambiguous',
      workspaceIds: [...discovery.exactMatches, ...discovery.legacyMatches].map((entry) => entry.workspaceId),
    }];
  }
  return discovery.exactMatches
    .filter((entry) => isActionableDeletionWorkspace(entry.workspaceId))
    .map((entry) => ({
      taskId: task.id,
      displayId: task.displayId,
      reason: 'actionable-workspace',
      workspaceIds: [entry.workspaceId],
    }));
}

function collectTaskDeletionBlockers(tasks: any[]) {
  return tasks.flatMap((task) => {
    const operations = unresolvedTaskOperations(task);
    const active = activeTaskExecutions(task);
    const workspaceBlockers = taskDeletionWorkspaceBlockers(task);
    if (!task.claim && active.length === 0 && operations.length === 0 && workspaceBlockers.length === 0) return [];
    return [{
      taskId: task.id,
      displayId: task.displayId,
      claimWorkspaceId: task.claim?.workspaceId || null,
      executionSessionIds: active.map((entry) => entry.id),
      operationIds: operations.map((entry) => entry.operationId),
      workspaceBlockers,
    }];
  });
}

export function withTaskDeletionLifecycleGuard<T>(taskIds: string[], deleteFn: (tasks: any[]) => T) {
  const ids = [...new Set(taskIds.map((value) => String(value || '').trim()).filter(Boolean))];
  if (ids.length === 0) throw createApiError(400, 'TASK_DELETE_IDS_REQUIRED', 'At least one task id is required for guarded deletion.');
  const initialTasks = ids.map((id) => getTaskByIdentifier(id, 'full')).filter(Boolean) as any[];
  if (initialTasks.length !== ids.length) throw createApiError(404, 'TASK_NOT_FOUND', 'One or more tasks selected for deletion were not found.');
  const projectIds = [...new Set(initialTasks.map((task) => String(task.projectId || '')).filter(Boolean))];
  if (projectIds.length !== 1) throw createApiError(409, 'TASK_DELETE_PROJECT_AMBIGUOUS', 'Recursive lifecycle-guarded deletion must stay within one project.');
  return withSyncLock(`task-claim:${projectIds[0]}`, () => withDbTransaction(() => {
    const tasks = ids.map((id) => getTaskByIdentifier(id, 'full')).filter(Boolean) as any[];
    if (tasks.length !== ids.length) throw createApiError(409, 'TASK_DELETE_SET_CHANGED', 'Task deletion set changed before lifecycle guard could execute.');
    const blockers = collectTaskDeletionBlockers(tasks);
    if (blockers.length > 0) {
      throw createApiError(409, 'TASK_DELETE_LIFECYCLE_BLOCKED', 'Task deletion is blocked while any selected task owns lifecycle or recoverable workspace state.', {
        details: { blockers, nextAction: 'Release/finalize ownership and recover or clean exact managed workspaces before deleting task records. Dirty managed WIP is never discarded by delete.' },
      });
    }
    return deleteFn(tasks);
  }));
}

export function withProjectDeletionLifecycleGuard<T>(projectId: string, deleteFn: (tasks: any[]) => T) {
  const cleanProjectId = String(projectId || '').trim();
  if (!cleanProjectId) throw createApiError(400, 'PROJECT_ID_REQUIRED', 'projectId is required for guarded project deletion.');
  return withSyncLock(`task-claim:${cleanProjectId}`, () => withDbTransaction(() => {
    const project = getProject(cleanProjectId);
    if (!project) throw createApiError(404, 'PROJECT_NOT_FOUND', 'Project not found', { affectedId: cleanProjectId });
    const tasks = getTasksByProjectId(cleanProjectId);
    const taskIds = new Set(tasks.map((task: any) => String(task.id || '')).filter(Boolean));
    const taskDisplayIds = new Set(tasks.map((task: any) => String(task.displayId || '')).filter(Boolean));
    const blockers: any[] = collectTaskDeletionBlockers(tasks);

    const executions = queryExecutionSessions({ projectId: cleanProjectId, limit: 100 });
    if (executions.truncated) {
      blockers.push({ reason: 'execution-discovery-truncated', total: executions.total, visible: executions.sessions.length });
    } else {
      for (const session of executions.sessions) {
        const pending = unresolvedExecutionOperations(session.id);
        const missingTask = Boolean(session.taskId) && !taskIds.has(String(session.taskId));
        blockers.push({
          reason: missingTask
            ? 'historical-execution-missing-task'
            : session.status === 'active'
              ? 'active-execution'
              : pending.length > 0
                ? 'pending-operation'
                : 'historical-execution-record',
          taskId: session.taskId || null,
          executionSessionId: session.id,
          workspaceId: session.workspaceId || null,
          operationIds: pending.map((entry) => entry.operationId),
        });
      }
    }

    const registry = listSessionWorkspaceMetadataForRecovery(cleanProjectId, 100);
    if (registry.truncated) {
      blockers.push({ reason: 'workspace-discovery-truncated', total: registry.total, visible: registry.workspaces.length });
    } else {
      for (const workspace of registry.workspaces) {
        const taskDisplayId = String(workspace.taskDisplayId || '').trim();
        const missingTask = !taskDisplayId || !taskDisplayIds.has(taskDisplayId);
        const actionable = isActionableDeletionWorkspace(workspace.workspaceId);
        blockers.push({
          reason: missingTask ? 'historical-workspace-missing-task' : actionable ? 'actionable-workspace' : 'historical-workspace-record',
          taskDisplayId: taskDisplayId || null,
          workspaceId: workspace.workspaceId,
        });
      }
    }

    if (blockers.length > 0) {
      throw createApiError(409, 'PROJECT_DELETE_LIFECYCLE_BLOCKED', 'Project deletion is blocked until lifecycle and managed-workspace recovery state is fully resolved.', {
        affectedId: cleanProjectId,
        details: {
          blockers,
          nextAction: 'Resolve active/pending execution state and recover or explicitly clean managed workspaces before deleting the project. Truncated discovery is never treated as all-clear.',
        },
      });
    }
    return deleteFn(tasks);
  }));
}

export function terminalizeTaskExecutionForFinalization(
  taskId: string,
  workspaceId: string,
  input: {
    changedFiles?: string[];
    verification?: unknown[];
    repoRevision: string;
    executionSessionId?: string | null;
    ownershipEpochId?: string | null;
    operationId?: string | null;
  },
) {
  const initial = getTaskByIdentifier(taskId, 'full');
  if (!initial) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
  const cleanWorkspaceId = String(workspaceId || '').trim();
  const repoRevision = String(input?.repoRevision || '').trim();
  if (!cleanWorkspaceId || !repoRevision) throw createApiError(400, 'TASK_FINALIZATION_IDENTITY_REQUIRED', 'workspaceId and repoRevision are required for lifecycle finalization.');
  return withSyncLock(`task-claim:${initial.projectId}`, () => withDbTransaction(() => {
    const current = getTaskByIdentifier(taskId, 'full');
    if (!current) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
    assertNoUnresolvedTaskOperations(current, 'terminalize task execution for finalization');
    if (current.claim?.workspaceId && current.claim.workspaceId !== cleanWorkspaceId) {
      throw createApiError(409, 'TASK_FINALIZATION_WORKSPACE_MISMATCH', 'Task claim belongs to a different workspace than finalization.', {
        affectedId: current.id,
        details: { claimWorkspaceId: current.claim.workspaceId, workspaceId: cleanWorkspaceId },
      });
    }
    const sessions = listExecutionSessionsForTask(current.id);
    const active = sessions.filter((entry) => entry.status === 'active');
    const foreign = active.filter((entry) => entry.workspaceId !== cleanWorkspaceId);
    if (foreign.length > 0) {
      throw createApiError(409, 'TASK_FINALIZATION_EXECUTION_AMBIGUOUS', 'Task has active execution ownership outside the workspace being finalized.', {
        affectedId: current.id,
        details: { workspaceId: cleanWorkspaceId, executionSessionIds: foreign.map((entry) => entry.id) },
      });
    }
    const requestedSessionId = String(input.executionSessionId || '').trim();
    const candidates = sessions.filter((entry) => entry.workspaceId === cleanWorkspaceId);
    const session = requestedSessionId
      ? candidates.find((entry) => entry.id === requestedSessionId) || null
      : active.filter((entry) => entry.workspaceId === cleanWorkspaceId).length === 1
        ? active.find((entry) => entry.workspaceId === cleanWorkspaceId) || null
        : candidates.length === 1
          ? candidates[0]
          : null;
    if (requestedSessionId && !session) {
      throw createApiError(409, 'TASK_FINALIZATION_EXECUTION_IDENTITY_MISMATCH', 'The frozen finalization execution session is no longer associated with this task/workspace.', {
        affectedId: current.id,
        details: { workspaceId: cleanWorkspaceId, executionSessionId: requestedSessionId },
      });
    }
    if (active.filter((entry) => entry.workspaceId === cleanWorkspaceId).length > 1) {
      throw createApiError(409, 'TASK_FINALIZATION_EXECUTION_AMBIGUOUS', 'Multiple active executions exist in the workspace being finalized.', {
        affectedId: current.id,
        details: { workspaceId: cleanWorkspaceId, executionSessionIds: active.filter((entry) => entry.workspaceId === cleanWorkspaceId).map((entry) => entry.id) },
      });
    }
    if (!session) return { task: current, executionSessionId: null, idempotent: true };
    const requestedEpoch = String(input.ownershipEpochId || '').trim();
    const actualEpoch = String(getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId || '').trim();
    if (requestedEpoch && actualEpoch !== requestedEpoch) {
      throw createApiError(409, 'TASK_FINALIZATION_OWNERSHIP_EPOCH_MISMATCH', 'The frozen finalization operation refers to a different execution ownership epoch.', {
        affectedId: current.id,
        details: { executionSessionId: session.id, requestedOwnershipEpochId: requestedEpoch, actualOwnershipEpochId: actualEpoch || null },
      });
    }
    if (session.status === 'completed') {
      if (session.lifecycle.stage !== 'finalized') {
        throw createApiError(409, 'TASK_FINALIZATION_EXECUTION_TERMINAL_INVALID', `Execution '${session.id}' is completed without finalized lifecycle evidence.`, {
          affectedId: current.id,
          details: { executionSessionId: session.id, stage: session.lifecycle.stage },
        });
      }
      return { task: current, executionSessionId: session.id, idempotent: true };
    }
    if (session.status !== 'active') {
      throw createApiError(409, 'TASK_FINALIZATION_EXECUTION_TERMINAL_INVALID', `Execution '${session.id}' is terminal (${session.status}) and cannot satisfy successful finalization.`, {
        affectedId: current.id,
        details: { executionSessionId: session.id, status: session.status },
      });
    }
    if (session.lifecycle.stage === 'committed') {
      recordExecutionLifecycleTransition(session.id, {
        toStage: 'finalized',
        reasonCode: 'workspace-finalization-succeeded',
        evidence: {
          id: `workspace-finalization:${cleanWorkspaceId}:${repoRevision}`,
          kind: 'workspace-finalization',
          status: 'completed',
          operationId: String(input.operationId || '').trim() || `finalize:${cleanWorkspaceId}:${repoRevision}`,
        },
      });
    } else if (session.lifecycle.stage !== 'finalized') {
      throw createApiError(409, 'TASK_FINALIZATION_EXECUTION_STAGE_INVALID', `Execution '${session.id}' must be committed before task finalization.`, {
        affectedId: current.id,
        details: { executionSessionId: session.id, stage: session.lifecycle.stage },
      });
    }
    completeExecutionSession(session.id, {
      changedFiles: input.changedFiles || [],
      verification: input.verification || session.verification,
    });
    return { task: getTaskByIdentifier(current.id, 'full') || current, executionSessionId: session.id, idempotent: false };
  }));
}

export function projectTaskCompletionAfterFinalization(
  taskId: string,
  workspaceId: string,
  buildFinalTask: (task: any) => any,
) {
  const initial = getTaskByIdentifier(taskId, 'full');
  if (!initial) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
  const cleanWorkspaceId = String(workspaceId || '').trim();
  if (!cleanWorkspaceId) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'workspaceId is required for finalization projection.');
  return withSyncLock(`task-claim:${initial.projectId}`, () => withDbTransaction(() => {
    const current = getTaskByIdentifier(taskId, 'full');
    if (!current) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
    assertNoUnresolvedTaskOperations(current, 'project task completion after finalization');
    const active = activeTaskExecutions(current);
    if (active.length > 0) {
      throw createApiError(409, 'TASK_FINALIZATION_EXECUTION_STILL_ACTIVE', 'Task completion projection is blocked until execution ownership is terminal.', {
        affectedId: current.id,
        details: { executionSessionIds: active.map((entry) => entry.id) },
      });
    }
    if (current.claim?.workspaceId && current.claim.workspaceId !== cleanWorkspaceId) {
      throw createApiError(409, 'TASK_FINALIZATION_WORKSPACE_MISMATCH', 'Task claim belongs to a different workspace than finalization.', {
        affectedId: current.id,
        details: { claimWorkspaceId: current.claim.workspaceId, workspaceId: cleanWorkspaceId },
      });
    }
    if (current.status === 'done' && !current.claim) return { task: current, idempotent: true };
    const base = { ...current, claim: undefined };
    const finalTask = buildFinalTask(base);
    if (!finalTask || finalTask.id !== current.id || finalTask.status !== 'done') {
      throw createApiError(409, 'TASK_FINALIZATION_MUTATION_INVALID', 'Finalization projection must preserve task identity and persist done status.', { affectedId: current.id });
    }
    saveTask(finalTask);
    return { task: getTaskByIdentifier(current.id, 'full') || finalTask, idempotent: false };
  }));
}

export function finalizeTaskLifecycleDisposition(
  taskId: string,
  workspaceId: string,
  buildFinalTask: (task: any) => any,
  input: { changedFiles?: string[]; verification?: unknown[]; repoRevision: string },
) {
  const authority = computeLifecycleAuthoritySnapshot(taskId, { workspaceId });
  if (authority.hardBlockers.length > 0) {
    throw createApiError(409, 'TASK_LIFECYCLE_AUTHORITY_CONFLICT', `Task '${authority.task.displayId || authority.task.id}' has ambiguous lifecycle authority and cannot use the compatibility finalization wrapper.`, {
      affectedId: authority.task.id,
      details: { classification: authority.classification, blockers: authority.hardBlockers, workspaceId },
    });
  }
  const terminalized = terminalizeTaskExecutionForFinalization(taskId, workspaceId, input);
  const projected = projectTaskCompletionAfterFinalization(taskId, workspaceId, buildFinalTask);
  return { task: projected.task, executionSessionId: terminalized.executionSessionId };
}

function assertOwnershipRotationAllowed(task: any, sessions: ReturnType<typeof activeTaskExecutionsForWorkspace>) {
  const operations = sessions.flatMap((session) => unresolvedExecutionOperations(session.id).map((entry) => ({
    executionSessionId: session.id,
    ownershipEpochId: getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId,
    operationId: entry.operationId,
    evidenceId: entry.evidenceId,
    kind: entry.kind,
    status: entry.status,
  })));
  if (operations.length === 0) return;
  throw createApiError(409, 'TASK_CLAIM_PENDING_OPERATION', `Task '${task.displayId || task.id}' cannot rotate ownership while durable lifecycle work is unresolved.`, {
    affectedId: task.id,
    details: {
      operationIds: operations.map((entry) => entry.operationId),
      operations,
      nextAction: 'Inspect the durable job result and retry ownership rotation only after terminal reconciliation.',
    },
  });
}

function terminalizeActiveTaskExecutions(task: any, workspaceId: string, reasonCode = 'claim-epoch-replaced') {
  const active = activeReconciledTaskExecutionsForWorkspace(task, workspaceId);
  assertOwnershipRotationAllowed(task, active);
  for (const session of active) {
    cancelExecutionSession(session.id);
    recordExecutionReconciliationEvidence(session.id, reasonCode, {
      ownershipEpochId: getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId,
    });
  }
  return active;
}

function ensureClaimExecutionSession(task: any, workspace: any, options: { allowLegacyAdoption?: boolean } = {}) {
  const ownershipEpochId = String(task?.claim?.ownershipEpochId || '').trim();
  if (!ownershipEpochId) {
    throw createApiError(409, 'TASK_CLAIM_OWNERSHIP_EPOCH_REQUIRED', `Task '${task.displayId || task.id}' claim has no authoritative ownership epoch.`, { affectedId: task.id });
  }
  const active = activeReconciledTaskExecutionsForWorkspace(task, workspace.workspaceId);
  const matching = active.filter((entry) => getExecutionSessionOwnershipEpoch(entry.id).ownershipEpochId === ownershipEpochId);
  if (matching.length === 1) return matching[0];
  if (options.allowLegacyAdoption && active.length === 1 && !getExecutionSessionOwnershipEpoch(active[0].id).ownershipEpochId) {
    bindExecutionSessionOwnershipEpoch(active[0].id, ownershipEpochId);
    return active[0];
  }
  terminalizeActiveTaskExecutions(task, workspace.workspaceId);
  return createExecutionSession({
    projectId: task.projectId,
    taskId: task.id,
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
    ownershipEpochId,
  });
}

function assertTaskWorkspaceBranchAuthority(task: any, workspace: any) {
  const expectedBranch = String(task?.branch || '').trim();
  if (!expectedBranch) return workspace;
  const actualBranch = String(workspace?.baseBranch || '').trim();
  if (actualBranch !== expectedBranch) {
    throw createApiError(409, 'TASK_WORKSPACE_BRANCH_AUTHORITY_MISMATCH', `Task '${task.displayId || task.id}' targets '${expectedBranch}', but its managed workspace is frozen to '${actualBranch || '<unknown>'}'.`, {
      affectedId: task.id,
      details: {
        taskBranch: expectedBranch,
        workspaceBaseBranch: actualBranch || null,
        workspaceId: workspace?.workspaceId || null,
        nextAction: 'Preserve the legacy workspace for recovery; do not silently integrate it into another branch.',
      },
    });
  }
  return workspace;
}

function resolveRecoverableTaskWorkspace(task: any) {
  const preferredWorkspaceId = String(task?.claim?.workspaceId || '').trim();
  if (preferredWorkspaceId) {
    const preferred = resolveSessionWorkspaceForRecovery(preferredWorkspaceId);
    if (preferred?.projectId === task.projectId && isSessionWorkspaceCompatibleWithTask(preferred, task.displayId)) return assertTaskWorkspaceBranchAuthority(task, preferred);
  }

  const discovered = findSessionWorkspaceRecoveryCandidatesForTask(task.projectId, task.displayId, 100);
  if (discovered.truncated) {
    throw createApiError(409, 'TASK_WORKSPACE_DISCOVERY_TRUNCATED', `Task '${task.displayId || task.id}' workspace recovery cannot prove uniqueness within the bounded registry view.`, {
      affectedId: task.id,
      details: { total: discovered.total, visible: discovered.workspaces.length },
    });
  }
  if (discovered.exactMatches.length > 1) {
    throw createApiError(409, 'TASK_WORKSPACE_AMBIGUOUS', `Task '${task.displayId || task.id}' has multiple exact recoverable managed workspaces. Recover or clean them before claiming the task again.`, {
      affectedId: task.id,
      details: { workspaceIds: discovered.exactMatches.map((workspace) => workspace.workspaceId) },
    });
  }
  if (discovered.exactMatches.length === 1) {
    const recovered = resolveSessionWorkspaceForRecovery(discovered.exactMatches[0].workspaceId);
    return recovered ? assertTaskWorkspaceBranchAuthority(task, recovered) : null;
  }
  if (discovered.legacyMatches.length > 0) {
    throw createApiError(409, 'TASK_WORKSPACE_LEGACY_IDENTITY_AMBIGUOUS', `Task '${task.displayId || task.id}' has only legacy-compatible workspace identity; automatic reclaim is blocked.`, {
      affectedId: task.id,
      details: { workspaceIds: discovered.legacyMatches.map((workspace) => workspace.workspaceId) },
    });
  }
  return null;
}

function promoteImmediateParentToInProgress(task: any, nowMs = Date.now()) {
  const parentId = String(task?.parentId || '').trim();
  if (!parentId) return null;
  const parent = getTaskByIdentifier(parentId, 'full');
  if (!parent || parent.projectId !== task.projectId || parent.status === 'in-progress') return parent || null;

  const timestamp = new Date(nowMs).toISOString();
  const updated = {
    ...parent,
    status: 'in-progress' as TaskStatus,
    updatedAt: timestamp,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []), {
      id: `log-task-parent-active-${nowMs}-${task.id}`,
      timestamp,
      message: `Parent moved to in-progress because active child ${task.displayId || task.id} is claimed.`,
      type: 'update',
    }],
  };
  saveTask(updated);
  return updated;
}

function reconcileClaimPresentationFromAuthority(task: any, nowMs: number) {
  const snapshot = computeLifecycleAuthoritySnapshot(task.id, { workspaceId: task.claim?.workspaceId, now: new Date(nowMs) });
  if (snapshot.hardBlockers.length > 0) {
    throw createApiError(409, 'TASK_LIFECYCLE_AUTHORITY_CONFLICT', `Task '${task.displayId || task.id}' has ambiguous lifecycle authority and cannot reconcile presentation state.`, {
      affectedId: task.id,
      details: { classification: snapshot.classification, blockers: snapshot.hardBlockers },
    });
  }
  if (snapshot.presentation.expectedStatus !== 'in-progress' || task.status === 'in-progress') return task;
  const timestamp = new Date(nowMs).toISOString();
  const updated = {
    ...task,
    status: 'in-progress' as TaskStatus,
    updatedAt: timestamp,
    logs: [...(Array.isArray(task.logs) ? task.logs : []), {
      id: `log-task-authority-projection-${nowMs}`,
      timestamp,
      message: `Task presentation reconciled to in-progress from lifecycle authority (${snapshot.classification}).`,
      type: 'update',
    }],
  };
  saveTask(updated);
  return updated;
}

function claimTaskForSessionLocked(taskId: string, input: ClaimTaskInput, cleanSessionId: string, project: any) {
  const task = getTaskByIdentifier(taskId, 'full');
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
  const nowMs = Date.now();
  const hash = sessionIdHash(cleanSessionId);
  if (isActiveClaim(task.claim, nowMs)) {
    if (task.claim.sessionIdHash !== hash) {
      throw createApiError(409, 'TASK_ALREADY_CLAIMED', `Task '${task.displayId || task.id}' is already claimed by ${task.claim.ownerLabel}.`, {
        affectedId: task.id,
        details: { claim: task.claim },
      });
    }
    const workspace = resolveRecoverableTaskWorkspace(task)
      || createOrReuseSessionWorkspace(project, cleanSessionId, { taskDisplayId: task.displayId, targetBranch: task.branch });
    let liveTask = task;
    withDbTransaction(() => {
      if (!String(task.claim?.ownershipEpochId || '').trim()) {
        const repairedAt = new Date(nowMs).toISOString();
        liveTask = {
          ...task,
          claim: { ...task.claim, ownershipEpochId: newOwnershipEpochId() },
          updatedAt: repairedAt,
          logs: [...(Array.isArray(task.logs) ? task.logs : []), {
            id: `log-task-claim-epoch-repair-${nowMs}`,
            timestamp: repairedAt,
            message: `Legacy active claim ownership epoch initialized for ${task.claim.ownerLabel}.`,
            type: 'update',
          }],
        };
        saveTask(liveTask);
        ensureClaimExecutionSession(liveTask, workspace, { allowLegacyAdoption: true });
      } else {
        ensureClaimExecutionSession(task, workspace);
      }
    });
    liveTask = reconcileClaimPresentationFromAuthority(getTaskByIdentifier(task.id, 'full') || liveTask, nowMs);
    promoteImmediateParentToInProgress(liveTask, nowMs);
    const refreshed = getTaskByIdentifier(task.id, 'full') || liveTask;
    return { task: refreshed, claim: refreshed.claim, workspace: { workspaceId: workspace.workspaceId, branch: workspace.branch, state: workspace.state }, reused: true };
  }

  if (!CLAIMABLE_STATUSES.has(task.status)) {
    throw createApiError(409, 'TASK_NOT_CLAIMABLE', `Task '${task.displayId || task.id}' is in '${task.status}' and cannot be claimed without existing active lifecycle authority.`, { affectedId: task.id });
  }

  if (!input.allowScopeConflict) {
    const conflicts = findScopeConflicts(task, getTasksByProjectId(task.projectId), nowMs);
    if (conflicts.length > 0) {
      throw createApiError(409, 'TASK_SCOPE_CONFLICT', `Task '${task.displayId || task.id}' overlaps active claimed scope.`, {
        affectedId: task.id,
        details: { conflicts },
      });
    }
  }

  const workspace = resolveRecoverableTaskWorkspace(task)
    || createOrReuseSessionWorkspace(project, cleanSessionId, { taskDisplayId: task.displayId, targetBranch: task.branch });
  const ownerKind = normalizeOwnerKind(input.ownerKind);
  const claimedAt = new Date(nowMs).toISOString();
  const claim: TaskClaim = {
    sessionIdHash: hash,
    ownershipEpochId: newOwnershipEpochId(),
    workspaceId: workspace.workspaceId,
    ownerKind,
    ownerLabel: normalizeOwnerLabel(input.ownerLabel, ownerKind, hash),
    claimedAt,
    expiresAt: new Date(nowMs + boundedTtlMs(input.ttlMs)).toISOString(),
  };
  const updated = {
    ...task,
    status: 'in-progress' as TaskStatus,
    claim,
    updatedAt: claimedAt,
    logs: [...(Array.isArray(task.logs) ? task.logs : []), {
      id: `log-task-claim-${nowMs}`,
      timestamp: claimedAt,
      message: `Task claimed by ${claim.ownerLabel} in managed workspace ${claim.workspaceId}.`,
      type: 'update',
    }],
  };
  withDbTransaction(() => {
    terminalizeActiveTaskExecutions(updated, workspace.workspaceId);
    saveTask(updated);
    ensureClaimExecutionSession(updated, workspace);
  });
  promoteImmediateParentToInProgress(updated, nowMs);
  return { task: getTaskByIdentifier(task.id, 'full') || updated, claim, workspace: { workspaceId: workspace.workspaceId, branch: workspace.branch, state: workspace.state }, reused: false };
}

export function claimTaskForSession(taskId: string, input: ClaimTaskInput) {
  const cleanSessionId = String(input?.sessionId || '').trim();
  if (!cleanSessionId) throw createApiError(400, 'SESSION_ID_REQUIRED', 'sessionId is required to claim a task.');
  const initial = getTaskByIdentifier(taskId, 'full');
  if (!initial) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
  if (!initial.projectId) throw createApiError(400, 'TASK_PROJECT_REQUIRED', 'Task must belong to a project before it can be claimed.', { affectedId: initial.id });
  const project = getProject(initial.projectId);
  if (!project) throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${initial.projectId}' was not found.`, { affectedId: initial.projectId });
  return withSyncLock(`task-claim:${initial.projectId}`, () => claimTaskForSessionLocked(taskId, input, cleanSessionId, project));
}

export function claimNextTaskForSession(projectId: string, input: ClaimNextTaskInput) {
  const cleanProjectId = String(projectId || '').trim();
  const cleanSessionId = String(input?.sessionId || '').trim();
  if (!cleanProjectId) throw createApiError(400, 'PROJECT_ID_REQUIRED', 'projectId is required to claim the next task.');
  if (!cleanSessionId) throw createApiError(400, 'SESSION_ID_REQUIRED', 'sessionId is required to claim the next task.');
  const project = getProject(cleanProjectId);
  if (!project) throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${cleanProjectId}' was not found.`, { affectedId: cleanProjectId });
  const limit = boundedNextTaskLimit(input.limit);

  return withSyncLock(`task-claim:${cleanProjectId}`, () => {
    const nowMs = Date.now();
    const projectTasks = getTasksByProjectId(cleanProjectId);
    const parentIds = new Set(projectTasks.map((task) => String(task.parentId || '')).filter(Boolean));
    const bounded = projectTasks
      .filter((task) => (task.status === 'backlog' || task.status === 'todo') && !task.archivedAt)
      .sort(compareNextTaskOrder)
      .slice(0, limit);
    let deferred = 0;

    for (const task of bounded) {
      if (parentIds.has(String(task.id))) {
        deferred += 1;
        continue;
      }
      if (isActiveClaim(task.claim, nowMs)) continue;
      if (isExplicitFinalGate(task) || hasBlockingDependency(task, projectTasks)) {
        deferred += 1;
        continue;
      }
      if (normalizedTargetFiles(task).size === 0) {
        deferred += 1;
        continue;
      }
      if (findScopeConflicts(task, projectTasks, nowMs).length > 0) {
        deferred += 1;
        continue;
      }

      const claimed = claimTaskForSessionLocked(task.id, { ...input, allowScopeConflict: false }, cleanSessionId, project);
      return { status: 'claimed' as const, ...claimed, scanned: bounded.length, deferred, limit };
    }

    return {
      status: 'no-eligible' as const,
      code: 'NO_ELIGIBLE_TASK',
      projectId: cleanProjectId,
      scanned: bounded.length,
      deferred,
      limit,
    };
  });
}

export function expandTaskClaimScope(taskId: string, input: ExpandTaskClaimScopeInput) {
  const cleanSessionId = String(input?.sessionId || '').trim();
  if (!cleanSessionId) throw createApiError(400, 'SESSION_ID_REQUIRED', 'sessionId is required to expand task scope.');
  const requestedPaths = normalizeRequestedScopePaths(input?.paths);
  const initial = getTaskByIdentifier(taskId, 'full');
  if (!initial) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
  if (!initial.projectId) throw createApiError(400, 'TASK_PROJECT_REQUIRED', 'Task must belong to a project before its scope can be expanded.', { affectedId: initial.id });

  return withSyncLock(`task-claim:${initial.projectId}`, () => {
    const task = getTaskByIdentifier(taskId, 'full');
    if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
    const nowMs = Date.now();
    if (task.status !== 'in-progress' || !isActiveClaim(task.claim, nowMs)) {
      throw createApiError(409, 'TASK_CLAIM_NOT_ACTIVE', `Task '${task.displayId || task.id}' must have an active claim before its scope can expand.`, { affectedId: task.id });
    }
    const hash = sessionIdHash(cleanSessionId);
    if (task.claim.sessionIdHash !== hash) {
      throw createApiError(403, 'TASK_CLAIM_OWNER_MISMATCH', `Task '${task.displayId || task.id}' is claimed by another session.`, { affectedId: task.id });
    }

    const currentScope = effectiveClaimedScope(task, nowMs);
    const addedPaths = requestedPaths.filter((file) => !currentScope.has(file));
    if (addedPaths.length > 0) {
      const conflicts = findScopeConflictsForPaths(task.id, new Set(addedPaths), getTasksByProjectId(task.projectId), nowMs);
      if (conflicts.length > 0) {
        throw createApiError(409, 'TASK_SCOPE_CONFLICT', `Task '${task.displayId || task.id}' scope expansion overlaps active claimed scope.`, {
          affectedId: task.id,
          details: { conflicts },
        });
      }
    }

    if (addedPaths.length === 0) {
      return {
        task,
        claim: task.claim,
        addedPaths: [] as string[],
        effectiveScope: [...currentScope].sort(),
        reused: true,
      };
    }

    const reservedPaths = new Set(normalizedReservedPaths(task));
    for (const file of addedPaths) reservedPaths.add(file);
    const timestamp = new Date(nowMs).toISOString();
    const claim: TaskClaim = { ...task.claim, reservedPaths: [...reservedPaths].sort() };
    const updated = {
      ...task,
      claim,
      updatedAt: timestamp,
      logs: [...(Array.isArray(task.logs) ? task.logs : []), {
        id: `log-task-scope-expand-${nowMs}`,
        timestamp,
        message: `Task claimed scope expanded by ${claim.ownerLabel}: ${addedPaths.join(', ')}.`,
        type: 'update',
      }],
    };
    saveTask(updated);
    const effectiveScope = normalizedTargetFiles(updated);
    for (const file of claim.reservedPaths || []) effectiveScope.add(file);
    return {
      task: getTaskByIdentifier(task.id, 'full') || updated,
      claim,
      addedPaths,
      effectiveScope: [...effectiveScope].sort(),
      reused: false,
    };
  });
}

export function releaseTaskClaim(taskId: string, input: ReleaseTaskClaimInput) {
  const cleanSessionId = String(input?.sessionId || '').trim();
  if (!cleanSessionId && !input?.emergency) throw createApiError(400, 'SESSION_ID_REQUIRED', 'sessionId is required to release a task claim.');
  const initial = getTaskByIdentifier(taskId, 'full');
  if (!initial) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
  if (!initial.projectId) throw createApiError(400, 'TASK_PROJECT_REQUIRED', 'Task must belong to a project before its claim can be released.', { affectedId: initial.id });

  return withSyncLock(`task-claim:${initial.projectId}`, () => {
    const task = getTaskByIdentifier(taskId, 'full');
    if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
    if (!task.claim) return { task, released: false };
    const hash = cleanSessionId ? sessionIdHash(cleanSessionId) : '';
    if (!input.emergency && task.claim.sessionIdHash !== hash) {
      throw createApiError(403, 'TASK_CLAIM_OWNER_MISMATCH', `Task '${task.displayId || task.id}' is claimed by another session.`, { affectedId: task.id });
    }
    const nextStatus = (input.nextStatus || 'backlog') as TaskStatus;
    if (!RELEASE_STATUSES.has(nextStatus)) {
      throw createApiError(400, 'TASK_CLAIM_RELEASE_STATUS_INVALID', `Claim release status must be backlog or todo.`, { affectedId: task.id });
    }
    const now = new Date().toISOString();
    const ownerLabel = task.claim.ownerLabel;
    const updated = {
      ...task,
      status: nextStatus,
      claim: undefined,
      updatedAt: now,
      logs: [...(Array.isArray(task.logs) ? task.logs : []), {
        id: `log-task-claim-release-${Date.now()}`,
        timestamp: now,
        message: `Task claim released by ${ownerLabel}; returned to ${nextStatus}.`,
        type: 'update',
      }],
    };
    withDbTransaction(() => {
      terminalizeActiveTaskExecutions(task, task.claim.workspaceId, 'claim-released');
      saveTask(updated);
    });
    return { task: getTaskByIdentifier(task.id, 'full') || updated, released: true };
  });
}

export function taskHasActiveClaim(task: any, nowMs = Date.now()) {
  return isActiveClaim(task?.claim, nowMs);
}
