import type { AppState } from '../types.js';

export interface SettingsCache {
  ngrokUrl: string;
  githubToken: string;
  jiraToken: string;
  jiraBaseUrl: string;
  jiraEmail: string;
  autoWork: boolean;
  agentExecutionMode?: string;
}

export interface DomainAppState {
  tasksCache: unknown[];
  projectsCache: unknown[];
  countersCache: Record<string, number>;
  skillsRegistry: unknown[];
  settingsCache: SettingsCache;
}

export function isAppStateLike(value: unknown): value is AppState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.tasksCache) &&
    Array.isArray(v.projectsCache) &&
    typeof v.countersCache === 'object' &&
    v.countersCache !== null &&
    Array.isArray(v.skillsRegistry) &&
    typeof v.settingsCache === 'object' &&
    v.settingsCache !== null
  );
}
