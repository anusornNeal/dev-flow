import type { Migration } from './runner.js';

export const projectGitWorkflowPolicyMigration: Migration = {
  id: '013-project-git-workflow-policy',
  up: (db) => {
    const tableInfo = db.pragma('table_info(projects)') as Array<{ name: string }>;
    const columns = new Set(tableInfo.map((column) => column.name));
    if (!columns.has('gitWorkflowPolicy')) {
      db.prepare('ALTER TABLE projects ADD COLUMN gitWorkflowPolicy TEXT').run();
    }
  },
};
