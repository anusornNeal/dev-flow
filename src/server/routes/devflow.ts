import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { getCapabilityCatalog } from '../contracts/devflowContract';
import { sendApiError } from '../services/api';
import { listLocalFiles, readLocalFile, searchLocalFiles } from '../services/localFileService';

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

  app.get('/api/local-files/search', (req, res) => {
    try {
      return res.json(searchLocalFiles(deps.state, req.query as Record<string, any>));
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}
