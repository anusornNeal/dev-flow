import express from 'express';
import type { ApiRouteDeps } from '../types';
import { getZrokRuntimeService, type ZrokRuntimeService } from '../services/zrokRuntimeService.js';

function takeoverHttpStatus(result: Awaited<ReturnType<ZrokRuntimeService['takeOver']>>) {
  if (result.ok) return 200;
  switch (result.code) {
    case 'ZROK_TAKEOVER_NOT_AVAILABLE':
    case 'ZROK_TAKEOVER_REMOTE_FENCE_UNAVAILABLE':
    case 'ZROK_TAKEOVER_STALE_OWNER':
      return 409;
    case 'ZROK_TAKEOVER_REMOTE_FENCE_FAILED':
    case 'ZROK_TAKEOVER_LOCAL_SHARE_FAILED':
    case 'ZROK_TAKEOVER_VERIFY_FAILED':
      return 502;
    default:
      return 500;
  }
}

export function registerZrokRoutes(
  app: express.Express,
  _deps: ApiRouteDeps,
  runtime: ZrokRuntimeService = getZrokRuntimeService(),
) {
  app.get('/api/zrok/status', async (_req, res) => {
    try {
      return res.json(await runtime.getStatus());
    } catch {
      return res.status(500).json({
        error: 'zrok status could not be read safely.',
        code: 'ZROK_STATUS_FAILED',
      });
    }
  });

  app.post('/api/zrok/takeover', async (_req, res) => {
    try {
      const result = await runtime.takeOver();
      return res.status(takeoverHttpStatus(result)).json(result);
    } catch {
      return res.status(500).json({
        ok: false,
        changed: false,
        error: 'zrok takeover failed safely.',
        code: 'ZROK_TAKEOVER_FAILED',
      });
    }
  });
}
