import { randomUUID } from 'node:crypto';
import { UiPreviewError } from '../domain/uiPreview.js';
import type { UiPreviewViewport, UiSpecV1 } from '../domain/uiPreview.js';
import {
  fingerprintCanonicalRequest,
  hashUiPreviewContent,
  type UiPreviewRepository,
  type ListUiPreviewsInput,
} from '../repositories/uiPreviewRepository.js';
import { normalizeUiPreviewInput } from './uiSpecValidator.js';
import { resolveUiPreviewUrl } from './uiPreviewUrlResolver.js';

export interface UiPreviewServiceDependencies {
  repository: UiPreviewRepository;
  runtimePort: () => number;
  createId?: () => string;
}

export interface CreateUiPreviewInput {
  taskId?: string | null;
  title?: string | null;
  html: string;
  css?: string | null;
  js?: string | null;
  spec: unknown;
  viewport?: Partial<UiPreviewViewport> | null;
  idempotencyKey?: string;
}

export interface UpdateUiPreviewInput {
  previewId: string;
  expectedRevision?: number;
  title?: string | null;
  html?: string;
  css?: string | null;
  js?: string | null;
  spec?: unknown;
  viewport?: Partial<UiPreviewViewport> | null;
  idempotencyKey?: string;
}

export interface GetUiPreviewInput {
  previewId: string;
  revision?: number;
  mode?: 'summary' | 'source';
}

interface MutationIdentity {
  previewId: string;
  revision: number;
  latestRevision: number;
  changed: boolean;
  contentHash: string;
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeTaskId(value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new UiPreviewError('UI_PREVIEW_VALIDATION_FAILED', 'taskId must be a non-empty string when supplied.');
  return value.trim();
}

function updateRequestFingerprint(input: UpdateUiPreviewInput) {
  const patch: Record<string, unknown> = {};
  for (const key of ['title', 'html', 'css', 'js', 'spec', 'viewport'] as const) {
    if (hasOwn(input, key)) patch[key] = input[key];
  }
  return fingerprintCanonicalRequest({
    previewId: input.previewId,
    expectedRevision: input.expectedRevision ?? null,
    patch,
  });
}

export function createUiPreviewService(deps: UiPreviewServiceDependencies) {
  const createId = deps.createId || (() => `uip_${randomUUID().replace(/-/g, '')}`);

  function shapeRevision(identity: MutationIdentity, replayed = false) {
    const preview = deps.repository.getPreview(identity.previewId);
    const revision = deps.repository.getRevision(identity.previewId, identity.revision);
    if (!preview || !revision) throw new UiPreviewError('UI_PREVIEW_NOT_FOUND', `UI preview '${identity.previewId}' was not found.`);
    return {
      previewId: identity.previewId,
      taskId: preview.taskId,
      revision: identity.revision,
      latestRevision: identity.latestRevision,
      changed: identity.changed,
      replayed,
      title: revision.title,
      contentHash: revision.contentHash,
      viewport: revision.viewport,
      specSummary: revision.spec.summary,
      previewUrl: resolveUiPreviewUrl({ previewId: identity.previewId, revision: identity.revision, port: deps.runtimePort() }),
    };
  }

  function create(input: CreateUiPreviewInput) {
    const normalized = normalizeUiPreviewInput(input);
    const taskId = normalizeTaskId(input.taskId);
    const contentHash = hashUiPreviewContent(normalized);
    const fingerprint = fingerprintCanonicalRequest({ taskId, ...normalized });
    const operation = deps.repository.runIdempotent<MutationIdentity>('create', input.idempotencyKey, fingerprint, () => {
      const previewId = createId();
      deps.repository.createPreview({
        id: previewId,
        taskId,
        ...normalized,
        contentHash,
      });
      return { previewId, revision: 1, latestRevision: 1, changed: true, contentHash };
    });
    return shapeRevision(operation.result, operation.replayed);
  }

  function update(input: UpdateUiPreviewInput) {
    if (!input.previewId || typeof input.previewId !== 'string') throw new UiPreviewError('UI_PREVIEW_VALIDATION_FAILED', 'previewId is required.');
    const fingerprint = updateRequestFingerprint(input);
    const operation = deps.repository.runIdempotent<MutationIdentity>('update', input.idempotencyKey, fingerprint, () => {
      const preview = deps.repository.getPreview(input.previewId);
      if (!preview) throw new UiPreviewError('UI_PREVIEW_NOT_FOUND', `UI preview '${input.previewId}' was not found.`);
      const current = deps.repository.getRevision(input.previewId, preview.latestRevision);
      if (!current) throw new UiPreviewError('UI_PREVIEW_NOT_FOUND', `UI preview '${input.previewId}' has no current revision.`);
      const viewport = hasOwn(input, 'viewport')
        ? { ...current.viewport, ...(input.viewport || {}) }
        : current.viewport;
      const resolved = normalizeUiPreviewInput({
        title: hasOwn(input, 'title') ? input.title : current.title,
        html: hasOwn(input, 'html') ? (input.html as string) : current.html,
        css: hasOwn(input, 'css') ? input.css : current.css,
        js: hasOwn(input, 'js') ? input.js : current.js,
        spec: hasOwn(input, 'spec') ? input.spec : current.spec,
        viewport,
      });
      const contentHash = hashUiPreviewContent(resolved);
      const result = deps.repository.appendRevision({
        previewId: input.previewId,
        expectedRevision: input.expectedRevision,
        ...resolved,
        contentHash,
      });
      return {
        previewId: input.previewId,
        revision: result.revision.revision,
        latestRevision: result.preview.latestRevision,
        changed: result.changed,
        contentHash: result.revision.contentHash,
      };
    });
    return shapeRevision(operation.result, operation.replayed);
  }

  function list(input: ListUiPreviewsInput = {}) {
    const page = deps.repository.listPreviews(input);
    const port = deps.runtimePort();
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        latestPreviewUrl: resolveUiPreviewUrl({ previewId: item.previewId, port }),
      })),
    };
  }

  function get(input: GetUiPreviewInput): any {
    const preview = deps.repository.getPreview(input.previewId);
    if (!preview) throw new UiPreviewError('UI_PREVIEW_NOT_FOUND', `UI preview '${input.previewId}' was not found.`);
    const selectedRevision = input.revision ?? preview.latestRevision;
    const revision = deps.repository.getRevision(input.previewId, selectedRevision);
    if (!revision) throw new UiPreviewError('UI_PREVIEW_REVISION_NOT_FOUND', `UI preview '${input.previewId}' revision ${selectedRevision} was not found.`);
    const summary: any = {
      previewId: preview.id,
      taskId: preview.taskId,
      revision: revision.revision,
      latestRevision: preview.latestRevision,
      title: revision.title,
      contentHash: revision.contentHash,
      viewport: revision.viewport,
      specSummary: revision.spec.summary,
      previewUrl: resolveUiPreviewUrl({ previewId: preview.id, revision: revision.revision, port: deps.runtimePort() }),
    };
    if (input.mode === 'source') {
      return {
        ...summary,
        html: revision.html,
        css: revision.css,
        js: revision.js,
        spec: revision.spec as UiSpecV1,
      };
    }
    return summary;
  }

  return { create, update, get, list };
}

export type UiPreviewService = ReturnType<typeof createUiPreviewService>;
