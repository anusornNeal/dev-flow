import type express from 'express';
import type { ApiRouteDeps } from '../types.js';
import { sendApiError } from '../services/api.js';
import { claimNextTaskForSession, claimTaskForSession, expandTaskClaimScope, releaseTaskClaim } from '../services/taskClaimService.js';
import { toMutationResponse } from './taskRouteSupport.js';

export function registerTaskClaimRoutes(app: express.Express, _deps: ApiRouteDeps) {
  app.post('/api/tasks/claim-next', (req, res) => {
    try {
      const body = req.body || {};
      const result = claimNextTaskForSession(body.projectId, body);
      if (result.status === 'no-eligible') return res.json(result);
      return res.json(toMutationResponse(req, result.task, result));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/tasks/:id/claim', (req, res) => {
    try {
      const result = claimTaskForSession(req.params.id, req.body || {});
      return res.json(toMutationResponse(req, result.task, result));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/tasks/:id/claim/scope', (req, res) => {
    try {
      const body = req.body || {};
      const result = expandTaskClaimScope(req.params.id, body);
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
