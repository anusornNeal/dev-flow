import { getProjects } from '../repositories/projectRepository.js';
import { getTasks } from '../repositories/taskRepository.js';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { getCapabilityCatalog } from '../contracts/devflowContract';
import { sendApiError } from '../services/api';
import { listLocalFiles, readLocalFile, searchLocalFiles, writeLocalFile } from '../services/localFileService';
import { applyLocalPatch } from '../services/localPatchService';
import { safeEditFile } from '../services/safeEditFileService';
import { runProjectCommand } from '../services/projectCommandService';
import { parseTestReport } from '../services/testReportParserService';
import { getGitLog, getGitDiff, getGitShow, getGitStatus, getGitBranch, commitGitChanges } from '../services/gitService';
import { getProjectStartContext, getRepoContextBundle } from '../services/projectStartContextService';
import { getDevFlowDiagnostics, getToolCallSummary } from '../services/mcpToolMonitor';
import { getWorkflowHealth } from '../services/workflowHealthService';
import { getRepoInspectionIndex } from '../services/repoInspectionIndexService';
import { validateTaskQuality } from '../services/taskQualityService';
import { buildJiraAuthoringBundle } from '../services/jiraAuthoringBundleService';

export function registerDevFlowRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/capabilities', (_req, res) => {
    try {
      const catalog = getCapabilityCatalog();
      return res.json({
        name: 'dev-flow',
        contractVersion: catalog.contractVersion,
        schemaVersion: catalog.contractVersion,
        modules: {
          api: true,
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

  app.get('/api/diagnostics', (req, res) => {
    try {
      const windowMs = Number.isFinite(Number(req.query.windowMs)) ? Number(req.query.windowMs) : undefined;
      return res.json(getDevFlowDiagnostics({ windowMs }));
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

  app.post('/api/local-files/safe-edit', (req, res) => {
    try {
      return res.json(safeEditFile(deps.state, req.body as Record<string, any>));
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

  app.get('/api/git/branch', (req, res) => {
    try {
      return res.json(getGitBranch(deps.state, req.query as Record<string, any>));
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
