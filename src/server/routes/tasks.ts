import path from 'path';
import { execFile } from 'child_process';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { TASK_SCHEMA_DEF, VALID_AGENTS, VALID_EFFORTS, VALID_MODELS, VALID_STATUSES } from '../constants';
import { loadTasks, generateDisplayId, saveTasks } from '../repositories/taskRepository';
import { buildTaskPrompt, extractDesignImages, getAgentTaskContext, resolveProjectIdFromRepo, validateAgentParams, validateTaskPayload } from '../services/taskService';
import { validateEnum, validateString } from '../validation';
import { isValidTransition, getValidationErrorMessage } from '../../lib/statusTransitions';

function clearActiveAgentIfSettled(task: any) {
  if (['backlog', 'done', 'ready-for-review'].includes(task.status)) {
    task.activeAgent = undefined;
  }
}

function canOverrideTaskLock(task: any, body: any, query?: any, agentRequestValue?: any) {
  const isAgentRequest = String(agentRequestValue).toLowerCase() === 'true';
  const emergencyBody = body?.emergency === true || String(body?.emergency).toLowerCase() === 'true';
  const emergencyQuery = String(query?.emergency).toLowerCase() === 'true';
  return isAgentRequest || emergencyBody || emergencyQuery;
}

function maybeTriggerTaskAgent(task: any, previousStatus: string | undefined, deps: ApiRouteDeps, routeLabel: string) {
  if (task.status !== 'todo' || previousStatus === 'todo') return;
  if (!task.agent || task.activeAgent) return;

  const isAgentBusy = deps.state.tasksCache.some((entry) =>
    entry.projectId === task.projectId &&
    (entry.status === 'in-progress' || entry.status === 'todo') &&
    entry.activeAgent &&
    entry.id !== task.id,
  );

  if (isAgentBusy) {
    deps.writeAgentLog('INFO', `Agent already busy for project=${task.projectId}, skipping trigger for task=${task.id}`);
    return;
  }

  task.activeAgent = task.agent;
  if (!/^[a-zA-Z0-9-]+$/.test(task.agent) || !/^[a-zA-Z0-9-]+$/.test(task.id)) {
    deps.writeAgentLog('ERROR', `Blocked trigger due to invalid chars: agent=${task.agent} taskId=${task.id}`);
    return;
  }

  const triggerBat = path.join(process.cwd(), 'scripts', 'trigger-agent.bat');
  const project = deps.state.projectsCache.find((entry) => entry.id === task.projectId);
  const execOpts = project?.localPath ? { cwd: project.localPath } : undefined;
  const safeLocalPath = `"${project?.localPath || 'none'}"`;
  const safeModel = `"${task.model || 'none'}"`;
  const safeEffort = `"${task.effort || 'none'}"`;

  deps.writeAgentLog('TRIGGER', `Spawning agent=${task.agent} for task=${task.id} ("${task.title}") via ${routeLabel}${execOpts ? ' at ' + execOpts.cwd : ''}`);
  execFile('cmd.exe', ['/c', triggerBat, task.agent, task.id, safeLocalPath, safeModel, safeEffort], execOpts, (error) => {
    if (error) deps.writeAgentLog('ERROR', `trigger-agent.bat failed for task=${task.id}: ${error.message}`);
    else deps.writeAgentLog('INFO', `trigger-agent.bat exited OK for task=${task.id}`);
  });
}

export function registerTaskRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/schema/task', (_req, res) => {
    res.json(TASK_SCHEMA_DEF);
  });

  app.get('/api/tasks', (_req, res) => {
    res.json(deps.state.tasksCache);
  });

  app.get('/api/tasks/:id/agent-context', (req, res) => {
    loadTasks(deps.state);
    const includeLogs = req.query.includeLogs === 'true' || req.query.mode === 'full' || req.query.mode === 'debug';
    const context = getAgentTaskContext(deps.state, req.params.id, includeLogs);
    if (!context) return res.status(404).json({ error: 'Task not found' });
    return res.json(context);
  });

  app.get('/api/tasks/:id/prompt', (req, res) => {
    const includeLogs = req.query.includeLogs === 'true' || req.query.mode === 'full' || req.query.mode === 'debug';
    const prompt = buildTaskPrompt(deps.state, req.params.id, includeLogs);
    if (!prompt) return res.status(404).json({ error: 'Task not found' });
    res.setHeader('Content-Type', 'text/plain');
    return res.send(prompt);
  });

  app.post('/api/tasks', (req, res) => {
    loadTasks(deps.state);
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

      const newTask = {
        id: item._internalId || `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
        displayId: generateDisplayId(deps.state, resolvedProjectId),
        projectId: resolvedProjectId,
        title: item.title.trim(),
        description: item.description || '',
        status: item.status || 'backlog',
        branch: item.branch || undefined,
        priority: item.priority || 'medium',
        tags: Array.isArray(item.tags) ? item.tags : [],
        targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : [],
        checklist: Array.isArray(item.checklist) ? item.checklist : [],
        designImages: extractDesignImages(item) || [],
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

      deps.state.tasksCache.push(newTask);
      createdTasks.push(newTask);
    }

    saveTasks(deps.state);
    if (isArray) return res.status(201).json({ success: true, createdCount: createdTasks.length, tasks: createdTasks });
    return res.status(201).json(createdTasks[0]);
  });

  app.post('/api/tasks/batch', (req, res) => {
    loadTasks(deps.state);
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

        const updatedTask = {
          ...currentTask,
          title: item.title !== undefined ? String(item.title).trim() : currentTask.title,
          description: item.description !== undefined ? item.description : currentTask.description,
          status: item.status !== undefined ? item.status : currentTask.status,
          branch: item.branch !== undefined ? item.branch : currentTask.branch,
          priority: item.priority !== undefined ? item.priority : currentTask.priority,
          tags: Array.isArray(item.tags) ? item.tags : currentTask.tags,
          targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : currentTask.targetFiles,
          checklist: Array.isArray(item.checklist) ? item.checklist : currentTask.checklist,
          designImages: extractDesignImages(item, currentTask) || [],
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

        clearActiveAgentIfSettled(updatedTask);
        deps.state.tasksCache[existingIndex] = updatedTask;
        updatedTasks.push(updatedTask);
        continue;
      }

      let resolvedProjectId = '';
      try {
        resolvedProjectId = resolveProjectIdFromRepo(deps.state, item, req);
      } catch (error: any) {
        return res.status(400).json({ error: error.message });
      }

      const newTask = {
        id: item.id || `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
        displayId: item.displayId || generateDisplayId(deps.state, resolvedProjectId),
        projectId: resolvedProjectId,
        title: item.title.trim(),
        description: item.description || '',
        status: item.status || 'backlog',
        branch: item.branch || undefined,
        priority: item.priority || 'medium',
        tags: Array.isArray(item.tags) ? item.tags : [],
        targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : [],
        checklist: Array.isArray(item.checklist) ? item.checklist : [],
        designImages: extractDesignImages(item) || [],
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

      deps.state.tasksCache.push(newTask);
      importedTasks.push(newTask);
    }

    saveTasks(deps.state);
    return res.status(201).json({ success: true, createdCount: importedTasks.length, updatedCount: updatedTasks.length, tasks: [...importedTasks, ...updatedTasks] });
  });

  app.post('/api/tasks/:id/move', (req, res) => {
    loadTasks(deps.state);
    const statusErr = validateEnum(req.body.status, 'status', VALID_STATUSES, true);
    if (statusErr) return res.status(400).json({ error: statusErr });

    const taskIndex = deps.state.tasksCache.findIndex((task) => task.id === req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const task = deps.state.tasksCache[taskIndex];
    const previousStatus = task.status;
    if (previousStatus === req.body.status) {
      return res.json({ message: 'Task is already in that lane', task });
    }

    if (!isValidTransition(previousStatus, req.body.status)) {
      return res.status(400).json({ error: getValidationErrorMessage(previousStatus, req.body.status) });
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

    clearActiveAgentIfSettled(updatedTask);
    maybeTriggerTaskAgent(updatedTask, previousStatus, deps, '/move endpoint');

    deps.state.tasksCache[taskIndex] = updatedTask;
    saveTasks(deps.state);
    return res.json({ success: true, message: `Successfully relocated task schema from ${previousStatus} to ${req.body.status}`, task: updatedTask });
  });

  app.post('/api/tasks/:id/checklist/toggle', (req, res) => {
    loadTasks(deps.state);
    const checklistErr = validateString(req.body.checklistId, 'checklistId', true);
    if (checklistErr) return res.status(400).json({ error: checklistErr });

    const taskIndex = deps.state.tasksCache.findIndex((task) => task.id === req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const task = deps.state.tasksCache[taskIndex];
    const checklist = task.checklist || [];
    const item = checklist.find((entry: any) => (entry.id || entry.text) === req.body.checklistId);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });

    if (task.status === 'in-progress' && !canOverrideTaskLock(task, req.body, undefined, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }

    item.completed = !item.completed;
    task.updatedAt = new Date().toISOString();
    task.logs = [...task.logs, {
      id: `log-chk-toggle-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: `Checklist step "${item.text}" set to ${item.completed ? 'COMPLETED' : 'INCOMPLETE'} via Specific API`,
      type: 'update',
    }];

    saveTasks(deps.state);
    return res.json(task);
  });

  app.post('/api/tasks/:id/assign', (req, res) => {
    loadTasks(deps.state);
    const agentErr = validateEnum(req.body.agent, 'agent', VALID_AGENTS, false);
    if (agentErr) return res.status(400).json({ error: agentErr });
    const modelErr = validateEnum(req.body.model, 'model', VALID_MODELS, false);
    if (modelErr) return res.status(400).json({ error: modelErr });
    const effortErr = validateEnum(req.body.effort, 'effort', VALID_EFFORTS, false);
    if (effortErr) return res.status(400).json({ error: effortErr });

    const taskIndex = deps.state.tasksCache.findIndex((task) => task.id === req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });
    const task = deps.state.tasksCache[taskIndex];

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

    saveTasks(deps.state);
    return res.json(task);
  });

  app.put('/api/tasks', (req, res) => {
    loadTasks(deps.state);
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

        const updatedTask = {
          ...currentTask,
          title: item.title !== undefined ? String(item.title).trim() : currentTask.title,
          description: item.description !== undefined ? item.description : currentTask.description,
          status: item.status !== undefined ? item.status : currentTask.status,
          branch: item.branch !== undefined ? item.branch : currentTask.branch,
          priority: item.priority !== undefined ? item.priority : currentTask.priority,
          tags: Array.isArray(item.tags) ? item.tags : currentTask.tags,
          targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : currentTask.targetFiles,
          checklist: Array.isArray(item.checklist) ? item.checklist : currentTask.checklist,
          designImages: extractDesignImages(item, currentTask) || [],
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

        clearActiveAgentIfSettled(updatedTask);
        deps.state.tasksCache[existingIndex] = updatedTask;
        updatedTasks.push(updatedTask);
        continue;
      }

      let resolvedProjectId = '';
      try {
        resolvedProjectId = resolveProjectIdFromRepo(deps.state, item, req);
      } catch (error: any) {
        return res.status(400).json({ error: error.message });
      }

      const newTask = {
        id: item.id || `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
        displayId: item.displayId || generateDisplayId(deps.state, resolvedProjectId),
        projectId: resolvedProjectId,
        title: item.title.trim(),
        description: item.description || '',
        status: item.status || 'backlog',
        branch: item.branch || undefined,
        priority: item.priority || 'medium',
        tags: Array.isArray(item.tags) ? item.tags : [],
        targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : [],
        checklist: Array.isArray(item.checklist) ? item.checklist : [],
        designImages: extractDesignImages(item) || [],
        specUrl: item.specUrl || undefined,
        agent: item.agent || undefined,
        model: item.model || undefined,
        parentId: item.parentId || undefined,
        effort: item.effort || undefined,
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || new Date().toISOString(),
        logs: Array.isArray(item.logs) && item.logs.length > 0 ? item.logs : [{
          id: `log-${Date.now()}-ct`,
          timestamp: new Date().toISOString(),
          message: 'Task created via Batch list PUT mode.',
          type: 'create',
        }],
      };
      deps.state.tasksCache.push(newTask);
      importedTasks.push(newTask);
    }

    saveTasks(deps.state);
    return res.status(200).json({ success: true, createdCount: importedTasks.length, updatedCount: updatedTasks.length, tasks: [...importedTasks, ...updatedTasks] });
  });

  app.put('/api/tasks/:id', (req, res) => {
    loadTasks(deps.state);
    const taskIndex = deps.state.tasksCache.findIndex((task) => task.id === req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const currentTask = deps.state.tasksCache[taskIndex];
    let updateBody = req.body;

    if (currentTask.status === 'in-progress' && !canOverrideTaskLock(currentTask, req.body, undefined, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }

    const validationErr = validateTaskPayload(updateBody, true);
    if (validationErr) return res.status(400).json({ error: validationErr });

    const hasProjectInfo = !!(updateBody.projectId || updateBody.repo || updateBody.repoUrl || (req.headers && (req.headers['x-repo'] || req.headers['x-repo-url'])));
    if (hasProjectInfo) {
      try {
        updateBody = { ...updateBody, projectId: resolveProjectIdFromRepo(deps.state, updateBody, req) };
      } catch (error: any) {
        return res.status(400).json({ error: error.message });
      }
    }

    const agentValidationError = validateAgentParams(updateBody, deps.state.tasksCache);
    if (agentValidationError) return res.status(400).json({ error: agentValidationError });

    const updatedTask = {
      ...currentTask,
      ...updateBody,
      designImages: extractDesignImages(updateBody, currentTask) || [],
      updatedAt: new Date().toISOString(),
    };

    clearActiveAgentIfSettled(updatedTask);
    maybeTriggerTaskAgent(updatedTask, currentTask.status, deps, 'PUT /tasks/:id endpoint');

    deps.state.tasksCache[taskIndex] = updatedTask;
    saveTasks(deps.state);
    return res.json(updatedTask);
  });

  app.delete('/api/tasks/:id', (req, res) => {
    loadTasks(deps.state);
    const taskIndex = deps.state.tasksCache.findIndex((task) => task.id === req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const currentTask = deps.state.tasksCache[taskIndex];
    if (currentTask.status === 'in-progress' && !canOverrideTaskLock(currentTask, req.body, req.query, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }

    const removed = deps.state.tasksCache.splice(taskIndex, 1);
    saveTasks(deps.state);
    return res.json({ success: true, removed: removed[0] });
  });
}
