import express from 'express';
import type { ApiRouteDeps } from '../types';
import { FigmaService } from '../services/figmaService';
import { saveTask } from '../repositories/taskRepository';

export function registerFigmaRoutes(app: express.Express, deps: ApiRouteDeps) {
  const getService = (req: express.Request, res: express.Response) => {
    const figmaToken = deps.state.settingsCache.figmaToken;
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
      const data = await service.getFigmaNode(req.params.fileKey, [req.params.nodeId]);
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

  app.post('/api/tasks/:taskId/figma-context', async (req, res) => {
    try {
      const service = getService(req, res);
      if (!service) return;

      const { fileKey, nodeId } = req.body;
      if (!fileKey || !nodeId) {
        return res.status(400).json({ error: 'fileKey and nodeId are required' });
      }

      const task = deps.state.tasksCache.find((t) => t.id === req.params.taskId || t.displayId === req.params.taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      const spec = await service.getFigmaDesignSpec(fileKey, nodeId);
      const figmaUrl = `https://www.figma.com/file/${fileKey}?node-id=${nodeId}`;

      task.sourceUrl = figmaUrl;

      const summary = `\n\n## Figma Design Context\nSource: [Figma Node ${nodeId}](${figmaUrl})\nName: ${spec.name}\nType: ${spec.type}\n`;
      const specString = JSON.stringify(spec, null, 2);
      
      const contextSection = `${summary}\n\`\`\`json\n${specString}\n\`\`\`\n`;
      
      if (!task.description) {
        task.description = contextSection;
      } else if (!task.description.includes(figmaUrl)) {
        task.description += contextSection;
      }

      saveTask(task);
      res.json({ success: true, task });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
