import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { TASK_SCHEMA_DEF } from '../constants';
import { archiveInactiveDoneTasks, getTasks, queryTaskBoardPage, restoreArchivedTask } from '../repositories/taskRepository.js';
import { getActiveRunForTask, getLatestAgentRunForTask } from '../repositories/agentRunRepository';
import { findTaskByIdentifier, getAgentTaskContext, renderTaskPrompt } from '../services/taskService';
import { buildTaskGitWarnings } from '../services/taskGitWorkflowService';
import {
  filterTasksForList,
  parseTaskReadMode,
  resolveTaskBoardListQuery,
  runThrottledStaleCleanup,
  toTaskResponse,
} from './taskRouteSupport';

export function registerTaskReadRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/schema/task', (_req, res) => res.json(TASK_SCHEMA_DEF));

  app.get('/api/tasks', (_req, res) => {
    runThrottledStaleCleanup(deps);
    const req = _req as express.Request;
    const mode = parseTaskReadMode(req.query.mode, 'full');
    const hasModernQuery = ['mode', 'projectId', 'projectName', 'repo', 'repoUrl', 'localPath', 'parentId', 'status', 'q', 'limit', 'offset', 'archived'].some((key) => req.query[key] !== undefined);
    const boardArchive = mode === 'board' && req.query.archived !== 'true'
      ? archiveInactiveDoneTasks()
      : { archivedCount: 0, skipped: true };
    if (mode === 'board' && typeof req.query.status === 'string') {
      const query = resolveTaskBoardListQuery(deps, req);
      const page = queryTaskBoardPage(query);
      return res.json({
        ...page,
        items: page.items.map((task) => toTaskResponse(task, mode)),
        relatedItems: page.relatedItems.map((task) => toTaskResponse(task, mode)),
        mode,
        archive: boardArchive,
      });
    }
    let filteredTasks = filterTasksForList(deps, req);
    if (mode === 'board') {
      const showArchived = req.query.archived === 'true';
      filteredTasks = filteredTasks.filter((task) => showArchived ? Boolean(task.archivedAt) : !task.archivedAt);
    }
    if (!hasModernQuery) return res.json(getTasks());
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(0, Number(req.query.offset)) : 0;
    const limit = Number.isFinite(Number(req.query.limit))
      ? Math.max(1, Math.min(500, Number(req.query.limit)))
      : filteredTasks.length || 0;
    const pagedTasks = filteredTasks.slice(offset, limit ? offset + limit : undefined);
    return res.json({ items: pagedTasks.map((task) => toTaskResponse(task, mode)), total: filteredTasks.length, offset, limit, mode });
  });

  app.get('/api/tasks/:id', (req, res) => {
    const mode = parseTaskReadMode(req.query.mode, 'standard');
    if (mode === 'agent-context') {
      const context = getAgentTaskContext(deps.state, req.params.id, false);
      if (!context) return res.status(404).json({ error: 'Task not found' });
      const task = findTaskByIdentifier(deps.state, req.params.id);
      return res.json({ ...context, workflowWarnings: task ? buildTaskGitWarnings(task) : [] });
    }
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json(toTaskResponse(task, mode));
  });

  app.post('/api/tasks/:id/restore', (req, res) => {
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const restored = restoreArchivedTask(task.id);
    return res.json({ success: true, task: toTaskResponse(restored, 'standard') });
  });

  app.get('/api/tasks/:id/images', (req, res) => {
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const images = task.designImages || [];
    return res.json({ count: images.length, images });
  });

  app.get('/api/tasks/:id/agent-context', (req, res) => {
    const includeLogs = req.query.includeLogs === 'true' || req.query.mode === 'full' || req.query.mode === 'debug';
    const context = getAgentTaskContext(deps.state, req.params.id, includeLogs);
    if (!context) return res.status(404).json({ error: 'Task not found' });
    const task = findTaskByIdentifier(deps.state, req.params.id);
    return res.json({ ...context, workflowWarnings: task ? buildTaskGitWarnings(task) : [] });
  });

  app.get('/api/tasks/:id/prompt', (req, res) => {
    const includeLogs = req.query.includeLogs === 'true' || req.query.mode === 'full' || req.query.mode === 'debug';
    const context = getAgentTaskContext(deps.state, req.params.id, includeLogs);
    if (!context) return res.status(404).json({ error: 'Task not found' });
    const activeRun = getActiveRunForTask(context.task.id) || getLatestAgentRunForTask(context.task.id);
    try {
      const renderResult = renderTaskPrompt(deps.state, context.task.id, { runId: activeRun?.id || 'preview-run-id', includeLogs }).renderResult;
      res.setHeader('Content-Type', 'text/plain');
      return res.send(renderResult.content);
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || 'Prompt could not be rendered.' });
    }
  });
}
