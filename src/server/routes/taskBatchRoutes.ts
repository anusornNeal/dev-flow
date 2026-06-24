import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { createApiError, sendApiError } from '../services/api';
import { applyTaskCategoryAndTagsUpdate, extractDesignImages, extractImages, normalizeTaskCategoryAndTags, resolveProjectIdFromRepo, validateAgentParams, validateTaskPayload } from '../services/taskService';
import { validateTaskQualityForMutation } from '../services/taskQualityService';
import db from '../../db/index';
import { generateDisplayId, saveTask } from '../repositories/taskRepository';
import { getValidationErrorMessage, isValidTransition } from '../../lib/statusTransitions';
import { applyChecklistToggle as applyChecklistToggleUseCase } from '../useCases/taskUseCases';
import { VALID_STATUSES } from '../constants';
import { validateEnum } from '../validation';
import { appendTaskLog, canOverrideTaskLock, createTaskLogEntry, getTaskIndexByIdentifier, maybeTriggerTaskAgent, syncTaskAgentStateForStatus, validateParentReviewMove } from './taskRouteSupport';

export function registerTaskBatchRoutes(app: express.Express, deps: ApiRouteDeps) {  app.post('/api/tasks/batch', (req, res) => {
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
    if (rawItems.length === 0) return res.status(400).json({ error: 'Batch array is empty' });

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

        const classification = applyTaskCategoryAndTagsUpdate(item, currentTask);

        const updatedTask = {
          ...currentTask,
          title: item.title !== undefined ? String(item.title).trim() : currentTask.title,
          description: item.description !== undefined ? item.description : currentTask.description,
          status: item.status !== undefined ? item.status : currentTask.status,
          branch: item.branch !== undefined ? item.branch : currentTask.branch,
          priority: item.priority !== undefined ? item.priority : currentTask.priority,
          category: item.category !== undefined || Array.isArray(item.tags) ? classification.category : currentTask.category,
          tags: Array.isArray(item.tags) ? classification.tags : currentTask.tags,
          targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : currentTask.targetFiles,
          checklist: Array.isArray(item.checklist) ? item.checklist : currentTask.checklist,
          designImages: extractDesignImages(item, currentTask) || [],
        images: extractImages(item, currentTask) || [],
          specUrl: item.specUrl !== undefined ? item.specUrl : currentTask.specUrl,
          agent: item.agent !== undefined ? item.agent : currentTask.agent,
          model: item.model !== undefined ? item.model : currentTask.model,
          parentId: item.parentId !== undefined ? item.parentId : currentTask.parentId,
          effort: item.effort !== undefined ? item.effort : currentTask.effort,
          reasoning: item.reasoning !== undefined ? item.reasoning : currentTask.reasoning,
          acceptanceCriteria: item.acceptanceCriteria !== undefined ? item.acceptanceCriteria : currentTask.acceptanceCriteria,
          verification: item.verification !== undefined ? item.verification : currentTask.verification,
          repoContext: item.repoContext !== undefined ? item.repoContext : currentTask.repoContext,
          updatedAt: new Date().toISOString(),
          logs: [...(currentTask.logs || []), {
            id: `log-${Date.now()}-ut-${Math.floor(Math.random() * 1000000)}`,
            timestamp: new Date().toISOString(),
            message: 'Task updated in Batch write mode.',
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
        maybeTriggerTaskAgent(updatedTask, currentTask, deps, 'POST /tasks/batch update');
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
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || new Date().toISOString(),
        logs: Array.isArray(item.logs) && item.logs.length > 0 ? item.logs : [{
          id: `log-${Date.now()}-ct`,
          timestamp: new Date().toISOString(),
          message: 'Task created in Batch mode.',
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
      maybeTriggerTaskAgent(newTask, undefined, deps, 'POST /tasks/batch create');
    }

    const batchTransaction = db.transaction(() => {
      for (const t of importedTasks) saveTask(t);
      for (const t of updatedTasks) saveTask(t);
    });
    batchTransaction();
    return res.status(201).json({ success: true, createdCount: importedTasks.length, updatedCount: updatedTasks.length, tasks: [...importedTasks, ...updatedTasks] });
  });

  app.post('/api/tasks/batch/move', (req, res) => {
    try {
      const moves = Array.isArray(req.body?.moves) ? req.body.moves : Array.isArray(req.body) ? req.body : null;
      if (!moves || moves.length === 0) {
        throw createApiError(400, 'MOVES_REQUIRED', 'moves must be a non-empty array.');
      }

      const results = moves.map((item: any) => {
        const statusErr = validateEnum(item.status, 'status', VALID_STATUSES, true);
        if (statusErr) {
          return { success: false, affectedId: item.taskId, error: { code: 'INVALID_STATUS', message: statusErr, retryable: false, affectedId: item.taskId } };
        }

        const taskIndex = getTaskIndexByIdentifier(deps.state.tasksCache, String(item.taskId || ''));
        if (taskIndex === -1) {
          return { success: false, affectedId: item.taskId, error: { code: 'TASK_NOT_FOUND', message: 'Task not found', retryable: false, affectedId: item.taskId } };
        }

        const task = deps.state.tasksCache[taskIndex];
        if (task.status === item.status) {
          return { success: true, affectedId: task.id, task };
        }
        if (!isValidTransition(task.status, item.status)) {
          return { success: false, affectedId: task.id, error: { code: 'INVALID_TRANSITION', message: getValidationErrorMessage(task.status, item.status), retryable: false, affectedId: task.id } };
        }
        if (task.status === 'in-progress' && !canOverrideTaskLock(task, item, undefined, item.isAgentRequest)) {
          return { success: false, affectedId: task.id, error: { code: 'TASK_LOCKED', message: 'Task is locked by an agent. Use emergency flag to override.', retryable: false, affectedId: task.id } };
        }

        const updatedTask = {
          ...task,
          status: item.status,
          updatedAt: new Date().toISOString(),
          logs: [...(task.logs || []), createTaskLogEntry(`Status moved from ${task.status.toUpperCase()} to ${item.status.toUpperCase()} via Batch API`, 'move')],
        };
        deps.state.tasksCache[taskIndex] = updatedTask;
        syncTaskAgentStateForStatus(updatedTask, task.status);
        return { success: true, affectedId: updatedTask.id, task: updatedTask };
      });

      const batchMoveTransaction = db.transaction((resList: any[]) => {
        for (const r of resList) {
          if (r.success && r.task) saveTask(r.task);
        }
      });
      batchMoveTransaction(results);
      return res.json({
        success: results.every((item) => item.success),
        successCount: results.filter((item) => item.success).length,
        errorCount: results.filter((item) => !item.success).length,
        results,
      });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/tasks/batch/checklist/toggle', (req, res) => {
    try {
      const toggles = Array.isArray(req.body?.toggles) ? req.body.toggles : Array.isArray(req.body) ? req.body : null;
      if (!toggles || toggles.length === 0) {
        throw createApiError(400, 'TOGGLES_REQUIRED', 'toggles must be a non-empty array.');
      }

      const results = toggles.map((item: any) => {
        const taskIndex = getTaskIndexByIdentifier(deps.state.tasksCache, String(item.taskId || ''));
        if (taskIndex === -1) {
          return { success: false, affectedId: item.taskId, error: { code: 'TASK_NOT_FOUND', message: 'Task not found', retryable: false, affectedId: item.taskId } };
        }

        const task = deps.state.tasksCache[taskIndex];
        const checklistItem = (task.checklist || []).find((entry: any) => (entry.id || entry.text) === item.checklistId);
        if (!checklistItem) {
          return { success: false, affectedId: task.id, error: { code: 'CHECKLIST_NOT_FOUND', message: 'Checklist item not found', retryable: false, affectedId: task.id } };
        }
        if (task.status === 'in-progress' && !canOverrideTaskLock(task, item, undefined, item.isAgentRequest)) {
          return { success: false, affectedId: task.id, error: { code: 'TASK_LOCKED', message: 'Task is locked by an agent. Use emergency flag to override.', retryable: false, affectedId: task.id } };
        }

        checklistItem.completed = !checklistItem.completed;
        task.updatedAt = new Date().toISOString();
        task.logs = [...(task.logs || []), createTaskLogEntry(`Checklist step "${checklistItem.text}" set to ${checklistItem.completed ? 'COMPLETED' : 'INCOMPLETE'} via Batch API`)];
        return { success: true, affectedId: task.id, task };
      });

      const batchToggleTransaction = db.transaction((resList: any[]) => {
        for (const r of resList) {
          if (r.success && r.task) saveTask(r.task);
        }
      });
      batchToggleTransaction(results);
      return res.json({
        success: results.every((item) => item.success),
        successCount: results.filter((item) => item.success).length,
        errorCount: results.filter((item) => !item.success).length,
        results,
      });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/tasks/batch/assign', (req, res) => {
    try {
      const assignments = Array.isArray(req.body?.assignments) ? req.body.assignments : Array.isArray(req.body) ? req.body : null;
      if (!assignments || assignments.length === 0) {
        throw createApiError(400, 'ASSIGNMENTS_REQUIRED', 'assignments must be a non-empty array.');
      }

      const results = assignments.map((item: any) => {
        const taskIndex = getTaskIndexByIdentifier(deps.state.tasksCache, String(item.taskId || ''));
        if (taskIndex === -1) {
          return { success: false, affectedId: item.taskId, error: { code: 'TASK_NOT_FOUND', message: 'Task not found', retryable: false, affectedId: item.taskId } };
        }

        const task = deps.state.tasksCache[taskIndex];
        const agentValidationError = validateAgentParams({ ...task, ...item }, deps.state.tasksCache);
        if (agentValidationError) {
          return { success: false, affectedId: task.id, error: { code: 'INVALID_ASSIGNMENT', message: agentValidationError, retryable: false, affectedId: task.id } };
        }
        if (task.status === 'in-progress' && !canOverrideTaskLock(task, item, undefined, item.isAgentRequest)) {
          return { success: false, affectedId: task.id, error: { code: 'TASK_LOCKED', message: 'Task is locked by an agent. Use emergency flag to override.', retryable: false, affectedId: task.id } };
        }

        const previousTask = { ...task };
        task.agent = item.agent || undefined;
        task.model = item.model || undefined;
        task.effort = item.effort || undefined;
        task.updatedAt = new Date().toISOString();
        task.logs = [...(task.logs || []), createTaskLogEntry(`Agent configuration updated via Batch API: Agent=${item.agent || 'None'}, Model=${item.model || 'Default'}, Effort=${item.effort || 'Auto'}`)];
        maybeTriggerTaskAgent(task, previousTask, deps, 'POST /tasks/batch/assign');
        return { success: true, affectedId: task.id, task };
      });

      const batchAssignTransaction = db.transaction((resList: any[]) => {
        for (const r of resList) {
          if (r.success && r.task) saveTask(r.task);
        }
      });
      batchAssignTransaction(results);
      return res.json({
        success: results.every((item) => item.success),
        successCount: results.filter((item) => item.success).length,
        errorCount: results.filter((item) => !item.success).length,
        results,
      });
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}

