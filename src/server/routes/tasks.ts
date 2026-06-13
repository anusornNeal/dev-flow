import { execFile } from 'child_process';
import path from 'path';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { TASK_SCHEMA_DEF, VALID_AGENTS, VALID_EFFORTS, VALID_MODELS, VALID_STATUSES } from '../constants';
import { cancelActiveRunsForTask, cancelStaleActiveRuns, createAgentRun, findActiveRunByTaskId, getActiveRunForProject, getActiveRunForTask, getLatestAgentRunForTask, listAgentRunsForTask, updateAgentRunStatus, type AgentRun } from '../repositories/agentRunRepository';
import { loadTasks, generateDisplayId, saveTasks } from '../repositories/taskRepository';
import { appendAgentRunLog, createAgentRunFiles, createAgentRunResultRecord, getAgentRunHistoryPaths, getAgentTriggerScriptPath, getDevFlowApiBaseUrl, resolveAgentExecutionMode, resolveFromDevFlowAppRoot, writeAgentRunLaunchMetadata, writeAgentRunOutputSummary, writeAgentRunResult } from '../services/agentRunService';
import { extractDesignImages, getAgentTaskContext, renderTaskPrompt, resolveProjectIdFromRepo, validateAgentParams, validateTaskPayload } from '../services/taskService';
import { validateEnum, validateString } from '../validation';
import { isValidTransition, getValidationErrorMessage } from '../../lib/statusTransitions';
import { buildCodexLaunchConfig, runAgentLaunchPreflight, type AgentLaunchPreflightCode } from '../services/agentLaunchConfig';

const STALE_AGENT_RUN_MS = 30 * 60 * 1000;

type TriggerTaskAgentResult =
  | { triggered: true; run: AgentRun }
  | { triggered: false; reason: string; code?: AgentLaunchPreflightCode | 'TASK_ALREADY_RUNNING' | 'PROJECT_ALREADY_RUNNING'; run?: AgentRun | null };
type TriggerTaskAgentFailure = Extract<TriggerTaskAgentResult, { triggered: false }>;

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
  const codexLaunchPreview = task.agent === 'Codex'
    ? buildCodexLaunchConfig({
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
      runId: run.id,
      executionMode,
      apiBaseUrl,
      appRoot: resolveFromDevFlowAppRoot(),
      preview: true,
      environment: execOpts.env,
    })
    : null;

  deps.writeAgentLog('TRIGGER', `Spawning run=${run.id} agent=${task.agent} for task=${task.id} ("${task.title}") via ${routeLabel}${project?.localPath ? ' at ' + project.localPath : ''}`);
  appendAgentRunLog(files.logPath, `Launch plan: agent=${launchPlan.agent} model=${launchPlan.devFlowModel || 'none'} resolvedModel=${launchPlan.resolvedModel || 'none'} effort=${launchPlan.selectedEffort || 'none'} effortHandling=${launchPlan.effortHandling.mode} executionMode=${executionMode}`);
  appendAgentRunLog(files.logPath, `cwd=${project?.localPath || 'none'} triggerScript=${triggerBat} promptPath=${files.promptPath}`);
  if (codexLaunchPreview?.ok) appendAgentRunLog(files.logPath, codexLaunchPreview.previewText);
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
    codexLaunchPreview: codexLaunchPreview?.ok ? {
      executable: codexLaunchPreview.executable,
      parameters: codexLaunchPreview.parameters,
      cwd: codexLaunchPreview.cwd,
      previewText: codexLaunchPreview.previewText,
    } : null,
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
    res.json(deps.state.tasksCache);
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
    const task = deps.state.tasksCache.find((entry) => entry.id === req.params.id || entry.displayId === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json({ taskId: task.id, runs: listAgentRunsForTask(task.id) });
  });

  app.get('/api/tasks/:id/agent-runs/:runId/history', (req, res) => {
    cleanupStaleActiveRuns(deps);
    loadTasks(deps.state);
    const task = deps.state.tasksCache.find((entry) => entry.id === req.params.id || entry.displayId === req.params.id);
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

  app.post('/api/tasks/:id/agent-runs/retry', (req, res) => {
    loadTasks(deps.state);
    const task = deps.state.tasksCache.find((entry) => entry.id === req.params.id || entry.displayId === req.params.id);
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
    const task = deps.state.tasksCache.find((entry) => entry.id === req.params.id || entry.displayId === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'cancelled manually';
    const cancelledCount = cancelActiveRunsForTask(task.id, reason);
    applyRunSummaryToTask(task, getLatestAgentRunForTask(task.id));
    saveTasks(deps.state);
    return res.json({ success: true, cancelledCount, task, runs: listAgentRunsForTask(task.id) });
  });

  app.post('/api/tasks/:id/agent-runs/:runId/complete', (req, res) => {
    loadTasks(deps.state);
    const task = deps.state.tasksCache.find((entry) => entry.id === req.params.id || entry.displayId === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const run = getActiveRunForTask(task.id) || getLatestAgentRunForTask(task.id);
    if (!run || run.id !== req.params.runId) {
       return res.status(404).json({ error: 'Run not found or not associated with task.' });
    }

    const success = req.body?.success !== false;
    completeAgentRunForTask(task, run, deps, {
      success,
      exitCode: typeof req.body?.exitCode === 'number' ? req.body.exitCode : undefined,
      errorMessage: req.body?.errorMessage || 'Run failed',
    });

    if (deps.state.settingsCache.autoWork) {
      continueTaskQueueForProject(task.projectId, deps);
    }

    return res.json({ success: true, task });
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

  app.delete('/api/tasks/:id', (req, res) => {
    loadTasks(deps.state);
    const taskIdToDelete = req.params.id;
    const taskIndex = deps.state.tasksCache.findIndex((task) => task.id === taskIdToDelete);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const currentTask = deps.state.tasksCache[taskIndex];
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
