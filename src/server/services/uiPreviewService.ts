import { randomUUID } from 'node:crypto';
import { UiPreviewError } from '../domain/uiPreview.js';
import type { UiPreviewScreen, UiPreviewViewport, UiSpecV1 } from '../domain/uiPreview.js';
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
  html?: string;
  css?: string | null;
  js?: string | null;
  spec?: unknown;
  screens?: unknown;
  defaultScreenId?: unknown;
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
  screens?: unknown;
  defaultScreenId?: unknown;
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
  for (const key of ['title', 'html', 'css', 'js', 'spec', 'screens', 'defaultScreenId', 'viewport'] as const) {
    if (hasOwn(input, key)) patch[key] = input[key];
  }
  return fingerprintCanonicalRequest({
    previewId: input.previewId,
    expectedRevision: input.expectedRevision ?? null,
    patch,
  });
}

type RevisionWithWorkspace = {
  title: string | null;
  html?: string;
  css?: string;
  js?: string;
  spec?: UiSpecV1;
  screens?: UiPreviewScreen[];
  defaultScreenId?: string;
  viewport: UiPreviewViewport;
};

function canonicalWorkspace(revision: RevisionWithWorkspace) {
  const screens = Array.isArray(revision.screens) && revision.screens.length > 0
    ? revision.screens
    : [{
        screenId: 'main',
        name: revision.spec?.summary?.screen?.trim() || revision.title?.trim() || 'Main',
        html: revision.html || '',
        css: revision.css || '',
        js: revision.js || '',
        spec: revision.spec as UiSpecV1,
      }];
  const defaultScreenId = typeof revision.defaultScreenId === 'string'
    && screens.some((screen) => screen.screenId === revision.defaultScreenId)
    ? revision.defaultScreenId
    : screens[0].screenId;
  const defaultScreen = screens.find((screen) => screen.screenId === defaultScreenId) || screens[0];
  return { screens, defaultScreenId, defaultScreen };
}

function workspaceSummary(revision: RevisionWithWorkspace) {
  const workspace = canonicalWorkspace(revision);
  return {
    screenCount: workspace.screens.length,
    defaultScreenId: workspace.defaultScreenId,
    defaultScreenSummary: {
      screenId: workspace.defaultScreen.screenId,
      name: workspace.defaultScreen.name,
      specSummary: workspace.defaultScreen.spec.summary,
    },
    specSummary: workspace.defaultScreen.spec.summary,
  };
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
      ...workspaceSummary(revision as unknown as RevisionWithWorkspace),
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
      const currentWorkspace = canonicalWorkspace(current as unknown as RevisionWithWorkspace);
      const viewport = hasOwn(input, 'viewport')
        ? { ...current.viewport, ...(input.viewport || {}) }
        : current.viewport;
      const hasCanonicalInput = hasOwn(input, 'screens') || hasOwn(input, 'defaultScreenId');
      const hasLegacySourceInput = ['html', 'css', 'js', 'spec'].some((key) => hasOwn(input, key));
      let resolved;
      if (hasCanonicalInput) {
        resolved = normalizeUiPreviewInput({
          title: hasOwn(input, 'title') ? input.title : current.title,
          screens: input.screens,
          defaultScreenId: input.defaultScreenId,
          viewport,
        });
      } else if (hasLegacySourceInput) {
        const legacyCompatible = currentWorkspace.screens.length === 1 && currentWorkspace.defaultScreen.screenId === 'main';
        if (!legacyCompatible) {
          throw new UiPreviewError(
            'UI_PREVIEW_VALIDATION_FAILED',
            'Legacy html/css/js/spec patch fields cannot modify a canonical workspace; replace the complete screens array instead.',
          );
        }
        resolved = normalizeUiPreviewInput({
          title: hasOwn(input, 'title') ? input.title : current.title,
          html: hasOwn(input, 'html') ? (input.html as string) : currentWorkspace.defaultScreen.html,
          css: hasOwn(input, 'css') ? input.css : currentWorkspace.defaultScreen.css,
          js: hasOwn(input, 'js') ? input.js : currentWorkspace.defaultScreen.js,
          spec: hasOwn(input, 'spec') ? input.spec : currentWorkspace.defaultScreen.spec,
          viewport,
        });
      } else {
        resolved = normalizeUiPreviewInput({
          title: hasOwn(input, 'title') ? input.title : current.title,
          screens: currentWorkspace.screens,
          defaultScreenId: currentWorkspace.defaultScreenId,
          viewport,
        });
      }
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

  function remove(input: { previewId: string }) {
    const previewId = String(input.previewId || '').trim();
    if (!previewId) throw new UiPreviewError('UI_PREVIEW_VALIDATION_FAILED', 'previewId is required.');
    return deps.repository.deleteStandalonePreview(previewId);
  }

  function list(input: ListUiPreviewsInput = {}) {
    const page = deps.repository.listPreviews(input);
    const port = deps.runtimePort();
    return {
      ...page,
      items: page.items.map((item) => {
        const revision = deps.repository.getRevision(item.previewId, item.latestRevision);
        return {
          ...item,
          ...(revision ? workspaceSummary(revision as unknown as RevisionWithWorkspace) : {}),
          latestPreviewUrl: resolveUiPreviewUrl({ previewId: item.previewId, port }),
        };
      }),
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
      ...workspaceSummary(revision as unknown as RevisionWithWorkspace),
      previewUrl: resolveUiPreviewUrl({ previewId: preview.id, revision: revision.revision, port: deps.runtimePort() }),
    };
    if (input.mode === 'source') {
      const workspace = canonicalWorkspace(revision as unknown as RevisionWithWorkspace);
      return {
        ...summary,
        screens: workspace.screens,
        defaultScreenId: workspace.defaultScreenId,
        html: workspace.defaultScreen.html,
        css: workspace.defaultScreen.css,
        js: workspace.defaultScreen.js,
        spec: workspace.defaultScreen.spec,
      };
    }
    return summary;
  }

  return { create, update, delete: remove, get, list };
}

export type UiPreviewService = ReturnType<typeof createUiPreviewService>;
