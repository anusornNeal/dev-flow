import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { createApiError, sendApiError } from '../services/api';
import { findProjectByIdentifier } from '../services/taskService';
import { getExecutionSessionState } from '../services/executionSessionService';
import { createExecutionHandoffSnapshot, getExecutionSessionResumeView } from '../services/executionSessionHandoffService';
import { resolveSessionWorkspace } from '../services/sessionWorkspaceService';

function resolveActiveExecutionRepoRoot(deps: ApiRouteDeps, executionSessionId: string, requestedWorkspaceId?: string | null) {
  const { session } = getExecutionSessionState(executionSessionId);
  if (session.status !== 'active') return undefined;

  const requested = String(requestedWorkspaceId || '').trim() || null;
  if (requested && session.workspaceId && requested !== session.workspaceId) return undefined;

  const workspaceId = requested || session.workspaceId;
  if (workspaceId) {
    const workspace = resolveSessionWorkspace(workspaceId);
    if (!workspace) {
      throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found for execution session '${executionSessionId}'.`, {
        affectedId: workspaceId,
      });
    }
    if (workspace.projectId !== session.projectId) {
      throw createApiError(409, 'EXECUTION_WORKSPACE_PROJECT_MISMATCH', 'Execution session workspace belongs to a different project.', {
        affectedId: workspaceId,
        details: { executionProjectId: session.projectId, workspaceProjectId: workspace.projectId },
      });
    }
    return workspace.root;
  }

  const project = findProjectByIdentifier(deps.state, { projectId: session.projectId });
  const projectRoot = String(project?.localPath || '').trim();
  if (!projectRoot) {
    throw createApiError(404, 'EXECUTION_PROJECT_ROOT_UNAVAILABLE', `Project root is unavailable for execution session '${executionSessionId}'.`, {
      affectedId: session.projectId,
    });
  }
  return projectRoot;
}

export function registerExecutionSessionRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.post('/api/execution-sessions/:executionSessionId/resume', (req, res) => {
    try {
      const executionSessionId = String(req.params.executionSessionId || '').trim();
      const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : undefined;
      const repoRoot = resolveActiveExecutionRepoRoot(deps, executionSessionId, workspaceId);
      return res.json(getExecutionSessionResumeView(deps.state, executionSessionId, {
        repoRoot,
        workspaceId,
        receivingAgent: typeof req.body?.receivingAgent === 'string' ? req.body.receivingAgent : undefined,
      }));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/execution-sessions/:executionSessionId/handoff', (req, res) => {
    try {
      const executionSessionId = String(req.params.executionSessionId || '').trim();
      const repoRoot = resolveActiveExecutionRepoRoot(deps, executionSessionId);
      return res.json(createExecutionHandoffSnapshot(deps.state, executionSessionId, req.body || {}, { repoRoot }));
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}
