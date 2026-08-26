import type { Migration } from './runner.js';

export const taskPrerequisitesMigration: Migration = {
  id: '021-task-prerequisites',
  up: (db) => {
    const columns = new Set((db.pragma('table_info(tasks)') as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has('prerequisiteTaskIds')) {
      db.prepare('ALTER TABLE tasks ADD COLUMN prerequisiteTaskIds TEXT').run();
    }
  },
};
