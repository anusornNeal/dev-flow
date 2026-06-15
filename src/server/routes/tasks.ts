import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { TASK_SCHEMA_DEF, VALID_AGENTS, LEGACY_VALID_EFFORTS_FALLBACK, VALID_MODELS, VALID_STATUSES } from '../constants';
import { cancelActiveRunsForTask, cancelStaleActiveRuns, createAgentRun, findActiveRunByTaskId, getActiveRunForProject, getActiveRunForTask, getLatestAgentRunForTask, listAgentRunsForTask, updateAgentRunStatus, type AgentRun } from '../repositories/agentRunRepository';
import { loadTasks, generateDisplayId, saveTasks } from '../repositories/taskRepository';
import { appendAgentRunLog, buildAgentCompletionSummary, createAgentRunFiles, createAgentRunResultRecord, getAgentRunHistoryPaths, getAgentTriggerScriptPath, getDevFlowApiBaseUrl, resolveAgentExecutionMode, resolveFromDevFlowAppRoot, writeAgentRunLaunchMetadata, writeAgentRunOutputSummary, writeAgentRunResult } from '../services/agentRunService';
import { extractDesignImages, findProjectByIdentifier, findTaskByIdentifier, getAgentTaskContext, normalizeAgentCompletionPayload, renderTaskPrompt, resolveProjectIdFromRepo, validateAgentCompletionPayload, validateAgentParams, validateTaskPayload } from '../services/taskService';
import { createApiError, sendApiError } from '../services/api';
import { validateEnum, validateString } from '../validation';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import { isValidTransition, getValidationErrorMessage } from '../../lib/statusTransitions';
import { buildAgentLaunchConfig, runAgentLaunchPreflight, type AgentLaunchPreflightCode } from '../services/agentLaunchConfig';
import type { AgentCompletionPayload, AgentCompletionStatus, TaskStatus } from '../../types';

const STALE_AGENT_RUN_MS = 30 * 60 * 1000;

type TriggerTaskAgentResult =
  | { triggered: true; run: AgentRun }
  | { triggered: false; reason: string; code?: AgentLaunchPreflightCode | 'TASK_ALREADY_RUNNING' | 'PROJECT_ALREADY_RUNNING'; run?: AgentRun | null };
type TriggerTaskAgentFailure = Extract<TriggerTaskAgentResult, { triggered: false }>;
type TaskReadMode = 'minimal' | 'summary' | 'standard' | 'full' | 'agent-context' | 'debug';
type AgentCompletionRouteResult = { task: any; run: AgentRun; payload: AgentCompletionPayload };

function normalizeFlag(value: unknown) {
  return value === true || String(value).toLowerCase() === 'true';
}

function parseTaskReadMode(value: unknown, fallback: TaskReadMode = 'standard'): TaskReadMode {
  const mode = String(value || fallback) as TaskReadMode;
  return ['minimal', 'summary', 'standard', 'full', 'agent-context', 'debug'].includes(mode) ? mode : fallback;
}

function getTaskIndexByIdentifier(tasks: any[], targetId: string) {
  return tasks.findIndex((task) => task.id === targetId || task.displayId === targetId);
}

function toTaskResponse(task: any, mode: TaskReadMode) {
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

  if (mode === 'standard') {
    return {
      ...task,
      logs: undefined,
    };
  }

  return task;
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

function filterTasksForList(deps: ApiRouteDeps, req: express.Request) {
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

function createTaskLogEntry(message: string, type: string = 'update') {
  return {
    id: `log-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
    timestamp: new Date().toISOString(),
    message,
    type,
  };
}

function appendTaskLog(task: any, message: string, type: string = 'update') {
  const lastLog = Array.isArray(task.logs) ? task.logs[task.logs.length - 1] : null;
  if (lastLog?.message === message && lastLog?.type === type) return;
  task.logs = [...(task.logs || []), createTaskLogEntry(message, type)];
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

function validateParentReviewMove(task: any, deps: ApiRouteDeps, nextStatus: string) {
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

function syncTaskAgentStateForStatus(task: any, previousStatus?: string) {
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

function canOverrideTaskLock(task: any, body: any, query?: any, agentRequestValue?: any) {
  const isAgentRequest = String(agentRequestValue).toLowerCase() === 'true';
  const emergencyBody = body?.emergency === true || String(body?.emergency).toLowerCase() === 'true';
  const emergencyQuery = String(query?.emergency).toLowerCase() === 'true';
  return isAgentRequest || emergencyBody || emergencyQuery;
}

function applyRunSummaryToTask(task: any, run: AgentRun | null) {
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

function requireAgentOwnedRequest(req: express.Request) {
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

function resolveAgentCompletionTargetStatus(payload: AgentCompletionPayload): TaskStatus {
  if (payload.status === 'success') {
    return payload.moveTo || 'ready-for-review';
  }
  return payload.moveTo || 'in-progress';
}

function applyAgentCompletionCallback(task: any, run: AgentRun, deps: ApiRouteDeps, payload: AgentCompletionPayload): AgentCompletionRouteResult {
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
  saveTasks(deps.state);

  return { task, run: updatedRun || run, payload };
}

function cleanupStaleActiveRuns(deps: ApiRouteDeps) {
  const cutoff = new Date(Date.now() - STALE_AGENT_RUN_MS).toISOString();
  const cancelledCount = cancelStaleActiveRuns(cutoff, `Stale active run cancelled after ${STALE_AGENT_RUN_MS / 60000} minutes.`);
  if (cancelledCount > 0) {
    deps.writeAgentLog('INFO', `Cancelled ${cancelledCount} stale active agent run(s).`);
    for (const task of deps.state.tasksCache) applyRunSummaryToTask(task, getLatestAgentRunForTask(task.id));
    saveTasks(deps.state);
  }
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
  saveTasks(deps.state);
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
  saveTasks(deps.state);
  return updatedRun;
}

export function continueTaskQueueForProject(projectId: string, deps: ApiRouteDeps) {
  const eligibleTasks = deps.state.tasksCache.filter((entry) => entry.projectId === projectId && entry.status === 'todo' && entry.agent);
  eligibleTasks.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

  for (const nextTask of eligibleTasks) {
    const latestRun = getLatestAgentRunForTask(nextTask.id);
    if (latestRun?.status === 'failed') {
      appendTaskLog(nextTask, 'Queue continuation skipped: latest agent run failed. Manual retry is required before auto-work can pick this task again.', 'update');
      continue;
    }

    const result = triggerTaskAgent(nextTask, deps, 'queue continuation');
    if (result.triggered) {
      saveTasks(deps.state);
      return result;
    }

    const blockedResult = result as TriggerTaskAgentFailure;
    appendTaskLog(nextTask, `Queue continuation skipped: ${blockedResult.reason}`, 'update');
  }

  saveTasks(deps.state);
  return { triggered: false, reason: 'No eligible todo task could be started.' };
}

export function triggerTaskAgent(task: any, deps: ApiRouteDeps, routeLabel: string, retryOfRunId?: string | null): TriggerTaskAgentResult {
  if (!task.agent) return { triggered: false, code: 'NO_AGENT', reason: 'Task has no assigned agent.' };
  if (!/^[a-zA-Z0-9-]+$/.test(task.agent) || !/^[a-zA-Z0-9-]+$/.test(task.id)) {
    deps.writeAgentLog('ERROR', `Blocked trigger due to invalid chars: agent=${task.agent} taskId=${task.id}`);
    return { triggered: false, reason: 'Invalid agent or task id characters.' };
  }

  cleanupStaleActiveRuns(deps);

  const project = deps.state.projectsCache.find((entry) => entry.id === task.projectId);
  const executionMode = resolveAgentExecutionMode(deps.state.settingsCache.agentExecutionMode || process.env.DEVFLOW_AGENT_EXECUTION_MODE);
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

  const activeTaskRun = findActiveRunByTaskId(task.id, task.agent);
  if (activeTaskRun) {
    return {
      triggered: false,
      code: 'TASK_ALREADY_RUNNING',
      reason: `${task.agent} is already running for this task.`,
      run: activeTaskRun,
    };
  }

  const activeProjectRun = getActiveRunForProject(task.projectId);
  if (activeProjectRun && activeProjectRun.taskId !== task.id) {
    deps.writeAgentLog('INFO', `Agent already busy for project=${task.projectId}, skipping trigger for task=${task.id}`);
    return { triggered: false, code: 'PROJECT_ALREADY_RUNNING', reason: `Project already has active run ${activeProjectRun.id}.` };
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
  saveTasks(deps.state);

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
  saveTasks(deps.state);

  const triggerBat = getAgentTriggerScriptPath();
  const invokeTriggerScript = resolveFromDevFlowAppRoot('scripts', 'invoke-agent-trigger.ps1');
  const apiBaseUrl = getDevFlowApiBaseUrl();

  const execOpts = {
    cwd: project?.localPath || undefined,
    env: {
      ...process.env,
      GITHUB_PERSONAL_ACCESS_TOKEN: deps.state.settingsCache.githubToken || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '',
      JIRA_BASE_URL: deps.state.settingsCache.jiraBaseUrl || process.env.JIRA_BASE_URL || '',
      JIRA_EMAIL: deps.state.settingsCache.jiraEmail || process.env.JIRA_EMAIL || '',
      JIRA_API_TOKEN: deps.state.settingsCache.jiraToken || process.env.JIRA_API_TOKEN || process.env.JIRA_PERSONAL_ACCESS_TOKEN || '',
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
    saveTasks(deps.state);
  });

  return { triggered: true, run: currentRun || run };
}

function maybeTriggerTaskAgent(task: any, previousTaskOrStatus: any, deps: ApiRouteDeps, routeLabel: string): TriggerTaskAgentResult | null {
  const previousTask = typeof previousTaskOrStatus === 'string' ? null : previousTaskOrStatus;
  const previousStatus = typeof previousTaskOrStatus === 'string' ? previousTaskOrStatus : previousTask?.status;
  const assignmentChanged = previousTask
    ? previousTask.agent !== task.agent || previousTask.model !== task.model || previousTask.effort !== task.effort
    : true;
  if (task.status !== 'todo') return null;
  if (previousStatus === 'todo' && !assignmentChanged) return null;
  if (!deps.state.settingsCache.autoWork) {
    deps.writeAgentLog('INFO', `Auto Work is disabled. Task ${task.id} moved to todo but agent will not be triggered.`);
    return null;
  }
  const result = triggerTaskAgent(task, deps, routeLabel);
  if (!result.triggered) {
    const blockedResult = result as TriggerTaskAgentFailure;
    deps.writeAgentLog('INFO', `Skipped agent trigger for task=${task.id}: ${blockedResult.reason}`);
    appendTaskLog(task, `Auto Work blocked before launch: ${blockedResult.reason}`, 'update');
  }
  return result;
}

export function registerTaskRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/schema/task', (_req, res) => {
    res.json(TASK_SCHEMA_DEF);
  });

  app.get('/api/tasks', (_req, res) => {
    cleanupStaleActiveRuns(deps);
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
    cleanupStaleActiveRuns(deps);
    loadTasks(deps.state);
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
    loadTasks(deps.state);
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const images = task.designImages || [];
    return res.json({ count: images.length, images });
  });

  app.get('/api/tasks/:id/agent-context', (req, res) => {
    cleanupStaleActiveRuns(deps);
    loadTasks(deps.state);
    const includeLogs = req.query.includeLogs === 'true' || req.query.mode === 'full' || req.query.mode === 'debug';
    const context = getAgentTaskContext(deps.state, req.params.id, includeLogs);
    if (!context) return res.status(404).json({ error: 'Task not found' });
    return res.json(context);
  });

  app.get('/api/tasks/:id/prompt', (req, res) => {
    cleanupStaleActiveRuns(deps);
    loadTasks(deps.state);
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
    cleanupStaleActiveRuns(deps);
    loadTasks(deps.state);
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json({ taskId: task.id, runs: listAgentRunsForTask(task.id) });
  });

  app.get('/api/tasks/:id/agent-runs/:runId/history', (req, res) => {
    cleanupStaleActiveRuns(deps);
    loadTasks(deps.state);
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
      cleanupStaleActiveRuns(deps);
      loadTasks(deps.state);
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
    loadTasks(deps.state);
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const activeRun = getActiveRunForTask(task.id);
    if (activeRun) return res.status(409).json({ error: `Task already has active run ${activeRun.id}`, run: activeRun });

    const latestRun = getLatestAgentRunForTask(task.id);
    if (!latestRun || latestRun.status !== 'failed') {
      return res.status(400).json({ error: 'Only a failed latest run can be retried.' });
    }

    const result = triggerTaskAgent(task, deps, 'retry endpoint', latestRun.id);
    saveTasks(deps.state);
    if (!result.triggered) {
      const blockedResult = result as TriggerTaskAgentFailure;
      return res.status(400).json({ error: blockedResult.reason, code: blockedResult.code, run: blockedResult.run });
    }
    return res.status(201).json({ success: true, run: result.run, task });
  });

  app.post('/api/tasks/:id/agent-runs/cancel', (req, res) => {
    loadTasks(deps.state);
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'cancelled manually';
    const cancelledCount = cancelActiveRunsForTask(task.id, reason);
    applyRunSummaryToTask(task, getLatestAgentRunForTask(task.id));
    saveTasks(deps.state);
    return res.json({ success: true, cancelledCount, task, runs: listAgentRunsForTask(task.id) });
  });

  app.post('/api/tasks/:id/agent-complete', (req, res) => {
    loadTasks(deps.state);
    const task = findTaskByIdentifier(deps.state, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    if (!requireAgentOwnedRequest(req)) {
      return res.status(403).json({ error: 'Agent completion callback requires x-agent-request=true.' });
    }

    const payloadError = validateAgentCompletionPayload(req.body);
    if (payloadError) {
      return res.status(400).json({ error: payloadError });
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
      if (deps.state.settingsCache.autoWork && payload.status === 'success') {
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
    loadTasks(deps.state);
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

    if (deps.state.settingsCache.autoWork && payload.status === 'success') {
      continueTaskQueueForProject(task.projectId, deps);
    }

    return res.json({ success: true, task: result.task, run: result.run });
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
      maybeTriggerTaskAgent(newTask, undefined, deps, 'POST /tasks endpoint');
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
        const candidateTask = { ...currentTask, ...item };
        const mergedAgentValidationError = validateAgentParams(candidateTask, deps.state.tasksCache);
        if (mergedAgentValidationError) {
          if (!Array.isArray(req.body)) return res.status(400).json({ error: mergedAgentValidationError });
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
      maybeTriggerTaskAgent(newTask, undefined, deps, 'POST /tasks/batch create');
    }

    saveTasks(deps.state);
    return res.status(201).json({ success: true, createdCount: importedTasks.length, updatedCount: updatedTasks.length, tasks: [...importedTasks, ...updatedTasks] });
  });

  app.post('/api/tasks/batch/move', (req, res) => {
    try {
      loadTasks(deps.state);
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

      saveTasks(deps.state);
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
      loadTasks(deps.state);
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

      saveTasks(deps.state);
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
      loadTasks(deps.state);
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

      saveTasks(deps.state);
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

  app.post('/api/tasks/:id/move', (req, res) => {
    loadTasks(deps.state);
    const statusErr = validateEnum(req.body.status, 'status', VALID_STATUSES, true);
    if (statusErr) return res.status(400).json({ error: statusErr });

    const taskIndex = getTaskIndexByIdentifier(deps.state.tasksCache, req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const task = deps.state.tasksCache[taskIndex];
    const previousStatus = task.status;
    if (previousStatus === req.body.status) {
      return res.json({ message: 'Task is already in that lane', task });
    }

    if (!isValidTransition(previousStatus, req.body.status)) {
      return res.status(400).json({ error: getValidationErrorMessage(previousStatus, req.body.status) });
    }

    const parentReviewError = validateParentReviewMove(task, deps, req.body.status);
    if (parentReviewError) {
      appendTaskLog(task, parentReviewError, 'update');
      saveTasks(deps.state);
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

    deps.state.tasksCache[taskIndex] = updatedTask;
    syncTaskAgentStateForStatus(updatedTask, previousStatus);
    const autoWorkTrigger = maybeTriggerTaskAgent(updatedTask, previousStatus, deps, '/move endpoint');

    saveTasks(deps.state);
    return res.json({
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
    });
  });

  app.post('/api/tasks/:id/checklist/toggle', (req, res) => {
    loadTasks(deps.state);
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
    task.updatedAt = new Date().toISOString();
    task.logs = [...task.logs, {
      id: `log-assign-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: `Agent configuration updated: Agent=${req.body.agent || 'None'}, Model=${req.body.model || 'Default'}, Effort=${req.body.effort || 'Auto'} via Specific API`,
      type: 'update',
    }];

    maybeTriggerTaskAgent(task, previousTask, deps, '/assign endpoint');
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
        const candidateTask = { ...currentTask, ...item };
        const mergedAgentValidationError = validateAgentParams(candidateTask, deps.state.tasksCache);
        if (mergedAgentValidationError) {
          if (!Array.isArray(req.body)) return res.status(400).json({ error: mergedAgentValidationError });
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
      maybeTriggerTaskAgent(newTask, undefined, deps, 'PUT /tasks list create');
    }

    saveTasks(deps.state);
    return res.status(200).json({ success: true, createdCount: importedTasks.length, updatedCount: updatedTasks.length, tasks: [...importedTasks, ...updatedTasks] });
  });

  app.put('/api/tasks/:id', (req, res) => {
    loadTasks(deps.state);
    const taskIndex = getTaskIndexByIdentifier(deps.state.tasksCache, req.params.id);
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

    const agentValidationError = validateAgentParams({ ...currentTask, ...updateBody }, deps.state.tasksCache);
    if (agentValidationError) return res.status(400).json({ error: agentValidationError });

    const parentReviewError = validateParentReviewMove({ ...currentTask, ...updateBody }, deps, updateBody.status ?? currentTask.status);
    if (parentReviewError) {
      appendTaskLog(currentTask, parentReviewError, 'update');
      saveTasks(deps.state);
      return res.status(400).json({ error: parentReviewError });
    }

    const updatedTask = {
      ...currentTask,
      ...updateBody,
      designImages: extractDesignImages(updateBody, currentTask) || [],
      updatedAt: new Date().toISOString(),
    };

    deps.state.tasksCache[taskIndex] = updatedTask;
    syncTaskAgentStateForStatus(updatedTask, currentTask.status);
    maybeTriggerTaskAgent(updatedTask, currentTask, deps, 'PUT /tasks/:id endpoint');

    saveTasks(deps.state);
    return res.json(updatedTask);
  });

  app.post('/api/tasks/import-file', async (req, res) => {
    try {
      loadTasks(deps.state);

      const mode = req.body.mode === 'apply' ? 'apply' : 'dry-run';
      const strategy = req.body.strategy === 'replace' ? 'replace' : 'patch';
      const fileUrl = typeof req.body.fileUrl === 'string' ? req.body.fileUrl.trim() : '';
      const patchFilePath = typeof req.body.patchFilePath === 'string' ? req.body.patchFilePath.trim() : '';
      const maxTasks = Number.isFinite(Number(req.body.maxTasks)) ? Math.max(1, Math.min(50, Number(req.body.maxTasks))) : 50;

      if (!fileUrl && !patchFilePath) {
        return res.status(400).json({ error: 'fileUrl or patchFilePath is required.' });
      }

      let raw = '';
      if (fileUrl) {
        if (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://')) {
          return res.status(400).json({ error: 'fileUrl must start with http:// or https://' });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const fetchRes = await fetch(fileUrl, { signal: controller.signal });
          const contentLength = Number(fetchRes.headers.get('content-length') || '0');
          if (contentLength > 5_000_000) {
            return res.status(400).json({ error: 'File too large. Maximum 5 MB.' });
          }
          raw = await fetchRes.text();
          if (raw.length > 5_000_000) {
            return res.status(400).json({ error: 'File too large. Maximum 5 MB.' });
          }
        } finally {
          clearTimeout(timer);
        }
      } else {
        const resolved = path.resolve(patchFilePath);
        const allowed = path.resolve(getDevFlowAppRoot());
        if (!resolved.startsWith(allowed + path.sep) && resolved !== allowed) {
          return res.status(400).json({ error: 'patchFilePath must be inside the DevFlow project root.' });
        }
        if (!fs.existsSync(resolved)) {
          return res.status(400).json({ error: `File not found: ${patchFilePath}` });
        }
        const stat = fs.statSync(resolved);
        if (stat.size > 5_000_000) {
          return res.status(400).json({ error: 'File too large. Maximum 5 MB.' });
        }
        raw = fs.readFileSync(resolved, 'utf8');
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return res.status(400).json({ error: 'Invalid JSON.' });
      }

      if (parsed.version !== 'devflow.taskPatch.v1') {
        return res.status(400).json({ error: 'Unsupported version. Expected devflow.taskPatch.v1.' });
      }

      const defaults = parsed.defaults || {};
      const items = Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, maxTasks) : [];

      const VALID_FIELDS: Set<string> = new Set([
        'title', 'description', 'status', 'priority', 'branch', 'tags', 'targetFiles',
        'checklist', 'effort', 'model', 'agent', 'parentId', 'reasoning',
        'acceptanceCriteria', 'verification', 'repoContext', 'specUrl', 'designImages', 'jiraKey', 'sourceUrl',
      ]);

      const projectDefaults = {
        projectId: defaults.projectId || req.body.projectId || '',
        projectName: defaults.projectName || req.body.projectName || '',
        repo: defaults.repo || req.body.repo || '',
        repoUrl: defaults.repoUrl || req.body.repoUrl || '',
      };

      const buildProjectInfo = (item: any) => ({
        projectId: (typeof item.projectId === 'string' ? item.projectId : '') || projectDefaults.projectId,
        projectName: (typeof item.projectName === 'string' ? item.projectName : '') || projectDefaults.projectName,
        repo: (typeof item.repo === 'string' ? item.repo : '') || projectDefaults.repo,
        repoUrl: (typeof item.repoUrl === 'string' ? item.repoUrl : '') || projectDefaults.repoUrl,
      });

      interface PlannedOp {
        type: 'create' | 'update';
        item: any;
        fields: Record<string, any>;
        taskId?: string;
        existingIndex?: number;
        title?: string;
        error?: string;
        resolvedProjectId?: string;
      }

      const planned: PlannedOp[] = [];
      let hasValidationError = false;

      for (const item of items) {
        if (!item.operation || !['create', 'update'].includes(item.operation)) {
          planned.push({ type: 'create' as const, item, fields: {}, error: 'Missing or unsupported operation. Use "create" or "update".' });
          hasValidationError = true;
          continue;
        }

        const fields = item.fields || {};
        const unknown = Object.keys(fields).find((k) => !VALID_FIELDS.has(k));
        if (unknown) {
          planned.push({ type: item.operation, item, fields, error: `Unknown field: ${unknown}` });
          hasValidationError = true;
          continue;
        }

        if (item.operation === 'update') {
          const taskId = item.taskId || item.id;
          if (!taskId) {
            planned.push({ type: 'update', item, fields, error: 'taskId is required for update operations.' });
            hasValidationError = true;
            continue;
          }
          const existingIndex = getTaskIndexByIdentifier(deps.state.tasksCache, String(taskId));
          if (existingIndex === -1) {
            planned.push({ type: 'update', item, fields, taskId, error: 'Task not found.' });
            hasValidationError = true;
            continue;
          }
          planned.push({ type: 'update', item, fields, taskId, existingIndex });
        } else {
          const itemProject = buildProjectInfo(item);
          const title = item.title || fields.title || '';
          if (!title.trim()) {
            planned.push({ type: 'create', item, fields, error: 'title is required for create operations.' });
            hasValidationError = true;
            continue;
          }
          const resolvedName = itemProject.projectName || itemProject.repo || itemProject.repoUrl || itemProject.projectId;
          if (!resolvedName) {
            planned.push({ type: 'create', item, fields, title, error: 'Project resolver (projectName, repo, repoUrl, or projectId) is required for create.' });
            hasValidationError = true;
            continue;
          }
          let resolvedProjectId = '';
          try {
            resolvedProjectId = resolveProjectIdFromRepo(deps.state, itemProject, req as any);
          } catch {
            planned.push({ type: 'create', item, fields, title: title.trim(), error: 'Could not resolve project.' });
            hasValidationError = true;
            continue;
          }
          planned.push({ type: 'create', item, fields, title: title.trim(), error: undefined, resolvedProjectId });
        }
      }

      if (planned.length === 0) {
        return res.status(400).json({ error: 'No valid operations to process. Check format: version devflow.taskPatch.v1, tasks array with operation + fields.' });
      }

      if (mode === 'dry-run' || hasValidationError) {
        return res.json({
          mode: hasValidationError ? 'dry-run' : mode,
          strategy,
          summary: {
            planned: planned.length,
            created: planned.filter((p) => p.type === 'create' && !p.error).length,
            updated: planned.filter((p) => p.type === 'update' && !p.error).length,
            failed: planned.filter((p) => p.error).length,
            operations: planned.map((p) => ({
              type: p.type,
              taskId: p.taskId,
              title: p.title,
              error: p.error,
            })),
          },
        });
      }

      const cloned = deps.state.tasksCache.map((t) => ({ ...t, checklist: Array.isArray(t.checklist) ? [...t.checklist] : t.checklist, logs: Array.isArray(t.logs) ? [...t.logs] : t.logs, tags: Array.isArray(t.tags) ? [...t.tags] : t.tags }));
      const created: string[] = [];
      const updated: string[] = [];

      for (const op of planned) {
        if (op.type === 'update' && op.existingIndex !== undefined && op.taskId) {
          const currentTask = cloned[op.existingIndex];
          if (strategy === 'replace') {
            cloned[op.existingIndex] = { ...currentTask, ...op.fields, updatedAt: new Date().toISOString() };
          } else {
            Object.assign(currentTask, op.fields, { updatedAt: new Date().toISOString() });
          }
          updated.push(op.taskId);
        } else if (op.type === 'create' && op.resolvedProjectId) {
          const f = op.fields;
          const newTask: any = {
            id: op.item.id || `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
            displayId: op.item.displayId || generateDisplayId(deps.state, op.resolvedProjectId),
            projectId: op.resolvedProjectId,
            title: op.title || 'untitled',
            description: f.description || '',
            status: f.status || 'backlog',
            priority: f.priority || 'medium',
            branch: f.branch || undefined,
            tags: Array.isArray(f.tags) ? f.tags : [],
            targetFiles: Array.isArray(f.targetFiles) ? f.targetFiles : [],
            checklist: Array.isArray(f.checklist) ? f.checklist : [],
            designImages: extractDesignImages(f) || [],
            effort: f.effort || undefined,
            model: f.model || undefined,
            agent: f.agent || undefined,
            parentId: f.parentId || undefined,
            reasoning: f.reasoning || undefined,
            acceptanceCriteria: f.acceptanceCriteria || undefined,
            verification: f.verification || undefined,
            repoContext: f.repoContext || undefined,
            specUrl: f.specUrl || undefined,
            jiraKey: f.jiraKey || undefined,
            sourceUrl: f.sourceUrl || undefined,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            logs: [{ id: `log-${Date.now()}-im`, timestamp: new Date().toISOString(), message: 'Task created via import-file.', type: 'create' }],
          };
          cloned.push(newTask);
          created.push(newTask.displayId || newTask.id);
        }
      }

      deps.state.tasksCache = cloned;
      saveTasks(deps.state);

      return res.json({
        mode,
        strategy,
        summary: {
          created: created.length,
          updated: updated.length,
          failed: 0,
          createdIds: created,
          updatedIds: updated,
        },
      });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.delete('/api/tasks/:id', (req, res) => {
    loadTasks(deps.state);
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

    saveTasks(deps.state);
    return res.json({ success: true, removed: removedTasks[0], removedCount: removedTasks.length });
  });
}
