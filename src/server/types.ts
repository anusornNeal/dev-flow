type LogLevel = 'INFO' | 'ERROR' | 'TRIGGER';

export interface AppState {
  tasksCache: any[];
  projectsCache: any[];
  countersCache: Record<string, number>;
  settingsCache: { 
    ngrokUrl: string; 
    githubToken: string; 
    jiraToken: string;
    jiraBaseUrl: string;
    jiraEmail: string;
    autoWork: boolean;
    agentExecutionMode?: string;
  };
  skillsRegistry: any[];
}

export interface ApiRouteDeps {
  state: AppState;
  writeAgentLog: (level: LogLevel, message: string) => void;

}
