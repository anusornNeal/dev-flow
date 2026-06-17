import type { SettingsCache } from './domain/appState.js';

type LogLevel = 'INFO' | 'ERROR' | 'TRIGGER';

/**
 * Domain-typed AppState.
 * Uses domain types (SettingsCache, TaskStatus, TaskPriority) from src/server/domain/ instead
 * of inline any[] to keep the contract explicit. Loose fields are still permitted via the
 * [key: string]: unknown escape hatch in narrow scopes (repositories continue to return any
 * shapes during the incremental migration).
 */
export interface AppState {
  tasksCache: any[];
  projectsCache: any[];
  countersCache: Record<string, number>;
  settingsCache: SettingsCache;
  skillsRegistry: any[];
}

export interface ApiRouteDeps {
  state: AppState;
  writeAgentLog: (level: LogLevel, message: string) => void;
}
