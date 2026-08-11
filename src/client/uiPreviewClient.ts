import { apiGet, apiPost } from './apiClient';

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

export type UiPreviewLibraryFilter = 'all' | 'standalone' | 'linked';

export interface UiPreviewLinkedTask {
  id: string;
  displayId: string | null;
  title: string;
  projectId: string | null;
}

export interface UiPreviewLibraryItem {
  previewId: string;
  taskId: string | null;
  title: string | null;
  specSummary: Record<string, unknown>;
  latestRevision: number;
  createdAt: string;
  updatedAt: string;
  latestPreviewUrl: string;
  linkedTask: UiPreviewLinkedTask | null;
}

export interface UiPreviewLibraryPage {
  items: UiPreviewLibraryItem[];
  nextCursor: string | null;
  limit: number;
  filter: UiPreviewLibraryFilter;
}

export interface UiPreviewLibraryPageOptions {
  filter?: UiPreviewLibraryFilter;
  cursor?: string | null;
  limit?: number;
}

export interface UiPreviewLibraryRequestToken {
  scope: UiPreviewLibraryFilter;
  generation: number;
}

export interface UiPreviewAttachAttemptToken {
  previewId: string;
  taskId: string;
  idempotencyKey: string;
  generation: number;
}

const DEFAULT_EVIDENCE_LIMIT = 20;
const MAX_EVIDENCE_LIMIT = 50;
const DEFAULT_LIBRARY_LIMIT = 20;
const MAX_LIBRARY_LIMIT = 50;

function clampLimit(value: number | undefined, defaultValue = DEFAULT_EVIDENCE_LIMIT) {
  if (!Number.isFinite(value)) return defaultValue;
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

function normalizeLinkedTask(value: unknown): UiPreviewLinkedTask | null {
  const input = record(value);
  if (!input) return null;
  const id = asString(input.id);
  if (!id) return null;
  return {
    id,
    displayId: asOptionalString(input.displayId),
    title: asString(input.title) || id,
    projectId: asOptionalString(input.projectId),
  };
}

function normalizeLibraryItem(value: unknown): UiPreviewLibraryItem | null {
  const input = record(value);
  if (!input) return null;
  const previewId = asString(input.previewId);
  const latestRevision = asRevision(input.latestRevision);
  const latestPreviewUrl = asString(input.latestPreviewUrl);
  if (!previewId || latestRevision < 1 || !latestPreviewUrl) return null;
  return {
    previewId,
    taskId: asOptionalString(input.taskId),
    title: asOptionalString(input.title),
    specSummary: record(input.specSummary) || {},
    latestRevision,
    createdAt: asString(input.createdAt),
    updatedAt: asString(input.updatedAt),
    latestPreviewUrl,
    linkedTask: normalizeLinkedTask(input.linkedTask),
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

export function buildUiPreviewLibraryPath(options: UiPreviewLibraryPageOptions = {}) {
  const filter = options.filter ?? 'all';
  const params = new URLSearchParams();
  params.set('limit', String(clampLimit(options.limit, DEFAULT_LIBRARY_LIMIT)));
  params.set('filter', filter);
  if (options.cursor) params.set('cursor', options.cursor);
  return `/api/ui-previews?${params.toString()}`;
}

export function normalizeUiPreviewLibraryPage(value: unknown): UiPreviewLibraryPage {
  const input = record(value) || {};
  const filter = input.filter === 'standalone' || input.filter === 'linked' ? input.filter : 'all';
  return {
    items: (Array.isArray(input.items) ? input.items : [])
      .map(normalizeLibraryItem)
      .filter((item): item is UiPreviewLibraryItem => Boolean(item)),
    nextCursor: asOptionalString(input.nextCursor),
    limit: clampLimit(typeof input.limit === 'number' ? input.limit : DEFAULT_LIBRARY_LIMIT, DEFAULT_LIBRARY_LIMIT),
    filter,
  };
}

export async function getUiPreviewLibraryPage(options: UiPreviewLibraryPageOptions = {}) {
  const result = await apiGet<unknown>(buildUiPreviewLibraryPath(options));
  return normalizeUiPreviewLibraryPage(result.data);
}

export async function attachUiPreviewToTask(input: { taskId: string; previewId: string; idempotencyKey: string }) {
  const result = await apiPost<TaskUiEvidence>(`/api/tasks/${encodeURIComponent(input.taskId)}/ui-evidence`, {
    previewId: input.previewId,
    idempotencyKey: input.idempotencyKey,
  });
  return result.data;
}

export function createUiPreviewLibraryRequestGate() {
  let generation = 0;
  let activeScope: UiPreviewLibraryFilter | null = null;
  return {
    begin(scope: UiPreviewLibraryFilter): UiPreviewLibraryRequestToken {
      generation += 1;
      activeScope = scope;
      return { scope, generation };
    },
    isCurrent(token: UiPreviewLibraryRequestToken) {
      return token.scope === activeScope && token.generation === generation;
    },
    invalidate() {
      generation += 1;
      activeScope = null;
    },
  };
}

function defaultAttachKey() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `ui-preview-attach-${uuid}` : `ui-preview-attach-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createUiPreviewAttachAttemptStore(createKey: () => string = defaultAttachKey) {
  const entries = new Map<string, { key: string; pending: boolean; generation: number }>();
  const pair = (previewId: string, taskId: string) => `${previewId}\u0000${taskId}`;

  const isCurrent = (token: UiPreviewAttachAttemptToken) => {
    const entry = entries.get(pair(token.previewId, token.taskId));
    return Boolean(entry && entry.key === token.idempotencyKey && entry.generation === token.generation && entry.pending);
  };

  return {
    begin(previewId: string, taskId: string): UiPreviewAttachAttemptToken | null {
      const id = pair(previewId, taskId);
      const existing = entries.get(id);
      if (existing?.pending) return null;
      const entry = existing || { key: createKey(), pending: false, generation: 0 };
      entry.pending = true;
      entry.generation += 1;
      entries.set(id, entry);
      return { previewId, taskId, idempotencyKey: entry.key, generation: entry.generation };
    },
    isCurrent,
    settle(token: UiPreviewAttachAttemptToken, outcome: 'uncertain' | 'terminal') {
      if (!isCurrent(token)) return;
      const id = pair(token.previewId, token.taskId);
      const entry = entries.get(id)!;
      if (outcome === 'terminal') entries.delete(id);
      else entry.pending = false;
    },
    cancel(token: UiPreviewAttachAttemptToken) {
      if (!isCurrent(token)) return;
      const entry = entries.get(pair(token.previewId, token.taskId))!;
      entry.pending = false;
      entry.generation += 1;
    },
    invalidate() {
      for (const entry of entries.values()) {
        entry.pending = false;
        entry.generation += 1;
      }
    },
  };
}
