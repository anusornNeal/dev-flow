import { apiGet } from './apiClient';

export interface TaskUiEvidence {
  evidenceId: string;
  taskId?: string;
  previewId: string;
  title?: string | null;
  frozenRevision: number;
  latestRevision: number;
  frozenPreviewUrl: string;
  latestPreviewUrl?: string | null;
  screenshotUrl: string;
  attachedAt: string;
  current?: boolean;
  spec: Record<string, unknown>;
}

export interface TaskUiEvidencePage {
  items: TaskUiEvidence[];
  nextCursor: string | null;
  limit: number;
}

export interface TaskUiEvidencePageOptions {
  cursor?: string | null;
  limit?: number;
}

export interface TaskUiEvidenceRequestToken {
  taskId: string;
  generation: number;
}

const DEFAULT_EVIDENCE_LIMIT = 20;
const MAX_EVIDENCE_LIMIT = 50;

function clampLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_EVIDENCE_LIMIT;
  return Math.max(1, Math.min(MAX_EVIDENCE_LIMIT, Math.trunc(value as number)));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function asOptionalString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRevision(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function normalizeEvidence(value: unknown): TaskUiEvidence | null {
  const input = record(value);
  if (!input) return null;
  const previewId = asString(input.previewId);
  const evidenceId = asString(input.evidenceId || input.id);
  const frozenRevision = asRevision(input.frozenRevision || input.revision);
  if (!previewId || !evidenceId || frozenRevision <= 0) return null;

  return {
    evidenceId,
    taskId: asOptionalString(input.taskId) || undefined,
    previewId,
    title: asOptionalString(input.title),
    frozenRevision,
    latestRevision: asRevision(input.latestRevision, frozenRevision),
    frozenPreviewUrl: asString(input.frozenPreviewUrl),
    latestPreviewUrl: asOptionalString(input.latestPreviewUrl),
    screenshotUrl: asString(input.screenshotUrl),
    attachedAt: asString(input.attachedAt || input.createdAt),
    current: typeof input.current === 'boolean'
      ? input.current
      : typeof input.isCurrent === 'boolean'
        ? input.isCurrent
        : undefined,
    spec: record(input.spec) || {},
  };
}

export function buildTaskUiEvidencePath(taskId: string, options: TaskUiEvidencePageOptions = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(clampLimit(options.limit)));
  if (options.cursor) params.set('cursor', options.cursor);
  return `/api/tasks/${encodeURIComponent(taskId)}/ui-evidence?${params.toString()}`;
}

export function normalizeTaskUiEvidencePage(value: unknown): TaskUiEvidencePage {
  const input = record(value) || {};
  const candidateItems = Array.isArray(input.items)
    ? input.items
    : Array.isArray(input.evidence)
      ? input.evidence
      : [];
  return {
    items: candidateItems.map(normalizeEvidence).filter((item): item is TaskUiEvidence => Boolean(item)),
    nextCursor: asOptionalString(input.nextCursor),
    limit: clampLimit(typeof input.limit === 'number' ? input.limit : DEFAULT_EVIDENCE_LIMIT),
  };
}

export async function getTaskUiEvidence(taskId: string, options: TaskUiEvidencePageOptions = {}) {
  const result = await apiGet<unknown>(buildTaskUiEvidencePath(taskId, options));
  return normalizeTaskUiEvidencePage(result.data);
}

export function createTaskUiEvidenceRequestGate() {
  let generation = 0;
  let activeTaskId: string | null = null;

  return {
    begin(taskId: string): TaskUiEvidenceRequestToken {
      generation += 1;
      activeTaskId = taskId;
      return { taskId, generation };
    },
    isCurrent(token: TaskUiEvidenceRequestToken) {
      return token.taskId === activeTaskId && token.generation === generation;
    },
    invalidate() {
      generation += 1;
      activeTaskId = null;
    },
  };
}
