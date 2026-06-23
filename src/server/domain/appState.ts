import type { AppState } from '../types.js';



export interface DomainAppState {
  tasksCache: unknown[];
  projectsCache: unknown[];
  countersCache: Record<string, number>;
  skillsRegistry: unknown[];
}

export function isAppStateLike(value: unknown): value is AppState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.tasksCache) &&
    Array.isArray(v.projectsCache) &&
    typeof v.countersCache === 'object' &&
    v.countersCache !== null &&
    Array.isArray(v.skillsRegistry)
  );
}
