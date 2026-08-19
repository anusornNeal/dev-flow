import type express from 'express';
import type { ApiRouteDeps } from '../types';
import type { TaskStatus } from '../../types';
import { VALID_STATUSES } from '../constants';
import { getActiveRunForTask } from '../repositories/agentRunRepository';
import { getTasks } from '../repositories/taskRepository.js';
import { sendApiError } from '../services/api.js';
import { mutateTaskStatusWithLifecycle } from '../services/taskClaimService.js';
import { getTransitionPath, getValidationErrorMessage, isValidTransition } from '../../lib/statusTransitions';
import { evaluateMove, ensureCloseWarningBug, normalizeRecoveryDisposition, requiresRecoveryDispositionForDone } from '../useCases/taskUseCases';
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
    const recovery = prepareMoveRecoveryDisposition(targetStatus, moveDecision.bypassedBlockers, req.body.recoveryDisposition);
    if (recovery.error) return res.status(recovery.error.status).json(recovery.error.body);
    let mutation: ReturnType<typeof mutateTaskStatusWithLifecycle>;
    try {
      mutation = mutateTaskStatusWithLifecycle(task.id, targetStatus, (base) => {
      let updatedTask = {
        ...base,
        status: targetStatus,
        updatedAt: new Date().toISOString(),
        logs: [...(Array.isArray(base.logs) ? base.logs : []), {
          id: `log-ext-move-${Date.now()}`,
          timestamp: new Date().toISOString(),
          message: `Status moved from ${previousStatus.toUpperCase()} to ${targetStatus.toUpperCase()} via External API Call`,
          type: 'move',
        }],
      };
      if (moveDecision.bypassedBlockers.length > 0) {
        appendTaskLog(updatedTask, `Manual override move ${previousStatus} -> ${targetStatus}; bypassed soft blockers: ${moveDecision.bypassedBlockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join(' | ')}`, 'move');
      }
      if (recovery.value) appendTaskLog(updatedTask, `[recovery-disposition] ${JSON.stringify(recovery.value)}`, 'update');
      if (updatedTask.status === 'done') {
        updatedTask = ensureCloseWarningBug(updatedTask);
        if (updatedTask.bugs.some((bug: any) => bug.source === 'auto-close-warning')) appendTaskLog(updatedTask, 'Done warning: unresolved bug thread created for unfinished mini tasks.', 'update');
      }
        syncTaskAgentStateForStatus(updatedTask, previousStatus);
        return updatedTask;
      }, { reason: `manual move ${previousStatus} -> ${targetStatus}` });
    } catch (error) {
      return sendApiError(res, error);
    }
    const updatedTask = mutation.task;
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
    const recovery = prepareMoveRecoveryDisposition(targetStatus, moveDecision.bypassedBlockers, req.body.recoveryDisposition);
    if (recovery.error) return res.status(recovery.error.status).json(recovery.error.body);
    const movedStatuses: Array<{ from: TaskStatus; to: TaskStatus }> = [];
    for (let index = 1; index < path.length; index += 1) {
      const previousStatus = path[index - 1];
      const nextStatus = path[index];
      if (!isValidTransition(previousStatus, nextStatus)) return res.status(400).json({ error: getValidationErrorMessage(previousStatus, nextStatus), path });
      movedStatuses.push({ from: previousStatus, to: nextStatus });
    }
    let mutation: ReturnType<typeof mutateTaskStatusWithLifecycle>;
    try {
      mutation = mutateTaskStatusWithLifecycle(task.id, targetStatus, (base) => {
      let updatedTask = { ...base, status: targetStatus, updatedAt: new Date().toISOString() };
      for (let index = 0; index < movedStatuses.length; index += 1) {
        const step = movedStatuses[index];
        updatedTask.logs = [...(Array.isArray(updatedTask.logs) ? updatedTask.logs : []), {
          id: `log-ext-move-path-${Date.now()}-${index + 1}`,
          timestamp: new Date().toISOString(),
          message: `Status moved from ${step.from.toUpperCase()} to ${step.to.toUpperCase()} via transition helper`,
          type: 'move',
        }];
      }
      if (moveDecision.bypassedBlockers.length > 0) appendTaskLog(updatedTask, `Manual override move ${fromStatus} -> ${targetStatus}; bypassed soft blockers: ${moveDecision.bypassedBlockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join(' | ')}`, 'move');
      if (recovery.value) appendTaskLog(updatedTask, `[recovery-disposition] ${JSON.stringify(recovery.value)}`, 'update');
      if (updatedTask.status === 'done') {
        updatedTask = ensureCloseWarningBug(updatedTask);
        if (updatedTask.bugs.some((bug: any) => bug.source === 'auto-close-warning')) appendTaskLog(updatedTask, 'Done warning: unresolved bug thread created for unfinished mini tasks.', 'update');
      }
        syncTaskAgentStateForStatus(updatedTask, fromStatus);
        return updatedTask;
      }, { reason: `multi-hop move ${fromStatus} -> ${targetStatus}` });
    } catch (error) {
      return sendApiError(res, error);
    }
    const movedTask = mutation.task;
    const standardPayload = { success: true, message: `Successfully moved task from ${fromStatus} to ${targetStatus}`, task: movedTask, path, movedStatuses, autoWorkTrigger: null, bypassedBlockers: moveDecision.bypassedBlockers };
    return res.json(toMutationResponse(req, movedTask, standardPayload, {
      autoWorkTrigger: standardPayload.autoWorkTrigger,
      bypassedBlockers: standardPayload.bypassedBlockers,
      path,
      movedStatuses,
    }));
  });
}

function prepareMoveRecoveryDisposition(targetStatus: TaskStatus, bypassedBlockers: Array<{ code?: string }>, raw: unknown) {
  const required = requiresRecoveryDispositionForDone(targetStatus, bypassedBlockers);
  if (required && (raw === undefined || raw === null)) {
    return {
      error: {
        status: 409,
        body: {
          success: false,
          code: 'MOVE_RECOVERY_DISPOSITION_REQUIRED',
          error: 'A recovery disposition is required before unfinished scope can be manually overridden to DONE.',
          message: 'Record how the unfinished implementation/evidence will be recovered, preserved, superseded, or followed up before moving this task to DONE.',
          confirmationRequired: true,
          targetStatus,
          blockers: bypassedBlockers,
        },
      },
    } as const;
  }
  if (raw === undefined || raw === null) return { value: undefined } as const;
  try {
    return { value: normalizeRecoveryDisposition(raw) } as const;
  } catch (error: any) {
    return {
      error: {
        status: 400,
        body: {
          success: false,
          code: 'INVALID_RECOVERY_DISPOSITION',
          error: error?.message || 'Invalid recoveryDisposition.',
          message: error?.message || 'Invalid recoveryDisposition.',
        },
      },
    } as const;
  }
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
