import fs from 'fs';
import path from 'path';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { listAgentRunsForTask } from '../repositories/agentRunRepository';
import { getAgentRunHistoryPaths, resolveFromDevFlowAppRoot } from '../services/agentRunService';
import { findTaskByIdentifier } from '../services/taskService';
import { sendApiError } from '../services/api';

/**
 * Read-only compatibility surface for historical legacy agent-run evidence.
 * Fresh-process launch/retry/cancel/completion mutations were retired after the
 * managed execution and external-worker cutovers. New orchestration must never
 * depend on this module for lifecycle mutation.
 */
export function registerLegacyTaskAgentRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/tasks/:id/agent-runs', (req, res) => {
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json({ taskId: task.id, runs: listAgentRunsForTask(task.id) });
  });

  app.get('/api/tasks/:id/agent-runs/:runId/history', (req, res) => {
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const run = listAgentRunsForTask(task.id).find((entry) => entry.id === req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const runDir = run.logPath ? path.dirname(run.logPath) : path.join(resolveFromDevFlowAppRoot('.devflow', 'runs'), run.id);
    return res.json({ taskId: task.id, runId: run.id, files: getAgentRunHistoryPaths(runDir) });
  });

  app.get('/api/tasks/:id/agent-runs/:runId/log', (req, res) => {
    try {
      const task = findTaskByIdentifier(deps.state, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const run = listAgentRunsForTask(task.id).find((entry) => entry.id === req.params.runId);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      const fallbackDir = path.join(resolveFromDevFlowAppRoot('.devflow', 'runs'), run.id);
      const runDir = run.logPath ? path.dirname(run.logPath) : fallbackDir;
      const runsBaseDir = path.resolve(resolveFromDevFlowAppRoot('.devflow', 'runs'));
      const resolvedRunDir = path.resolve(runDir);
      const runsBaseWithSep = runsBaseDir.endsWith(path.sep) ? runsBaseDir : `${runsBaseDir}${path.sep}`;
      if (resolvedRunDir !== runsBaseDir && !resolvedRunDir.startsWith(runsBaseWithSep)) {
        return res.status(403).json({ error: 'Run directory is outside the allowed runs root.' });
      }
      const logPath = path.join(resolvedRunDir, 'agent.log');
      if (!fs.existsSync(logPath)) {
        return res.json({ taskId: task.id, runId: run.id, runStatus: run.status, logPath, content: '', exists: false });
      }
      return res.json({ taskId: task.id, runId: run.id, runStatus: run.status, logPath, content: fs.readFileSync(logPath, 'utf8'), exists: true });
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}
