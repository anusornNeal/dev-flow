import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import db from '../../db/index.js';
import type {
  JsonValue,
  UiPreviewRecord,
  UiPreviewRevision,
  UiPreviewRevisionDesignProvenance,
  UiPreviewScope,
  UiPreviewScreen,
  UiPreviewViewport,
  UiPreviewWorkspaceRevision,
  UiSpecV1,
} from '../domain/uiPreview.js';
import {
  UiPreviewError,
  UiPreviewIdempotencyConflictError,
  UiPreviewNotFoundError,
  UiPreviewRevisionConflictError,
  UiPreviewTaskConflictError,
} from '../domain/uiPreview.js';
import { createUiPreviewObjectMetadataRepository } from './uiPreviewObjectMetadataRepository.js';
import { createUiPreviewSourceObjectStore, type UiPreviewSourceObjectStore } from '../services/uiPreviewSourceObjectStore.js';
import { publishServerEvent } from '../services/serverEventService.js';
import type { UiPreviewFontSnapshot } from '../services/uiPreviewDocumentService.js';

export const UI_PREVIEW_HASH_SCHEMA_VERSION = 1;

const LEGACY_SOURCE_SENTINEL = '';
const LEGACY_SPEC_SENTINEL = '{}';

type DatabaseLike = any;

export interface UiPreviewRepositoryOptions {
  database?: DatabaseLike;
  sourceStore?: UiPreviewSourceObjectStore;
}

function nowIso() {
  return new Date().toISOString();
}

function stableJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value as JsonValue;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON only supports finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return Array.from(value, stableJsonValue);
  if (!value || typeof value !== 'object') throw new TypeError('Canonical JSON only supports JSON values.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Canonical JSON only supports plain JSON objects.');
  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b))) {
    output[key] = stableJsonValue((value as Record<string, unknown>)[key]);
  }
  return output;
}

export function stableJsonStringify(value: unknown) {
  return JSON.stringify(stableJsonValue(value));
}

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprintCanonicalRequest(value: unknown) {
  return sha256(stableJsonStringify(value));
}

export function hashUiPreviewContent(input: {
  title: string | null;
  html?: string;
  css?: string;
  js?: string;
  spec?: UiSpecV1;
  screens?: UiPreviewScreen[];
  defaultScreenId?: string;
  viewport: UiPreviewViewport;
  designProvenance?: UiPreviewRevisionDesignProvenance;
  fontSnapshot?: UiPreviewFontSnapshot;
}) {
  const viewport = {
    width: input.viewport.width,
    height: input.viewport.height,
    deviceScaleFactor: input.viewport.deviceScaleFactor,
  };
  if (input.screens?.length) {
    const defaultScreenId = input.defaultScreenId ?? input.screens[0].screenId;
    return sha256(stableJsonStringify({
      hashSchemaVersion: 2,
      title: input.title,
      screens: input.screens.map((screen) => ({
        screenId: screen.screenId,
        name: screen.name,
        html: screen.html,
        css: screen.css,
        js: screen.js,
        spec: stableJsonValue(screen.spec),
      })),
      defaultScreenId,
      viewport,
    }));
  }
  if (input.html === undefined || input.css === undefined || input.js === undefined || input.spec === undefined) {
    throw new TypeError('Legacy UI preview hashing requires html, css, js and spec.');
  }
  const canonical = {
    hashSchemaVersion: UI_PREVIEW_HASH_SCHEMA_VERSION,
    title: input.title,
    html: input.html,
    css: input.css,
    js: input.js,
    spec: stableJsonValue(input.spec),
    viewport,
  };
  return sha256(JSON.stringify(canonical));
}

function parsePreview(row: any): UiPreviewRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id ?? null,
    latestRevision: Number(row.latest_revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type UiPreviewWorkspaceRevisionWithProvenance = UiPreviewWorkspaceRevision & {
  scope?: UiPreviewScope;
  designProvenance?: UiPreviewRevisionDesignProvenance;
  fontSnapshot?: UiPreviewFontSnapshot;
};

type UiPreviewRepositoryRevision = UiPreviewWorkspaceRevisionWithProvenance & Pick<UiPreviewRevision, 'html' | 'css' | 'js' | 'spec'>;

interface UiPreviewWorkspaceStorageObject {
  schemaVersion: 1;
  scope?: UiPreviewScope;
  designProvenance?: UiPreviewRevisionDesignProvenance;
  fontSnapshot?: UiPreviewFontSnapshot;
  title: string | null;
  screens: UiPreviewScreen[];
  defaultScreenId: string;
  viewport: UiPreviewViewport;
}

function defaultScreenName(title: string | null, spec: UiSpecV1) {
  return spec.summary.screen.trim() || title?.trim() || 'Main';
}

function projectDefaultScreen(input: UiPreviewWorkspaceRevisionWithProvenance): UiPreviewRepositoryRevision {
  const defaultScreen = input.screens.find((screen) => screen.screenId === input.defaultScreenId);
  if (!defaultScreen) {
    throw new UiPreviewError(
      'UI_PREVIEW_STORAGE_OBJECT_INVALID',
      `UI preview '${input.previewId}' revision ${input.revision} does not contain default screen '${input.defaultScreenId}'.`,
    );
  }
  return {
    ...input,
    html: defaultScreen.html,
    css: defaultScreen.css,
    js: defaultScreen.js,
    spec: defaultScreen.spec,
  };
}

function isUiPreviewScope(value: unknown): value is UiPreviewScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (scope.kind === 'unscoped') return true;
  if (scope.kind === 'project') return typeof scope.projectId === 'string' && Boolean(scope.projectId.trim());
  if (scope.kind === 'task') {
    return typeof scope.taskId === 'string' && Boolean(scope.taskId.trim())
      && typeof scope.projectId === 'string' && Boolean(scope.projectId.trim());
  }
  return false;
}

function parseWorkspaceStorageObject(value: string): UiPreviewWorkspaceStorageObject {
  let parsed: any;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UiPreviewError('UI_PREVIEW_STORAGE_OBJECT_INVALID', 'UI preview workspace source object is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== 1) {
    throw new UiPreviewError('UI_PREVIEW_STORAGE_OBJECT_INVALID', 'UI preview workspace source object has an invalid schema.');
  }  if (parsed.scope !== undefined && !isUiPreviewScope(parsed.scope)) {
    throw new UiPreviewError('UI_PREVIEW_STORAGE_OBJECT_INVALID', 'UI preview workspace source object has an invalid scope.');
  }
  if (!(parsed.title === null || typeof parsed.title === 'string') || !Array.isArray(parsed.screens) || parsed.screens.length === 0) {
    throw new UiPreviewError('UI_PREVIEW_STORAGE_OBJECT_INVALID', 'UI preview workspace source object is missing title or screens.');
  }
  const ids = new Set<string>();
  for (const screen of parsed.screens) {
    if (!screen || typeof screen !== 'object' || Array.isArray(screen)
      || typeof screen.screenId !== 'string' || !screen.screenId
      || typeof screen.name !== 'string' || !screen.name.trim()
      || typeof screen.html !== 'string' || typeof screen.css !== 'string' || typeof screen.js !== 'string'
      || !screen.spec || typeof screen.spec !== 'object' || Array.isArray(screen.spec)
      || screen.spec.schemaVersion !== 1
      || !screen.spec.summary || typeof screen.spec.summary !== 'object'
      || typeof screen.spec.summary.screen !== 'string' || !screen.spec.summary.screen.trim()
      || ids.has(screen.screenId)) {
      throw new UiPreviewError('UI_PREVIEW_STORAGE_OBJECT_INVALID', 'UI preview workspace source object contains an invalid screen.');
    }
    ids.add(screen.screenId);
  }
  if (typeof parsed.defaultScreenId !== 'string' || !ids.has(parsed.defaultScreenId)) {
    throw new UiPreviewError('UI_PREVIEW_STORAGE_OBJECT_INVALID', 'UI preview workspace source object has an invalid defaultScreenId.');
  }
  const viewport = parsed.viewport;
  if (!viewport || typeof viewport !== 'object' || Array.isArray(viewport)
    || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || !Number.isFinite(viewport.deviceScaleFactor)) {
    throw new UiPreviewError('UI_PREVIEW_STORAGE_OBJECT_INVALID', 'UI preview workspace source object has an invalid viewport.');
  }
  return parsed as UiPreviewWorkspaceStorageObject;
}

function parseLegacyRevision(row: any): UiPreviewRepositoryRevision | null {
  if (!row) return null;
  const title = row.title ?? null;
  const spec = JSON.parse(row.spec_json) as UiSpecV1;
  const screen: UiPreviewScreen = {
    screenId: 'main',
    name: defaultScreenName(title, spec),
    html: row.html,
    css: row.css || '',
    js: row.js || '',
    spec,
  };
  return projectDefaultScreen({
    previewId: row.preview_id,
    revision: Number(row.revision),
    title,
    screens: [screen],
    defaultScreenId: 'main',
    viewport: JSON.parse(row.viewport_json),
    contentHash: row.content_hash,
    createdAt: row.created_at,
  });
}

export interface CreatePreviewRevisionInput {
  id: string;
  taskId: string | null;
  scope?: UiPreviewScope;
  title: string | null;
  html: string;
  css: string;
  js: string;
  spec: UiSpecV1;
  screens?: UiPreviewScreen[];
  defaultScreenId?: string;
  viewport: UiPreviewViewport;
  contentHash: string;
  createdAt?: string;
  designProvenance?: UiPreviewRevisionDesignProvenance;
  fontSnapshot?: UiPreviewFontSnapshot;
}

export interface AppendPreviewRevisionInput {
  previewId: string;
  expectedRevision?: number;
  scope?: UiPreviewScope;
  title: string | null;
  html: string;
  css: string;
  js: string;
  spec: UiSpecV1;
  screens?: UiPreviewScreen[];
  defaultScreenId?: string;
  viewport: UiPreviewViewport;
  contentHash: string;
  createdAt?: string;
  designProvenance?: UiPreviewRevisionDesignProvenance;
  fontSnapshot?: UiPreviewFontSnapshot;
}

export type UiPreviewListFilter = 'all' | 'standalone' | 'linked';

export interface ListUiPreviewsInput {
  filter?: UiPreviewListFilter;
  cursor?: string | null;
  limit?: number;
}

const UI_PREVIEW_LIST_DEFAULT_LIMIT = 20;
const UI_PREVIEW_LIST_MAX_LIMIT = 50;

function clampListLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return UI_PREVIEW_LIST_DEFAULT_LIMIT;
  return Math.max(1, Math.min(UI_PREVIEW_LIST_MAX_LIMIT, Math.trunc(parsed)));
}

function encodeListCursor(row: { updatedAt: string; previewId: string }) {
  return Buffer.from(JSON.stringify(row), 'utf8').toString('base64url');
}

function decodeListCursor(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.updatedAt !== 'string' || !parsed.updatedAt || typeof parsed.previewId !== 'string' || !parsed.previewId) throw new Error('invalid cursor');
    return { updatedAt: parsed.updatedAt, previewId: parsed.previewId };
  } catch {
    throw new UiPreviewError('UI_PREVIEW_CURSOR_INVALID', 'UI preview library cursor is invalid.');
  }
}

function resolveRepositoryOptions(databaseOrOptions: DatabaseLike | UiPreviewRepositoryOptions) {
  if (databaseOrOptions && typeof databaseOrOptions.prepare === 'function' && typeof databaseOrOptions.transaction === 'function') {
    return { database: databaseOrOptions as DatabaseLike } satisfies UiPreviewRepositoryOptions;
  }
  return (databaseOrOptions || {}) as UiPreviewRepositoryOptions;
}

export function createUiPreviewRepository(databaseOrOptions: DatabaseLike | UiPreviewRepositoryOptions = db) {
  const options = resolveRepositoryOptions(databaseOrOptions);
  const database = options.database ?? db;
  const sourceStore = options.sourceStore ?? createUiPreviewSourceObjectStore();
  const metadataRepository = createUiPreviewObjectMetadataRepository(database);
  const transaction = <T>(work: () => T): T => database.transaction(work)();

  function getPreview(previewId: string) {
    return parsePreview(database.prepare('SELECT * FROM ui_previews WHERE id = ?').get(previewId));
  }

  function requirePreview(previewId: string) {
    const preview = getPreview(previewId);
    if (!preview) throw new UiPreviewNotFoundError(previewId);
    return preview;
  }

  function readSourceObject(objectHash: string) {
    const metadata = metadataRepository.getObjectMetadata(objectHash);
    if (!metadata || metadata.kind !== 'source' || metadata.codec !== 'br') {
      throw new UiPreviewError('UI_PREVIEW_STORAGE_OBJECT_INVALID', `UI preview source object metadata '${objectHash}' is missing or invalid.`);
    }
    try {
      const absolutePath = sourceStore.resolveObjectPath(objectHash);
      const stored = fs.readFileSync(absolutePath);
      if (stored.byteLength !== metadata.storedBytes) {
        throw new Error(`stored byte count ${stored.byteLength} does not match metadata ${metadata.storedBytes}`);
      }
      const raw = Buffer.from(brotliDecompressSync(stored));
      if (raw.byteLength !== metadata.rawBytes || sha256(raw) !== objectHash) {
        throw new Error('raw bytes do not match immutable object metadata');
      }
      return raw.toString('utf8');
    } catch (error) {
      throw new UiPreviewError(
        'UI_PREVIEW_STORAGE_OBJECT_INVALID',
        `UI preview source object '${objectHash}' could not be reconstructed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function persistSourceObject(value: string) {
    const raw = Buffer.from(value, 'utf8');
    const objectHash = sha256(raw);
    const absolutePath = sourceStore.resolveObjectPath(objectHash);
    if (!fs.existsSync(absolutePath)) {
      const stored = brotliCompressSync(raw);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      const tempPath = `${absolutePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tempPath, stored, { flag: 'wx' });
        try {
          fs.renameSync(tempPath, absolutePath);
        } catch (error) {
          if (!fs.existsSync(absolutePath)) throw error;
        }
      } finally {
        fs.rmSync(tempPath, { force: true });
      }
    }

    const stored = fs.readFileSync(absolutePath);
    const verifiedRaw = Buffer.from(brotliDecompressSync(stored));
    if (sha256(verifiedRaw) !== objectHash || !verifiedRaw.equals(raw)) {
      throw new UiPreviewError('UI_PREVIEW_STORAGE_OBJECT_INVALID', `Existing UI preview source object '${objectHash}' failed integrity verification.`);
    }
    metadataRepository.insertOrVerifyObjectMetadata({
      objectHash,
      kind: 'source',
      codec: 'br',
      rawBytes: raw.byteLength,
      storedBytes: stored.byteLength,
    });
    return objectHash;
  }

  function persistRevisionObjects(input: Pick<CreatePreviewRevisionInput, 'html' | 'css' | 'js' | 'spec'>) {
    return {
      htmlObjectHash: persistSourceObject(input.html),
      cssObjectHash: persistSourceObject(input.css),
      jsObjectHash: persistSourceObject(input.js),
      specObjectHash: persistSourceObject(stableJsonStringify(input.spec)),
    };
  }

  function persistWorkspaceObject(input: Pick<CreatePreviewRevisionInput, 'title' | 'screens' | 'defaultScreenId' | 'viewport' | 'scope' | 'designProvenance' | 'fontSnapshot'>) {
    if (!input.screens?.length) return null;
    const defaultScreenId = input.defaultScreenId ?? input.screens[0].screenId;
    if (!input.screens.some((screen) => screen.screenId === defaultScreenId)) {
      throw new UiPreviewError('UI_PREVIEW_STORAGE_OBJECT_INVALID', `UI preview workspace default screen '${defaultScreenId}' does not exist.`);
    }
    const workspace: UiPreviewWorkspaceStorageObject = {
      schemaVersion: 1,
      ...(input.scope ? { scope: input.scope } : {}),
      title: input.title,
      screens: input.screens,
      defaultScreenId,
      viewport: input.viewport,
      ...(input.designProvenance ? { designProvenance: input.designProvenance } : {}),
      ...(input.fontSnapshot ? { fontSnapshot: input.fontSnapshot } : {}),
    };
    return {
      workspace,
      workspaceObjectHash: persistSourceObject(stableJsonStringify(workspace)),
    };
  }

  function parseRevision(row: any): UiPreviewRepositoryRevision | null {
    if (!row) return null;
    const workspaceManifest = database.prepare(`
      SELECT workspace_object_hash
      FROM ui_preview_workspace_revision_manifests
      WHERE preview_id = ? AND revision = ?
    `).get(String(row.preview_id), Number(row.revision)) as { workspace_object_hash: string } | undefined;
    if (workspaceManifest) {
      const workspace = parseWorkspaceStorageObject(readSourceObject(workspaceManifest.workspace_object_hash));
      const rowViewport = JSON.parse(row.viewport_json) as UiPreviewViewport;
      if ((row.title ?? null) !== workspace.title || stableJsonStringify(rowViewport) !== stableJsonStringify(workspace.viewport)) {
        throw new UiPreviewError(
          'UI_PREVIEW_STORAGE_OBJECT_INVALID',
          `UI preview '${row.preview_id}' revision ${row.revision} workspace metadata does not match its revision row.`,
        );
      }
      return projectDefaultScreen({
        previewId: row.preview_id,
        revision: Number(row.revision),
        title: workspace.title,
        screens: workspace.screens,
        defaultScreenId: workspace.defaultScreenId,
        viewport: workspace.viewport,
        contentHash: row.content_hash,
        createdAt: row.created_at,
        ...(workspace.scope ? { scope: workspace.scope } : {}),
        ...(workspace.designProvenance ? { designProvenance: workspace.designProvenance } : {}),
        ...(workspace.fontSnapshot ? { fontSnapshot: workspace.fontSnapshot } : {}),
      });
    }

    const manifest = metadataRepository.getRevisionManifest(String(row.preview_id), Number(row.revision));
    if (!manifest) return parseLegacyRevision(row);
    const title = row.title ?? null;
    const spec = JSON.parse(readSourceObject(manifest.specObjectHash)) as UiSpecV1;
    const screen: UiPreviewScreen = {
      screenId: 'main',
      name: defaultScreenName(title, spec),
      html: readSourceObject(manifest.htmlObjectHash),
      css: readSourceObject(manifest.cssObjectHash),
      js: readSourceObject(manifest.jsObjectHash),
      spec,
    };
    return projectDefaultScreen({
      previewId: row.preview_id,
      revision: Number(row.revision),
      title,
      screens: [screen],
      defaultScreenId: 'main',
      viewport: JSON.parse(row.viewport_json),
      contentHash: row.content_hash,
      createdAt: row.created_at,
    });
  }

  function getRevision(previewId: string, revision?: number) {
    const row = revision === undefined
      ? database.prepare(`
          SELECT r.* FROM ui_preview_revisions r
          JOIN ui_previews p ON p.id = r.preview_id AND p.latest_revision = r.revision
          WHERE r.preview_id = ?
        `).get(previewId)
      : database.prepare('SELECT * FROM ui_preview_revisions WHERE preview_id = ? AND revision = ?').get(previewId, revision);
    return parseRevision(row);
  }

  function insertManifestBackedRevision(input: {
    previewId: string;
    revision: number;
    title: string | null;
    viewport: UiPreviewViewport;
    contentHash: string;
    createdAt: string;
    objectHashes: ReturnType<typeof persistRevisionObjects>;
  }) {
    database.prepare(`
      INSERT INTO ui_preview_revisions
        (preview_id, revision, title, html, css, js, spec_json, viewport_json, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.previewId,
      input.revision,
      input.title,
      LEGACY_SOURCE_SENTINEL,
      LEGACY_SOURCE_SENTINEL,
      LEGACY_SOURCE_SENTINEL,
      LEGACY_SPEC_SENTINEL,
      JSON.stringify(input.viewport),
      input.contentHash,
      input.createdAt,
    );
    metadataRepository.insertOrVerifyRevisionManifest({
      previewId: input.previewId,
      revision: input.revision,
      ...input.objectHashes,
      createdAt: input.createdAt,
    });
  }

  function insertWorkspaceManifestBackedRevision(input: {
    previewId: string;
    revision: number;
    title: string | null;
    viewport: UiPreviewViewport;
    contentHash: string;
    createdAt: string;
    workspaceObjectHash: string;
  }) {
    database.prepare(`
      INSERT INTO ui_preview_revisions
        (preview_id, revision, title, html, css, js, spec_json, viewport_json, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.previewId,
      input.revision,
      input.title,
      LEGACY_SOURCE_SENTINEL,
      LEGACY_SOURCE_SENTINEL,
      LEGACY_SOURCE_SENTINEL,
      LEGACY_SPEC_SENTINEL,
      JSON.stringify(input.viewport),
      input.contentHash,
      input.createdAt,
    );
    database.prepare(`
      INSERT INTO ui_preview_workspace_revision_manifests
        (preview_id, revision, workspace_object_hash, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.previewId, input.revision, input.workspaceObjectHash, input.createdAt);
  }

  function createPreview(input: CreatePreviewRevisionInput) {
    const createdAt = input.createdAt || nowIso();
    const workspaceObject = persistWorkspaceObject(input);
    const objectHashes = workspaceObject ? null : persistRevisionObjects(input);
    const preview = transaction(() => {
      database.prepare(`
        INSERT INTO ui_previews (id, task_id, latest_revision, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).run(input.id, input.taskId, createdAt, createdAt);
      if (workspaceObject) {
        insertWorkspaceManifestBackedRevision({
          previewId: input.id,
          revision: 1,
          title: input.title,
          viewport: input.viewport,
          contentHash: input.contentHash,
          createdAt,
          workspaceObjectHash: workspaceObject.workspaceObjectHash,
        });
      } else {
        insertManifestBackedRevision({
          previewId: input.id,
          revision: 1,
          title: input.title,
          viewport: input.viewport,
          contentHash: input.contentHash,
          createdAt,
          objectHashes: objectHashes!,
        });
      }
      return requirePreview(input.id);
    });
    publishServerEvent('ui-preview.changed', { entityId: input.id, reason: 'created' });
    return preview;
  }

  function appendRevision(input: AppendPreviewRevisionInput) {
    const previewBefore = requirePreview(input.previewId);
    if (input.expectedRevision !== undefined && input.expectedRevision !== previewBefore.latestRevision) {
      throw new UiPreviewRevisionConflictError(input.previewId, input.expectedRevision, previewBefore.latestRevision);
    }
    const currentBefore = getRevision(input.previewId, previewBefore.latestRevision);
    if (!currentBefore) throw new UiPreviewNotFoundError(input.previewId);
    if (currentBefore.contentHash === input.contentHash) {
      return { changed: false as const, preview: previewBefore, revision: currentBefore };
    }

    const workspaceObject = persistWorkspaceObject(input);
    const objectHashes = workspaceObject ? null : persistRevisionObjects(input);
    const result = transaction(() => {
      const preview = requirePreview(input.previewId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== preview.latestRevision) {
        throw new UiPreviewRevisionConflictError(input.previewId, input.expectedRevision, preview.latestRevision);
      }
      const current = getRevision(input.previewId, preview.latestRevision);
      if (!current) throw new UiPreviewNotFoundError(input.previewId);
      if (current.contentHash === input.contentHash) {
        return { changed: false as const, preview, revision: current };
      }
      const nextRevision = preview.latestRevision + 1;
      const createdAt = input.createdAt || nowIso();
      if (workspaceObject) {
        insertWorkspaceManifestBackedRevision({
          previewId: input.previewId,
          revision: nextRevision,
          title: input.title,
          viewport: input.viewport,
          contentHash: input.contentHash,
          createdAt,
          workspaceObjectHash: workspaceObject.workspaceObjectHash,
        });
      } else {
        insertManifestBackedRevision({
          previewId: input.previewId,
          revision: nextRevision,
          title: input.title,
          viewport: input.viewport,
          contentHash: input.contentHash,
          createdAt,
          objectHashes: objectHashes!,
        });
      }
      database.prepare('UPDATE ui_previews SET latest_revision = ?, updated_at = ? WHERE id = ?')
        .run(nextRevision, createdAt, input.previewId);
      return { changed: true as const, preview: requirePreview(input.previewId), revision: getRevision(input.previewId, nextRevision)! };
    });
    if (result.changed) publishServerEvent('ui-preview.changed', { entityId: input.previewId, reason: 'updated' });
    return result;
  }

  function migrateLegacyRevisions() {
    const rows = database.prepare(`
      SELECT r.*
      FROM ui_preview_revisions r
      LEFT JOIN ui_preview_revision_manifests m
        ON m.preview_id = r.preview_id AND m.revision = r.revision
      LEFT JOIN ui_preview_workspace_revision_manifests w
        ON w.preview_id = r.preview_id AND w.revision = r.revision
      WHERE m.preview_id IS NULL AND w.preview_id IS NULL
      ORDER BY r.preview_id, r.revision
    `).all() as any[];
    let migrated = 0;

    for (const row of rows) {
      const legacy = parseLegacyRevision(row);
      if (!legacy) continue;
      const objectHashes = persistRevisionObjects(legacy);
      for (const objectHash of Object.values(objectHashes)) readSourceObject(objectHash);

      transaction(() => {
        if (metadataRepository.getRevisionManifest(legacy.previewId, legacy.revision)) return;
        metadataRepository.insertOrVerifyRevisionManifest({
          previewId: legacy.previewId,
          revision: legacy.revision,
          ...objectHashes,
          createdAt: legacy.createdAt,
        });
        const reconstructed = parseRevision(row);
        if (!reconstructed
          || reconstructed.html !== legacy.html
          || reconstructed.css !== legacy.css
          || reconstructed.js !== legacy.js
          || stableJsonStringify(reconstructed.spec) !== stableJsonStringify(legacy.spec)) {
          throw new UiPreviewError('UI_PREVIEW_STORAGE_MIGRATION_VERIFY_FAILED', `UI preview '${legacy.previewId}' revision ${legacy.revision} failed source reconstruction verification.`);
        }
        database.prepare(`
          UPDATE ui_preview_revisions
          SET html = ?, css = ?, js = ?, spec_json = ?
          WHERE preview_id = ? AND revision = ?
        `).run(
          LEGACY_SOURCE_SENTINEL,
          LEGACY_SOURCE_SENTINEL,
          LEGACY_SOURCE_SENTINEL,
          LEGACY_SPEC_SENTINEL,
          legacy.previewId,
          legacy.revision,
        );
        migrated += 1;
      });
    }
    return { scanned: rows.length, migrated };
  }

  function bindPreviewToTask(previewId: string, taskId: string, options: { publishEvent?: boolean } = {}) {
    const result = transaction(() => {
      const preview = requirePreview(previewId);
      if (preview.taskId && preview.taskId !== taskId) {
        throw new UiPreviewTaskConflictError(previewId, preview.taskId, taskId);
      }
      const changed = !preview.taskId;
      if (changed) {
        database.prepare('UPDATE ui_previews SET task_id = ?, updated_at = ? WHERE id = ?').run(taskId, nowIso(), previewId);
      }
      return { changed, preview: requirePreview(previewId) };
    });
    if (result.changed && options.publishEvent !== false) publishServerEvent('ui-preview.changed', { entityId: previewId, reason: 'bound' });
    return result.preview;
  }

  function deleteStandalonePreview(previewId: string) {
    const result = transaction(() => {
      const preview = requirePreview(previewId);
      if (preview.taskId) {
        throw new UiPreviewError(
          'UI_PREVIEW_DELETE_LINKED_CONFLICT',
          `UI preview '${previewId}' is linked to task '${preview.taskId}' and cannot be deleted from the Preview Library.`,
        );
      }
      const deletedRevisions = countRevisions(previewId);
      database.prepare('DELETE FROM ui_previews WHERE id = ?').run(previewId);
      return { previewId, deleted: true as const, deletedRevisions };
    });
    publishServerEvent('ui-preview.changed', { entityId: previewId, reason: 'deleted' });
    return result;
  }

  function listPreviews(input: ListUiPreviewsInput = {}) {
    const filter = input.filter ?? 'all';
    if (!['all', 'standalone', 'linked'].includes(filter)) {
      throw new UiPreviewError('UI_PREVIEW_FILTER_INVALID', `Unsupported UI preview filter '${String(filter)}'.`);
    }
    const limit = clampListLimit(input.limit);
    const cursor = decodeListCursor(input.cursor);
    const where: string[] = [];
    const params: any[] = [];
    if (filter === 'standalone') where.push('p.task_id IS NULL');
    if (filter === 'linked') where.push('p.task_id IS NOT NULL');
    if (cursor) {
      where.push('(p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))');
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.previewId);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = database.prepare(`
      SELECT
        p.id AS preview_id,
        p.task_id,
        p.latest_revision,
        p.created_at,
        p.updated_at,
        r.title,
        t.id AS linked_task_id,
        t.displayId AS linked_task_display_id,
        t.title AS linked_task_title,
        t.projectId AS linked_task_project_id
      FROM ui_previews p
      JOIN ui_preview_revisions r ON r.preview_id = p.id AND r.revision = p.latest_revision
      LEFT JOIN tasks t ON t.id = p.task_id
      ${whereSql}
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT ?
    `).all(...params, limit + 1) as any[];
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    const items = visible.map((row) => {
      const revision = getRevision(String(row.preview_id), Number(row.latest_revision));
      return {
        previewId: String(row.preview_id),
        taskId: row.task_id ?? null,
        title: row.title ?? null,
        specSummary: (revision?.spec.summary || {}) as UiSpecV1['summary'],
        latestRevision: Number(row.latest_revision),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        linkedTask: row.task_id && row.linked_task_id ? {
          id: String(row.linked_task_id),
          displayId: row.linked_task_display_id ?? null,
          title: String(row.linked_task_title || row.linked_task_id),
          projectId: row.linked_task_project_id ?? null,
        } : null,
      };
    });
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeListCursor({ updatedAt: last.updatedAt, previewId: last.previewId }) : null,
      limit,
      filter,
    };
  }

  function countRevisions(previewId: string) {
    return Number((database.prepare('SELECT COUNT(*) AS count FROM ui_preview_revisions WHERE preview_id = ?').get(previewId) as any)?.count || 0);
  }

  function runIdempotent<T>(operation: string, key: string | undefined, requestFingerprint: string, work: () => T) {
    if (!key) return { replayed: false, result: work() };
    if (!operation.trim() || !key.trim()) throw new TypeError('operation and idempotency key must be non-empty.');
    return transaction(() => {
      const existing = database.prepare(`
        SELECT request_fingerprint, result_json FROM ui_preview_idempotency
        WHERE operation = ? AND idempotency_key = ?
      `).get(operation, key) as any;
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) throw new UiPreviewIdempotencyConflictError(operation, key);
        return { replayed: true, result: JSON.parse(existing.result_json) as T };
      }
      const result = work();
      database.prepare(`
        INSERT INTO ui_preview_idempotency
          (operation, idempotency_key, request_fingerprint, result_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(operation, key, requestFingerprint, JSON.stringify(result), nowIso());
      return { replayed: false, result };
    });
  }

  return {
    createPreview,
    appendRevision,
    migrateLegacyRevisions,
    bindPreviewToTask,
    deleteStandalonePreview,
    getPreview,
    getRevision,
    listPreviews,
    countRevisions,
    runIdempotent,
  };
}

export type UiPreviewRepository = ReturnType<typeof createUiPreviewRepository>;
