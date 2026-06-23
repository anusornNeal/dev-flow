import { getProject } from '../repositories/projectRepository.js';
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
import { registerTaskImportFileRoute } from './taskImportFileRoute';

const STALE_AGENT_RUN_MS = 30 * 60 * 1000;
let lastCleanupCheck = 0;
const CLEANUP_INTERVAL_MS = 30_000;

type TriggerTaskAgentResult =
  | { triggered: true; run: AgentRun }
  | { triggered: false; reason: string; code?: AgentLaunchPreflightCode | 'TASK_ALREADY_RUNNING' | 'AGENT_ALREADY_RUNNING' | 'LAUNCH_PLAN_INVALID'; run?: AgentRun | null };
export type TriggerTaskAgentFailure = Extract<TriggerTaskAgentResult, { triggered: false }>;
type ContinueTaskQueueResult = {
  triggered: boolean;
  reason: string;
  run?: AgentRun;
  runs?: AgentRun[];
};
type TaskReadMode = 'minimal' | 'summary' | 'board' | 'standard' | 'full' | 'agent-context' | 'debug';
type MutationResponseMode = 'standard' | 'summary' | 'ack';
type AgentCompletionRouteResult = { task: any; run: AgentRun; payload: AgentCompletionPayload };

function normalizeFlag(value: unknown) {
  return value === true || String(value).toLowerCase() === 'true';
}

export function parseTaskReadMode(value: unknown, fallback: TaskReadMode = 'standard'): TaskReadMode {
  const mode = String(value || fallback) as TaskReadMode;
  return ['minimal', 'summary', 'board', 'standard', 'full', 'agent-context', 'debug'].includes(mode) ? mode : fallback;
}

function parseMutationResponseMode(value: unknown): MutationResponseMode {
  const mode = String(value || 'standard') as MutationResponseMode;
  return ['standard', 'summary', 'ack'].includes(mode) ? mode : 'standard';
}

export function getTaskIndexByIdentifier(tasks: any[], targetId: string) {
  return tasks.findIndex((task) => task.id === targetId || task.displayId === targetId);
}

export function toTaskResponse(task: any, mode: TaskReadMode) {
  if (mode === 'minimal') {
    return {
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      status: task.status,
      projectId: task.projectId,
    };
  }

  if (mode === 'summary') {
    return {
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      status: task.status,
      priority: task.priority,
      projectId: task.projectId,
      parentId: task.parentId,
      agent: task.agent,
      model: task.model,
      effort: task.effort,
      updatedAt: task.updatedAt,
      latestAgentRun: task.latestAgentRun,
    };
  }

  if (mode === 'board') {
    return {
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      status: task.status,
      priority: task.priority,
      category: task.category,
      projectId: task.projectId,
      parentId: task.parentId,
      branch: task.branch,
      tags: task.tags,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      targetFiles: task.targetFiles,
      checklist: task.checklist,
      images: task.images,
      specUrl: task.specUrl,
      agent: task.agent,
      activeAgent: task.activeAgent,
      latestAgentRun: task.latestAgentRun,
      agentRuns: task.agentRuns,
      model: task.model,
      effort: task.effort,
      repo: task.repo,
      sourceUrl: task.sourceUrl,
    };
  }

  if (mode === 'standard') {
    return {
      ...task,
      attachments: listAttachmentsForTask(task.id),
      logs: undefined,
    };
  }

  return {
    ...task,
    attachments: listAttachmentsForTask(task.id),
  };
}

export function toMutationResponse(req: express.Request, task: any, standardPayload: any, extra?: Record<string, any>) {
  const responseMode = parseMutationResponseMode(req.query.responseMode);
  if (responseMode === 'ack') {
    return {
      success: true,
      responseMode,
      taskId: task.id,
      displayId: task.displayId,
      status: task.status,
      ...(extra || {}),
    };
  }
  if (responseMode === 'summary') {
    return {
      success: true,
      responseMode,
      task: toTaskResponse(task, 'summary'),
      ...(extra || {}),
    };
  }
  return standardPayload;
}

export function toMutationListResponse(req: express.Request, tasks: any[], standardPayload: any, extra?: Record<string, any>) {
  const responseMode = parseMutationResponseMode(req.query.responseMode);
  if (responseMode === 'ack') {
    return {
      success: true,
      responseMode,
      count: tasks.length,
      tasks: tasks.map((task) => ({
        id: task.id,
        displayId: task.displayId,
        status: task.status,
      })),
      ...(extra || {}),
    };
  }
  if (responseMode === 'summary') {
    return {
      success: true,
      responseMode,
      count: tasks.length,
      tasks: tasks.map((task) => toTaskResponse(task, 'summary')),
      ...(extra || {}),
    };
  }
  return standardPayload;
}

function resolveTaskListProjectId(deps: ApiRouteDeps, req: express.Request) {
  const project = findProjectByIdentifier(deps.state, {
    projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
    projectName: typeof req.query.projectName === 'string' ? req.query.projectName : undefined,
    repo: typeof req.query.repo === 'string' ? req.query.repo : undefined,
    repoUrl: typeof req.query.repoUrl === 'string' ? req.query.repoUrl : undefined,
    localPath: typeof req.query.localPath === 'string' ? req.query.localPath : undefined,
  });
  return project?.id || null;
}

export function filterTasksForList(deps: ApiRouteDeps, req: express.Request) {
  let tasks = [...deps.state.tasksCache];
  const resolvedProjectId = resolveTaskListProjectId(deps, req);
  const projectId = resolvedProjectId || (typeof req.query.projectId === 'string' ? req.query.projectId : '');
  const parentId = typeof req.query.parentId === 'string' ? req.query.parentId : '';
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const query = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

  if (projectId) {
    tasks = tasks.filter((task) => task.projectId === projectId);
  }
  if (parentId) {
    const parentTask = findTaskByIdentifier(deps.state, parentId);
    tasks = tasks.filter((task) => task.parentId === (parentTask?.id || parentId));
  }
  if (status) {
    tasks = tasks.filter((task) => task.status === status);
  }
  if (query) {
    tasks = tasks.filter((task) => {
      const haystack = [
        task.id,
        task.displayId,
        task.title,
        task.description,
        task.reasoning,
        task.acceptanceCriteria,
        task.verification,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  return tasks;
}

export function createTaskLogEntry(message: string, type: string = 'update') {
  return {
    id: `log-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
    timestamp: new Date().toISOString(),
    message,
    type,
  };
}

export function appendTaskLog(task: any, message: string, type: string = 'update') {
  const lastLog = Array.isArray(task.logs) ? task.logs[task.logs.length - 1] : null;
  if (lastLog?.message === message && lastLog?.type === type) return;
  task.logs = [...(task.logs || []), createTaskLogEntry(message, type)];
}

export function stripRequestControlFields<T extends Record<string, any>>(input: T): T {
  const copy = { ...input };
  delete copy.idempotencyKey;
  delete copy.resourceLockOverride;
  return copy;
}

function taskRequiresManualEvidence(task: any) {
  const haystack = [
    task?.description,
    task?.acceptanceCriteria,
    task?.verification,
    ...(Array.isArray(task?.targetFiles) ? task.targetFiles : []),
  ].filter(Boolean).join(' ').toLowerCase();
  return /evidence|prompt\.md|agent\.log/.test(haystack);
}

function taskHasManualEvidence(task: any) {
  const messages = (task.logs || []).map((entry: any) => String(entry?.message || ''));
  const hasPromptExcerpt = messages.some((message: string) => /prompt\.md/i.test(message));
  const hasAgentLogExcerpt = messages.some((message: string) => /agent\.log/i.test(message));
  return hasPromptExcerpt && hasAgentLogExcerpt;
}

function getChildReviewBlockers(task: any, deps: ApiRouteDeps) {
  const children = deps.state.tasksCache.filter((entry) => entry.parentId === task.id);
  if (children.length === 0) return [];

  const blockers: string[] = [];
  for (const child of children) {
    if (!['ready-for-review', 'done'].includes(child.status)) {
      blockers.push(`${child.displayId || child.id} is still ${child.status}.`);
      continue;
    }
    if (taskRequiresManualEvidence(child) && !taskHasManualEvidence(child)) {
      blockers.push(`${child.displayId || child.id} is missing visible prompt.md and agent.log evidence in task logs.`);
    }
  }
  return blockers;
}

export function validateParentReviewMove(task: any, deps: ApiRouteDeps, nextStatus: string) {
  if (!['ready-for-review', 'done'].includes(nextStatus)) return null;
  const blockers = getChildReviewBlockers(task, deps);
  if (blockers.length === 0) return null;
  return `Parent task ${task.displayId || task.id} cannot move to ${nextStatus} yet: ${blockers.join(' ')}`;
}

function clearActiveAgentIfSettled(task: any) {
  if (['backlog', 'done', 'ready-for-review'].includes(task.status)) {
    const activeRun = getActiveRunForTask(task.id);
    if (activeRun && ['done', 'ready-for-review'].includes(task.status)) {
      updateAgentRunStatus(activeRun.id, 'succeeded');
    }
    task.activeAgent = undefined;
  }
}

export function syncTaskAgentStateForStatus(task: any, previousStatus?: string) {
  if (task.status === 'backlog') {
    if (previousStatus !== 'backlog') {
      const resetReason = 'Manual reset: moved task to backlog and cancelled the active agent run.';
      cancelActiveRunsForTask(task.id, resetReason);
      appendTaskLog(task, 'Manual reset: cleared active agent lock after moving task to BACKLOG.', 'update');
    }
    applyRunSummaryToTask(task, getLatestAgentRunForTask(task.id));
    task.activeAgent = undefined;
    return;
  }

  clearActiveAgentIfSettled(task);
  applyRunSummaryToTask(task, getLatestAgentRunForTask(task.id));
}

export function canOverrideTaskLock(task: any, body: any, query?: any, agentRequestValue?: any) {
  const isAgentRequest = String(agentRequestValue).toLowerCase() === 'true';
  const emergencyBody = body?.emergency === true || String(body?.emergency).toLowerCase() === 'true';
  const emergencyQuery = String(query?.emergency).toLowerCase() === 'true';
  return isAgentRequest || emergencyBody || emergencyQuery;
}

export function applyRunSummaryToTask(task: any, run: AgentRun | null) {
  const activeRun = run && ['queued', 'starting', 'running'].includes(run.status) ? run : getActiveRunForTask(task.id);
  const latestRun = run || getLatestAgentRunForTask(task.id);
  const allRuns = listAgentRunsForTask(task.id);
  task.activeAgent = activeRun?.agent || undefined;
  task.latestAgentRun = latestRun ? {
    id: latestRun.id,
    status: latestRun.status,
    agent: latestRun.agent,
    errorMessage: latestRun.errorMessage,
    createdAt: latestRun.createdAt,
    startedAt: latestRun.startedAt,
    endedAt: latestRun.endedAt,
  } : undefined;
  task.agentRuns = allRuns.map((r) => ({
    id: r.id,
    status: r.status,
    logFile: r.logPath,
  }));
}

export function requireAgentOwnedRequest(req: express.Request) {
  return String(req.headers['x-agent-request']).toLowerCase() === 'true';
}

function formatAgentCompletionLogMessage(payload: AgentCompletionPayload) {
  const statusLabel = payload.status.toUpperCase();
  const parts = [`Agent completion callback recorded ${statusLabel}.`, payload.summary];
  if (payload.changedFiles && payload.changedFiles.length > 0) {
    parts.push(`Changed files: ${payload.changedFiles.join(', ')}`);
  }
  if (payload.tests && payload.tests.length > 0) {
    parts.push(`Tests: ${payload.tests.map((test) => `${test.command}=${test.result}`).join('; ')}`);
  }
  if (payload.notes) {
    parts.push(`Notes: ${payload.notes}`);
  }
  return parts.join(' ');
}

function buildSameAgentBusyMessage(task: any, activeRun: AgentRun) {
  const assignedAgent = task.agent || activeRun.agent;
  return `Auto Work queued: assigned agent ${assignedAgent} is busy with run ${activeRun.id}; task stays in TODO until that agent becomes available.`;
}

function resolveAgentCompletionTargetStatus(payload: AgentCompletionPayload): TaskStatus {
  if (payload.status === 'success') {
    return payload.moveTo || 'ready-for-review';
  }
  return payload.moveTo || 'todo';
}

export function applyAgentCompletionCallback(task: any, run: AgentRun, deps: ApiRouteDeps, payload: AgentCompletionPayload): AgentCompletionRouteResult {
  const summaryText = buildAgentCompletionSummary(payload);
  const completionMessage = formatAgentCompletionLogMessage(payload);
  const targetStatus = resolveAgentCompletionTargetStatus(payload);
  const runDir = run.logPath ? path.dirname(run.logPath) : path.join(resolveFromDevFlowAppRoot('.devflow', 'runs'), run.id);

  let updatedRun: AgentRun | null = null;
  let nextStatus: TaskStatus = task.status;

  if (payload.status === 'success') {
    const reviewBlockError = validateParentReviewMove(task, deps, targetStatus);
    if (reviewBlockError) {
      throw createApiError(409, 'TASK_REVIEW_BLOCKED', reviewBlockError, { affectedId: task.id });
    }
    nextStatus = targetStatus;
    updatedRun = updateAgentRunStatus(run.id, 'succeeded');
  } else if (payload.status === 'failed') {
    nextStatus = targetStatus;
    updatedRun = updateAgentRunStatus(run.id, 'failed', { errorMessage: payload.summary });
  } else {
    nextStatus = targetStatus;
    updatedRun = updateAgentRunStatus(run.id, 'cancelled', { errorMessage: payload.summary });
  }

  writeAgentRunOutputSummary(runDir, summaryText);
  writeAgentRunResult(runDir, {
    ...createAgentRunResultRecord({
      runId: run.id,
      status: updatedRun?.status || run.status,
      summary: payload.summary,
      success: payload.status === 'success' ? true : payload.status === 'failed' ? false : null,
      errorMessage: payload.status === 'success' ? null : payload.summary,
      completedAt: new Date().toISOString(),
    }),
    payload,
  });
  if (run.logPath) {
    appendAgentRunLog(run.logPath, completionMessage);
  }

  task.status = nextStatus;
  task.updatedAt = new Date().toISOString();
  appendTaskLog(task, completionMessage, 'update');
  applyRunSummaryToTask(task, updatedRun || getLatestAgentRunForTask(task.id));
  saveTask(task);

  return { task, run: updatedRun || run, payload };
}

export function cleanupStaleActiveRuns(deps: ApiRouteDeps) {
  const cutoff = new Date(Date.now() - STALE_AGENT_RUN_MS).toISOString();
  const cancelledCount = cancelStaleActiveRuns(cutoff, `Stale active run cancelled after ${STALE_AGENT_RUN_MS / 60000} minutes.`);
  if (cancelledCount > 0) {
    deps.writeAgentLog('INFO', `Cancelled ${cancelledCount} stale active agent run(s).`);
    // Batch-load all agent runs to avoid N+1 loop
    const allRuns = db.prepare('SELECT * FROM agent_runs ORDER BY createdAt DESC').all() as AgentRun[];
    const runsByTaskId = new Map<string, AgentRun[]>();
    for (const run of allRuns) {
      const existing = runsByTaskId.get(run.taskId);
      if (existing) { existing.push(run); }
      else { runsByTaskId.set(run.taskId, [run]); }
    }
    for (const task of deps.state.tasksCache) {
      const taskRuns = runsByTaskId.get(task.id) || [];
      const activeRun = taskRuns.find(r => ACTIVE_AGENT_RUN_STATUSES.includes(r.status as any)) || null;
      const latestRun = taskRuns[0] || null;
      task.activeAgent = activeRun?.agent || undefined;
      task.latestAgentRun = latestRun ? {
        id: latestRun.id,
        status: latestRun.status,
        agent: latestRun.agent,
        errorMessage: latestRun.errorMessage,
        createdAt: latestRun.createdAt,
        startedAt: latestRun.startedAt,
        endedAt: latestRun.endedAt,
      } : undefined;
      task.agentRuns = taskRuns.map((r) => ({ id: r.id, status: r.status, logFile: r.logPath }));
    }
    saveTasks(deps.state);
  }
}

export function runThrottledStaleCleanup(deps: ApiRouteDeps, now = Date.now()) {
  if (now - lastCleanupCheck <= CLEANUP_INTERVAL_MS) return;
  cleanupStaleActiveRuns(deps);
  lastCleanupCheck = now;
}

function failTaskRun(task: any, deps: ApiRouteDeps, runId: string, reason: string, options?: {
  runDir?: string | null;
  logPath?: string | null;
  taskMessage?: string;
}) {
  const failedRun = updateAgentRunStatus(runId, 'failed', { errorMessage: reason });
  task.status = 'todo';
  task.updatedAt = new Date().toISOString();
  appendTaskLog(task, options?.taskMessage || reason, 'update');
  if (options?.logPath) appendAgentRunLog(options.logPath, reason);
  if (options?.runDir) {
    writeAgentRunOutputSummary(options.runDir, reason);
    writeAgentRunResult(options.runDir, createAgentRunResultRecord({
      runId,
      status: 'failed',
      summary: reason,
      success: false,
      errorMessage: reason,
      completedAt: new Date().toISOString(),
    }));
  }
  applyRunSummaryToTask(task, failedRun);
  saveTask(task);
  return failedRun;
}

export function completeAgentRunForTask(task: any, run: AgentRun, deps: ApiRouteDeps, options: {
  success: boolean;
  exitCode?: number | null;
  errorMessage?: string;
}) {
  let updatedRun: AgentRun | null;
  if (options.success) {
    const reviewBlockError = validateParentReviewMove(task, deps, 'ready-for-review');
    updatedRun = updateAgentRunStatus(run.id, 'succeeded');
    if (run.logPath) {
      const runDir = path.dirname(run.logPath);
      const summary = `Run ${run.id} completed successfully.`;
      writeAgentRunOutputSummary(runDir, summary);
      writeAgentRunResult(runDir, createAgentRunResultRecord({
        runId: run.id,
        status: 'succeeded',
        summary,
        success: true,
        exitCode: options.exitCode ?? 0,
        completedAt: new Date().toISOString(),
      }));
    }
    if (reviewBlockError) {
      task.status = 'todo';
      appendTaskLog(task, `Agent run ${run.id} completed successfully, but review is still blocked. ${reviewBlockError}`, 'update');
    } else {
      task.status = 'ready-for-review';
      appendTaskLog(task, `Agent run ${run.id} completed successfully.`, 'update');
    }
  } else {
    const exitCodeSuffix = options.exitCode !== undefined && options.exitCode !== null ? ` (exitCode=${options.exitCode})` : '';
    const detail = options.errorMessage?.trim() || 'Run failed';
    const errorMessage = `${detail}${exitCodeSuffix}`;
    updatedRun = updateAgentRunStatus(run.id, 'failed', { errorMessage });
    if (run.logPath) {
      const runDir = path.dirname(run.logPath);
      writeAgentRunOutputSummary(runDir, errorMessage);
      writeAgentRunResult(runDir, createAgentRunResultRecord({
        runId: run.id,
        status: 'failed',
        summary: errorMessage,
        success: false,
        exitCode: options.exitCode ?? null,
        errorMessage,
        completedAt: new Date().toISOString(),
      }));
    }
    task.status = 'todo';
    appendTaskLog(task, `Agent run ${run.id} failed: ${errorMessage}`, 'update');
  }

  task.updatedAt = new Date().toISOString();
  applyRunSummaryToTask(task, updatedRun || getLatestAgentRunForTask(task.id));
  saveTask(task);
  return updatedRun;
}

export function continueTaskQueueForProject(projectId: string, deps: ApiRouteDeps) {
  const eligibleTasks = deps.state.tasksCache.filter((entry) => entry.projectId === projectId && entry.status === 'todo' && entry.agent);
  eligibleTasks.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
  const startedRuns: AgentRun[] = [];

  for (const nextTask of eligibleTasks) {
    const latestRun = getLatestAgentRunForTask(nextTask.id);
    if (latestRun?.status === 'failed') {
      appendTaskLog(nextTask, 'Queue continuation skipped: latest agent run failed. Manual retry is required before auto-work can pick this task again.', 'update');
      continue;
    }

    const result = triggerTaskAgent(nextTask, deps, 'queue continuation');
    if (result.triggered) {
      startedRuns.push(result.run);
      continue;
    }

    const blockedResult = result as TriggerTaskAgentFailure;
    if (blockedResult.code !== 'AGENT_ALREADY_RUNNING') {
      appendTaskLog(nextTask, `Queue continuation skipped: ${blockedResult.reason}`, 'update');
    }
  }

  saveTasks(deps.state);
  if (startedRuns.length > 0) {
    return {
      triggered: true,
      reason: `Started ${startedRuns.length} eligible task(s) for project ${projectId}.`,
      run: startedRuns[0],
      runs: startedRuns,
    } satisfies ContinueTaskQueueResult;
  }
  const activeSummaries = listActiveRunSummariesForProject(projectId);
  if (activeSummaries.length > 0) {
    const agentList = activeSummaries.map((summary) => `${summary.agent}:${summary.runId}`).join(', ');
    return { triggered: false, reason: `No eligible todo task could be started. Active agent runs: ${agentList}.` } satisfies ContinueTaskQueueResult;
  }
  return { triggered: false, reason: 'No eligible todo task could be started.' } satisfies ContinueTaskQueueResult;
}

export function triggerTaskAgent(task: any, deps: ApiRouteDeps, routeLabel: string, retryOfRunId?: string | null): TriggerTaskAgentResult {
  if (!task.agent) return { triggered: false, code: 'NO_AGENT', reason: 'Task has no assigned agent.' };
  if (!/^[a-zA-Z0-9-]+$/.test(task.agent) || !/^[a-zA-Z0-9-]+$/.test(task.id)) {
    deps.writeAgentLog('ERROR', `Blocked trigger due to invalid chars: agent=${task.agent} taskId=${task.id}`);
    return { triggered: false, reason: 'Invalid agent or task id characters.' };
  }

  cleanupStaleActiveRuns(deps);

  const project = getProject(task.projectId);
  const executionMode = resolveAgentExecutionMode(getSettings().agentExecutionMode || process.env.DEVFLOW_AGENT_EXECUTION_MODE);
  const preflight = runAgentLaunchPreflight({
    agent: task.agent,
    localPath: project?.localPath,
    model: task.model,
    effort: task.effort,
    executionMode,
    appRoot: resolveFromDevFlowAppRoot(),
  });

  if (!preflight.ok || !preflight.launchPlan) {
    deps.writeAgentLog('ERROR', `Blocked trigger for task=${task.id}: [${preflight.code}] ${preflight.message}`);
    return { triggered: false, code: preflight.code, reason: preflight.message };
  }
  const launchPlan = preflight.launchPlan;

  const activeTaskRun = getActiveRunForTask(task.id);
  if (activeTaskRun) {
    return {
      triggered: false,
      code: 'TASK_ALREADY_RUNNING',
      reason: `${activeTaskRun.agent} is already running for this task.`,
      run: activeTaskRun,
    };
  }

  const activeAgentRun = getActiveRunForProjectAndAgent(task.projectId, task.agent);
  if (activeAgentRun && activeAgentRun.taskId !== task.id) {
    deps.writeAgentLog('INFO', `Assigned agent already busy for project=${task.projectId} agent=${task.agent}, queueing task=${task.id}`);
    appendTaskLog(task, buildSameAgentBusyMessage(task, activeAgentRun), 'update');
    return {
      triggered: false,
      code: 'AGENT_ALREADY_RUNNING',
      reason: `${task.agent} already has active run ${activeAgentRun.id}.`,
      run: activeAgentRun,
    };
  }

  const run = createAgentRun({
    taskId: task.id,
    projectId: task.projectId,
    agent: task.agent,
    model: task.model,
    effort: task.effort,
    retryOfRunId: retryOfRunId || null,
    triggerSource: routeLabel,
  });

  task.status = 'in-progress';
  task.updatedAt = new Date().toISOString();
  applyRunSummaryToTask(task, run);
  saveTask(task);

  let prompt = '';
  let files: { runDir: string; promptPath: string; logPath: string };
  try {
    prompt = renderTaskPrompt(deps.state, task.id, { runId: run.id }).renderResult.content;
    files = createAgentRunFiles({ runId: run.id, prompt });
  } catch (error: any) {
    const reason = error?.message || 'Task prompt could not be built.';
    deps.writeAgentLog('ERROR', `Agent startup preparation failed for run=${run.id} task=${task.id}: ${reason}`);
    const failedRun = failTaskRun(task, deps, run.id, reason, {
      runDir: files?.runDir,
      taskMessage: `Agent startup failed before launch: ${reason}`,
    });
    return { triggered: false, reason, run: failedRun };
  }

  let currentRun = updateAgentRunStatus(run.id, 'queued', {
    promptPath: files.promptPath,
    contextRef: files.promptPath,
    logPath: files.logPath,
  });
  appendAgentRunLog(files.logPath, `Queued ${task.agent} for task ${task.id} from ${routeLabel}`);
  currentRun = updateAgentRunStatus(run.id, 'starting', { startedAt: new Date().toISOString() }) || currentRun;
  applyRunSummaryToTask(task, currentRun);
  saveTask(task);

  const triggerBat = getAgentTriggerScriptPath();
  const invokeTriggerScript = resolveFromDevFlowAppRoot('scripts', 'invoke-agent-trigger.ps1');
  const apiBaseUrl = getDevFlowApiBaseUrl();

  const execOpts = {
    cwd: project?.localPath || undefined,
    env: {
      ...process.env,
      GITHUB_PERSONAL_ACCESS_TOKEN: getSettings().githubToken || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '',
      JIRA_BASE_URL: getSettings().jiraBaseUrl || process.env.JIRA_BASE_URL || '',
      JIRA_EMAIL: getSettings().jiraEmail || process.env.JIRA_EMAIL || '',
      JIRA_API_TOKEN: getSettings().jiraToken || process.env.JIRA_API_TOKEN || process.env.JIRA_PERSONAL_ACCESS_TOKEN || '',
      DEVFLOW_AGENT_EXECUTION_MODE: executionMode,
      DEVFLOW_API_BASE_URL: apiBaseUrl,
    }
  };
  const agentLaunchPreview = buildAgentLaunchConfig({
    task: {
      id: task.id,
      agent: task.agent,
      model: task.model,
      effort: task.effort,
    },
    project: {
      localPath: project?.localPath,
    },
    promptPath: files.promptPath,
    logPath: files.logPath,
    runId: run.id,
    executionMode,
    apiBaseUrl,
    appRoot: resolveFromDevFlowAppRoot(),
    preview: true,
    environment: execOpts.env,
  });
  if (agentLaunchPreview.ok === false) {
    const reason = agentLaunchPreview.error;
    deps.writeAgentLog('ERROR', `Launch preview failed for run=${run.id} task=${task.id}: ${reason}`);
    failTaskRun(task, deps, run.id, reason, {
      runDir: files.runDir,
      logPath: files.logPath,
      taskMessage: `Agent startup failed before launch: ${reason}`,
    });
    return { triggered: false, code: 'LAUNCH_PLAN_INVALID', reason, run: currentRun || run };
  }

  deps.writeAgentLog('TRIGGER', `Spawning run=${run.id} agent=${task.agent} for task=${task.id} ("${task.title}") via ${routeLabel}${project?.localPath ? ' at ' + project.localPath : ''}`);
  appendAgentRunLog(files.logPath, `Launch plan: agent=${launchPlan.agent} model=${launchPlan.devFlowModel || 'none'} resolvedModel=${launchPlan.resolvedModel || 'none'} effort=${launchPlan.selectedEffort || 'none'} effortHandling=${launchPlan.effortHandling.mode} executionMode=${executionMode}`);
  appendAgentRunLog(files.logPath, `cwd=${project?.localPath || 'none'} triggerScript=${triggerBat} promptPath=${files.promptPath}`);
  appendAgentRunLog(files.logPath, agentLaunchPreview.previewText);
  writeAgentRunLaunchMetadata(files.runDir, {
    runId: run.id,
    taskId: task.id,
    agent: task.agent,
    routeLabel,
    executionMode,
    cwd: project?.localPath || null,
    promptPath: files.promptPath,
    logPath: files.logPath,
    triggerScript: triggerBat,
    launchPlan,
    launchPackage: {
      executable: agentLaunchPreview.executable,
      parameters: agentLaunchPreview.parameters,
      cwd: agentLaunchPreview.cwd,
      promptReference: agentLaunchPreview.promptReference,
      previewText: agentLaunchPreview.previewText,
    },
    writtenAt: new Date().toISOString(),
  });
  const startingSummary = `Run ${run.id} queued for ${task.agent}.`;
  writeAgentRunOutputSummary(files.runDir, startingSummary);
  writeAgentRunResult(files.runDir, createAgentRunResultRecord({
    runId: run.id,
    status: 'starting',
    summary: startingSummary,
  }));
  execFile('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    invokeTriggerScript,
    triggerBat,
    task.agent,
    task.id,
    project?.localPath || 'none',
    task.model || 'none',
    task.effort || 'none',
    run.id,
    files.promptPath,
    files.logPath,
    apiBaseUrl,
  ], execOpts, (error) => {
    if (error) {
      const reason = error.message || 'trigger-agent.bat failed.';
      deps.writeAgentLog('ERROR', `trigger-agent.bat failed for run=${run.id} task=${task.id}: ${error.message}`);
      failTaskRun(task, deps, run.id, reason, {
        runDir: files.runDir,
        logPath: files.logPath,
        taskMessage: `Agent startup failed before launch: ${reason}`,
      });
      return;
    }

    const runningRun = updateAgentRunStatus(run.id, 'running');
    appendAgentRunLog(files.logPath, 'Runner completed launcher handoff successfully; run marked running.');
    const runningSummary = `Run ${run.id} is running.`;
    writeAgentRunOutputSummary(files.runDir, runningSummary);
    writeAgentRunResult(files.runDir, createAgentRunResultRecord({
      runId: run.id,
      status: 'running',
      summary: runningSummary,
    }));
    deps.writeAgentLog('INFO', `Runner completed launcher handoff for run=${run.id} task=${task.id}`);
    applyRunSummaryToTask(task, runningRun);
    saveTask(task);
  });

  return { triggered: true, run: currentRun || run };
}

export function maybeTriggerTaskAgent(task: any, previousTaskOrStatus: any, deps: ApiRouteDeps, routeLabel: string): TriggerTaskAgentResult | null {
  const previousTask = typeof previousTaskOrStatus === 'string' ? null : previousTaskOrStatus;
  const previousStatus = typeof previousTaskOrStatus === 'string' ? previousTaskOrStatus : previousTask?.status;
  const assignmentChanged = previousTask
    ? previousTask.agent !== task.agent || previousTask.model !== task.model || previousTask.effort !== task.effort
    : true;
  if (task.status !== 'todo') return null;
  if (previousStatus === 'todo' && !assignmentChanged) return null;
  if (!getSettings().autoWork) {
    deps.writeAgentLog('INFO', `Auto Work is disabled. Task ${task.id} moved to todo but agent will not be triggered.`);
    return null;
  }
  const result = triggerTaskAgent(task, deps, routeLabel);
  if (!result.triggered) {
    const blockedResult = result as TriggerTaskAgentFailure;
    deps.writeAgentLog('INFO', `Skipped agent trigger for task=${task.id}: ${blockedResult.reason}`);
    if (blockedResult.code !== 'AGENT_ALREADY_RUNNING') {
      appendTaskLog(task, `Auto Work blocked before launch: ${blockedResult.reason}`, 'update');
    }
  }
  return result;
}


