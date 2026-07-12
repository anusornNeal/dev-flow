export const VALID_STATUSES = ['backlog', 'todo', 'in-progress', 'ready-for-review', 'done'] as const;
export const VALID_PRIORITIES = ['low', 'medium', 'high'] as const;
export const VALID_BUG_STATUSES = ['open', 'fixing', 'fixed', 'verified', 'reopened', 'archived'] as const;
export const VALID_BUG_SOURCES = ['agent', 'review', 'user', 'auto-close-warning', 'manual'] as const;
export const VALID_BUG_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export type TaskStatus = (typeof VALID_STATUSES)[number];
export type TaskPriority = (typeof VALID_PRIORITIES)[number];
export type BugStatus = (typeof VALID_BUG_STATUSES)[number];
export type BugSource = (typeof VALID_BUG_SOURCES)[number];
export type BugSeverity = (typeof VALID_BUG_SEVERITIES)[number];

const STATUS_SET: ReadonlySet<string> = new Set<string>(VALID_STATUSES);
const PRIORITY_SET: ReadonlySet<string> = new Set<string>(VALID_PRIORITIES);

export function isValidStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

export function isValidPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && PRIORITY_SET.has(value);
}
