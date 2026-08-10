import type express from 'express';
import type { ApiRouteDeps } from '../types.js';
import { sendApiError } from '../services/api.js';
import { claimTaskForSession, releaseTaskClaim } from '../services/taskClaimService.js';
import { toMutationResponse } from './taskRouteSupport.js';

export function registerTaskClaimRoutes(app: express.Express, _deps: ApiRouteDeps) {
  app.post('/api/tasks/:id/claim', (req, res) => {
    try {
      const result = claimTaskForSession(req.params.id, req.body || {});
      return res.json(toMutationResponse(req, result.task, result));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/tasks/:id/claim/release', (req, res) => {
    try {
      const result = releaseTaskClaim(req.params.id, req.body || {});
      return res.json(toMutationResponse(req, result.task, result));
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}
