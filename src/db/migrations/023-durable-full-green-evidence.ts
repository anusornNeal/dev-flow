import type { Migration } from './runner.js';

export const durableFullGreenEvidenceMigration: Migration = {
  id: '023-durable-full-green-evidence',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS durable_full_green_evidence (
        reuse_key TEXT PRIMARY KEY,
        repository_scope TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        source_job_id TEXT NOT NULL,
        result_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_durable_full_green_evidence_scope_used
        ON durable_full_green_evidence(repository_scope, last_used_at DESC);
      CREATE INDEX IF NOT EXISTS idx_durable_full_green_evidence_used
        ON durable_full_green_evidence(last_used_at DESC);
      CREATE INDEX IF NOT EXISTS idx_durable_full_green_evidence_source_job
        ON durable_full_green_evidence(source_job_id);
    `);
  },
};
