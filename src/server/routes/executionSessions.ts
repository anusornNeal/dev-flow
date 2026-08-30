import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { createApiError, sendApiError } from '../services/api';
import { findProjectByIdentifier } from '../services/taskService';
import { getExecutionSessionState } from '../services/executionSessionService';
import { createExecutionHandoffSnapshot, getExecutionSessionResumeView } from '../services/executionSessionHandoffService';
import { resolveSessionWorkspace } from '../services/sessionWorkspaceService';
import { evaluateExecutionContinuation } from '../services/executionContinuationService';
import { continueAutonomousTailWithCommitIntent } from '../services/mcpToolJobService';

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
        details: {
          recoveryBlocker: 'EXECUTION_WORKSPACE_UNAVAILABLE',
          replacementExecutionAllowed: false,
          guidance: 'Recover or revalidate the existing logical workspace before resuming; never create a replacement execution automatically.',
        },
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
  app.get('/api/execution-sessions/:executionSessionId/continuation', (req, res) => {
    try {
      const executionSessionId = String(req.params.executionSessionId || '').trim();
      const workspaceId = typeof req.query?.workspaceId === 'string' ? req.query.workspaceId : undefined;
      const repoRoot = resolveActiveExecutionRepoRoot(deps, executionSessionId, workspaceId);
      return res.json(evaluateExecutionContinuation(deps.state, executionSessionId, {
        repoRoot,
        workspaceId,
        boardLoopRequested: req.query?.boardLoopRequested === 'true',
      }));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/execution-sessions/:executionSessionId/continue-tail', (req, res) => {
    try {
      const executionSessionId = String(req.params.executionSessionId || '').trim();
      const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : undefined;
      resolveActiveExecutionRepoRoot(deps, executionSessionId, workspaceId);
      return res.json(continueAutonomousTailWithCommitIntent(deps.state, {
        executionSessionId,
        triggerJobId: String(req.body?.triggerJobId || ''),
        commitMessage: String(req.body?.commitMessage || ''),
        workspaceId,
      }));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/execution-sessions/:executionSessionId/resume', (req, res) => {
    try {
      const executionSessionId = String(req.params.executionSessionId || '').trim();
      const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : undefined;
      const repoRoot = resolveActiveExecutionRepoRoot(deps, executionSessionId, workspaceId);
      const resume = getExecutionSessionResumeView(deps.state, executionSessionId, {
        repoRoot,
        workspaceId,
        receivingAgent: typeof req.body?.receivingAgent === 'string' ? req.body.receivingAgent : undefined,
      });
      return res.json({
        ...resume,
        executionContinuation: evaluateExecutionContinuation(deps.state, executionSessionId, { repoRoot, workspaceId }),
      });
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
