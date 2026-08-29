import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { VALID_AGENTS, LEGACY_VALID_EFFORTS_FALLBACK, VALID_MODELS, VALID_STATUSES } from '../constants';
import { archiveInactiveDoneTasks, deleteTasksByIds, generateDisplayId, queryTaskBoardPage, resolveDisplayIdForNewTask, restoreArchivedTask, saveTask, getTasks } from '../repositories/taskRepository.js';
import { extractImages, extractDesignImages, normalizeTaskCategoryAndTags, applyTaskCategoryAndTagsUpdate, resolveProjectIdFromRepo, validateAgentParams, validateTaskPayload } from '../services/taskService';
import { validateTaskQualityForMutation } from '../services/taskQualityService';
import { createApiError, sendApiError } from '../services/api';
import { draftTaskFromJiraBundle } from '../services/compositeAuthoringService';
import { acquireLock, releaseLock, withIdempotency, getIdempotencyResult, createPendingIdempotencyWithFingerprint, resolvePendingIdempotency, rejectPendingIdempotency, buildIdempotencyFingerprint } from '../services/lockAndIdempotencyService';
import { validateEnum, validateString } from '../validation';
import { isValidTransition, getValidationErrorMessage, getTransitionPath } from '../../lib/statusTransitions';
import {
  appendBugVersion,
  createBugThread,
  ensureCloseWarningBug,
  updateBugStatus,
  applyChecklistToggle as applyChecklistToggleUseCase,
  evaluateChecklistToggleMutation,
  evaluateMove,
  validateTaskPatch as validateTaskPatchUseCase,
} from '../useCases/taskUseCases';
import type { AgentCompletionPayload, AgentCompletionStatus, BugStatus, TaskStatus } from '../../types';
import { registerTaskBatchRoutes } from './taskBatchRoutes';
import { registerTaskSetAuthoringRoute } from './taskSetAuthoringRoute';
import { assertTaskPrerequisiteGraph, resolveTaskPrerequisiteIds } from '../services/taskDependencyService.js';
import { registerTaskImportFileRoute } from './taskImportFileRoute';
import { registerTaskBugRoutes } from './taskBugRoutes';
import { registerTaskReviewRoutes } from './taskReviewRoutes';
import { registerLegacyTaskAgentRoutes } from './taskLegacyAgentRoutes';
import { registerTaskReadRoutes } from './taskReadRoutes';
import { registerTaskWorkflowRoutes } from './taskWorkflowRoutes';
import { registerTaskClaimRoutes } from './taskClaimRoutes';
import { buildTaskGitWarnings, evaluateReviewSubmission, syncTaskWithGit } from '../services/taskGitWorkflowService';
import { getProjectOrchestrationProjection, withTaskDeletionLifecycleGuard } from '../services/taskClaimService.js';

import {
  appendTaskLog,
  canOverrideTaskLock,
  getTaskIndexByIdentifier,
  stripRequestControlFields,
  persistTaskMutationWithLifecycle,
  toMutationListResponse,
  toMutationResponse,
  validateParentReviewMove,
} from './taskRouteSupport';
export function registerTaskRoutes(app: express.Express, deps: ApiRouteDeps) {
  registerTaskSetAuthoringRoute(app, deps);
  registerTaskReadRoutes(app, deps);  registerTaskBugRoutes(app, deps);  registerTaskReviewRoutes(app, deps);  registerLegacyTaskAgentRoutes(app, deps);  registerTaskClaimRoutes(app, deps);
  app.get('/api/tasks/orchestration', (req, res) => {
    try {
      return res.json(getProjectOrchestrationProjection(String(req.query.projectId || '')));
    } catch (error) {
      return sendApiError(res, error);
    }
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

        const agentValidationError = validateAgentParams(item, getTasks());
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
          prerequisiteTaskIds: Array.isArray(item.prerequisiteTaskIds) ? [...item.prerequisiteTaskIds] : [],
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

        const existingTasksForDependencies = getTasks();
        newTask.prerequisiteTaskIds = resolveTaskPrerequisiteIds(newTask, [...existingTasksForDependencies, newTask]);
        assertTaskPrerequisiteGraph([...existingTasksForDependencies, newTask]);

        const qualityError = validateTaskQualityForMutation(newTask);
        if (qualityError) {
          if (!isArray) return res.status(400).json({ error: qualityError });
          continue;
        }

        saveTask(newTask);
        createdTasks.push(newTask);
      }

      
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
  registerTaskWorkflowRoutes(app, deps);  app.post('/api/tasks/:id/checklist/toggle', (req, res) => {
    const checklistErr = validateString(req.body.checklistId, 'checklistId', true);
    if (checklistErr) return res.status(400).json({ error: checklistErr });

    const taskIndex = getTaskIndexByIdentifier(getTasks(), req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const task = getTasks()[taskIndex];
    const checklist = task.checklist || [];
    const item = checklist.find((entry: any) => (entry.id || entry.text) === req.body.checklistId);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });

    if (task.status === 'in-progress' && !canOverrideTaskLock(task, req.body, undefined, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }

    const toggleDecision = evaluateChecklistToggleMutation(task.status, Boolean(item.completed));
    if (toggleDecision.ok === false) {
      return res.status(409).json({
        code: toggleDecision.code,
        error: toggleDecision.message,
        retryable: false,
        affectedId: task.id,
      });
    }

    // Delegate the pure flip to the use-case so the route handler stays focused on transport concerns.
    task.checklist = applyChecklistToggleUseCase(checklist, item.id || item.text);
    const toggled = task.checklist.find((entry: any) => (entry.id || entry.text) === req.body.checklistId);
    task.updatedAt = new Date().toISOString();
    task.logs = [...task.logs, {
      id: `log-chk-toggle-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: `Checklist step "${item.text}" set to ${toggled?.completed ? 'COMPLETED' : 'INCOMPLETE'} via Specific API`,
      type: 'update',
    }];

    saveTask(task);
    return res.json(toMutationResponse(req, task, task));
  });

  app.post('/api/tasks/:id/assign', (req, res) => {
    const agentErr = validateEnum(req.body.agent, 'agent', VALID_AGENTS, false);
    if (agentErr) return res.status(400).json({ error: agentErr });
    const modelErr = validateEnum(req.body.model, 'model', VALID_MODELS, false);
    if (modelErr) return res.status(400).json({ error: modelErr });


    const taskIndex = getTaskIndexByIdentifier(getTasks(), req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });
    const task = getTasks()[taskIndex];
    const agentValidationError = validateAgentParams({ ...task, ...req.body }, getTasks());
    if (agentValidationError) return res.status(400).json({ error: agentValidationError });

    if (task.status === 'in-progress' && !canOverrideTaskLock(task, req.body, undefined, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }

    task.agent = req.body.agent || undefined;
    task.model = req.body.model || undefined;
    task.effort = req.body.effort || undefined;
    task.updatedAt = new Date().toISOString();
    task.logs = [...task.logs, {
      id: `log-assign-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: `Agent configuration updated: Agent=${req.body.agent || 'None'}, Model=${req.body.model || 'Default'}, Effort=${req.body.effort || 'Auto'} via Specific API`,
      type: 'update',
    }];

    saveTask(task);
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
      const existingIndex = item.id ? getTasks().findIndex((task) => task.id === item.id) : -1;
      const isUpdate = existingIndex !== -1;
      const validationErr = validateTaskPayload(item, isUpdate);
      if (validationErr) {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: validationErr });
        continue;
      }

      const agentValidationError = validateAgentParams(item, getTasks());
      if (agentValidationError) {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: agentValidationError });
        continue;
      }


      if (existingIndex !== -1) {
        const currentTask = getTasks()[existingIndex];
        if (currentTask.status === 'in-progress' && !canOverrideTaskLock(currentTask, item, undefined, req.headers['x-agent-request'])) {
          continue;
        }
        const candidateTask = { ...currentTask, ...item };
        const mergedAgentValidationError = validateAgentParams(candidateTask, getTasks());
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
          prerequisiteTaskIds: Array.isArray(item.prerequisiteTaskIds) ? [...item.prerequisiteTaskIds] : currentTask.prerequisiteTaskIds,
          effort: item.effort !== undefined ? item.effort : currentTask.effort,
          updatedAt: new Date().toISOString(),
          logs: [...(currentTask.logs || []), {
            id: `log-${Date.now()}-ut-${Math.floor(Math.random() * 1000000)}`,
            timestamp: new Date().toISOString(),
            message: 'Task updated in Batch list PUT mode.',
            type: 'update',
          }],
        };

        const tasksForDependencyUpdate = getTasks();
        updatedTask.prerequisiteTaskIds = resolveTaskPrerequisiteIds(updatedTask, tasksForDependencyUpdate.map((task) => task.id === updatedTask.id ? updatedTask : task));
        assertTaskPrerequisiteGraph(tasksForDependencyUpdate.map((task) => task.id === updatedTask.id ? updatedTask : task));

        const qualityError = validateTaskQualityForMutation(updatedTask, { currentTask, changedFields: Object.keys(item) });
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

        const persistedTask = persistTaskMutationWithLifecycle(currentTask, updatedTask, 'PUT /tasks list update');
        updatedTasks.push(persistedTask);
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
        displayId: resolveDisplayIdForNewTask(deps.state, resolvedProjectId, item.displayId),
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
        prerequisiteTaskIds: Array.isArray(item.prerequisiteTaskIds) ? [...item.prerequisiteTaskIds] : [],
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

      const existingTasksForBatchCreate = getTasks();
      newTask.prerequisiteTaskIds = resolveTaskPrerequisiteIds(newTask, [...existingTasksForBatchCreate, newTask]);
      assertTaskPrerequisiteGraph([...existingTasksForBatchCreate, newTask]);

      const qualityError = validateTaskQualityForMutation(newTask);
      if (qualityError) {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: qualityError });
        continue;
      }

      saveTask(newTask);
      importedTasks.push(newTask);
    }

    
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
      const taskIndex = getTaskIndexByIdentifier(getTasks(), req.params.id);
      if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

      const currentTask = getTasks()[taskIndex];
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

      const agentValidationError = validateAgentParams({ ...currentTask, ...updateBody }, getTasks());
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

      if (Array.isArray(updateBody.prerequisiteTaskIds)) {
        const dependencyTasks = getTasks();
        updatedTask.prerequisiteTaskIds = resolveTaskPrerequisiteIds(updatedTask, dependencyTasks.map((task) => task.id === updatedTask.id ? updatedTask : task));
        assertTaskPrerequisiteGraph(dependencyTasks.map((task) => task.id === updatedTask.id ? updatedTask : task));
      }

      const qualityError = validateTaskQualityForMutation(updatedTask, { currentTask, changedFields: Object.keys(updateBody) });
      if (qualityError) return res.status(400).json({ error: qualityError });

      const persistedTask = persistTaskMutationWithLifecycle(currentTask, updatedTask, 'PUT /tasks/:id endpoint');
      return res.json(toMutationResponse(req, persistedTask, persistedTask));
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
    const taskIndex = getTaskIndexByIdentifier(getTasks(), req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const currentTask = getTasks()[taskIndex];
    const taskIdToDelete = currentTask.id;
    if (currentTask.status === 'in-progress' && !canOverrideTaskLock(currentTask, req.body, req.query, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }

    // Collect all task IDs to delete (parent + all recursive children)
    const idsToDelete = new Set<string>([taskIdToDelete]);
    let added = true;
    while (added) {
      added = false;
      for (const task of getTasks()) {
        if (task.parentId && idsToDelete.has(task.parentId) && !idsToDelete.has(task.id)) {
          idsToDelete.add(task.id);
          added = true;
        }
      }
    }

    // Filter them out
    const removedTasks = getTasks().filter((task) => idsToDelete.has(task.id));
    

    try {
      withTaskDeletionLifecycleGuard(Array.from(idsToDelete), () => {
        deleteTasksByIds(Array.from(idsToDelete));
        return true;
      });
      return res.json({ success: true, removed: removedTasks[0], removedCount: removedTasks.length });
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}


