-- Schema for DevFlow SQLite Persistence

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repoUrl TEXT,
  description TEXT,
  createdAt TEXT,
  localPath TEXT,
  taskIdPrefix TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  displayId TEXT,
  title TEXT NOT NULL,
  description TEXT,
  projectId TEXT,
  status TEXT,
  priority TEXT,
  branch TEXT,
  tags TEXT, -- JSON string
  targetFiles TEXT, -- JSON string
  checklist TEXT, -- JSON string
  effort TEXT,
  model TEXT,
  agent TEXT,
  parentId TEXT,
  reasoning TEXT,
  acceptanceCriteria TEXT,
  verification TEXT,
  repoContext TEXT,
  jiraKey TEXT,
  repo TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  logs TEXT, -- JSON string
  designImages TEXT -- JSON string
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  startedAt TEXT,
  endedAt TEXT,
  promptPath TEXT,
  contextRef TEXT,
  logPath TEXT,
  errorMessage TEXT,
  retryOfRunId TEXT,
  triggerSource TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task_status ON agent_runs(taskId, status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_status ON agent_runs(projectId, status);

CREATE TABLE IF NOT EXISTS counters (
  prefix TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT -- JSON string
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  isCustom INTEGER DEFAULT 0,
  content TEXT,
  kind TEXT DEFAULT 'master',
  isProtected INTEGER DEFAULT 0,
  sourceType TEXT,
  sourcePath TEXT,
  createdAt TEXT,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  appliedAt TEXT NOT NULL
);
