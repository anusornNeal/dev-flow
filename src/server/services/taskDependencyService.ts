import { createApiError } from './api.js';

const TERMINAL_PREREQUISITE_STATUSES = new Set(['done']);
const MAX_PREREQUISITES = 50;

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function taskIdentityMatches(task: any, ref: string) {
  const normalized = ref.toLowerCase();
  return String(task?.id || '').toLowerCase() === normalized
    || String(task?.displayId || '').toLowerCase() === normalized;
}

export function normalizePrerequisiteRefs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw createApiError(400, 'TASK_PREREQUISITES_INVALID', 'prerequisiteTaskIds must be an array of task ids/display ids or request-local task-set keys.');
  }
  if (value.length > MAX_PREREQUISITES) {
    throw createApiError(400, 'TASK_PREREQUISITES_LIMIT', `prerequisiteTaskIds supports at most ${MAX_PREREQUISITES} entries.`);
  }
  const refs = value.map((entry) => clean(entry));
  if (refs.some((entry) => !entry)) {
    throw createApiError(400, 'TASK_PREREQUISITES_INVALID', 'prerequisiteTaskIds must contain only non-empty strings.');
  }
  const normalized = refs.map((entry) => entry.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw createApiError(400, 'TASK_PREREQUISITES_DUPLICATE', 'Duplicate prerequisite references are not allowed.');
  }
  return refs;
}

export function resolveTaskPrerequisiteIds(
  task: any,
  allTasks: any[],
  options: { localKeyToTaskId?: Map<string, string> } = {},
) {
  const refs = normalizePrerequisiteRefs(task?.prerequisiteTaskIds);
  const localKeys = options.localKeyToTaskId || new Map<string, string>();
  const resolved: string[] = [];
  for (const ref of refs) {
    const localId = localKeys.get(ref) || localKeys.get(ref.toLowerCase());
    const dependency = localId
      ? allTasks.find((candidate) => candidate.id === localId)
      : allTasks.find((candidate) => taskIdentityMatches(candidate, ref));
    if (!dependency) {
      throw createApiError(400, 'TASK_PREREQUISITE_NOT_FOUND', `Prerequisite '${ref}' was not found.`, {
        affectedId: task?.id,
        details: { prerequisite: ref },
      });
    }
    if (dependency.projectId !== task.projectId) {
      throw createApiError(400, 'TASK_PREREQUISITE_CROSS_PROJECT', `Prerequisite '${ref}' belongs to another project.`, {
        affectedId: task?.id,
        details: { prerequisiteTaskId: dependency.id, prerequisiteProjectId: dependency.projectId, taskProjectId: task.projectId },
      });
    }
    if (dependency.id === task.id) {
      throw createApiError(400, 'TASK_PREREQUISITE_SELF', 'A task cannot depend on itself.', { affectedId: task.id });
    }
    if (resolved.includes(dependency.id)) {
      throw createApiError(400, 'TASK_PREREQUISITES_DUPLICATE', `Multiple prerequisite references resolve to '${dependency.displayId || dependency.id}'.`, {
        affectedId: task?.id,
        details: { prerequisiteTaskId: dependency.id },
      });
    }
    resolved.push(dependency.id);
  }
  return resolved;
}

export function assertTaskPrerequisiteGraph(tasks: any[]) {
  const byId = new Map(tasks.map((task) => [String(task.id), task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (task: any, trail: string[]) => {
    const id = String(task.id);
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = trail.indexOf(id);
      const cycle = [...trail.slice(Math.max(0, cycleStart)), id];
      throw createApiError(400, 'TASK_PREREQUISITE_CYCLE', 'Task prerequisites must form an acyclic graph.', {
        affectedId: id,
        details: { cycle },
      });
    }
    visiting.add(id);
    for (const dependencyId of Array.isArray(task.prerequisiteTaskIds) ? task.prerequisiteTaskIds : []) {
      const dependency = byId.get(String(dependencyId));
      if (!dependency) {
        throw createApiError(400, 'TASK_PREREQUISITE_NOT_FOUND', `Prerequisite task '${dependencyId}' was not found.`, { affectedId: id });
      }
      if (dependency.projectId !== task.projectId) {
        throw createApiError(400, 'TASK_PREREQUISITE_CROSS_PROJECT', 'Task prerequisites must stay inside one project.', {
          affectedId: id,
          details: { prerequisiteTaskId: dependency.id },
        });
      }
      visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of tasks) visit(task, []);
}

function legacyPrerequisiteRefs(task: any) {
  return (Array.isArray(task?.tags) ? task.tags : [])
    .map((tag: unknown) => clean(tag).toLowerCase())
    .filter((tag: string) => tag.startsWith('depends-on:') || tag.startsWith('blocked-by:'))
    .map((tag: string) => tag.slice(tag.indexOf(':') + 1).trim())
    .filter(Boolean);
}

export function getTaskPrerequisiteBlockers(task: any, projectTasks: any[]) {
  const blockers: Array<{ taskId?: string; displayId?: string; status?: string; reference?: string; reason: string }> = [];
  const canonicalIds = Array.isArray(task?.prerequisiteTaskIds) ? task.prerequisiteTaskIds.map(String) : [];
  for (const dependencyId of canonicalIds) {
    const dependency = projectTasks.find((candidate) => String(candidate.id) === dependencyId);
    if (!dependency) {
      blockers.push({ taskId: dependencyId, reason: 'missing-prerequisite' });
      continue;
    }
    if (!TERMINAL_PREREQUISITE_STATUSES.has(String(dependency.status || ''))) {
      blockers.push({ taskId: dependency.id, displayId: dependency.displayId, status: dependency.status, reason: 'prerequisite-not-complete' });
    }
  }

  // Preserve compatibility for older cards authored before canonical prerequisiteTaskIds existed.
  if (canonicalIds.length === 0) {
    for (const reference of legacyPrerequisiteRefs(task)) {
      const dependency = projectTasks.find((candidate) => taskIdentityMatches(candidate, reference));
      if (!dependency) blockers.push({ reference, reason: 'missing-legacy-prerequisite' });
      else if (!TERMINAL_PREREQUISITE_STATUSES.has(String(dependency.status || ''))) {
        blockers.push({ taskId: dependency.id, displayId: dependency.displayId, status: dependency.status, reference, reason: 'legacy-prerequisite-not-complete' });
      }
    }
  }
  return blockers;
}

export function assertTaskPrerequisitesSatisfied(task: any, projectTasks: any[], operation: 'claim' | 'finalization') {
  const blockers = getTaskPrerequisiteBlockers(task, projectTasks);
  if (blockers.length === 0) return;
  const code = operation === 'claim' ? 'TASK_PREREQUISITES_BLOCKING' : 'TASK_PREREQUISITE_DRIFT';
  const verb = operation === 'claim' ? 'claimed' : 'finalized/integrated';
  throw createApiError(409, code, `Task '${task.displayId || task.id}' cannot be ${verb} until all prerequisites are done.`, {
    affectedId: task.id,
    details: { blockers, preserveWorkspace: operation === 'finalization' },
  });
}
