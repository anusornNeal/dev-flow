import crypto from 'node:crypto';
import { getProject } from '../repositories/projectRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import { getTaskByIdentifier, getTasksByProjectId, saveTask } from '../repositories/taskRepository.js';
import {
  createOrReuseSessionWorkspace,
  isSessionWorkspaceCompatibleWithTask,
  resolveSessionWorkspaceForRecovery,
} from './sessionWorkspaceService.js';
import { createApiError } from './api.js';
import { createExecutionSession } from './executionSessionService.js';
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
    if (candidate.id === taskId || candidate.status !== 'in-progress' || !isActiveClaim(candidate.claim, nowMs)) continue;
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

function ensureClaimExecutionSession(task: any, workspace: any) {
  const existing = listExecutionSessionsForTask(task.id)
    .find((entry) => entry.workspaceId === workspace.workspaceId && entry.status === 'active');
  if (existing) return existing;
  return createExecutionSession({
    projectId: task.projectId,
    taskId: task.id,
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
  });
}

function resolveRecoverableTaskWorkspace(task: any) {
  const preferredWorkspaceId = String(task?.claim?.workspaceId || '').trim();
  if (preferredWorkspaceId) {
    const preferred = resolveSessionWorkspaceForRecovery(preferredWorkspaceId);
    if (preferred?.projectId === task.projectId && isSessionWorkspaceCompatibleWithTask(preferred, task.displayId)) return preferred;
  }

  const candidateIds = Array.from(new Set(listExecutionSessionsForTask(task.id)
    .filter((entry) => entry.status === 'active')
    .map((entry) => String(entry.workspaceId || '').trim())
    .filter(Boolean)));
  const recovered = candidateIds
    .map((workspaceId) => resolveSessionWorkspaceForRecovery(workspaceId))
    .filter((workspace): workspace is NonNullable<typeof workspace> => Boolean(
      workspace
      && workspace.projectId === task.projectId
      && isSessionWorkspaceCompatibleWithTask(workspace, task.displayId),
    ));
  if (recovered.length > 1) {
    throw createApiError(409, 'TASK_WORKSPACE_AMBIGUOUS', `Task '${task.displayId || task.id}' has multiple recoverable managed workspaces. Recover or clean them before claiming the task again.`, {
      affectedId: task.id,
      details: { workspaceIds: recovered.map((workspace) => workspace.workspaceId) },
    });
  }
  return recovered[0] || null;
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
    const workspace = resolveRecoverableTaskWorkspace(task)
      || createOrReuseSessionWorkspace(project, cleanSessionId, { taskDisplayId: task.displayId });
    ensureClaimExecutionSession(task, workspace);
    promoteImmediateParentToInProgress(task, nowMs);
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

  const workspace = resolveRecoverableTaskWorkspace(task)
    || createOrReuseSessionWorkspace(project, cleanSessionId, { taskDisplayId: task.displayId });
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
  ensureClaimExecutionSession(updated, workspace);
  saveTask(updated);
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
