import { createHash } from 'node:crypto';
import db from '../../db/index.js';
import type { JsonValue, UiPreviewRecord, UiPreviewRevision, UiPreviewViewport, UiSpecV1 } from '../domain/uiPreview.js';
import {
  UiPreviewError,
  UiPreviewIdempotencyConflictError,
  UiPreviewNotFoundError,
  UiPreviewRevisionConflictError,
  UiPreviewTaskConflictError,
} from '../domain/uiPreview.js';
import { publishServerEvent } from '../services/serverEventService.js';

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
    const preview = transaction(() => {
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
    publishServerEvent('ui-preview.changed', { entityId: input.id, reason: 'created' });
    return preview;
  }

  function appendRevision(input: AppendPreviewRevisionInput) {
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
    if (result.changed) publishServerEvent('ui-preview.changed', { entityId: input.previewId, reason: 'updated' });
    return result;
  }

  function bindPreviewToTask(previewId: string, taskId: string) {
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
    if (result.changed) publishServerEvent('ui-preview.changed', { entityId: previewId, reason: 'bound' });
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
        r.spec_json,
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
    const items = visible.map((row) => ({
      previewId: String(row.preview_id),
      taskId: row.task_id ?? null,
      title: row.title ?? null,
      specSummary: (JSON.parse(row.spec_json || '{}') as any)?.summary || {},
      latestRevision: Number(row.latest_revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      linkedTask: row.task_id && row.linked_task_id ? {
        id: String(row.linked_task_id),
        displayId: row.linked_task_display_id ?? null,
        title: String(row.linked_task_title || row.linked_task_id),
        projectId: row.linked_task_project_id ?? null,
      } : null,
    }));
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
