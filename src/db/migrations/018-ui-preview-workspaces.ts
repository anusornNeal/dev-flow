import type { Migration } from './runner.js';

export const uiPreviewWorkspacesMigration: Migration = {
  id: '018-ui-preview-workspaces',
  up: (db) => {
    const evidenceColumns = db.prepare('PRAGMA table_info(task_ui_evidence)').all() as Array<{ name: string }>;
    if (!evidenceColumns.some((column) => column.name === 'primary_screen_id')) {
      db.exec('ALTER TABLE task_ui_evidence ADD COLUMN primary_screen_id TEXT;');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS ui_preview_workspace_revision_manifests (
        preview_id TEXT NOT NULL CHECK(length(preview_id) > 0),
        revision INTEGER NOT NULL CHECK(revision >= 1 AND typeof(revision) = 'integer'),
        workspace_object_hash TEXT NOT NULL
          CHECK(length(workspace_object_hash) = 64 AND workspace_object_hash NOT GLOB '*[^0-9a-f]*'),
        created_at TEXT NOT NULL CHECK(length(created_at) > 0),
        PRIMARY KEY(preview_id, revision),
        FOREIGN KEY(preview_id, revision)
          REFERENCES ui_preview_revisions(preview_id, revision) ON DELETE CASCADE,
        FOREIGN KEY(workspace_object_hash)
          REFERENCES ui_preview_objects(object_hash) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_ui_preview_workspace_manifests_object
        ON ui_preview_workspace_revision_manifests(workspace_object_hash);
    `);
  },
};
