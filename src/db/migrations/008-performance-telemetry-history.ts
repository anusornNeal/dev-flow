import type { Migration } from './runner.js';

export const performanceTelemetryHistoryMigration: Migration = {
  id: '008-performance-telemetry-history',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS performance_telemetry_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        windowStart INTEGER NOT NULL,
        windowEnd INTEGER NOT NULL,
        toolName TEXT NOT NULL,
        projectScope TEXT NOT NULL DEFAULT '',
        contractRevision TEXT NOT NULL,
        appRevision TEXT NOT NULL,
        count INTEGER NOT NULL,
        errorCount INTEGER NOT NULL,
        p50DurationMs REAL NOT NULL,
        p95DurationMs REAL NOT NULL,
        inputBytes INTEGER NOT NULL,
        responseBytes INTEGER NOT NULL,
        truncatedCount INTEGER NOT NULL,
        truncationRate REAL NOT NULL,
        cacheHitCount INTEGER NOT NULL,
        processSpawns INTEGER NOT NULL,
        executionP50Ms REAL NOT NULL DEFAULT 0,
        executionP95Ms REAL NOT NULL DEFAULT 0,
        logicalOperationP50Ms REAL NOT NULL DEFAULT 0,
        logicalOperationP95Ms REAL NOT NULL DEFAULT 0,
        handoffCount INTEGER NOT NULL DEFAULT 0,
        pollCount INTEGER NOT NULL DEFAULT 0,
        inlineJsonCount INTEGER NOT NULL DEFAULT 0,
        requestStreamCount INTEGER NOT NULL DEFAULT 0,
        durableHandoffCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_performance_telemetry_window
        ON performance_telemetry_snapshots(windowEnd DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_performance_telemetry_baseline
        ON performance_telemetry_snapshots(toolName, projectScope, windowEnd DESC, id DESC);
    `);
  },
};
