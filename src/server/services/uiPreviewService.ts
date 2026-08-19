import { randomUUID } from 'node:crypto';
import { UiPreviewError } from '../domain/uiPreview.js';
import type { UiPreviewDesignContext, UiPreviewRevisionDesignProvenance, UiPreviewScope, UiPreviewScreen, UiPreviewViewport, UiSpecV1 } from '../domain/uiPreview.js';
import {
  fingerprintCanonicalRequest,
  hashUiPreviewContent,
  type UiPreviewRepository,
  type ListUiPreviewsInput,
} from '../repositories/uiPreviewRepository.js';
import { normalizeUiPreviewDesignGateExceptionRefs, normalizeUiPreviewInput } from './uiSpecValidator.js';
import { evaluateUiPreviewDesignGate } from './uiPreviewDesignGateService.js';
import { materializeUiPreviewFonts, type UiPreviewFontSnapshot } from './uiPreviewDocumentService.js';
import { resolveUiPreviewUrl } from './uiPreviewUrlResolver.js';

export interface UiPreviewServiceDependencies {
  repository: UiPreviewRepository;
  runtimePort: () => number;
  createId?: () => string;
  designContextService?: { get(input: { taskId?: string; projectId?: string }): UiPreviewDesignContext };
  materializeFonts?: (context: UiPreviewDesignContext) => UiPreviewFontSnapshot;
}

export interface CreateUiPreviewInput {
  taskId?: string | null;
  projectId?: string | null;
  expectedDesignContextHash?: string;
  exceptionRefs?: unknown;
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
  taskId?: string | null;
  projectId?: string | null;
  expectedDesignContextHash?: string;
  exceptionRefs?: unknown;
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

function normalizeProjectId(value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new UiPreviewError('UI_PREVIEW_VALIDATION_FAILED', 'projectId must be a non-empty string when supplied.');
  return value.trim();
}

function normalizeExpectedContextHash(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value.trim())) {
    throw new UiPreviewError('UI_PREVIEW_DESIGN_CONTEXT_REQUIRED', 'Scoped UI preview writes require expectedDesignContextHash from get_ui_design_context.');
  }
  return value.trim().toLowerCase();
}

function provenanceIdentity(provenance: UiPreviewRevisionDesignProvenance) {
  return {
    schemaVersion: provenance.schemaVersion,
    scope: provenance.scope,
    contextHash: provenance.contextHash,
    contextSchemaVersion: provenance.contextSchemaVersion,
    gatePolicyVersion: provenance.gatePolicyVersion,
    exceptionRefs: provenance.exceptionRefs,
    renderAssets: provenance.renderAssets.map((asset) => ({ assetId: asset.assetId, kind: asset.kind, contentIdentity: asset.contentIdentity, font: asset.font })),
    fontRenderability: provenance.fontRenderability,
    fontContentIdentities: provenance.fontContentIdentities,
  };
}

function hashScopedContent(normalized: ReturnType<typeof normalizeUiPreviewInput>, provenance?: UiPreviewRevisionDesignProvenance) {
  const sourceHash = hashUiPreviewContent(normalized);
  return provenance ? fingerprintCanonicalRequest({ sourceHash, design: provenanceIdentity(provenance) }) : sourceHash;
}

function updateRequestFingerprint(input: UpdateUiPreviewInput) {
  const patch: Record<string, unknown> = {};
  for (const key of ['title', 'html', 'css', 'js', 'spec', 'screens', 'defaultScreenId', 'viewport'] as const) {
    if (hasOwn(input, key)) patch[key] = input[key];
  }
  return fingerprintCanonicalRequest({
    previewId: input.previewId,
    expectedRevision: input.expectedRevision ?? null,
    taskId: hasOwn(input, 'taskId') ? input.taskId ?? null : null,
    projectId: hasOwn(input, 'projectId') ? input.projectId ?? null : null,
    expectedDesignContextHash: input.expectedDesignContextHash ?? null,
    exceptionRefs: input.exceptionRefs ?? null,
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
  designProvenance?: UiPreviewRevisionDesignProvenance;
  fontSnapshot?: UiPreviewFontSnapshot;
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

  const fontMaterializer = deps.materializeFonts ?? ((context: UiPreviewDesignContext) => materializeUiPreviewFonts({
    contextHash: context.contextHash,
    renderAssets: context.renderAssets,
    resolvedFonts: [],
  }));

  function resolveCurrentContext(input: { taskId?: string; projectId?: string; expectedDesignContextHash?: string }) {
    const expected = normalizeExpectedContextHash(input.expectedDesignContextHash);
    if (!deps.designContextService) {
      throw new UiPreviewError('UI_PREVIEW_DESIGN_CONTEXT_UNAVAILABLE', 'Scoped UI preview writes require the server design-context resolver.');
    }
    let context: UiPreviewDesignContext;
    try {
      context = deps.designContextService.get({ taskId: input.taskId, projectId: input.projectId });
    } catch (error) {
      if ((error as any)?.code === 'UI_PREVIEW_DESIGN_CONTEXT_PROJECT_MISMATCH') {
        throw new UiPreviewError('UI_PREVIEW_SCOPE_MISMATCH', 'Task and project UI preview scope do not match.');
      }
      throw error;
    }
    if (context.contextHash.toLowerCase() !== expected) {
      throw new UiPreviewError('UI_PREVIEW_DESIGN_CONTEXT_STALE', 'The expected UI design context is stale; read current design context before writing the preview.');
    }
    if (context.sufficiency === 'insufficient') {
      throw new UiPreviewError('UI_PREVIEW_DESIGN_CONTEXT_INSUFFICIENT', 'Scoped UI preview writes require a usable project visual basis.');
    }
    return context;
  }

  function evaluateScopedWrite(args: { context: UiPreviewDesignContext; scope: UiPreviewScope; screens: UiPreviewScreen[]; exceptionRefs?: unknown }) {
    let exceptionRefs;
    try {
      exceptionRefs = normalizeUiPreviewDesignGateExceptionRefs(args.exceptionRefs);
    } catch {
      throw new UiPreviewError('UI_PREVIEW_DESIGN_EXCEPTION_INVALID', 'UI preview design exception references are invalid.');
    }
    const gate = evaluateUiPreviewDesignGate({
      screens: args.screens,
      designContext: args.context,
      gatePolicyVersion: args.context.gatePolicyVersion,
      exceptionRefs,
    });
    if (gate.exceptionResults.some((result) => result.status === 'rejected')) {
      throw new UiPreviewError('UI_PREVIEW_DESIGN_EXCEPTION_INVALID', 'One or more UI preview design exception references were rejected.');
    }
    if (gate.blocked) {
      throw new UiPreviewError('UI_PREVIEW_DESIGN_GATE_FAILED', 'UI preview source failed deterministic project design compliance checks.');
    }
    const fontSnapshot = fontMaterializer(args.context);
    if (args.context.renderAssets.some((asset) => asset.kind === 'font') && fontSnapshot.fontRenderability !== 'available') {
      throw new UiPreviewError('UI_PREVIEW_FONT_RENDER_UNAVAILABLE', 'Required project font content could not be materialized safely for this preview revision.');
    }
    const provenance: UiPreviewRevisionDesignProvenance = {
      schemaVersion: 1,
      scope: args.scope,
      repositoryRevision: args.context.repositoryRevision,
      contextHash: args.context.contextHash,
      contextSchemaVersion: args.context.contextSchemaVersion,
      gatePolicyVersion: args.context.gatePolicyVersion,
      sufficiency: args.context.sufficiency,
      unknowns: [...args.context.unknowns],
      sources: args.context.sources.map((source) => ({ ...source })),
      findings: gate.findings.map((entry) => ({ ...entry, evidence: entry.evidence.map((evidence) => ({ ...evidence })) })),
      suppressedFindings: gate.suppressedFindings.map((entry) => ({ ...entry, evidence: entry.evidence.map((evidence) => ({ ...evidence })) })),
      exceptionRefs: exceptionRefs.map((entry) => ({ ...entry, ruleIds: [...entry.ruleIds], categories: [...entry.categories], authority: entry.authority ? { ...entry.authority, authorizedRuleIds: [...entry.authority.authorizedRuleIds], authorizedCategories: [...entry.authority.authorizedCategories] } : undefined })),
      exceptionResults: gate.exceptionResults.map((entry) => ({ ...entry, suppressedRuleIds: [...entry.suppressedRuleIds] })),
      renderAssets: args.context.renderAssets.map((asset) => ({ ...asset, font: asset.font ? { ...asset.font } : undefined })),
      fontRenderability: fontSnapshot.fontRenderability,
      fontContentIdentities: fontSnapshot.fonts.map((font) => font.contentIdentity),
    };
    return { provenance, fontSnapshot };
  }

  function assertUpdateScope(input: UpdateUiPreviewInput, preview: any, current: RevisionWithWorkspace) {
    const requestedTaskId = normalizeTaskId(input.taskId);
    const requestedProjectId = normalizeProjectId(input.projectId);
    const scope = current.designProvenance?.scope;
    if (!scope && !preview.taskId) {
      if (requestedTaskId || requestedProjectId) throw new UiPreviewError('UI_PREVIEW_SCOPE_MISMATCH', 'An unscoped UI preview cannot be retargeted during update.');
      return { kind: 'unscoped' } as UiPreviewScope;
    }
    if (scope?.kind === 'project') {
      if (requestedTaskId || (requestedProjectId && requestedProjectId !== scope.projectId)) throw new UiPreviewError('UI_PREVIEW_SCOPE_MISMATCH', 'UI preview project scope is immutable.');
      return scope;
    }
    if (scope?.kind === 'task') {
      if ((requestedTaskId && requestedTaskId !== scope.taskId) || (requestedProjectId && requestedProjectId !== scope.projectId)) throw new UiPreviewError('UI_PREVIEW_SCOPE_MISMATCH', 'UI preview task scope is immutable.');
      return scope;
    }
    if (preview.taskId && requestedTaskId && requestedTaskId !== preview.taskId) throw new UiPreviewError('UI_PREVIEW_SCOPE_MISMATCH', 'UI preview task scope is immutable.');
    return { kind: 'task', taskId: String(preview.taskId), projectId: requestedProjectId || '' } as UiPreviewScope;
  }


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
      ...((revision as unknown as RevisionWithWorkspace).designProvenance ? {
        scope: (revision as unknown as RevisionWithWorkspace).designProvenance?.scope,
        designProvenance: (revision as unknown as RevisionWithWorkspace).designProvenance,
      } : {}),
      ...workspaceSummary(revision as unknown as RevisionWithWorkspace),
      previewUrl: resolveUiPreviewUrl({ previewId: identity.previewId, revision: identity.revision, port: deps.runtimePort() }),
    };
  }

  function create(input: CreateUiPreviewInput) {
    const normalized = normalizeUiPreviewInput(input);
    const requestedTaskId = normalizeTaskId(input.taskId);
    const requestedProjectId = normalizeProjectId(input.projectId);
    const fingerprint = fingerprintCanonicalRequest({
      taskId: requestedTaskId,
      projectId: requestedProjectId,
      expectedDesignContextHash: input.expectedDesignContextHash ?? null,
      exceptionRefs: input.exceptionRefs ?? null,
      ...normalized,
    });
    const operation = deps.repository.runIdempotent<MutationIdentity>('create', input.idempotencyKey, fingerprint, () => {
      let scope: UiPreviewScope = { kind: 'unscoped' };
      let provenance: UiPreviewRevisionDesignProvenance | undefined;
      let fontSnapshot: UiPreviewFontSnapshot | undefined;
      let taskId: string | null = null;
      if (requestedTaskId || requestedProjectId) {
        const context = resolveCurrentContext({
          taskId: requestedTaskId || undefined,
          projectId: requestedProjectId || undefined,
          expectedDesignContextHash: input.expectedDesignContextHash,
        });
        if (requestedTaskId) {
          if (!context.taskId) throw new UiPreviewError('UI_PREVIEW_SCOPE_MISMATCH', 'Task-bound UI preview scope could not be resolved authoritatively.');
          scope = { kind: 'task', taskId: context.taskId, projectId: context.projectId };
          taskId = context.taskId;
        } else {
          scope = { kind: 'project', projectId: context.projectId };
        }
        const accepted = evaluateScopedWrite({ context, scope, screens: normalized.screens, exceptionRefs: input.exceptionRefs });
        provenance = accepted.provenance;
        fontSnapshot = accepted.fontSnapshot;
      }
      const contentHash = hashScopedContent(normalized, provenance);
      const previewId = createId();
      deps.repository.createPreview({
        id: previewId,
        taskId,
        ...normalized,
        contentHash,
        designProvenance: provenance,
        fontSnapshot,
      } as any);
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
      const currentRevision = current as unknown as RevisionWithWorkspace;
      const currentWorkspace = canonicalWorkspace(currentRevision);
      let scope = assertUpdateScope(input, preview, currentRevision);
      const viewport = hasOwn(input, 'viewport') ? { ...current.viewport, ...(input.viewport || {}) } : current.viewport;
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
          throw new UiPreviewError('UI_PREVIEW_VALIDATION_FAILED', 'Legacy html/css/js/spec patch fields cannot modify a canonical workspace; replace the complete screens array instead.');
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

      let provenance: UiPreviewRevisionDesignProvenance | undefined;
      let fontSnapshot: UiPreviewFontSnapshot | undefined;
      if (scope.kind !== 'unscoped') {
        const context = resolveCurrentContext({
          taskId: scope.kind === 'task' ? scope.taskId : undefined,
          projectId: scope.projectId || normalizeProjectId(input.projectId) || undefined,
          expectedDesignContextHash: input.expectedDesignContextHash,
        });
        if (scope.kind === 'task' && !scope.projectId) scope = { kind: 'task', taskId: scope.taskId, projectId: context.projectId };
        if (scope.kind === 'project' && context.projectId !== scope.projectId) throw new UiPreviewError('UI_PREVIEW_SCOPE_MISMATCH', 'UI preview project scope is immutable.');
        const accepted = evaluateScopedWrite({ context, scope, screens: resolved.screens, exceptionRefs: input.exceptionRefs });
        provenance = accepted.provenance;
        fontSnapshot = accepted.fontSnapshot;
      }
      const contentHash = hashScopedContent(resolved, provenance);
      const result = deps.repository.appendRevision({
        previewId: input.previewId,
        expectedRevision: input.expectedRevision,
        ...resolved,
        contentHash,
        designProvenance: provenance,
        fontSnapshot,
      } as any);
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
