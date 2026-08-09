import { getSettings } from '../repositories/settingsRepository.js';
import express from 'express';
import type { ApiRouteDeps } from '../types';
import { FigmaService } from '../services/figmaService';
import { applyFigmaAuthoringContextToTask, buildFigmaAuthoringContext, MAX_FIGMA_AUTHORING_NODES } from '../services/figmaAuthoringContextService';
import { saveTask, getTasks } from '../repositories/taskRepository.js';

function parseNodeIds(value: string) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function requestedNodeIds(body: any): string[] {
  const values: unknown[] = Array.isArray(body?.nodeIds) ? body.nodeIds : body?.nodeId ? [body.nodeId] : [];
  return [...new Set(values.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

export function registerFigmaRoutes(app: express.Express, deps: ApiRouteDeps) {
  const getService = (req: express.Request, res: express.Response) => {
    const figmaToken = getSettings().figmaToken;
    if (!figmaToken) {
      res.status(400).json({ error: 'Figma token not configured in settings.' });
      return null;
    }
    return new FigmaService(figmaToken);
  };

  app.get('/api/figma/file/:fileKey', async (req, res) => {
    try {
      const service = getService(req, res);
      if (!service) return;
      const data = await service.getFigmaFile(req.params.fileKey);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/figma/file/:fileKey/node/:nodeId', async (req, res) => {
    try {
      const service = getService(req, res);
      if (!service) return;
      const data = await service.getFigmaNode(req.params.fileKey, parseNodeIds(req.params.nodeId));
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/figma/file/:fileKey/node/:nodeId/spec', async (req, res) => {
    try {
      const service = getService(req, res);
      if (!service) return;
      const data = await service.getFigmaDesignSpec(req.params.fileKey, req.params.nodeId);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/figma/authoring-context', async (req, res) => {
    try {
      const service = getService(req, res);
      if (!service) return;
      const fileKey = String(req.body?.fileKey || '').trim();
      const nodeIds = requestedNodeIds(req.body);
      if (!fileKey || nodeIds.length === 0) return res.status(400).json({ error: 'fileKey and at least one nodeId are required' });
      if (nodeIds.length > MAX_FIGMA_AUTHORING_NODES) return res.status(400).json({ error: `At most ${MAX_FIGMA_AUTHORING_NODES} nodeIds are supported` });
      const context = await buildFigmaAuthoringContext(service, fileKey, nodeIds);
      return res.json(context);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/tasks/:taskId/figma-context', async (req, res) => {
    try {
      const service = getService(req, res);
      if (!service) return;

      const fileKey = String(req.body?.fileKey || '').trim();
      const nodeIds = requestedNodeIds(req.body);
      if (!fileKey || nodeIds.length === 0) {
        return res.status(400).json({ error: 'fileKey and at least one nodeId are required' });
      }
      if (nodeIds.length > MAX_FIGMA_AUTHORING_NODES) {
        return res.status(400).json({ error: `At most ${MAX_FIGMA_AUTHORING_NODES} nodeIds are supported` });
      }

      const task = getTasks().find((t) => t.id === req.params.taskId || t.displayId === req.params.taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      const context = await buildFigmaAuthoringContext(service, fileKey, nodeIds);
      applyFigmaAuthoringContextToTask(task, context);
      saveTask(task);
      res.json({ success: true, task, figma: context });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
