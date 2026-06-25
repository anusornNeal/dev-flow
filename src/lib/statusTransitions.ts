import { TaskStatus } from '../types';

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  'backlog': ['todo'],
  'todo': ['backlog', 'in-progress'],
  'in-progress': ['backlog', 'todo', 'ready-for-review'],
  'ready-for-review': ['backlog', 'in-progress', 'done'],
  'done': ['ready-for-review']
};

export function isValidTransition(fromStatus: TaskStatus, toStatus: TaskStatus): boolean {
  if (fromStatus === toStatus) return true;
  const allowed = VALID_TRANSITIONS[fromStatus];
  return allowed ? allowed.includes(toStatus) : false;
}

export function getTransitionPath(fromStatus: TaskStatus, toStatus: TaskStatus): TaskStatus[] | null {
  if (fromStatus === toStatus) return [fromStatus];

  const queue: TaskStatus[][] = [[fromStatus]];
  const visited = new Set<TaskStatus>([fromStatus]);

  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    const nextStatuses = VALID_TRANSITIONS[current] || [];

    for (const next of nextStatuses) {
      if (visited.has(next)) continue;
      const nextPath = [...path, next];
      if (next === toStatus) return nextPath;
      visited.add(next);
      queue.push(nextPath);
    }
  }

  return null;
}

export function getValidationErrorMessage(fromStatus: TaskStatus, toStatus: TaskStatus): string {
  const allowed = VALID_TRANSITIONS[fromStatus] || [];
  return `Invalid status transition from '${fromStatus}' to '${toStatus}'. Allowed next statuses: ${allowed.join(', ')}`;
}
