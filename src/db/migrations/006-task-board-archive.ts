import type { Migration } from './runner.js';

export const taskBoardArchiveMigration: Migration = {
  id: '006-task-board-archive',
  up: (db) => {
    const tableInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
    const columns = new Set(tableInfo.map((column) => column.name));
    if (!columns.has('archivedAt')) {
      db.prepare('ALTER TABLE tasks ADD COLUMN archivedAt TEXT').run();
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_board_page
        ON tasks(projectId, status, archivedAt, parentId, createdAt DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_archive_age
        ON tasks(status, archivedAt, updatedAt);
    `);
  },
};
