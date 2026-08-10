import type { Migration } from './runner.js';

function hasColumn(db: any, table: string, column: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === column);
}

export const mcpToolJobLeaseFencingMigration: Migration = {
  id: '011-mcp-tool-job-lease-fencing',
  up: (db) => {
    if (!hasColumn(db, 'mcp_tool_jobs', 'lease_generation')) {
      db.exec('ALTER TABLE mcp_tool_jobs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;');
    }
    if (!hasColumn(db, 'mcp_tool_jobs', 'detached_at')) {
      db.exec('ALTER TABLE mcp_tool_jobs ADD COLUMN detached_at TEXT;');
    }
    if (!hasColumn(db, 'mcp_tool_jobs', 'fenced_write_count')) {
      db.exec('ALTER TABLE mcp_tool_jobs ADD COLUMN fenced_write_count INTEGER NOT NULL DEFAULT 0;');
    }
  },
};
