import type { Migration } from './runner.js';

const columns = [
  ['executionP50Ms', 'REAL NOT NULL DEFAULT 0'],
  ['executionP95Ms', 'REAL NOT NULL DEFAULT 0'],
  ['logicalOperationP50Ms', 'REAL NOT NULL DEFAULT 0'],
  ['logicalOperationP95Ms', 'REAL NOT NULL DEFAULT 0'],
  ['handoffCount', 'INTEGER NOT NULL DEFAULT 0'],
  ['pollCount', 'INTEGER NOT NULL DEFAULT 0'],
  ['inlineJsonCount', 'INTEGER NOT NULL DEFAULT 0'],
  ['requestStreamCount', 'INTEGER NOT NULL DEFAULT 0'],
  ['durableHandoffCount', 'INTEGER NOT NULL DEFAULT 0'],
] as const;

export const mcpLatencyTelemetryMigration: Migration = {
  id: '014-mcp-latency-telemetry',
  up: (db) => {
    const existing = new Set((db.pragma('table_info(performance_telemetry_snapshots)') as Array<{ name: string }>).map((column) => column.name));
    for (const [name, definition] of columns) {
      if (!existing.has(name)) db.exec(`ALTER TABLE performance_telemetry_snapshots ADD COLUMN ${name} ${definition}`);
    }
  },
};
