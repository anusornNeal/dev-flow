import db from '../../db/index.js';

type DatabaseLike = any;

const OBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export class UiPreviewStorageReachabilityError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'UiPreviewStorageReachabilityError';
    this.code = code;
    this.details = details;
  }
}

export interface UiPreviewStorageReachabilityResult {
  objectHashes: string[];
  counts: {
    source: number;
    screenshot: number;
    total: number;
  };
}

function assertPersistedObjectHash(value: unknown, context: Record<string, unknown>) {
  const objectHash = String(value ?? '');
  if (!OBJECT_HASH_PATTERN.test(objectHash)) {
    throw new UiPreviewStorageReachabilityError(
      'UI_PREVIEW_STORAGE_REACHABILITY_INVALID_HASH',
      'Persisted UI Preview storage metadata contains an invalid object hash.',
      { ...context, objectHash },
    );
  }
  return objectHash;
}

export function createUiPreviewStorageReachabilityRepository(database: DatabaseLike = db) {
  function collectSourceRoots() {
    const rows = database.prepare(`
      SELECT
        preview_id,
        revision,
        html_object_hash,
        css_object_hash,
        js_object_hash,
        spec_object_hash
      FROM ui_preview_revision_manifests
    `).all() as Array<Record<string, unknown>>;

    const roots = new Set<string>();
    for (const row of rows) {
      for (const [component, column] of [
        ['html', 'html_object_hash'],
        ['css', 'css_object_hash'],
        ['js', 'js_object_hash'],
        ['spec', 'spec_object_hash'],
      ] as const) {
        roots.add(assertPersistedObjectHash(row[column], {
          source: 'revision-manifest',
          previewId: row.preview_id,
          revision: row.revision,
          component,
        }));
      }
    }
    const workspaceRows = database.prepare(`
      SELECT preview_id, revision, workspace_object_hash
      FROM ui_preview_workspace_revision_manifests
    `).all() as Array<Record<string, unknown>>;
    for (const row of workspaceRows) {
      roots.add(assertPersistedObjectHash(row.workspace_object_hash, {
        source: 'workspace-revision-manifest',
        previewId: row.preview_id,
        revision: row.revision,
        component: 'workspace',
      }));
    }

    return roots;
  }

  function collectScreenshotRoots() {
    const rows = database.prepare(`
      SELECT DISTINCT
        evidence.evidence_id,
        mapping.artifact_id,
        mapping.object_hash
      FROM task_ui_evidence AS evidence
      INNER JOIN ui_preview_artifact_objects AS mapping
        ON mapping.artifact_id = evidence.screenshot_artifact_id
      WHERE evidence.screenshot_artifact_id IS NOT NULL
    `).all() as Array<Record<string, unknown>>;

    const roots = new Set<string>();
    for (const row of rows) {
      roots.add(assertPersistedObjectHash(row.object_hash, {
        source: 'task-ui-evidence',
        evidenceId: row.evidence_id,
        artifactId: row.artifact_id,
      }));
    }
    return roots;
  }

  function collectReachableObjectHashes(): UiPreviewStorageReachabilityResult {
    const sourceRoots = collectSourceRoots();
    const screenshotRoots = collectScreenshotRoots();
    const objectHashes = Array.from(new Set([...sourceRoots, ...screenshotRoots])).sort();

    return {
      objectHashes,
      counts: {
        source: sourceRoots.size,
        screenshot: screenshotRoots.size,
        total: objectHashes.length,
      },
    };
  }

  return {
    collectReachableObjectHashes,
  };
}
