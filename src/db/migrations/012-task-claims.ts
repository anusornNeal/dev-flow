import type { Migration } from './runner.js';

export const taskClaimsMigration: Migration = {
  id: '012-task-claims',
  up: (db) => {
    const tableInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
    const columns = new Set(tableInfo.map((column) => column.name));
    if (!columns.has('claim')) {
      db.prepare('ALTER TABLE tasks ADD COLUMN claim TEXT').run();
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_project_status_claim
        ON tasks(projectId, status, claim);
    `);
  },
};
