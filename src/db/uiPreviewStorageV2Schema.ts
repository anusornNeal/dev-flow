export const UI_PREVIEW_STORAGE_V2_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ui_preview_objects (
    object_hash TEXT PRIMARY KEY
      CHECK(length(object_hash) = 64 AND object_hash NOT GLOB '*[^0-9a-f]*'),
    kind TEXT NOT NULL CHECK(kind IN ('source', 'screenshot')),
    codec TEXT NOT NULL CHECK(codec IN ('br', 'identity')),
    raw_bytes INTEGER NOT NULL CHECK(raw_bytes >= 0 AND typeof(raw_bytes) = 'integer'),
    stored_bytes INTEGER NOT NULL CHECK(stored_bytes >= 0 AND typeof(stored_bytes) = 'integer'),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0)
  );

  CREATE TABLE IF NOT EXISTS ui_preview_revision_manifests (
    preview_id TEXT NOT NULL CHECK(length(preview_id) > 0),
    revision INTEGER NOT NULL CHECK(revision >= 1 AND typeof(revision) = 'integer'),
    html_object_hash TEXT NOT NULL
      CHECK(length(html_object_hash) = 64 AND html_object_hash NOT GLOB '*[^0-9a-f]*'),
    css_object_hash TEXT NOT NULL
      CHECK(length(css_object_hash) = 64 AND css_object_hash NOT GLOB '*[^0-9a-f]*'),
    js_object_hash TEXT NOT NULL
      CHECK(length(js_object_hash) = 64 AND js_object_hash NOT GLOB '*[^0-9a-f]*'),
    spec_object_hash TEXT NOT NULL
      CHECK(length(spec_object_hash) = 64 AND spec_object_hash NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    PRIMARY KEY(preview_id, revision),
    FOREIGN KEY(preview_id, revision)
      REFERENCES ui_preview_revisions(preview_id, revision) ON DELETE CASCADE,
    FOREIGN KEY(html_object_hash) REFERENCES ui_preview_objects(object_hash) ON DELETE RESTRICT,
    FOREIGN KEY(css_object_hash) REFERENCES ui_preview_objects(object_hash) ON DELETE RESTRICT,
    FOREIGN KEY(js_object_hash) REFERENCES ui_preview_objects(object_hash) ON DELETE RESTRICT,
    FOREIGN KEY(spec_object_hash) REFERENCES ui_preview_objects(object_hash) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS ui_preview_artifact_objects (
    artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) > 0),
    object_hash TEXT NOT NULL
      CHECK(length(object_hash) = 64 AND object_hash NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    FOREIGN KEY(object_hash) REFERENCES ui_preview_objects(object_hash) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_ui_preview_revision_manifests_html_object
    ON ui_preview_revision_manifests(html_object_hash);
  CREATE INDEX IF NOT EXISTS idx_ui_preview_revision_manifests_css_object
    ON ui_preview_revision_manifests(css_object_hash);
  CREATE INDEX IF NOT EXISTS idx_ui_preview_revision_manifests_js_object
    ON ui_preview_revision_manifests(js_object_hash);
  CREATE INDEX IF NOT EXISTS idx_ui_preview_revision_manifests_spec_object
    ON ui_preview_revision_manifests(spec_object_hash);
  CREATE INDEX IF NOT EXISTS idx_ui_preview_artifact_objects_object
    ON ui_preview_artifact_objects(object_hash);
`;
