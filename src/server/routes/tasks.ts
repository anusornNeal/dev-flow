import { getSettings } from '../repositories/settingsRepository.js';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import db from '../../db/index';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { TASK_SCHEMA_DEF, VALID_AGENTS, LEGACY_VALID_EFFORTS_FALLBACK, VALID_MODELS, VALID_STATUSES } from '../constants';
import { ACTIVE_AGENT_RUN_STATUSES, cancelActiveRunsForTask, cancelStaleActiveRuns, createAgentRun, getActiveRunForProjectAndAgent, getActiveRunForTask, getLatestAgentRunForTask, listActiveRunSummariesForProject, listAgentRunsForTask, updateAgentRunStatus, type AgentRun } from '../repositories/agentRunRepository';
import { deleteTasksByIds, loadTasks, generateDisplayId, saveTask, saveTasks } from '../repositories/taskRepository';
import { listAttachmentsForTask } from '../repositories/attachmentRepository';
import { appendAgentRunLog, buildAgentCompletionSummary, createAgentRunFiles, createAgentRunResultRecord, getAgentRunHistoryPaths, getAgentTriggerScriptPath, getDevFlowApiBaseUrl, resolveAgentExecutionMode, resolveFromDevFlowAppRoot, writeAgentRunLaunchMetadata, writeAgentRunOutputSummary, writeAgentRunResult } from '../services/agentRunService';
import { extractImages, extractDesignImages, findProjectByIdentifier, findTaskByIdentifier, getAgentTaskContext, normalizeAgentCompletionPayload, normalizeTaskCategoryAndTags, applyTaskCategoryAndTagsUpdate, renderTaskPrompt, resolveProjectIdFromRepo, validateAgentCompletionPayload, validateAgentParams, validateTaskPayload } from '../services/taskService';
import { validateTaskQualityForMutation } from '../services/taskQualityService';
import { createApiError, sendApiError } from '../services/api';
import { draftTaskFromJiraBundle } from '../services/compositeAuthoringService';
import { acquireLock, releaseLock, withIdempotency, getIdempotencyResult, createPendingIdempotencyWithFingerprint, resolvePendingIdempotency, rejectPendingIdempotency, buildIdempotencyFingerprint } from '../services/lockAndIdempotencyService';
import { validateEnum, validateString } from '../validation';
import { isValidTransition, getValidationErrorMessage } from '../../lib/statusTransitions';
import { buildAgentLaunchConfig, runAgentLaunchPreflight, type AgentLaunchPreflightCode } from '../services/agentLaunchConfig';
import { applyChecklistToggle as applyChecklistToggleUseCase, validateTaskPatch as validateTaskPatchUseCase } from '../useCases/taskUseCases';
import { canRetryRun as canRetryRunUseCase, canCancelRun as canCancelRunUseCase, validateCompletion as validateCompletionUseCase } from '../useCases/agentRunUseCases';
import type { AgentCompletionPayload, AgentCompletionStatus, TaskStatus } from '../../types';
import { registerTaskBatchRoutes } from './taskBatchRoutes';
import { registerTaskImportFileRoute } from './taskImportFileRoute';

import {
  applyAgentCompletionCallback,
  applyRunSummaryToTask,
  appendTaskLog,
  canOverrideTaskLock,
  completeAgentRunForTask,
  continueTaskQueueForProject,
  createTaskLogEntry,
  filterTasksForList,
  getTaskIndexByIdentifier,
  maybeTriggerTaskAgent,
  parseTaskReadMode,
  requireAgentOwnedRequest,
  runThrottledStaleCleanup,
  stripRequestControlFields,
  syncTaskAgentStateForStatus,
  toMutationListResponse,
  toMutationResponse,
  toTaskResponse,
  triggerTaskAgent,
  type TriggerTaskAgentFailure,
  validateParentReviewMove,
} from './taskRouteSupport';
export { completeAgentRunForTask, continueTaskQueueForProject, triggerTaskAgent } from './taskRouteSupport';
export function registerTaskRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/schema/task', (_req, res) => {
    res.json(TASK_SCHEMA_DEF);
  });

  app.get('/api/tasks', (_req, res) => {
    runThrottledStaleCleanup(deps);
    const req = _req as express.Request;
    const mode = parseTaskReadMode(req.query.mode, 'full');
    const hasModernQuery = ['mode', 'projectId', 'projectName', 'repo', 'repoUrl', 'localPath', 'parentId', 'status', 'q', 'limit', 'offset'].some((key) => req.query[key] !== undefined);
    const filteredTasks = filterTasksForList(deps, req);

    if (!hasModernQuery) {
      return res.json(deps.state.tasksCache);
    }

    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(0, Number(req.query.offset)) : 0;
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.max(1, Math.min(500, Number(req.query.limit))) : filteredTasks.length || 0;
    const pagedTasks = filteredTasks.slice(offset, limit ? offset + limit : undefined);

    return res.json({
      items: pagedTasks.map((task) => toTaskResponse(task, mode)),
      total: filteredTasks.length,
      offset,
      limit,
      mode,
    });
  });

  app.get('/api/tasks/:id', (req, res) => {
    const mode = parseTaskReadMode(req.query.mode, 'standard');

    if (mode === 'agent-context') {
      const context = getAgentTaskContext(deps.state, req.params.id, false);
      if (!context) return res.status(404).json({ error: 'Task not found' });
      return res.json(context);
    }

    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json(toTaskResponse(task, mode));
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
    return res.json(context);
  });

  app.get('/api/tasks/:id/prompt', (req, res) => {
    const includeLogs = req.query.includeLogs === 'true' || req.query.mode === 'full' || req.query.mode === 'debug';
    const context = getAgentTaskContext(deps.state, req.params.id, includeLogs);
    if (!context) return res.status(404).json({ error: 'Task not found' });

    const activeRun = getActiveRunForTask(context.task.id) || getLatestAgentRunForTask(context.task.id);
    let renderResult;
    try {
      renderResult = renderTaskPrompt(deps.state, context.task.id, {
        runId: activeRun?.id || 'preview-run-id',
        includeLogs,
      }).renderResult;
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || 'Prompt could not be rendered.' });
    }

    res.setHeader('Content-Type', 'text/plain');
    return res.send(renderResult.content);
  });

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
    return res.json({
      taskId: task.id,
      runId: run.id,
      files: getAgentRunHistoryPaths(runDir),
    });
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
        return res.json({
          taskId: task.id,
          runId: run.id,
          runStatus: run.status,
          logPath,
          content: '',
          exists: false,
        });
      }
      const content = fs.readFileSync(logPath, 'utf8');
      return res.json({
        taskId: task.id,
        runId: run.id,
        runStatus: run.status,
        logPath,
        content,
        exists: true,
      });
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
    if (!latestRun || !canRetryRunUseCase(latestRun as any)) {
      return res.status(400).json({ error: 'Only a failed latest run can be retried.' });
    }

    const retryTransaction = db.transaction(() => {
      const txResult = triggerTaskAgent(task, deps, 'retry endpoint', latestRun.id);
      saveTask(task);
      return txResult;
    });
    const result = retryTransaction();
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
    const cancelTransaction = db.transaction(() => {
      const count = cancelActiveRunsForTask(task.id, reason);
      if (count > 0) {
        task.status = 'todo';
        task.updatedAt = new Date().toISOString();
        appendTaskLog(task, `Agent run cancelled: ${reason}`, 'update');
      }
      applyRunSummaryToTask(task, getLatestAgentRunForTask(task.id));
      saveTask(task);
      return count;
    });
    const cancelledCount = cancelTransaction();
    return res.json({ success: true, cancelledCount, task, runs: listAgentRunsForTask(task.id) });
  });

  app.post('/api/tasks/:id/agent-complete', (req, res) => {
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    if (!requireAgentOwnedRequest(req)) {
      return res.status(403).json({ error: 'Agent completion callback requires x-agent-request=true.' });
    }

    const payloadError = validateAgentCompletionPayload(req.body);
    if (payloadError) {
      return res.status(400).json({ error: payloadError });
    }

    // Use-case level guard: the summary + status invariants live in agentRunUseCases so the
    // route handler does not have to redeclare them. We layer the check after the field-level
    // service validation so the response code stays 400 for both.
    const useCaseValidation = validateCompletionUseCase({
      status: req.body.status,
      summary: req.body.summary,
    });
    if (!useCaseValidation.ok) {
      return res.status(400).json({ error: useCaseValidation.reason });
    }

    const payload = normalizeAgentCompletionPayload(req.body);
    const activeRun = getActiveRunForTask(task.id);
    const latestRun = getLatestAgentRunForTask(task.id);
    const run = payload.runId
      ? [activeRun, latestRun, ...listAgentRunsForTask(task.id)].find((entry) => entry?.id === payload.runId) || null
      : activeRun;

    if (!run) {
      return res.status(409).json({ error: 'No matching active run was found for this task.' });
    }

    if (payload.runId && run.id !== payload.runId) {
      return res.status(409).json({ error: 'Completion callback runId does not match the task active run.' });
    }

    if (!['queued', 'starting', 'running'].includes(run.status)) {
      return res.status(409).json({ error: `Run ${run.id} is already settled with status ${run.status}.` });
    }

    try {
      const result = applyAgentCompletionCallback(task, run, deps, payload);
      if (getSettings().autoWork && payload.status === 'success') {
        continueTaskQueueForProject(task.projectId, deps);
      }
      return res.json({
        success: true,
        task: result.task,
        run: result.run,
      });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/tasks/:id/agent-runs/:runId/complete', (req, res) => {
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const run = getActiveRunForTask(task.id) || getLatestAgentRunForTask(task.id);
    if (!run || run.id !== req.params.runId) {
       return res.status(404).json({ error: 'Run not found or not associated with task.' });
    }

    const payload = normalizeAgentCompletionPayload({
      runId: req.params.runId,
      status: req.body?.success === false ? 'failed' : 'success',
      summary: req.body?.errorMessage || (req.body?.success === false ? 'Run failed' : 'Run completed successfully'),
      changedFiles: [],
      tests: [],
    });
    const result = applyAgentCompletionCallback(task, run, deps, payload);

    if (getSettings().autoWork && payload.status === 'success') {
      continueTaskQueueForProject(task.projectId, deps);
    }

    return res.json({ success: true, task: result.task, run: result.run });
  });

  app.post('/api/tasks/draft-from-jira', async (req, res, next) => {
    try {
      const fingerprint = buildIdempotencyFingerprint(req.method, req.path, req.body);
      const payload = await withIdempotency(req.body.idempotencyKey, fingerprint, async () => {
        return await draftTaskFromJiraBundle(deps.state, req.body);
      });
      res.json(payload);
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post('/api/tasks', async (req, res, next) => {
    const idempotencyKey = req.body?.idempotencyKey;
    const idempotencyFingerprint = idempotencyKey
      ? buildIdempotencyFingerprint(req.method, req.path, req.body)
      : undefined;
    if (idempotencyKey) {
      let cached;
      try {
        cached = getIdempotencyResult(idempotencyKey, idempotencyFingerprint);
      } catch (err) {
        return sendApiError(res, err);
      }
      if (cached !== undefined) {
        if (cached instanceof Promise) {
          try {
            const resolved = await cached;
            return res.json(resolved);
          } catch (err: any) {
            return next(err);
          }
        }
        return res.json(cached);
      }
      createPendingIdempotencyWithFingerprint(idempotencyKey, idempotencyFingerprint);
      const originalJson = res.json;
      res.json = function (body) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolvePendingIdempotency(idempotencyKey, body);
        } else {
          rejectPendingIdempotency(idempotencyKey, new Error(`Request failed with status ${res.statusCode}`));
        }
        return originalJson.call(this, body);
      };
    }

    const lockKey = req.body?.projectId || req.body?.repo || 'global-create';
    let lockToken: string | null = null;
    if (lockKey) {
      try {
        lockToken = acquireLock(lockKey);
      } catch (e: any) {
        if (idempotencyKey) {
          rejectPendingIdempotency(idempotencyKey, e);
        }
        if (e.name === 'ResourceBusyError') return res.status(409).json({ error: { code: 'RESOURCE_BUSY', message: e.message, retryable: true } });
        return next(e);
      }
    }

    try {
      let rawItems = req.body;
      let outerRepo: string | null = null;
      if (rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)) {
        if (Array.isArray(rawItems.tasks)) {
          outerRepo = rawItems.repo || rawItems.repoUrl;
          rawItems = rawItems.tasks.map((taskItem: any) => {
            if (typeof taskItem === 'object' && taskItem !== null && !taskItem.repo && !taskItem.repoUrl && outerRepo) {
              return { ...taskItem, repo: outerRepo };
            }
            return taskItem;
          });
        } else if (rawItems.parent && Array.isArray(rawItems.children)) {
          const parentTask = { ...rawItems.parent };
          const childrenTasks = [...rawItems.children];
          const parentGenId = `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
          parentTask._internalId = parentGenId;
          rawItems = [parentTask, ...childrenTasks.map((child: any) => ({
            ...child,
            parentId: parentGenId,
            agent: child.agent || parentTask.agent,
          }))];
        }
      }

      const isArray = Array.isArray(rawItems);
      if (!isArray) {
        if (rawItems && typeof rawItems === 'object') rawItems = [rawItems];
        else return res.status(400).json({ error: 'Request body must be a JSON object or a JSON array of tasks' });
      }

      if (rawItems.length === 0) {
        return res.status(400).json({ error: 'Tasks list is empty' });
      }

      const createdTasks: any[] = [];
      for (const item of rawItems) {
        const validationErr = validateTaskPayload(item, false);
        if (validationErr) {
          if (!isArray) return res.status(400).json({ error: validationErr });
          continue;
        }

        let resolvedProjectId = '';
        try {
          resolvedProjectId = resolveProjectIdFromRepo(deps.state, item, req);
        } catch (error: any) {
          if (!isArray) return res.status(400).json({ error: error.message });
          continue;
        }

        const agentValidationError = validateAgentParams(item, deps.state.tasksCache);
        if (agentValidationError) {
          if (!isArray) return res.status(400).json({ error: agentValidationError });
          continue;
        }

        const classification = normalizeTaskCategoryAndTags(item, { requireCategory: true });

        const newTask = {
          id: item._internalId || `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
          displayId: generateDisplayId(deps.state, resolvedProjectId),
          projectId: resolvedProjectId,
          title: item.title.trim(),
          description: item.description || '',
          status: item.status || 'backlog',
          branch: item.branch || undefined,
          priority: item.priority || 'medium',
          category: classification.category,
          tags: classification.tags,
          targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : [],
          checklist: Array.isArray(item.checklist) ? item.checklist : [],
          designImages: extractDesignImages(item) || [],
          images: extractImages(item) || [],
          specUrl: item.specUrl || undefined,
          agent: item.agent || undefined,
          model: item.model || undefined,
          parentId: item.parentId || undefined,
          effort: item.effort || undefined,
          reasoning: item.reasoning || undefined,
          acceptanceCriteria: item.acceptanceCriteria || undefined,
          verification: item.verification || undefined,
          repoContext: item.repoContext || undefined,
          createdAt: item.createdAt || new Date().toISOString(),
          updatedAt: item.updatedAt || new Date().toISOString(),
          logs: Array.isArray(item.logs) && item.logs.length > 0 ? item.logs : [{
            id: `log-${Date.now()}-c`,
            timestamp: new Date().toISOString(),
            message: item.parentId ? `Subtask initialized under parent task ${item.parentId} via Workspace API.` : 'Task initialized via Workspace API.',
            type: 'create',
          }],
        };

        const qualityError = validateTaskQualityForMutation(newTask);
        if (qualityError) {
          if (!isArray) return res.status(400).json({ error: qualityError });
          continue;
        }

        deps.state.tasksCache.push(newTask);
        createdTasks.push(newTask);
        maybeTriggerTaskAgent(newTask, undefined, deps, 'POST /tasks endpoint');
      }

      const createTransaction = db.transaction(() => {
        for (const task of createdTasks) {
          saveTask(task);
        }
      });
      createTransaction();
      if (isArray) {
        const standardPayload = { success: true, createdCount: createdTasks.length, tasks: createdTasks };
        return res.status(201).json(toMutationListResponse(req, createdTasks, standardPayload, { createdCount: createdTasks.length }));
      }
      return res.status(201).json(toMutationResponse(req, createdTasks[0], createdTasks[0]));
    } catch (err: any) {
      if (idempotencyKey) {
        rejectPendingIdempotency(idempotencyKey, err);
      }
      return next(err);
    } finally {
      if (lockKey && lockToken) releaseLock(lockKey, lockToken);
    }
  });

  registerTaskBatchRoutes(app, deps);

  app.post('/api/tasks/:id/move', (req, res) => {
    const statusErr = validateEnum(req.body.status, 'status', VALID_STATUSES, true);
    if (statusErr) return res.status(400).json({ error: statusErr });

    const taskIndex = getTaskIndexByIdentifier(deps.state.tasksCache, req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const task = deps.state.tasksCache[taskIndex];
    const previousStatus = task.status;
    if (previousStatus === req.body.status) {
      return res.json(toMutationResponse(req, task, { message: 'Task is already in that lane', task }));
    }

    if (!isValidTransition(previousStatus, req.body.status)) {
      return res.status(400).json({ error: getValidationErrorMessage(previousStatus, req.body.status) });
    }

    const parentReviewError = validateParentReviewMove(task, deps, req.body.status);
    if (parentReviewError) {
      appendTaskLog(task, parentReviewError, 'update');
      saveTask(task);
      return res.status(400).json({ error: parentReviewError });
    }

    if (previousStatus === 'in-progress' && !canOverrideTaskLock(task, req.body, undefined, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }

    const updatedTask = {
      ...task,
      status: req.body.status,
      updatedAt: new Date().toISOString(),
      logs: [...task.logs, {
        id: `log-ext-move-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: `Status moved from ${previousStatus.toUpperCase()} to ${req.body.status.toUpperCase()} via External API Call`,
        type: 'move',
      }],
    };

    const moveTransaction = db.transaction(() => {
      deps.state.tasksCache[taskIndex] = updatedTask;
      syncTaskAgentStateForStatus(updatedTask, previousStatus);
      const trigger = maybeTriggerTaskAgent(updatedTask, previousStatus, deps, '/move endpoint');
      saveTask(deps.state.tasksCache[taskIndex]);
      return trigger;
    });
    const autoWorkTrigger = moveTransaction();
    const standardPayload = {
      success: true,
      message: `Successfully relocated task schema from ${previousStatus} to ${req.body.status}`,
      task: updatedTask,
      autoWorkTrigger: autoWorkTrigger
        ? autoWorkTrigger.triggered
          ? { triggered: true, run: autoWorkTrigger.run }
          : (() => {
              const blockedResult = autoWorkTrigger as TriggerTaskAgentFailure;
              return {
                triggered: false,
                code: blockedResult.code,
                reason: blockedResult.reason,
                run: blockedResult.run,
              };
            })()
        : null,
    };
    return res.json(toMutationResponse(req, updatedTask, standardPayload, {
      autoWorkTrigger: standardPayload.autoWorkTrigger,
    }));
  });

  app.post('/api/tasks/:id/checklist/toggle', (req, res) => {
    const checklistErr = validateString(req.body.checklistId, 'checklistId', true);
    if (checklistErr) return res.status(400).json({ error: checklistErr });

    const taskIndex = getTaskIndexByIdentifier(deps.state.tasksCache, req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const task = deps.state.tasksCache[taskIndex];
    const checklist = task.checklist || [];
    const item = checklist.find((entry: any) => (entry.id || entry.text) === req.body.checklistId);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });

    if (task.status === 'in-progress' && !canOverrideTaskLock(task, req.body, undefined, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }

    // Delegate the pure flip to the use-case so the route handler stays focused on transport concerns.
    task.checklist = applyChecklistToggleUseCase(checklist, item.id || item.text);
    const toggled = task.checklist.find((entry: any) => (entry.id || entry.text) === req.body.checklistId);
    const toggleTransaction = db.transaction(() => {
      task.updatedAt = new Date().toISOString();
      task.logs = [...task.logs, {
        id: `log-chk-toggle-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: `Checklist step "${item.text}" set to ${toggled?.completed ? 'COMPLETED' : 'INCOMPLETE'} via Specific API`,
        type: 'update',
      }];
      saveTask(task);
    });
    toggleTransaction();

    return res.json(toMutationResponse(req, task, task));
  });

  app.post('/api/tasks/:id/assign', (req, res) => {
    const agentErr = validateEnum(req.body.agent, 'agent', VALID_AGENTS, false);
    if (agentErr) return res.status(400).json({ error: agentErr });
    const modelErr = validateEnum(req.body.model, 'model', VALID_MODELS, false);
    if (modelErr) return res.status(400).json({ error: modelErr });


    const taskIndex = getTaskIndexByIdentifier(deps.state.tasksCache, req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });
    const task = deps.state.tasksCache[taskIndex];
    const agentValidationError = validateAgentParams({ ...task, ...req.body }, deps.state.tasksCache);
    if (agentValidationError) return res.status(400).json({ error: agentValidationError });

    if (task.status === 'in-progress' && !canOverrideTaskLock(task, req.body, undefined, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }

    const previousTask = { ...task };
    task.agent = req.body.agent || undefined;
    task.model = req.body.model || undefined;
    task.effort = req.body.effort || undefined;
    const assignTransaction = db.transaction(() => {
      task.updatedAt = new Date().toISOString();
      task.logs = [...task.logs, {
        id: `log-assign-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: `Agent configuration updated: Agent=${req.body.agent || 'None'}, Model=${req.body.model || 'Default'}, Effort=${req.body.effort || 'Auto'} via Specific API`,
        type: 'update',
      }];

      maybeTriggerTaskAgent(task, previousTask, deps, '/assign endpoint');
      saveTask(task);
    });
    assignTransaction();
    return res.json(toMutationResponse(req, task, task));
  });

  app.put('/api/tasks', (req, res) => {
    let rawItems = req.body;
    let outerRepo: string | null = null;
    if (rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems) && Array.isArray(rawItems.tasks)) {
      outerRepo = rawItems.repo || rawItems.repoUrl;
      rawItems = rawItems.tasks.map((taskItem: any) => {
        if (typeof taskItem === 'object' && taskItem !== null && !taskItem.repo && !taskItem.repoUrl && outerRepo) {
          return { ...taskItem, repo: outerRepo };
        }
        return taskItem;
      });
    }

    if (!Array.isArray(rawItems)) {
      if (rawItems && typeof rawItems === 'object') rawItems = [rawItems];
      else return res.status(400).json({ error: 'Request body must be a JSON array or a Task object' });
    }
    if (rawItems.length === 0) return res.status(400).json({ error: 'Tasks list is empty' });

    const importedTasks: any[] = [];
    const updatedTasks: any[] = [];

    for (const item of rawItems) {
      const existingIndex = item.id ? deps.state.tasksCache.findIndex((task) => task.id === item.id) : -1;
      const isUpdate = existingIndex !== -1;
      const validationErr = validateTaskPayload(item, isUpdate);
      if (validationErr) {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: validationErr });
        continue;
      }

      const agentValidationError = validateAgentParams(item, deps.state.tasksCache);
      if (agentValidationError) {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: agentValidationError });
        continue;
      }


      if (existingIndex !== -1) {
        const currentTask = deps.state.tasksCache[existingIndex];
        if (currentTask.status === 'in-progress' && !canOverrideTaskLock(currentTask, item, undefined, req.headers['x-agent-request'])) {
          continue;
        }
        const candidateTask = { ...currentTask, ...item };
        const mergedAgentValidationError = validateAgentParams(candidateTask, deps.state.tasksCache);
        if (mergedAgentValidationError) {
          if (!Array.isArray(req.body)) return res.status(400).json({ error: mergedAgentValidationError });
          continue;
        }

        const nextClassification = applyTaskCategoryAndTagsUpdate(item, currentTask);

        const updatedTask = {
          ...currentTask,
          title: item.title !== undefined ? String(item.title).trim() : currentTask.title,
          description: item.description !== undefined ? item.description : currentTask.description,
          status: item.status !== undefined ? item.status : currentTask.status,
          branch: item.branch !== undefined ? item.branch : currentTask.branch,
          priority: item.priority !== undefined ? item.priority : currentTask.priority,
          category: item.category !== undefined || Array.isArray(item.tags) ? nextClassification.category : currentTask.category,
          tags: Array.isArray(item.tags) ? nextClassification.tags : currentTask.tags,
          targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : currentTask.targetFiles,
          checklist: Array.isArray(item.checklist) ? item.checklist : currentTask.checklist,
          designImages: extractDesignImages(item, currentTask) || [],
        images: extractImages(item, currentTask) || [],
          specUrl: item.specUrl !== undefined ? item.specUrl : currentTask.specUrl,
          agent: item.agent !== undefined ? item.agent : currentTask.agent,
          model: item.model !== undefined ? item.model : currentTask.model,
          parentId: item.parentId !== undefined ? item.parentId : currentTask.parentId,
          effort: item.effort !== undefined ? item.effort : currentTask.effort,
          updatedAt: new Date().toISOString(),
          logs: [...(currentTask.logs || []), {
            id: `log-${Date.now()}-ut-${Math.floor(Math.random() * 1000000)}`,
            timestamp: new Date().toISOString(),
            message: 'Task updated in Batch list PUT mode.',
            type: 'update',
          }],
        };

        const qualityError = validateTaskQualityForMutation(updatedTask);
        if (qualityError) {
          if (!Array.isArray(req.body)) return res.status(400).json({ error: qualityError });
          continue;
        }

        const parentReviewError = validateParentReviewMove(updatedTask, deps, updatedTask.status);
        if (parentReviewError) {
          appendTaskLog(currentTask, parentReviewError, 'update');
          if (!Array.isArray(req.body)) return res.status(400).json({ error: parentReviewError });
          continue;
        }

        syncTaskAgentStateForStatus(updatedTask, currentTask.status);
        deps.state.tasksCache[existingIndex] = updatedTask;
        updatedTasks.push(updatedTask);
        maybeTriggerTaskAgent(updatedTask, currentTask, deps, 'PUT /tasks list update');
        continue;
      }

      let resolvedProjectId = '';
      try {
        resolvedProjectId = resolveProjectIdFromRepo(deps.state, item, req);
      } catch (error: any) {
        return res.status(400).json({ error: error.message });
      }

      const classification = normalizeTaskCategoryAndTags(item, { requireCategory: true });

      const newTask = {
        id: item.id || `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
        displayId: item.displayId || generateDisplayId(deps.state, resolvedProjectId),
        projectId: resolvedProjectId,
        title: item.title.trim(),
        description: item.description || '',
        status: item.status || 'backlog',
        branch: item.branch || undefined,
        priority: item.priority || 'medium',
        category: classification.category,
        tags: classification.tags,
        targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : [],
        checklist: Array.isArray(item.checklist) ? item.checklist : [],
        designImages: extractDesignImages(item) || [],
        images: extractImages(item) || [],
        specUrl: item.specUrl || undefined,
        agent: item.agent || undefined,
        model: item.model || undefined,
        parentId: item.parentId || undefined,
        effort: item.effort || undefined,
        reasoning: item.reasoning || undefined,
        acceptanceCriteria: item.acceptanceCriteria || undefined,
        verification: item.verification || undefined,
        repoContext: item.repoContext || undefined,
        jiraKey: item.jiraKey || undefined,
        sourceUrl: item.sourceUrl || undefined,
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || new Date().toISOString(),
        logs: Array.isArray(item.logs) && item.logs.length > 0 ? item.logs : [{
          id: `log-${Date.now()}-ct`,
          timestamp: new Date().toISOString(),
          message: 'Task created via Batch list PUT mode.',
          type: 'create',
        }],
      };

      const qualityError = validateTaskQualityForMutation(newTask);
      if (qualityError) {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: qualityError });
        continue;
      }

      deps.state.tasksCache.push(newTask);
      importedTasks.push(newTask);
      maybeTriggerTaskAgent(newTask, undefined, deps, 'PUT /tasks list create');
    }

    const batchTransaction = db.transaction(() => {
      for (const t of importedTasks) saveTask(t);
      for (const t of updatedTasks) saveTask(t);
    });
    batchTransaction();
    return res.status(200).json({ success: true, createdCount: importedTasks.length, updatedCount: updatedTasks.length, tasks: [...importedTasks, ...updatedTasks] });
  });

  app.put('/api/tasks/:id', async (req, res, next) => {
    const idempotencyKey = req.body?.idempotencyKey;
    const idempotencyFingerprint = idempotencyKey
      ? buildIdempotencyFingerprint(req.method, req.path, req.body)
      : undefined;
    if (idempotencyKey) {
      let cached;
      try {
        cached = getIdempotencyResult(idempotencyKey, idempotencyFingerprint);
      } catch (err) {
        return sendApiError(res, err);
      }
      if (cached !== undefined) {
        if (cached instanceof Promise) {
          try {
            const resolved = await cached;
            return res.json(resolved);
          } catch (err: any) {
            return next(err);
          }
        }
        return res.json(cached);
      }
      createPendingIdempotencyWithFingerprint(idempotencyKey, idempotencyFingerprint);
      const originalJson = res.json;
      res.json = function (body) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolvePendingIdempotency(idempotencyKey, body);
        } else {
          rejectPendingIdempotency(idempotencyKey, new Error(`Request failed with status ${res.statusCode}`));
        }
        return originalJson.call(this, body);
      };
    }

    const lockKey = req.params.id;
    let lockToken: string | null = null;
    if (lockKey) {
      try {
        lockToken = acquireLock(lockKey);
      } catch (e: any) {
        if (idempotencyKey) {
          rejectPendingIdempotency(idempotencyKey, e);
        }
        if (e.name === 'ResourceBusyError') return res.status(409).json({ error: { code: 'RESOURCE_BUSY', message: e.message, retryable: true } });
        return next(e);
      }
    }

    try {
      const taskIndex = getTaskIndexByIdentifier(deps.state.tasksCache, req.params.id);
      if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

      const currentTask = deps.state.tasksCache[taskIndex];
      let updateBody = stripRequestControlFields(req.body);

      if (currentTask.status === 'in-progress' && !canOverrideTaskLock(currentTask, req.body, undefined, req.headers['x-agent-request'])) {
        return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
      }

      const validationErr = validateTaskPayload(updateBody, true);
      if (validationErr) return res.status(400).json({ error: validationErr });

      // Use-case level invariant: a non-empty title is required. We layer the check after
      // the field-level service validation so the response code stays 400 for both.
      if (updateBody.title !== undefined) {
        const useCaseValidation = validateTaskPatchUseCase({ title: updateBody.title });
        if (!useCaseValidation.ok) {
          return res.status(400).json({ error: (useCaseValidation as { ok: false; reason: string }).reason });
        }
      }

      const hasProjectInfo = !!(updateBody.projectId || updateBody.repo || updateBody.repoUrl || (req.headers && (req.headers['x-repo'] || req.headers['x-repo-url'])));
      if (hasProjectInfo) {
        try {
          updateBody = { ...updateBody, projectId: resolveProjectIdFromRepo(deps.state, updateBody, req) };
        } catch (error: any) {
          return res.status(400).json({ error: error.message });
        }
      }

      const agentValidationError = validateAgentParams({ ...currentTask, ...updateBody }, deps.state.tasksCache);
      if (agentValidationError) return res.status(400).json({ error: agentValidationError });

      const parentReviewError = validateParentReviewMove({ ...currentTask, ...updateBody }, deps, updateBody.status ?? currentTask.status);
      if (parentReviewError) {
        appendTaskLog(currentTask, parentReviewError, 'update');
        saveTask(currentTask);
        return res.status(400).json({ error: parentReviewError });
      }

      const updatedTask = {
        ...currentTask,
        ...updateBody,
        ...applyTaskCategoryAndTagsUpdate(updateBody, currentTask),
        designImages: extractDesignImages(updateBody, currentTask) || [],
        images: extractImages(updateBody, currentTask) || [],
        updatedAt: new Date().toISOString(),
      };

      const qualityError = validateTaskQualityForMutation(updatedTask);
      if (qualityError) return res.status(400).json({ error: qualityError });

      deps.state.tasksCache[taskIndex] = updatedTask;
      syncTaskAgentStateForStatus(updatedTask, currentTask.status);
      maybeTriggerTaskAgent(updatedTask, currentTask, deps, 'PUT /tasks/:id endpoint');

      saveTask(updatedTask);
      return res.json(toMutationResponse(req, updatedTask, updatedTask));
    } catch (err: any) {
      if (idempotencyKey) {
        rejectPendingIdempotency(idempotencyKey, err);
      }
      return next(err);
    } finally {
      if (lockKey && lockToken) releaseLock(lockKey, lockToken);
    }
  });

  registerTaskImportFileRoute(app, deps);

  app.delete('/api/tasks/:id', (req, res) => {
    const taskIndex = getTaskIndexByIdentifier(deps.state.tasksCache, req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const currentTask = deps.state.tasksCache[taskIndex];
    const taskIdToDelete = currentTask.id;
    if (currentTask.status === 'in-progress' && !canOverrideTaskLock(currentTask, req.body, req.query, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }

    // Collect all task IDs to delete (parent + all recursive children)
    const idsToDelete = new Set<string>([taskIdToDelete]);
    let added = true;
    while (added) {
      added = false;
      for (const task of deps.state.tasksCache) {
        if (task.parentId && idsToDelete.has(task.parentId) && !idsToDelete.has(task.id)) {
          idsToDelete.add(task.id);
          added = true;
        }
      }
    }

    // Filter them out
    const removedTasks = deps.state.tasksCache.filter((task) => idsToDelete.has(task.id));
    deps.state.tasksCache = deps.state.tasksCache.filter((task) => !idsToDelete.has(task.id));

    deleteTasksByIds(Array.from(idsToDelete));
    return res.json({ success: true, removed: removedTasks[0], removedCount: removedTasks.length });
  });
}


