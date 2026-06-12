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

export function getValidationErrorMessage(fromStatus: TaskStatus, toStatus: TaskStatus): string {
  const allowed = VALID_TRANSITIONS[fromStatus] || [];
  return `Invalid status transition from '${fromStatus}' to '${toStatus}'. Allowed next statuses: ${allowed.join(', ')}`;
}
