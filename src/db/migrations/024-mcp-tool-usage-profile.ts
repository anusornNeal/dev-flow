import type { Migration } from './runner.js';

export const mcpToolUsageProfileMigration: Migration = {
  id: '024-mcp-tool-usage-profile',
  up: (db) => {
    const columns = db.pragma('table_info(performance_telemetry_snapshots)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'mcpProfile')) {
      db.exec(`
        ALTER TABLE performance_telemetry_snapshots
        ADD COLUMN mcpProfile TEXT NOT NULL DEFAULT 'unknown';
      `);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_performance_telemetry_profile_usage
        ON performance_telemetry_snapshots(mcpProfile, toolName, windowEnd DESC, id DESC);
    `);
  },
};
