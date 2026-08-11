import type { Migration } from './runner.js';

export const uiPreviewsMigration: Migration = {
  id: '016-ui-previews',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ui_previews (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        latest_revision INTEGER NOT NULL CHECK(latest_revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS ui_preview_revisions (
        preview_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        title TEXT,
        html TEXT NOT NULL,
        css TEXT NOT NULL DEFAULT '',
        js TEXT NOT NULL DEFAULT '',
        spec_json TEXT NOT NULL,
        viewport_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(preview_id, revision),
        FOREIGN KEY(preview_id) REFERENCES ui_previews(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS ui_preview_idempotency (
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(operation, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS task_ui_evidence (
        evidence_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        preview_id TEXT NOT NULL,
        frozen_revision INTEGER NOT NULL CHECK(frozen_revision >= 1),
        frozen_spec_json TEXT NOT NULL,
        screenshot_artifact_id TEXT NOT NULL,
        screenshot_width INTEGER NOT NULL CHECK(screenshot_width > 0),
        screenshot_height INTEGER NOT NULL CHECK(screenshot_height > 0),
        screenshot_sha256 TEXT,
        is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1)),
        created_at TEXT NOT NULL,
        superseded_at TEXT,
        superseded_by_evidence_id TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(preview_id, frozen_revision) REFERENCES ui_preview_revisions(preview_id, revision) ON DELETE CASCADE,
        UNIQUE(task_id, preview_id, frozen_revision)
      );

      CREATE INDEX IF NOT EXISTS idx_ui_preview_revisions_preview_revision
        ON ui_preview_revisions(preview_id, revision DESC);
      CREATE INDEX IF NOT EXISTS idx_ui_preview_idempotency_created
        ON ui_preview_idempotency(created_at);
      CREATE INDEX IF NOT EXISTS idx_task_ui_evidence_task_created
        ON task_ui_evidence(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_ui_evidence_preview_revision
        ON task_ui_evidence(preview_id, frozen_revision DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_ui_evidence_current_pair
        ON task_ui_evidence(task_id, preview_id)
        WHERE is_current = 1;
    `);
  },
};
