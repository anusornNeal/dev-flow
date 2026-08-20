import type { Migration } from './runner.js';

export const lifecycleEmergencyOperationsMigration: Migration = {
  id: '020-lifecycle-emergency-operations',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_emergency_operations (
        id TEXT PRIMARY KEY,
        requestDigest TEXT NOT NULL,
        action TEXT NOT NULL,
        projectId TEXT NOT NULL,
        taskId TEXT NOT NULL,
        workspaceId TEXT,
        executionSessionId TEXT,
        ownershipEpochId TEXT,
        actorLabel TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'rejected', 'partial')),
        requestJson TEXT NOT NULL,
        beforeSnapshotJson TEXT,
        afterSnapshotJson TEXT,
        bypassedGatesJson TEXT NOT NULL DEFAULT '[]',
        hardChecksJson TEXT NOT NULL DEFAULT '[]',
        evidenceJson TEXT NOT NULL DEFAULT '{}',
        wipDisposition TEXT NOT NULL DEFAULT 'preserved',
        resultJson TEXT,
        failureJson TEXT,
        retryCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_lifecycle_emergency_operations_project
        ON lifecycle_emergency_operations(projectId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_emergency_operations_task
        ON lifecycle_emergency_operations(taskId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_emergency_operations_status
        ON lifecycle_emergency_operations(projectId, status, updatedAt DESC);
    `);
  },
};
