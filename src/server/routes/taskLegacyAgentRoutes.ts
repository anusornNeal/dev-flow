import fs from 'fs';
import path from 'path';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { AgentOrchestrationWorker } from '../services/agentOrchestrationWorker';
import { getSettings } from '../repositories/settingsRepository.js';
import { getActiveRunForTask, getLatestAgentRunForTask, listAgentRunsForTask } from '../repositories/agentRunRepository';
import { saveTask } from '../repositories/taskRepository.js';
import { getAgentRunHistoryPaths, resolveFromDevFlowAppRoot } from '../services/agentRunService';
import { findTaskByIdentifier, normalizeAgentCompletionPayload, validateAgentCompletionPayload } from '../services/taskService';
import { sendApiError } from '../services/api';
import { taskHasLifecycleOwnership } from '../services/taskClaimService.js';
import { canRetryRun as canRetryRunUseCase, validateCompletion as validateCompletionUseCase } from '../useCases/agentRunUseCases';
import {
  appendTaskLog,
  applyRunSummaryToTask,
  continueTaskQueueForProject,
  persistTaskMutationWithLifecycle,
  requireAgentOwnedRequest,
  type TriggerTaskAgentFailure,
} from './taskRouteSupport';

/**
 * Legacy agent-run HTTP surface kept isolated from the main task route composition.
 * New execution-session architecture must not build new dependencies on these routes.
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

  app.post('/api/tasks/:id/agent-runs/retry', (req, res) => {
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const activeRun = getActiveRunForTask(task.id);
    if (activeRun) return res.status(409).json({ error: `Task already has active run ${activeRun.id}`, run: activeRun });
    const latestRun = getLatestAgentRunForTask(task.id);
    if (!latestRun || !canRetryRunUseCase(latestRun as any)) return res.status(400).json({ error: 'Only a failed latest run can be retried.' });
    const result = AgentOrchestrationWorker.trigger(task, deps, 'retry endpoint', latestRun.id);
    saveTask(task);
    if (!result.triggered) {
      const blockedResult = result as TriggerTaskAgentFailure;
      return res.status(400).json({ error: blockedResult.reason, code: blockedResult.code, run: blockedResult.run });
    }
    return res.status(201).json({ success: true, run: result.run, task });
  });

  app.post('/api/tasks/:id/agent-runs/cancel', (req, res) => {
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'cancelled manually';
    const cancelledCount = AgentOrchestrationWorker.cancelRuns(task.id, reason);
    let persistedTask = task;
    if (cancelledCount > 0) {
      task.updatedAt = new Date().toISOString();
      appendTaskLog(task, `Agent run cancelled: ${reason}`, 'update');
    }
    applyRunSummaryToTask(task, getLatestAgentRunForTask(task.id));
    if (cancelledCount > 0 && !taskHasLifecycleOwnership(task)) {
      persistedTask = persistTaskMutationWithLifecycle(task, { ...task, status: 'todo' }, 'legacy agent run cancellation');
    } else {
      if (cancelledCount > 0 && taskHasLifecycleOwnership(task)) {
        appendTaskLog(task, 'Legacy agent run cancelled; Chat lifecycle ownership and task lane were preserved.', 'update');
      }
      saveTask(task);
      persistedTask = task;
    }
    return res.json({ success: true, cancelledCount, task: persistedTask, runs: listAgentRunsForTask(task.id) });
  });

  app.post('/api/tasks/:id/agent-complete', (req, res) => {
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!requireAgentOwnedRequest(req)) return res.status(403).json({ error: 'Agent completion callback requires x-agent-request=true.' });
    const payloadError = validateAgentCompletionPayload(req.body);
    if (payloadError) return res.status(400).json({ error: payloadError });
    const useCaseValidation = validateCompletionUseCase({ status: req.body.status, summary: req.body.summary });
    if (!useCaseValidation.ok) return res.status(400).json({ error: useCaseValidation.reason });
    const payload = normalizeAgentCompletionPayload(req.body);
    const activeRun = getActiveRunForTask(task.id);
    const latestRun = getLatestAgentRunForTask(task.id);
    const run = payload.runId ? [activeRun, latestRun, ...listAgentRunsForTask(task.id)].find((entry) => entry?.id === payload.runId) || null : activeRun;
    if (!run) return res.status(409).json({ error: 'No matching active run was found for this task.' });
    if (payload.runId && run.id !== payload.runId) return res.status(409).json({ error: 'Completion callback runId does not match the task active run.' });
    if (!['queued', 'starting', 'running'].includes(run.status)) return res.status(409).json({ error: `Run ${run.id} is already settled with status ${run.status}.` });
    try {
      const result = AgentOrchestrationWorker.applyCompletionCallback(task, run, deps, payload);
      if (getSettings().autoWork && payload.status === 'success') continueTaskQueueForProject(task.projectId, deps);
      return res.json({ success: true, task: result.task, run: result.run });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/tasks/:id/agent-runs/:runId/complete', (req, res) => {
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const run = getActiveRunForTask(task.id) || getLatestAgentRunForTask(task.id);
    if (!run || run.id !== req.params.runId) return res.status(404).json({ error: 'Run not found or not associated with task.' });
    const payload = normalizeAgentCompletionPayload({
      runId: req.params.runId,
      status: req.body?.success === false ? 'failed' : 'success',
      summary: req.body?.errorMessage || (req.body?.success === false ? 'Run failed' : 'Run completed successfully'),
      changedFiles: [], tests: [],
    });
    const result = AgentOrchestrationWorker.applyCompletionCallback(task, run, deps, payload);
    if (getSettings().autoWork && payload.status === 'success') continueTaskQueueForProject(task.projectId, deps);
    return res.json({ success: true, task: result.task, run: result.run });
  });
}
