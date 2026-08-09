import { getProjects } from '../repositories/projectRepository.js';
import { getTasks } from '../repositories/taskRepository.js';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { getCapabilityCatalog, getToolSchema } from '../contracts/devflowContract';
import { createApiError, sendApiError } from '../services/api';
import { listLocalFiles, readFileSnippetsBatch, readLocalFile, searchLocalFiles, writeLocalFile } from '../services/localFileService';
import { applyLocalPatch } from '../services/localPatchService';
import { deleteLocalPath, moveLocalPath } from '../services/localPathMutationService';
import { createPullRequest } from '../services/githubPullRequestService';
import { safeEditFile } from '../services/safeEditFileService';
import { editFilesBatch } from '../services/fileEditBatchService';
import { runProjectCommand } from '../services/projectCommandService';
import { parseTestReport } from '../services/testReportParserService';
import { getGitLog, getGitDiff, getGitShow, getGitStatus, getGitBranchAsync, commitGitChanges, ensureGitBranch, pushGitBranch, getGitSyncStatus, getChangeSummary } from '../services/gitService';
import { getProjectStartContext, getRepoContextBundle, getRepoReadSnapshot } from '../services/projectStartContextService';
import { getDevFlowDiagnostics, getToolCallSummary } from '../services/mcpToolMonitor';
import { getWorkflowHealth } from '../services/workflowHealthService';
import { getRepoInspectionIndex } from '../services/repoInspectionIndexService';
import { validateTaskQuality } from '../services/taskQualityService';
import { buildJiraAuthoringBundle } from '../services/jiraAuthoringBundleService';
import { findProjectByIdentifier } from '../services/taskService';
import { applyProjectAtlasAgentUpdate, getProjectAtlasForApi, getProjectAtlasStatus } from '../services/projectAtlasService';
import { enqueueToolJob } from '../services/mcpToolJobService';
import { getDevFlowRestartStatus, requestDevFlowRestart } from '../services/restartService';
import { applyPreparedEditPlan, prepareEditPlan } from '../services/preparedEditService';
import { prepareCompactEdit } from '../services/stenoEditProtocolService';
import { applyAndVerifyAsync } from '../services/applyAndVerifyService';
import { getRepoContextWithHandle } from '../services/contextHandleService';
import { executeRecoveryAwareTool } from '../services/devFlowRecoveryRuntime.js';
import { getRepoSemanticIndex } from '../services/repoInspectionIndexService';
import { cleanupSessionWorkspace, createOrReuseSessionWorkspace } from '../services/sessionWorkspaceService';
import { abortWorkspaceIntegration, integrateWorkspaceCommits, retryWorkspaceIntegration } from '../services/workspaceIntegrationService';
import { getRuntimeIdentity } from '../services/runtimeIdentityService';

export function registerDevFlowRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/capabilities', (_req, res) => {
    try {
      const catalog = getCapabilityCatalog();
      const runtime = getRuntimeIdentity();
      return res.json({
        name: 'dev-flow',
        contractVersion: catalog.contractVersion,
        runtimeInstanceId: runtime.runtimeInstanceId,
        runtimeStartedAt: runtime.runtimeStartedAt,
        transport: runtime.transport,
        schemaVersion: catalog.contractVersion,
        modules: {
          api: true,
          mcpStreamableHttp: true,
          mcpSse: true,
          mcpStdio: true,
          localFiles: true,
          skills: true,
          agentRuns: true,
        },
        counts: {
          projects: getProjects().length,
          tasks: getTasks().length,
          tools: catalog.tools.length,
        },
        matrix: catalog.matrix,
        workflow: catalog.workflow,
        tools: catalog.tools.map((tool) => ({
          name: tool.name,
          aliases: tool.aliases,
          description: tool.description,
          lightweight: tool.lightweight,
        })),
      });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/capabilities/tools/:toolName', (req, res) => {
    try {
      return res.json(getToolSchema(req.params.toolName));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/diagnostics', (req, res) => {
    try {
      const windowMs = Number.isFinite(Number(req.query.windowMs)) ? Number(req.query.windowMs) : undefined;
      const previousContractVersion = typeof req.query.previousContractVersion === 'string' ? req.query.previousContractVersion : undefined;
      const previousRuntimeInstanceId = typeof req.query.previousRuntimeInstanceId === 'string' ? req.query.previousRuntimeInstanceId : undefined;
      const clientToolsVisible = req.query.clientToolsVisible === 'true'
        ? true
        : req.query.clientToolsVisible === 'false'
          ? false
          : undefined;
      const clientState = previousContractVersion || previousRuntimeInstanceId || clientToolsVisible !== undefined
        ? {
            contractVersion: previousContractVersion,
            runtimeInstanceId: previousRuntimeInstanceId,
            toolsVisible: clientToolsVisible,
          }
        : undefined;
      return res.json(getDevFlowDiagnostics({ windowMs, clientState }));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/workflow-health', (req, res) => {
    try {
      return res.json(getWorkflowHealth(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/restart', (req, res) => {
    try {
      if (!deps.restartProcess) {
        throw createApiError(409, 'RESTART_UNSUPPORTED', 'This DevFlow host cannot schedule a safe process restart.');
      }
      const result = requestDevFlowRestart(req.body as Record<string, any>);
      if (!result.duplicate) {
        res.once('finish', () => {
          deps.restartProcess?.(result.exitCode, result.shutdownDelayMs);
        });
      }
      return res.json(result);
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/restart/status', (req, res) => {
    try {
      return res.json(getDevFlowRestartStatus(req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/workspaces/prepare', (req, res) => {
    try {
      const project = findProjectByIdentifier(deps.state, req.body || {});
      if (!project) throw createApiError(404, 'PROJECT_NOT_FOUND', 'Project could not be resolved for workspace preparation.');
      return res.json(createOrReuseSessionWorkspace(project, req.body?.sessionId));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/workspaces/integrate', (req, res) => {
    try {
      const result = integrateWorkspaceCommits(req.body?.workspaceId);
      return res.status(result.status === 'conflict' ? 409 : 200).json(result);
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/workspaces/integration/abort', (req, res) => {
    try {
      return res.json(abortWorkspaceIntegration(req.body?.workspaceId));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/workspaces/integration/retry', (req, res) => {
    try {
      const result = retryWorkspaceIntegration(req.body?.workspaceId);
      return res.status(result.status === 'conflict' ? 409 : 200).json(result);
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/workspaces/cleanup', (req, res) => {
    try {
      return res.json(cleanupSessionWorkspace(req.body?.workspaceId));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/local-files', (req, res) => {
    try {
      return res.json(listLocalFiles(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/local-files/read', (req, res) => {
    try {
      return res.json(readLocalFile(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/read-batch', async (req, res) => {
    try {
      const args = req.body as Record<string, any>;
      const result = await executeRecoveryAwareTool(
        deps.state,
        'read_file_snippets_batch',
        args,
        (payload) => readFileSnippetsBatch(deps.state, payload),
      );
      return res.json(result);
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/write', (req, res) => {
    try {
      return res.json(writeLocalFile(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/apply-patch', (req, res) => {
    try {
      return res.json(applyLocalPatch(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/delete', (req, res) => {
    try {
      return res.json(deleteLocalPath(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/move', (req, res) => {
    try {
      return res.json(moveLocalPath(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/safe-edit', (req, res) => {
    try {
      return res.json(safeEditFile(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/edit-batch', (req, res) => {
    try {
      return res.json(editFilesBatch(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/edit-plans/prepare', (req, res) => {
    try {
      return res.json(prepareEditPlan(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/edit-plans/apply', async (req, res) => {
    try {
      const args = req.body as Record<string, any>;
      const result = await executeRecoveryAwareTool(
        deps.state,
        'apply_prepared_edit_plan',
        args,
        (payload) => applyPreparedEditPlan(payload),
      );
      return res.json(result);
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/compact-edit/prepare', (req, res) => {
    try {
      return res.json(prepareCompactEdit(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/local-files/compact-edit/apply', async (req, res) => {
    try {
      const args = { editPlanId: req.body?.editPlanId };
      const result = await executeRecoveryAwareTool(
        deps.state,
        'apply_prepared_edit',
        args,
        (payload) => applyPreparedEditPlan(payload),
      );
      return res.json(result);
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/workflows/apply-and-verify', async (req, res) => {
    try {
      return res.json(await applyAndVerifyAsync(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/project-commands/run', (req, res) => {
    try {
      return res.json(runProjectCommand(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/test-reports/parse', (req, res) => {
    try {
      return res.json(parseTestReport(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/local-files/search', (req, res) => {
    try {
      return res.json(searchLocalFiles(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/project-start-context', (req, res) => {
    try {
      return res.json(getProjectStartContext(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/repo-context-bundle', (req, res) => {
    try {
      return res.json(getRepoContextBundle(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/repo-context/delta', (req, res) => {
    try {
      return res.json(getRepoContextWithHandle(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/repo-read-snapshot', (req, res) => {
    try {
      return res.json(getRepoReadSnapshot(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/tool-monitor/summary', (req, res) => {
    try {
      const windowMs = Number.isFinite(Number(req.query.windowMs)) ? Number(req.query.windowMs) : undefined;
      return res.json(getToolCallSummary({ windowMs }));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/repo-inspection-index', (req, res) => {
    try {
      return res.json(getRepoInspectionIndex(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/repo-inspection/semantic', (req, res) => {
    try {
      return res.json(getRepoSemanticIndex(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/project-atlas', (req, res) => {
    try {
      const project = findProjectByIdentifier(deps.state, req.query as Record<string, any>);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      return res.json(getProjectAtlasForApi(project, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/project-atlas/status', (req, res) => {
    try {
      const project = findProjectByIdentifier(deps.state, req.query as Record<string, any>);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      return res.json(getProjectAtlasStatus(project.id));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/project-atlas/agent-update', (req, res) => {
    try {
      const project = findProjectByIdentifier(deps.state, req.body as Record<string, any>);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (req.body?.sync === true) {
        const { sync, ...patch } = req.body as Record<string, any>;
        const result = applyProjectAtlasAgentUpdate(project, patch);
        return res.status(result.ok ? 200 : 400).json(result);
      }
      return res.json(enqueueToolJob(deps.state, 'apply_project_atlas_agent_update', { ...req.body, projectId: project.id }, 'repo-write'));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/task-quality/validate', (req, res) => {
    try {
      return res.json(validateTaskQuality(req.body));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/jira/authoring-bundle', async (req, res) => {
    try {
      return res.json(await buildJiraAuthoringBundle(req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/git/log', (req, res) => {
    try {
      return res.json(getGitLog(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/git/diff', (req, res) => {
    try {
      return res.json(getGitDiff(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/git/show', (req, res) => {
    try {
      return res.json(getGitShow(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/git/status', (req, res) => {
    try {
      return res.json(getGitStatus(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/git/change-summary', (req, res) => {
    try {
      return res.json(getChangeSummary(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/git/branch', async (req, res) => {
    try {
      return res.json(await getGitBranchAsync(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/git/branch/ensure', (req, res) => {
    try {
      return res.json(ensureGitBranch(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/git/push', (req, res) => {
    try {
      return res.json(pushGitBranch(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/git/sync-status', (req, res) => {
    try {
      return res.json(getGitSyncStatus(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/github/pull-requests', async (req, res) => {
    try {
      return res.json(await createPullRequest(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/git/commit', (req, res) => {
    try {
      return res.json(commitGitChanges(deps.state, req.body as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}
