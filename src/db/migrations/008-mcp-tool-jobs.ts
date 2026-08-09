import type { Migration } from './runner.js';

export const mcpToolJobsMigration: Migration = {
  id: '008-mcp-tool-jobs',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tool_jobs (
        job_id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        wait_ms INTEGER,
        duration_ms INTEGER,
        failure_summary TEXT,
        args_json TEXT NOT NULL DEFAULT '{}',
        resource_key TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        cancel_requested_at TEXT,
        cancel_reason TEXT,
        recovery_classification TEXT,
        artifact_dir TEXT NOT NULL,
        stdout_bytes INTEGER NOT NULL DEFAULT 0,
        stderr_bytes INTEGER NOT NULL DEFAULT 0,
        result_bytes INTEGER NOT NULL DEFAULT 0,
        result_sha256 TEXT,
        patch_bytes INTEGER NOT NULL DEFAULT 0,
        patch_sha256 TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_tool_jobs_status_updated
        ON mcp_tool_jobs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_jobs_lease_expiry
        ON mcp_tool_jobs(status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_jobs_updated
        ON mcp_tool_jobs(updated_at DESC);
    `);
  },
};
