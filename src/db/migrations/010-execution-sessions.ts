import type { Migration } from './runner.js';

export const executionSessionsMigration: Migration = {
  id: '010-execution-sessions',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_sessions (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        taskId TEXT,
        workspaceId TEXT,
        branch TEXT,
        baseRevision TEXT,
        repoRevision TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
        contextHandle TEXT,
        changedFilesJson TEXT NOT NULL DEFAULT '[]',
        verificationJson TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        expiresAt TEXT,
        endedAt TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_execution_sessions_project_status
        ON execution_sessions(projectId, status, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_execution_sessions_task
        ON execution_sessions(taskId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_execution_sessions_workspace
        ON execution_sessions(workspaceId, status, updatedAt DESC);

      CREATE TABLE IF NOT EXISTS execution_session_evidence (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        repoRevision TEXT,
        fileRevision TEXT,
        revisionIdentity TEXT,
        contextHandle TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        metadataJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES execution_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_execution_session_evidence_session
        ON execution_session_evidence(sessionId, stale, updatedAt DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_session_evidence_logical
        ON execution_session_evidence(sessionId, kind, path, contextHandle);
    `);
  },
};
