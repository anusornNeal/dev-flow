import type { Migration } from './runner.js';

export const taskDisplayIdIndexMigration: Migration = {
  id: '007-task-display-id-index',
  up: (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_display_id
        ON tasks(displayId);
    `);
  },
};
