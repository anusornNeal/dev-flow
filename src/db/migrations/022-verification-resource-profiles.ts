import type { Migration } from './runner.js';

export const verificationResourceProfilesMigration: Migration = {
  id: '022-verification-resource-profiles',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS verification_resource_profile_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_key TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        censored_lower_bound_ms INTEGER,
        cpu_ratio REAL,
        memory_bytes INTEGER,
        process_count INTEGER,
        system_cpu_ratio REAL,
        memory_pressure_ratio REAL,
        tree_accounting INTEGER,
        recorded_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_verification_resource_profile_samples_profile
        ON verification_resource_profile_samples(profile_key, recorded_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_verification_resource_profile_samples_retention
        ON verification_resource_profile_samples(recorded_at DESC, id DESC);
    `);
  },
};
