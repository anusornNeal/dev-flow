import type { Migration } from './runner.js';

export const persistenceHardeningMigration: Migration = {
  id: '002-persistence-hardening',
  up: (db) => {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_project_display_id_unique
        ON tasks(projectId, displayId)
        WHERE projectId IS NOT NULL AND displayId IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_tasks_project_status
        ON tasks(projectId, status);

      CREATE INDEX IF NOT EXISTS idx_tasks_parent
        ON tasks(parentId);

      CREATE INDEX IF NOT EXISTS idx_tasks_updated_at
        ON tasks(updatedAt);

      CREATE INDEX IF NOT EXISTS idx_agent_runs_task_created
        ON agent_runs(taskId, createdAt DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_runs_retry_of
        ON agent_runs(retryOfRunId);
    `);
  }
};
