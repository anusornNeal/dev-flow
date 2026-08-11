import { createHash, randomUUID } from 'node:crypto';
import db from '../../db/index.js';
import { getTaskByIdentifier } from '../repositories/taskRepository.js';
import {
  createTaskUiEvidenceRepository,
  type TaskUiEvidenceRepository,
} from '../repositories/taskUiEvidenceRepository.js';
import {
  createUiPreviewRepository,
  fingerprintCanonicalRequest,
  type UiPreviewRepository,
} from '../repositories/uiPreviewRepository.js';
import {
  UiPreviewError,
  UiPreviewIdempotencyConflictError,
  type TaskUiEvidence,
} from '../domain/uiPreview.js';
import {
  createUiPreviewScreenshotService,
  type UiPreviewCaptureInput,
  type UiPreviewCaptureResult,
} from './uiPreviewScreenshotService.js';
import { resolveUiPreviewUrl } from './uiPreviewUrlResolver.js';
import { publishServerEvent } from './serverEventService.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const ATTACH_OPERATION = 'attach';

type DatabaseLike = any;

type ScreenshotServiceLike = {
  capture(input: UiPreviewCaptureInput): Promise<UiPreviewCaptureResult>;
};

export interface TaskUiEvidenceServiceDependencies {
  database?: DatabaseLike;
  previewRepository?: UiPreviewRepository;
  evidenceRepository?: TaskUiEvidenceRepository;
  screenshotService?: ScreenshotServiceLike;
  runtimePort: () => number;
  createEvidenceId?: () => string;
  resolveTaskId?: (identifier: string) => string | null;
}

export interface AttachUiPreviewInput {
  taskId: string;
  previewId: string;
  revision?: number;
  idempotencyKey?: string;
}

export interface ListTaskUiEvidenceInput {
  taskId: string;
  cursor?: string | null;
  limit?: number;
}

type EvidenceRow = {
  evidence_id: string;
  task_id: string;
  preview_id: string;
  frozen_revision: number;
  frozen_spec_json: string;
  screenshot_artifact_id: string;
  screenshot_width: number;
  screenshot_height: number;
  screenshot_sha256: string | null;
  is_current: number;
  created_at: string;
  superseded_at: string | null;
  superseded_by_evidence_id: string | null;
  title: string | null;
  latest_revision: number;
};

type AttachIdentity = { evidenceId: string };

function clampLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(parsed)));
}

function encodeCursor(row: Pick<EvidenceRow, 'created_at' | 'evidence_id'>) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, evidenceId: row.evidence_id }), 'utf8').toString('base64url');
}

function decodeCursor(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.createdAt !== 'string' || !parsed.createdAt || typeof parsed.evidenceId !== 'string' || !parsed.evidenceId) {
      throw new Error('invalid cursor');
    }
    return { createdAt: parsed.createdAt, evidenceId: parsed.evidenceId };
  } catch {
    throw new UiPreviewError('UI_PREVIEW_CURSOR_INVALID', 'Task UI evidence cursor is invalid.');
  }
}

function resolveArtifactUrl(artifactId: string, port: number) {
  if (!/^uisa_[a-f0-9]{32}$/.test(artifactId)) {
    throw new UiPreviewError('UI_PREVIEW_ARTIFACT_INVALID', 'Task UI evidence references an invalid screenshot artifact id.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UiPreviewError('UI_PREVIEW_RUNTIME_UNAVAILABLE', 'A valid bound runtime port is required to resolve screenshot URLs.');
  }
  return `http://127.0.0.1:${port}/api/ui-preview-artifacts/${artifactId}`;
}

function screenshotSha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createTaskUiEvidenceService(deps: TaskUiEvidenceServiceDependencies) {
  const database = deps.database ?? db;
  const previewRepository = deps.previewRepository ?? createUiPreviewRepository(database);
  const evidenceRepository = deps.evidenceRepository ?? createTaskUiEvidenceRepository(database);
  const screenshotService = deps.screenshotService ?? createUiPreviewScreenshotService();
  const createEvidenceId = deps.createEvidenceId ?? (() => `uie_${randomUUID().replace(/-/g, '')}`);
  const resolveTaskId = deps.resolveTaskId ?? ((identifier: string) => getTaskByIdentifier(identifier, 'minimal')?.id || null);
  const inFlight = new Map<string, Promise<ReturnType<typeof shapeEvidenceRow>>>();

  function canonicalTaskId(identifier: string) {
    const normalized = String(identifier || '').trim();
    if (!normalized) throw new UiPreviewError('UI_PREVIEW_TASK_REQUIRED', 'taskId is required.');
    const taskId = resolveTaskId(normalized);
    if (!taskId) throw new UiPreviewError('UI_PREVIEW_TASK_NOT_FOUND', `Task '${normalized}' was not found.`);
    return taskId;
  }

  function selectEvidenceRow(evidenceId: string): EvidenceRow | null {
    return (database.prepare(`
      SELECT e.*, r.title, p.latest_revision
      FROM task_ui_evidence e
      JOIN ui_preview_revisions r ON r.preview_id = e.preview_id AND r.revision = e.frozen_revision
      JOIN ui_previews p ON p.id = e.preview_id
      WHERE e.evidence_id = ?
    `).get(evidenceId) as EvidenceRow | undefined) || null;
  }

  function shapeEvidenceRow(row: EvidenceRow, options: { replayed?: boolean } = {}) {
    const port = deps.runtimePort();
    const frozenRevision = Number(row.frozen_revision);
    const latestRevision = Number(row.latest_revision);
    return {
      evidenceId: row.evidence_id,
      taskId: row.task_id,
      previewId: row.preview_id,
      title: row.title ?? null,
      frozenRevision,
      latestRevision,
      frozenPreviewUrl: resolveUiPreviewUrl({ previewId: row.preview_id, revision: frozenRevision, port }),
      latestPreviewUrl: resolveUiPreviewUrl({ previewId: row.preview_id, port }),
      screenshotUrl: resolveArtifactUrl(row.screenshot_artifact_id, port),
      attachedAt: row.created_at,
      current: Number(row.is_current) === 1,
      spec: JSON.parse(row.frozen_spec_json),
      ...(options.replayed ? { replayed: true } : {}),
    };
  }

  function readIdempotency(key: string | undefined, requestFingerprint: string) {
    if (!key) return null;
    const normalizedKey = String(key).trim();
    if (!normalizedKey) throw new UiPreviewError('UI_PREVIEW_VALIDATION_FAILED', 'idempotencyKey must be non-empty when supplied.');
    const existing = database.prepare(`
      SELECT request_fingerprint, result_json FROM ui_preview_idempotency
      WHERE operation = ? AND idempotency_key = ?
    `).get(ATTACH_OPERATION, normalizedKey) as any;
    if (!existing) return null;
    if (existing.request_fingerprint !== requestFingerprint) {
      throw new UiPreviewIdempotencyConflictError(ATTACH_OPERATION, normalizedKey);
    }
    const identity = JSON.parse(existing.result_json) as AttachIdentity;
    const row = selectEvidenceRow(identity.evidenceId);
    if (!row) throw new UiPreviewError('UI_PREVIEW_EVIDENCE_NOT_FOUND', `Task UI evidence '${identity.evidenceId}' was not found.`);
    return shapeEvidenceRow(row, { replayed: true });
  }

  function persistIdempotency(key: string | undefined, requestFingerprint: string, result: { evidenceId: string }) {
    if (!key) return;
    const normalizedKey = String(key).trim();
    const transaction = database.transaction(() => {
      const existing = database.prepare(`
        SELECT request_fingerprint, result_json FROM ui_preview_idempotency
        WHERE operation = ? AND idempotency_key = ?
      `).get(ATTACH_OPERATION, normalizedKey) as any;
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) throw new UiPreviewIdempotencyConflictError(ATTACH_OPERATION, normalizedKey);
        return;
      }
      database.prepare(`
        INSERT INTO ui_preview_idempotency (operation, idempotency_key, request_fingerprint, result_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(ATTACH_OPERATION, normalizedKey, requestFingerprint, JSON.stringify({ evidenceId: result.evidenceId }), new Date().toISOString());
    });
    if (typeof transaction.immediate === 'function') transaction.immediate();
    else transaction();
  }

  function staleError(taskId: string, previewId: string, revision: number, current: TaskUiEvidence) {
    return new UiPreviewError(
      'UI_PREVIEW_EVIDENCE_REVISION_STALE',
      `UI preview '${previewId}' revision ${revision} cannot supersede current task evidence revision ${current.frozenRevision} for task '${taskId}'.`,
    );
  }

  async function attach(input: AttachUiPreviewInput) {
    const taskId = canonicalTaskId(input.taskId);
    const previewId = String(input.previewId || '').trim();
    if (!previewId) throw new UiPreviewError('UI_PREVIEW_VALIDATION_FAILED', 'previewId is required.');
    if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision < 1)) {
      throw new UiPreviewError('UI_PREVIEW_INVALID_REVISION', 'revision must be a positive integer.');
    }

    const requestFingerprint = fingerprintCanonicalRequest({
      taskId,
      previewId,
      revision: input.revision ?? null,
    });
    const replay = readIdempotency(input.idempotencyKey, requestFingerprint);
    if (replay) return replay;

    const preview = previewRepository.getPreview(previewId);
    if (!preview) throw new UiPreviewError('UI_PREVIEW_NOT_FOUND', `UI preview '${previewId}' was not found.`);
    const frozenRevision = input.revision ?? preview.latestRevision;
    const revision = previewRepository.getRevision(previewId, frozenRevision);
    if (!revision) throw new UiPreviewError('UI_PREVIEW_REVISION_NOT_FOUND', `UI preview '${previewId}' revision ${frozenRevision} was not found.`);
    if (preview.taskId && preview.taskId !== taskId) {
      previewRepository.bindPreviewToTask(previewId, taskId);
    }

    const current = evidenceRepository.getCurrentEvidence(taskId, previewId);
    if (current?.frozenRevision > frozenRevision) throw staleError(taskId, previewId, frozenRevision, current);
    if (current?.frozenRevision === frozenRevision) {
      const row = selectEvidenceRow(current.evidenceId);
      if (!row) throw new UiPreviewError('UI_PREVIEW_EVIDENCE_NOT_FOUND', `Task UI evidence '${current.evidenceId}' was not found.`);
      previewRepository.bindPreviewToTask(previewId, taskId);
      const result = shapeEvidenceRow(row);
      persistIdempotency(input.idempotencyKey, requestFingerprint, result);
      return result;
    }

    const flightKey = `${taskId}\u0000${previewId}\u0000${frozenRevision}`;
    let shared = inFlight.get(flightKey);
    if (!shared) {
      shared = (async () => {
        const capture = await screenshotService.capture({
          title: revision.title,
          html: revision.html,
          css: revision.css,
          js: revision.js,
          viewport: revision.viewport,
        });
        const evidenceId = createEvidenceId();
        const commit = database.transaction(() => {
          const beforeBinding = previewRepository.getPreview(previewId);
          const bindingChanged = !beforeBinding?.taskId;
          previewRepository.bindPreviewToTask(previewId, taskId, { publishEvent: false });
          const recorded = evidenceRepository.recordEvidence({
            evidenceId,
            taskId,
            previewId,
            frozenRevision,
            frozenSpec: revision.spec,
            screenshotArtifactId: capture.artifactId,
            screenshotWidth: capture.viewport.width,
            screenshotHeight: capture.viewport.height,
            screenshotSha256: screenshotSha256(capture.png),
          });
          if (recorded.outcome === 'stale') throw staleError(taskId, previewId, frozenRevision, recorded.evidence);
          return { recorded, bindingChanged };
        });
        const committed = typeof commit.immediate === 'function' ? commit.immediate() : commit();
        const { recorded, bindingChanged } = committed;
        if (bindingChanged) publishServerEvent('ui-preview.changed', { entityId: previewId, reason: 'bound' });
        if (recorded.outcome === 'inserted' || recorded.outcome === 'superseded') {
          publishServerEvent('task.changed', { entityId: taskId, reason: 'ui-design-evidence' });
        }
        const row = selectEvidenceRow(recorded.evidence.evidenceId);
        if (!row) throw new UiPreviewError('UI_PREVIEW_EVIDENCE_NOT_FOUND', `Task UI evidence '${recorded.evidence.evidenceId}' was not found after capture.`);
        return shapeEvidenceRow(row);
      })();
      inFlight.set(flightKey, shared);
      void shared.finally(() => {
        if (inFlight.get(flightKey) === shared) inFlight.delete(flightKey);
      }).catch(() => {});
    }

    const result = await shared;
    persistIdempotency(input.idempotencyKey, requestFingerprint, result);
    return result;
  }

  function list(input: ListTaskUiEvidenceInput) {
    const taskId = canonicalTaskId(input.taskId);
    const limit = clampLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = cursor
      ? database.prepare(`
          SELECT e.*, r.title, p.latest_revision
          FROM task_ui_evidence e
          JOIN ui_preview_revisions r ON r.preview_id = e.preview_id AND r.revision = e.frozen_revision
          JOIN ui_previews p ON p.id = e.preview_id
          WHERE e.task_id = ? AND (e.created_at < ? OR (e.created_at = ? AND e.evidence_id < ?))
          ORDER BY e.created_at DESC, e.evidence_id DESC
          LIMIT ?
        `).all(taskId, cursor.createdAt, cursor.createdAt, cursor.evidenceId, limit + 1) as EvidenceRow[]
      : database.prepare(`
          SELECT e.*, r.title, p.latest_revision
          FROM task_ui_evidence e
          JOIN ui_preview_revisions r ON r.preview_id = e.preview_id AND r.revision = e.frozen_revision
          JOIN ui_previews p ON p.id = e.preview_id
          WHERE e.task_id = ?
          ORDER BY e.created_at DESC, e.evidence_id DESC
          LIMIT ?
        `).all(taskId, limit + 1) as EvidenceRow[];
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    return {
      items: visible.map((row) => shapeEvidenceRow(row)),
      nextCursor: hasMore && visible.length > 0 ? encodeCursor(visible[visible.length - 1]) : null,
      limit,
    };
  }

  return { attach, list };
}

export type TaskUiEvidenceService = ReturnType<typeof createTaskUiEvidenceService>;

export function listTaskUiEvidenceForAgent(taskId: string, options: { limit?: number } = {}) {
  const service = createTaskUiEvidenceService({
    runtimePort: () => {
      const baseUrl = process.env.DEVFLOW_API_BASE_URL || 'http://127.0.0.1:3000';
      const parsed = new URL(baseUrl);
      return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    },
  });
  return service.list({ taskId, limit: Math.min(options.limit ?? 5, 20) });
}
