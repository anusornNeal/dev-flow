import fs from 'node:fs';
import type express from 'express';
import type { ApiRouteDeps } from '../types.js';
import { createApiError, sendApiError } from '../services/api.js';
import { createStrictLoopbackAccessMiddleware } from '../services/apiAccessPolicyService.js';
import { createUiPreviewArtifactStore, type UiPreviewArtifactStore } from '../services/uiPreviewArtifactStore.js';
import { composeUiPreviewDocument, composeUiPreviewWorkspaceDocument } from '../services/uiPreviewDocumentService.js';
import { UI_PREVIEW_SCREEN_ID_PATTERN, UiPreviewError } from '../domain/uiPreview.js';
import { createUiPreviewRepository } from '../repositories/uiPreviewRepository.js';
import { createUiPreviewService, type UiPreviewService } from '../services/uiPreviewService.js';
import { createUiPreviewScreenshotService } from '../services/uiPreviewScreenshotService.js';
import { createTaskUiEvidenceService, type TaskUiEvidenceService } from '../services/taskUiEvidenceService.js';
import { getDevFlowApiBaseUrl } from '../services/agentRunService.js';

export interface UiPreviewRouteOverrides {
  previewService?: Pick<UiPreviewService, 'create' | 'update' | 'delete' | 'get' | 'list'>;
  evidenceService?: Pick<TaskUiEvidenceService, 'attach' | 'list'>;
  artifactStore?: UiPreviewArtifactStore;
  runtimePort?: () => number;
}

function runtimePortFromApiBaseUrl() {
  const parsed = new URL(getDevFlowApiBaseUrl());
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createApiError(503, 'UI_PREVIEW_RUNTIME_UNAVAILABLE', 'DevFlow API runtime port is unavailable for UI preview URL resolution.');
  }
  return port;
}

function parseRevision(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw createApiError(400, 'UI_PREVIEW_INVALID_REVISION', 'revision must be a positive integer.');
  return revision;
}

function parseScreenId(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !UI_PREVIEW_SCREEN_ID_PATTERN.test(value)) {
    throw new UiPreviewError('UI_PREVIEW_INVALID_SCREEN_ID', 'screenId must be a URL-safe opaque UI preview screen id.');
  }
  return value;
}

function documentScreensFromSource(source: any) {
  if (Array.isArray(source.screens) && source.screens.length > 0) return source.screens;
  return [{
    screenId: 'main',
    name: source.spec?.summary?.screen || source.title || 'Main',
    html: source.html,
    css: source.css || '',
    js: source.js || '',
  }];
}

function isLoopbackHostHeader(value: unknown) {
  const host = String(value || '').trim().toLowerCase();
  if (!host) return false;
  if (/^\[::1\](?::\d+)?$/.test(host)) return true;
  const hostname = host.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('127.');
}

function noStore(res: express.Response) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function apiErrorForUiPreview(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as any).code === 'string') {
    const code = String((error as any).code);
    const message = error instanceof Error ? error.message : code;
    if (/NOT_FOUND/.test(code)) return createApiError(404, code, message);
    if (/CONFLICT|STALE|IDEMPOTENCY/.test(code)) return createApiError(409, code, message);
    if (/RENDERER_UNAVAILABLE|CAPTURE_FAILED|CAPTURE_TIMEOUT|RUNTIME_UNAVAILABLE/.test(code)) return createApiError(503, code, message, { retryable: true });
    return createApiError(400, code, message);
  }
  return error;
}

export function registerUiPreviewRoutes(app: express.Express, _deps: ApiRouteDeps, overrides: UiPreviewRouteOverrides = {}) {
  const runtimePort = overrides.runtimePort ?? runtimePortFromApiBaseUrl;
  const previewRepository = createUiPreviewRepository();
  if (!overrides.previewService && !overrides.evidenceService) previewRepository.migrateLegacyRevisions();
  const previewService = overrides.previewService ?? createUiPreviewService({ repository: previewRepository, runtimePort });
  const screenshotService = overrides.evidenceService ? null : createUiPreviewScreenshotService();
  const evidenceService = overrides.evidenceService ?? createTaskUiEvidenceService({
    previewRepository,
    screenshotService: screenshotService!,
    runtimePort,
  });
  const artifactStore = overrides.artifactStore ?? screenshotService?.artifactStore ?? createUiPreviewArtifactStore();
  const strictLocal = createStrictLoopbackAccessMiddleware();

  app.get('/api/ui-previews', strictLocal, (req, res) => {
    try {
      if (!isLoopbackHostHeader(req.headers.host)) {
        throw createApiError(403, 'UI_PREVIEW_LOCAL_ONLY', 'UI preview library enumeration requires a loopback Host header.');
      }
      const rawFilter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
      if (!['all', 'standalone', 'linked'].includes(rawFilter)) {
        throw createApiError(400, 'UI_PREVIEW_FILTER_INVALID', `Unsupported UI preview filter '${rawFilter}'.`);
      }
      const result = previewService.list({
        filter: rawFilter as 'all' | 'standalone' | 'linked',
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
      });
      noStore(res);
      return res.json(result);
    } catch (error) {
      return sendApiError(res, apiErrorForUiPreview(error));
    }
  });

  app.post('/api/ui-previews', (req, res) => {
    try {
      return res.status(201).json(previewService.create(req.body || {}));
    } catch (error) {
      return sendApiError(res, apiErrorForUiPreview(error));
    }
  });

  app.put('/api/ui-previews/:previewId', (req, res) => {
    try {
      return res.json(previewService.update({ ...(req.body || {}), previewId: req.params.previewId } as any));
    } catch (error) {
      return sendApiError(res, apiErrorForUiPreview(error));
    }
  });

  app.delete('/api/ui-previews/:previewId', strictLocal, (req, res) => {
    try {
      if (!isLoopbackHostHeader(req.headers.host)) {
        throw createApiError(403, 'UI_PREVIEW_LOCAL_ONLY', 'UI preview deletion requires a loopback Host header.');
      }
      return res.json(previewService.delete({ previewId: req.params.previewId }));
    } catch (error) {
      return sendApiError(res, apiErrorForUiPreview(error));
    }
  });

  app.get('/api/ui-previews/:previewId', (req, res) => {
    try {
      const mode = req.query.mode === 'source' ? 'source' : 'summary';
      return res.json(previewService.get({ previewId: req.params.previewId, revision: parseRevision(req.query.revision), mode }));
    } catch (error) {
      return sendApiError(res, apiErrorForUiPreview(error));
    }
  });

  app.get('/api/tasks/:taskId/ui-evidence', (req, res) => {
    try {
      return res.json(evidenceService.list({
        taskId: req.params.taskId,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
      }));
    } catch (error) {
      return sendApiError(res, apiErrorForUiPreview(error));
    }
  });

  app.post('/api/tasks/:taskId/ui-evidence', async (req, res) => {
    try {
      const result = await evidenceService.attach({
        taskId: req.params.taskId,
        previewId: req.body?.previewId,
        revision: parseRevision(req.body?.revision),
        idempotencyKey: req.body?.idempotencyKey,
      });
      return res.json(result);
    } catch (error) {
      return sendApiError(res, apiErrorForUiPreview(error));
    }
  });

  app.get('/api/ui-previews/:previewId/document', strictLocal, (req, res) => {
    try {
      const revision = parseRevision(req.query.revision);
      const requestedScreenId = parseScreenId(req.query.screenId);
      const source = previewService.get({
        previewId: req.params.previewId,
        revision,
        mode: 'source',
      }) as any;
      const screens = documentScreensFromSource(source);
      const defaultScreenId = typeof source.defaultScreenId === 'string' ? source.defaultScreenId : screens[0]?.screenId;
      const selectedScreenId = requestedScreenId ?? defaultScreenId;
      const selectedScreen = screens.find((screen: any) => screen.screenId === selectedScreenId);
      if (!selectedScreen) {
        throw new UiPreviewError(
          'UI_PREVIEW_SCREEN_NOT_FOUND',
          `UI preview '${req.params.previewId}' does not contain screen '${selectedScreenId}'.`,
        );
      }

      const document = screens.length === 1
        ? composeUiPreviewDocument({
            title: source.title,
            html: selectedScreen.html,
            css: selectedScreen.css,
            js: selectedScreen.js,
          })
        : composeUiPreviewWorkspaceDocument({
            title: source.title,
            selectedScreenId,
            screens: screens.map((screen: any) => {
              const query = new URLSearchParams();
              const exactRevision = Number.isInteger(source.revision) ? source.revision : revision;
              if (exactRevision !== undefined) query.set('revision', String(exactRevision));
              query.set('screenId', screen.screenId);
              return {
                screenId: screen.screenId,
                name: screen.name,
                html: screen.html,
                css: screen.css,
                js: screen.js,
                href: `/api/ui-previews/${encodeURIComponent(req.params.previewId)}/document?${query.toString()}`,
              };
            }),
          });
      noStore(res);
      res.setHeader('Content-Security-Policy', document.csp);
      res.type('html');
      return res.send(document.html);
    } catch (error) {
      return sendApiError(res, apiErrorForUiPreview(error));
    }
  });

  app.get('/api/ui-preview-artifacts/:artifactId', strictLocal, (req, res) => {
    try {
      let artifactPath: string;
      try {
        artifactPath = artifactStore.resolveArtifactPath(req.params.artifactId);
      } catch (error) {
        throw createApiError(400, 'UI_PREVIEW_ARTIFACT_INVALID', error instanceof Error ? error.message : 'Invalid UI preview artifact id.');
      }
      if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        throw createApiError(404, 'UI_PREVIEW_ARTIFACT_NOT_FOUND', `UI preview artifact '${req.params.artifactId}' was not found.`);
      }
      noStore(res);
      res.type('png');
      return res.send(fs.readFileSync(artifactPath));
    } catch (error) {
      return sendApiError(res, apiErrorForUiPreview(error));
    }
  });
}
