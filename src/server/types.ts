export type LogLevel = 'INFO' | 'ERROR' | 'TRIGGER';

export interface AppState {
  tasksCache: any[];
  projectsCache: any[];
  countersCache: Record<string, number>;
  settingsCache: { autoWorking: boolean; ngrokUrl: string; envNotes: string };
  skillsRegistry: any[];
}

export interface ApiRouteDeps {
  state: AppState;
  seedTasks: any[];
  writeAgentLog: (level: LogLevel, message: string) => void;
  drainReadyToDoQueue: () => void;
}
