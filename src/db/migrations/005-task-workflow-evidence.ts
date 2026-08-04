import type { Migration } from './runner.js';

export const taskWorkflowEvidenceMigration: Migration = {
  id: '005-task-workflow-evidence',
  up: (db) => {
    const tableInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
    const columns = new Set(tableInfo.map((column) => column.name));
    if (!columns.has('gitEvidence')) {
      db.prepare('ALTER TABLE tasks ADD COLUMN gitEvidence TEXT').run();
    }
    if (!columns.has('verificationEvidence')) {
      db.prepare('ALTER TABLE tasks ADD COLUMN verificationEvidence TEXT').run();
    }
  },
};
