import type { Migration } from './runner.js';

export const taskFinalizationOperationsMigration: Migration = {
  id: '019-task-finalization-operations',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_finalization_operations (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        taskId TEXT NOT NULL,
        workspaceId TEXT NOT NULL,
        executionSessionId TEXT,
        ownershipEpochId TEXT,
        sourceHead TEXT NOT NULL,
        baseRevision TEXT NOT NULL,
        baseBranch TEXT NOT NULL,
        candidateId TEXT,
        candidateRepoRevision TEXT,
        ownedFingerprint TEXT,
        phase TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'cleanup-pending', 'completed')),
        integrationJson TEXT,
        verificationJson TEXT NOT NULL DEFAULT '{}',
        gitEvidenceJson TEXT,
        cleanupJson TEXT,
        failureJson TEXT,
        retryCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_task_finalization_operations_task
        ON task_finalization_operations(taskId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_task_finalization_operations_workspace
        ON task_finalization_operations(workspaceId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_task_finalization_operations_status
        ON task_finalization_operations(projectId, status, updatedAt DESC);
    `);
  },
};
