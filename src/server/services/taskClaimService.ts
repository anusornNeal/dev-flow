import crypto from 'node:crypto';
import { getProject } from '../repositories/projectRepository.js';
import { getTaskByIdentifier, getTasksByProjectId, saveTask } from '../repositories/taskRepository.js';
import { createOrReuseSessionWorkspace } from './sessionWorkspaceService.js';
import { createApiError } from './api.js';
import { withSyncLock } from './lockAndIdempotencyService.js';
import type { TaskClaim, TaskStatus } from '../../types.js';

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

export type ReleaseTaskClaimInput = {
  sessionId: string;
  nextStatus?: TaskStatus;
  emergency?: boolean;
};

function sessionIdHash(sessionId: string) {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
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

function normalizedTargetFiles(task: any): Set<string> {
  return new Set<string>((Array.isArray(task?.targetFiles) ? task.targetFiles : [])
    .map((file: unknown) => String(file || '').trim().replace(/\\/g, '/').toLowerCase())
    .filter(Boolean));
}

function findScopeConflicts(task: any, projectTasks: any[], nowMs: number) {
  const targetFiles = normalizedTargetFiles(task);
  if (targetFiles.size === 0) return [];
  const conflicts: Array<{ taskId: string; displayId?: string; ownerLabel: string; files: string[] }> = [];
  for (const candidate of projectTasks) {
    if (candidate.id === task.id || candidate.status !== 'in-progress' || !isActiveClaim(candidate.claim, nowMs)) continue;
    const overlap = [...normalizedTargetFiles(candidate)].filter((file) => targetFiles.has(file));
    if (overlap.length === 0) continue;
    conflicts.push({
      taskId: candidate.id,
      displayId: candidate.displayId,
      ownerLabel: candidate.claim.ownerLabel,
      files: overlap,
    });
  }
  return conflicts;
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

function claimTaskForSessionLocked(taskId: string, input: ClaimTaskInput, cleanSessionId: string, project: any) {
  const task = getTaskByIdentifier(taskId, 'full');
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
  if (!CLAIMABLE_STATUSES.has(task.status)) {
    throw createApiError(409, 'TASK_NOT_CLAIMABLE', `Task '${task.displayId || task.id}' is in '${task.status}' and cannot be claimed.`, { affectedId: task.id });
  }

  const nowMs = Date.now();
  const hash = sessionIdHash(cleanSessionId);
  if (isActiveClaim(task.claim, nowMs)) {
    if (task.claim.sessionIdHash !== hash) {
      throw createApiError(409, 'TASK_ALREADY_CLAIMED', `Task '${task.displayId || task.id}' is already claimed by ${task.claim.ownerLabel}.`, {
        affectedId: task.id,
        details: { claim: task.claim },
      });
    }
    const workspace = createOrReuseSessionWorkspace(project, cleanSessionId);
    return { task, claim: task.claim, workspace: { workspaceId: workspace.workspaceId, branch: workspace.branch, state: workspace.state }, reused: true };
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

  const workspace = createOrReuseSessionWorkspace(project, cleanSessionId);
  const ownerKind = normalizeOwnerKind(input.ownerKind);
  const claimedAt = new Date(nowMs).toISOString();
  const claim: TaskClaim = {
    sessionIdHash: hash,
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
  saveTask(updated);
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
    saveTask(updated);
    return { task: getTaskByIdentifier(task.id, 'full') || updated, released: true };
  });
}

export function clearTaskClaimWhenLeavingInProgress(task: any) {
  if (task?.status !== 'in-progress' && task?.claim) task.claim = undefined;
  return task;
}

export function taskHasActiveClaim(task: any, nowMs = Date.now()) {
  return isActiveClaim(task?.claim, nowMs);
}
