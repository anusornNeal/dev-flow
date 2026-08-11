import { createHash } from 'node:crypto';
import db from '../../db/index.js';
import type { JsonValue, UiPreviewRecord, UiPreviewRevision, UiPreviewViewport, UiSpecV1 } from '../domain/uiPreview.js';
import {
  UiPreviewIdempotencyConflictError,
  UiPreviewNotFoundError,
  UiPreviewRevisionConflictError,
  UiPreviewTaskConflictError,
} from '../domain/uiPreview.js';

export const UI_PREVIEW_HASH_SCHEMA_VERSION = 1;

type DatabaseLike = any;

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

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function fingerprintCanonicalRequest(value: unknown) {
  return sha256(stableJsonStringify(value));
}

export function hashUiPreviewContent(input: {
  title: string | null;
  html: string;
  css: string;
  js: string;
  spec: UiSpecV1;
  viewport: UiPreviewViewport;
}) {
  const canonical = {
    hashSchemaVersion: UI_PREVIEW_HASH_SCHEMA_VERSION,
    title: input.title,
    html: input.html,
    css: input.css,
    js: input.js,
    spec: stableJsonValue(input.spec),
    viewport: {
      width: input.viewport.width,
      height: input.viewport.height,
      deviceScaleFactor: input.viewport.deviceScaleFactor,
    },
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

function parseRevision(row: any): UiPreviewRevision | null {
  if (!row) return null;
  return {
    previewId: row.preview_id,
    revision: Number(row.revision),
    title: row.title ?? null,
    html: row.html,
    css: row.css || '',
    js: row.js || '',
    spec: JSON.parse(row.spec_json),
    viewport: JSON.parse(row.viewport_json),
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

export interface CreatePreviewRevisionInput {
  id: string;
  taskId: string | null;
  title: string | null;
  html: string;
  css: string;
  js: string;
  spec: UiSpecV1;
  viewport: UiPreviewViewport;
  contentHash: string;
  createdAt?: string;
}

export interface AppendPreviewRevisionInput {
  previewId: string;
  expectedRevision?: number;
  title: string | null;
  html: string;
  css: string;
  js: string;
  spec: UiSpecV1;
  viewport: UiPreviewViewport;
  contentHash: string;
  createdAt?: string;
}

export function createUiPreviewRepository(database: DatabaseLike = db) {
  const transaction = <T>(work: () => T): T => database.transaction(work)();

  function getPreview(previewId: string) {
    return parsePreview(database.prepare('SELECT * FROM ui_previews WHERE id = ?').get(previewId));
  }

  function requirePreview(previewId: string) {
    const preview = getPreview(previewId);
    if (!preview) throw new UiPreviewNotFoundError(previewId);
    return preview;
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

  function createPreview(input: CreatePreviewRevisionInput) {
    return transaction(() => {
      const createdAt = input.createdAt || nowIso();
      database.prepare(`
        INSERT INTO ui_previews (id, task_id, latest_revision, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).run(input.id, input.taskId, createdAt, createdAt);
      database.prepare(`
        INSERT INTO ui_preview_revisions
          (preview_id, revision, title, html, css, js, spec_json, viewport_json, content_hash, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.title,
        input.html,
        input.css,
        input.js,
        JSON.stringify(input.spec),
        JSON.stringify(input.viewport),
        input.contentHash,
        createdAt,
      );
      return requirePreview(input.id);
    });
  }

  function appendRevision(input: AppendPreviewRevisionInput) {
    return transaction(() => {
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
      database.prepare(`
        INSERT INTO ui_preview_revisions
          (preview_id, revision, title, html, css, js, spec_json, viewport_json, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.previewId,
        nextRevision,
        input.title,
        input.html,
        input.css,
        input.js,
        JSON.stringify(input.spec),
        JSON.stringify(input.viewport),
        input.contentHash,
        createdAt,
      );
      database.prepare('UPDATE ui_previews SET latest_revision = ?, updated_at = ? WHERE id = ?')
        .run(nextRevision, createdAt, input.previewId);
      return { changed: true as const, preview: requirePreview(input.previewId), revision: getRevision(input.previewId, nextRevision)! };
    });
  }

  function bindPreviewToTask(previewId: string, taskId: string) {
    return transaction(() => {
      const preview = requirePreview(previewId);
      if (preview.taskId && preview.taskId !== taskId) {
        throw new UiPreviewTaskConflictError(previewId, preview.taskId, taskId);
      }
      if (!preview.taskId) {
        database.prepare('UPDATE ui_previews SET task_id = ?, updated_at = ? WHERE id = ?').run(taskId, nowIso(), previewId);
      }
      return requirePreview(previewId);
    });
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
    bindPreviewToTask,
    getPreview,
    getRevision,
    countRevisions,
    runIdempotent,
  };
}

export type UiPreviewRepository = ReturnType<typeof createUiPreviewRepository>;
