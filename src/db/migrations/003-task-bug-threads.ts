import type { Migration } from './runner.js';

export const taskBugThreadsMigration: Migration = {
  id: '003-task-bug-threads',
  up: (db) => {
    const tableInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
    const hasBugs = tableInfo.some((column) => column.name === 'bugs');
    if (!hasBugs) {
      db.prepare('ALTER TABLE tasks ADD COLUMN bugs TEXT').run();
    }
  },
};
