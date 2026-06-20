import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { getCapabilityCatalog } from '../contracts/devflowContract';
import { sendApiError } from '../services/api';
import { listLocalFiles, readLocalFile, searchLocalFiles, writeLocalFile } from '../services/localFileService';
import { getGitLog, getGitDiff, getGitShow, getGitStatus, getGitBranch } from '../services/gitService';
import { getProjectStartContext } from '../services/projectStartContextService';
import { getToolCallSummary } from '../services/mcpToolMonitor';
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
          projects: deps.state.projectsCache.length,
          tasks: deps.state.tasksCache.length,
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
      return res.json(await buildJiraAuthoringBundle(deps.state, req.query as Record<string, any>));
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
}
