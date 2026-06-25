import type { AppState } from '../types.js';

export interface DomainAppState {
  countersCache: Record<string, number>;
}

export function isAppStateLike(value: unknown): value is AppState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.countersCache === 'object' &&
    v.countersCache !== null
  );
}
