import type express from 'express';
import type { ApiRouteDeps } from '../types';
import type { TaskStatus } from '../../types';
import { VALID_STATUSES } from '../constants';
import { getActiveRunForTask } from '../repositories/agentRunRepository';
import { getTasks, saveTask } from '../repositories/taskRepository.js';
import { getTransitionPath, getValidationErrorMessage, isValidTransition } from '../../lib/statusTransitions';
import { evaluateMove, ensureCloseWarningBug } from '../useCases/taskUseCases';
import { validateEnum } from '../validation';
import {
  appendTaskLog,
  canOverrideTaskLock,
  getTaskIndexByIdentifier,
  getTaskMoveWorkflowBlockers,
  syncTaskAgentStateForStatus,
  toMutationResponse,
} from './taskRouteSupport';

export function registerTaskWorkflowRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.post('/api/tasks/:id/move', (req, res) => {
    const statusErr = validateEnum(req.body.status, 'status', VALID_STATUSES, true);
    if (statusErr) return res.status(400).json({ error: statusErr });
    const taskIndex = getTaskIndexByIdentifier(getTasks(), req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });
    const task = getTasks()[taskIndex];
    const previousStatus = task.status;
    if (previousStatus === req.body.status) return res.json(toMutationResponse(req, task, { message: 'Task is already in that lane', task }));
    if (!isValidTransition(previousStatus, req.body.status)) return res.status(400).json({ error: getValidationErrorMessage(previousStatus, req.body.status) });

    const targetStatus = req.body.status as TaskStatus;
    const activeRun = getActiveRunForTask(task.id);
    const hardBlockers = activeRun && !canOverrideTaskLock(task, req.body, undefined, req.headers['x-agent-request'])
      ? [{ code: 'ACTIVE_AGENT_LOCK', message: `Task is actively owned by ${activeRun.agent || 'an agent'} (${activeRun.status}). Cancel/complete the run before moving it manually.`, bypassable: false, details: { runId: activeRun.id, status: activeRun.status, agent: activeRun.agent } }]
      : [];
    const moveDecision = evaluateMove({
      intent: req.body.intent,
      manualOverride: req.body.manualOverride === true,
      softBlockers: getTaskMoveWorkflowBlockers(task, deps, targetStatus),
      hardBlockers,
    });
    if (!moveDecision.allowed) return sendMoveBlocked(res, previousStatus, targetStatus, moveDecision);
    if (moveDecision.bypassedBlockers.length > 0) {
      appendTaskLog(task, `Manual override move ${previousStatus} -> ${targetStatus}; bypassed soft blockers: ${moveDecision.bypassedBlockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join(' | ')}`, 'move');
    }

    let updatedTask = {
      ...task,
      status: targetStatus,
      updatedAt: new Date().toISOString(),
      logs: [...task.logs, {
        id: `log-ext-move-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: `Status moved from ${previousStatus.toUpperCase()} to ${targetStatus.toUpperCase()} via External API Call`,
        type: 'move',
      }],
    };
    if (updatedTask.status === 'done') {
      updatedTask = ensureCloseWarningBug(updatedTask);
      if (updatedTask.bugs.some((bug: any) => bug.source === 'auto-close-warning')) appendTaskLog(updatedTask, 'Done warning: unresolved bug thread created for unfinished mini tasks.', 'update');
    }
    saveTask(updatedTask);
    syncTaskAgentStateForStatus(updatedTask, previousStatus);
    saveTask(updatedTask);
    const standardPayload = {
      success: true,
      message: `Successfully relocated task schema from ${previousStatus} to ${targetStatus}`,
      task: updatedTask,
      autoWorkTrigger: null,
      bypassedBlockers: moveDecision.bypassedBlockers,
    };
    return res.json(toMutationResponse(req, updatedTask, standardPayload, {
      autoWorkTrigger: standardPayload.autoWorkTrigger,
      bypassedBlockers: standardPayload.bypassedBlockers,
    }));
  });

  app.post('/api/tasks/:id/move-to', (req, res) => {
    const statusErr = validateEnum(req.body.status, 'status', VALID_STATUSES, true);
    if (statusErr) return res.status(400).json({ error: statusErr });
    const taskIndex = getTaskIndexByIdentifier(getTasks(), req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });
    const task = getTasks()[taskIndex];
    const fromStatus = task.status;
    const targetStatus = req.body.status as TaskStatus;
    const path = getTransitionPath(fromStatus, targetStatus);
    if (!path) return res.status(400).json({ error: getValidationErrorMessage(fromStatus, targetStatus) });
    if (path.length === 1) return res.json(toMutationResponse(req, task, { message: 'Task is already in that lane', task, path }));

    const activeRun = getActiveRunForTask(task.id);
    const hardBlockers = activeRun && !canOverrideTaskLock(task, req.body, undefined, req.headers['x-agent-request'])
      ? [{ code: 'ACTIVE_AGENT_LOCK', message: `Task is actively owned by ${activeRun.agent || 'an agent'} (${activeRun.status}). Cancel/complete the run before moving it manually.`, bypassable: false, details: { runId: activeRun.id, status: activeRun.status, agent: activeRun.agent } }]
      : [];
    const moveDecision = evaluateMove({
      intent: req.body.intent,
      manualOverride: req.body.manualOverride === true,
      softBlockers: getTaskMoveWorkflowBlockers(task, deps, targetStatus),
      hardBlockers,
    });
    if (!moveDecision.allowed) return sendMoveBlocked(res, fromStatus, targetStatus, moveDecision, path);
    if (moveDecision.bypassedBlockers.length > 0) appendTaskLog(task, `Manual override move ${fromStatus} -> ${targetStatus}; bypassed soft blockers: ${moveDecision.bypassedBlockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join(' | ')}`, 'move');

    const movedStatuses: Array<{ from: TaskStatus; to: TaskStatus }> = [];
    for (let index = 1; index < path.length; index += 1) {
      const previousStatus = task.status;
      const nextStatus = path[index];
      if (!isValidTransition(previousStatus, nextStatus)) return res.status(400).json({ error: getValidationErrorMessage(previousStatus, nextStatus), path });
      task.status = nextStatus;
      task.updatedAt = new Date().toISOString();
      task.logs = [...task.logs, { id: `log-ext-move-path-${Date.now()}-${index}`, timestamp: new Date().toISOString(), message: `Status moved from ${previousStatus.toUpperCase()} to ${nextStatus.toUpperCase()} via transition helper`, type: 'move' }];
      saveTask(task);
      syncTaskAgentStateForStatus(task, previousStatus);
      movedStatuses.push({ from: previousStatus, to: nextStatus });
    }
    if (task.status === 'done') {
      const updatedTask = ensureCloseWarningBug(task);
      task.bugs = updatedTask.bugs;
      task.updatedAt = updatedTask.updatedAt;
      if (task.bugs.some((bug: any) => bug.source === 'auto-close-warning')) appendTaskLog(task, 'Done warning: unresolved bug thread created for unfinished mini tasks.', 'update');
    }
    saveTask(task);
    const standardPayload = { success: true, message: `Successfully moved task from ${fromStatus} to ${targetStatus}`, task, path, movedStatuses, autoWorkTrigger: null, bypassedBlockers: moveDecision.bypassedBlockers };
    return res.json(toMutationResponse(req, task, standardPayload, {
      autoWorkTrigger: standardPayload.autoWorkTrigger,
      bypassedBlockers: standardPayload.bypassedBlockers,
      path,
      movedStatuses,
    }));
  });
}

function sendMoveBlocked(
  res: express.Response,
  sourceStatus: TaskStatus,
  targetStatus: TaskStatus,
  moveDecision: ReturnType<typeof evaluateMove>,
  path?: TaskStatus[],
) {
  const confirmationRequired = moveDecision.outcome === 'confirmation-required';
  const code = confirmationRequired ? 'MOVE_CONFIRMATION_REQUIRED' : moveDecision.outcome === 'hard-blocked' ? 'MOVE_HARD_BLOCKED' : 'MOVE_WORKFLOW_BLOCKED';
  return res.status(confirmationRequired ? 409 : moveDecision.outcome === 'hard-blocked' ? 403 : 400).json({
    success: false,
    code,
    error: moveDecision.blockers.map((blocker) => blocker.message).join(' '),
    message: confirmationRequired ? 'This manual move is blocked only by workflow-quality checks. Confirm manual override to continue.' : moveDecision.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join(' '),
    confirmationRequired,
    sourceStatus,
    targetStatus,
    ...(path ? { path } : {}),
    blockers: moveDecision.blockers,
    retry: confirmationRequired ? { intent: 'manual', manualOverride: true } : undefined,
  });
}
