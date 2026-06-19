import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AppState, ApiRouteDeps } from '../src/server/types.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-dvf-0224-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const repoPath = path.join(tempDir, 'repo');
fs.mkdirSync(repoPath, { recursive: true });

const triggerScriptPath = path.join(tempDir, 'trigger-agent.bat');
fs.writeFileSync(triggerScriptPath, ['@echo off', 'setlocal', 'exit /b 0', ''].join('\r\n'), 'utf8');
process.env.DEVFLOW_AGENT_TRIGGER_SCRIPT = triggerScriptPath;

const {
  continueTaskQueueForProject,
  registerTaskRoutes,
  triggerTaskAgent,
} = await import('../src/server/routes/tasks.js');
const { registerSettingsRoutes } = await import('../src/server/routes/settings.js');
const {
  createAgentRun,
  getActiveRunForProjectAndAgent,
  getLatestAgentRunForTask,
  listActiveRunSummariesForProject,
  listAgentRunsForTask,
  updateAgentRunStatus,
} = await import('../src/server/repositories/agentRunRepository.js');
const { saveProjects } = await import('../src/server/repositories/projectRepository.js');
const { saveTasks } = await import('../src/server/repositories/taskRepository.js');
const { createAgentRunFiles } = await import('../src/server/services/agentRunService.js');
const { createAgentLaunchScript, createCodexLaunchScript } = await import('../src/runner.js');
const { getAutoWorkState } = await import('../src/lib/autoWorkState.js');

function makeTask(id: string, agent: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayId: id.toUpperCase(),
    projectId: 'project-1',
    status: 'todo',
    agent,
    model: agent === 'Claude' ? 'Claude 4.8 Opus' : 'GPT-5.5',
    effort: 'high',
    title: `Task ${id}`,
    description: `Run ${id}`,
    logs: [],
    createdAt: overrides.createdAt || new Date().toISOString(),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition.');
}

async function withServer(
  appFactory: () => { app: express.Express; deps: ApiRouteDeps },
  run: (baseUrl: string, deps: ApiRouteDeps) => Promise<void>,
) {
  const { app, deps } = appFactory();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl, deps);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

console.log('[DVF-0224] verifying repository helpers and per-agent locking...');
const lockState: AppState = {
  tasksCache: [
    makeTask('codex-1', 'Codex', { projectId: 'project-lock', createdAt: '2026-06-19T01:00:00.000Z' }),
    makeTask('claude-1', 'Claude', { projectId: 'project-lock', createdAt: '2026-06-19T01:01:00.000Z' }),
    makeTask('codex-2', 'Codex', { projectId: 'project-lock', createdAt: '2026-06-19T01:02:00.000Z' }),
  ],
  projectsCache: [{ id: 'project-lock', name: 'p1', repoUrl: 'repo', localPath: repoPath }],
  countersCache: {},
  settingsCache: { autoWork: false, ngrokUrl: '', githubToken: '', jiraToken: '', figmaToken: '', jiraBaseUrl: '', jiraEmail: '', agentExecutionMode: 'safe' },
  skillsRegistry: [],
};
const lockDeps: ApiRouteDeps = { state: lockState, writeAgentLog: () => {} };
saveProjects(lockState);
saveTasks(lockState);

const codexTrigger = triggerTaskAgent(lockState.tasksCache[0], lockDeps, 'verify');
const claudeTrigger = triggerTaskAgent(lockState.tasksCache[1], lockDeps, 'verify');
const blockedCodexTrigger = triggerTaskAgent(lockState.tasksCache[2], lockDeps, 'verify');

assert.equal(codexTrigger.triggered, true);
assert.equal(claudeTrigger.triggered, true);
assert.equal(blockedCodexTrigger.triggered, false);
assert.equal(blockedCodexTrigger.code, 'AGENT_ALREADY_RUNNING');
assert.equal(lockState.tasksCache[2].status, 'todo');
assert.equal(listAgentRunsForTask('codex-2').length, 0);
assert.match(lockState.tasksCache[2].logs.at(-1)?.message || '', /assigned agent Codex is busy/i);

await waitFor(() => getLatestAgentRunForTask('codex-1')?.status === 'running');
await waitFor(() => getLatestAgentRunForTask('claude-1')?.status === 'running');

assert.ok(getActiveRunForProjectAndAgent('project-lock', 'Codex'));
assert.ok(getActiveRunForProjectAndAgent('project-lock', 'Claude'));
assert.equal(listActiveRunSummariesForProject('project-lock').length, 2);

console.log('[DVF-0224] verifying queue continuation drains all available agents...');
const queueState: AppState = {
  tasksCache: [
    makeTask('queue-codex-1', 'Codex', { projectId: 'project-queue', createdAt: '2026-06-19T02:00:00.000Z' }),
    makeTask('queue-claude-1', 'Claude', { projectId: 'project-queue', createdAt: '2026-06-19T02:01:00.000Z' }),
    makeTask('queue-codex-2', 'Codex', { projectId: 'project-queue', createdAt: '2026-06-19T02:02:00.000Z' }),
  ],
  projectsCache: [{ id: 'project-queue', name: 'p1', repoUrl: 'repo', localPath: repoPath }],
  countersCache: {},
  settingsCache: { autoWork: true, ngrokUrl: '', githubToken: '', jiraToken: '', figmaToken: '', jiraBaseUrl: '', jiraEmail: '', agentExecutionMode: 'safe' },
  skillsRegistry: [],
};
const queueDeps: ApiRouteDeps = { state: queueState, writeAgentLog: () => {} };
saveTasks(queueState);
const queueResult = continueTaskQueueForProject('project-queue', queueDeps);
assert.equal(queueResult.triggered, true);
assert.equal(queueResult.runs?.length, 2);
assert.equal(queueState.tasksCache[0].status, 'in-progress');
assert.equal(queueState.tasksCache[1].status, 'in-progress');
assert.equal(queueState.tasksCache[2].status, 'todo');
assert.match(queueState.tasksCache[2].logs.at(-1)?.message || '', /task stays in TODO/i);

console.log('[DVF-0224] verifying success continuation, failure, and cancellation routes...');
await withServer(() => {
  const state: AppState = {
    tasksCache: [
      makeTask('done-codex-1', 'Codex', { projectId: 'project-complete', createdAt: '2026-06-19T03:00:00.000Z' }),
      makeTask('done-codex-2', 'Codex', { projectId: 'project-complete', createdAt: '2026-06-19T03:01:00.000Z' }),
      makeTask('done-claude-1', 'Claude', { projectId: 'project-complete', createdAt: '2026-06-19T03:02:00.000Z' }),
      makeTask('fail-codex-1', 'Codex', { projectId: 'project-fail', status: 'in-progress', createdAt: '2026-06-19T03:03:00.000Z' }),
      makeTask('cancel-codex-1', 'Codex', { projectId: 'project-cancel', status: 'in-progress', createdAt: '2026-06-19T03:04:00.000Z' }),
    ],
    projectsCache: [
      { id: 'project-complete', name: 'p1', repoUrl: 'repo', localPath: repoPath },
      { id: 'project-fail', name: 'p2', repoUrl: 'repo', localPath: repoPath },
      { id: 'project-cancel', name: 'p3', repoUrl: 'repo', localPath: repoPath },
    ],
    countersCache: {},
    settingsCache: { autoWork: true, ngrokUrl: '', githubToken: '', jiraToken: '', figmaToken: '', jiraBaseUrl: '', jiraEmail: '', agentExecutionMode: 'safe' },
    skillsRegistry: [],
  };
  saveTasks(state);
  const deps: ApiRouteDeps = { state, writeAgentLog: () => {} };
  const firstRun = createAgentRun({ taskId: 'done-codex-1', projectId: 'project-complete', agent: 'Codex', model: 'GPT-5.5', effort: 'high' });
  updateAgentRunStatus(firstRun.id, 'running', { startedAt: new Date().toISOString() });
  state.tasksCache[0].status = 'in-progress';

  const failRun = createAgentRun({ taskId: 'fail-codex-1', projectId: 'project-fail', agent: 'Codex', model: 'GPT-5.5', effort: 'high' });
  updateAgentRunStatus(failRun.id, 'running', { startedAt: new Date().toISOString() });

  const cancelRun = createAgentRun({ taskId: 'cancel-codex-1', projectId: 'project-cancel', agent: 'Codex', model: 'GPT-5.5', effort: 'high' });
  updateAgentRunStatus(cancelRun.id, 'running', { startedAt: new Date().toISOString() });

  const app = express();
  app.use(express.json());
  registerTaskRoutes(app, deps);
  return { app, deps };
}, async (baseUrl, deps) => {
  const successResponse = await fetch(`${baseUrl}/api/tasks/done-codex-1/agent-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-request': 'true' },
    body: JSON.stringify({ runId: getLatestAgentRunForTask('done-codex-1')?.id, status: 'success', summary: 'done' }),
  });
  assert.equal(successResponse.status, 200);
  await waitFor(() => deps.state.tasksCache.find((task) => task.id === 'done-codex-2')?.status === 'in-progress');
  assert.equal(deps.state.tasksCache.find((task) => task.id === 'done-codex-1')?.status, 'ready-for-review');
  assert.equal(deps.state.tasksCache.find((task) => task.id === 'done-codex-2')?.status, 'in-progress');

  const failedResponse = await fetch(`${baseUrl}/api/tasks/fail-codex-1/agent-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-request': 'true' },
    body: JSON.stringify({ runId: getLatestAgentRunForTask('fail-codex-1')?.id, status: 'failed', summary: 'compile failed' }),
  });
  assert.equal(failedResponse.status, 200);
  assert.equal(deps.state.tasksCache.find((task) => task.id === 'fail-codex-1')?.status, 'todo');

  const cancelResponse = await fetch(`${baseUrl}/api/tasks/cancel-codex-1/agent-runs/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'user cancelled' }),
  });
  assert.equal(cancelResponse.status, 200);
  assert.equal(deps.state.tasksCache.find((task) => task.id === 'cancel-codex-1')?.status, 'todo');
  assert.equal(getLatestAgentRunForTask('cancel-codex-1')?.status, 'cancelled');
});

console.log('[DVF-0224] verifying Auto Work enable drains multiple agents...');
await withServer(() => {
  const state: AppState = {
    tasksCache: [
      makeTask('enable-codex-1', 'Codex', { projectId: 'project-enable', createdAt: '2026-06-19T04:00:00.000Z' }),
      makeTask('enable-claude-1', 'Claude', { projectId: 'project-enable', createdAt: '2026-06-19T04:01:00.000Z' }),
      makeTask('enable-codex-2', 'Codex', { projectId: 'project-enable', createdAt: '2026-06-19T04:02:00.000Z' }),
    ],
    projectsCache: [{ id: 'project-enable', name: 'p1', repoUrl: 'repo', localPath: repoPath }],
    countersCache: {},
    settingsCache: { autoWork: false, ngrokUrl: '', githubToken: '', jiraToken: '', figmaToken: '', jiraBaseUrl: '', jiraEmail: '', agentExecutionMode: 'safe' },
    skillsRegistry: [],
  };
  const deps: ApiRouteDeps = { state, writeAgentLog: () => {} };
  const app = express();
  app.use(express.json());
  registerSettingsRoutes(app, deps);
  return { app, deps };
}, async (baseUrl, deps) => {
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoWork: true }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.autoWorkTrigger.triggered, true);
  assert.equal(body.autoWorkTrigger.runs.length, 2);
  assert.equal(deps.state.tasksCache.find((task) => task.id === 'enable-codex-1')?.status, 'in-progress');
  assert.equal(deps.state.tasksCache.find((task) => task.id === 'enable-claude-1')?.status, 'in-progress');
  assert.equal(deps.state.tasksCache.find((task) => task.id === 'enable-codex-2')?.status, 'todo');
});

console.log('[DVF-0224] verifying final stdout/stderr capture is wired into launch scripts...');
const successFiles = createAgentRunFiles({
  runId: 'run-log-success',
  prompt: 'prompt-success',
  baseDir: tempDir,
});
const successLaunchPath = createAgentLaunchScript({
  runId: 'run-log-success',
  taskId: 'task-log-success',
  apiBaseUrl: 'http://127.0.0.1:3000',
  runDir: successFiles.runDir,
  executable: path.resolve('scripts', 'fake-codex-runner.cmd'),
  args: [`Read and follow the DevFlow prompt file at: ${successFiles.promptPath}`],
  cwd: repoPath,
  logPath: successFiles.logPath,
});
const successScript = fs.readFileSync(successLaunchPath, 'utf8');
assert.match(successScript, /--- agent output start ---/);
assert.match(successScript, />> ".*agent\.log" 2>&1/);
assert.match(successScript, /--- agent output end \(exit=%EXIT_CODE%\) ---/);

const codexLaunchPath = createCodexLaunchScript({
  runId: 'run-log-codex',
  taskId: 'task-log-codex',
  apiBaseUrl: 'http://127.0.0.1:3000',
  runDir: successFiles.runDir,
  executable: path.resolve('scripts', 'fake-codex-runner.cmd'),
  args: ['prompt'],
  cwd: repoPath,
  logPath: successFiles.logPath,
});
const codexScript = fs.readFileSync(codexLaunchPath, 'utf8');
assert.match(codexScript, /--- agent output start ---/);
assert.match(codexScript, />> ".*agent\.log" 2>&1/);
assert.match(codexScript, /--- agent output end \(exit=%EXIT_CODE%\) ---/);

console.log('[DVF-0224] verifying queued-busy UI state helper...');
const busyState = getAutoWorkState({
  id: 'busy-task',
  title: 'busy',
  description: '',
  status: 'todo',
  priority: 'medium',
  tags: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  logs: [{ id: 'log-1', timestamp: new Date().toISOString(), type: 'edit', message: 'Auto Work queued: assigned agent Codex is busy with run run-1; task stays in TODO until that agent becomes available.' }],
  agent: 'Codex',
} as any);
assert.equal(busyState?.kind, 'queued-busy');
assert.equal(busyState?.label, 'Queued');
assert.match(busyState?.message || '', /task stays in TODO/i);

console.log('[verify-dvf-0224] all assertions passed');
