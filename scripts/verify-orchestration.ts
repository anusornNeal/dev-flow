import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AppState, ApiRouteDeps } from '../src/server/types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-orchestration-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const repoPathWithSpaces = path.join(tempDir, 'repo with spaces');
fs.mkdirSync(repoPathWithSpaces, { recursive: true });

const triggerScriptPath = path.join(tempDir, 'trigger script with spaces.bat');
fs.writeFileSync(triggerScriptPath, [
  '@echo off',
  'setlocal',
  'echo trigger invoked> "%TEMP%\\devflow-trigger-args.txt"',
  'exit /b 0',
  '',
].join('\r\n'), 'utf8');
process.env.DEVFLOW_AGENT_TRIGGER_SCRIPT = triggerScriptPath;

const {
  completeAgentRunForTask,
  continueTaskQueueForProject,
  registerTaskRoutes,
  triggerTaskAgent,
} = await import('../src/server/routes/tasks.js');

const {
  createAgentRun,
  getActiveRunForTask,
  getLatestAgentRunForTask,
  updateAgentRunStatus,
} = await import('../src/server/repositories/agentRunRepository.js');

const { saveProjects } = await import('../src/server/repositories/projectRepository.js');
const { saveTasks } = await import('../src/server/repositories/taskRepository.js');
const { isValidTransition } = await import('../src/lib/statusTransitions.js');
const express = (await import('express')).default;

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const state: AppState = {
  tasksCache: [
    {
      id: 'task-1',
      displayId: 'DVF-0080',
      projectId: 'project-1',
      status: 'todo',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'xhigh',
      title: 'Fix fresh-session prompt flow',
      description: 'Generate the prompt from the real production agent context.',
      acceptanceCriteria: 'Prompt includes description, acceptance criteria, verification, checklist, subtasks, repo, localPath, agent, model, and effort.',
      verification: 'Run prompt template and orchestration verification scripts.',
      checklist: [{ id: 'chk-1', text: 'Use real agent task context', completed: false }],
      reasoning: 'Review blockers found the old flat task shape still in use.',
      targetFiles: ['src/server/routes/tasks.ts'],
      repoContext: 'Keep changes scoped to the fresh-session orchestration flow.',
      logs: [],
      createdAt: '2026-06-13T00:00:00.000Z',
      updatedAt: '2026-06-13T00:00:00.000Z',
    },
    {
      id: 'task-1-sub',
      displayId: 'DVF-0081',
      projectId: 'project-1',
      parentId: 'task-1',
      status: 'backlog',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Pass production context shape to prompt rendering',
      description: 'Use instruction, requirements, workspace, and orchestration fields.',
      checklist: [{ id: 'chk-sub', text: 'Update templates', completed: false }],
      logs: [],
      createdAt: '2026-06-13T00:01:00.000Z',
      updatedAt: '2026-06-13T00:01:00.000Z',
    },
    {
      id: 'task-2',
      displayId: 'DVF-0082',
      projectId: 'project-1',
      status: 'todo',
      agent: 'Bad@Agent',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Invalid card for skip logging',
      description: 'This should be skipped visibly.',
      logs: [],
      createdAt: '2026-06-13T00:02:00.000Z',
      updatedAt: '2026-06-13T00:02:00.000Z',
    },
    {
      id: 'task-3',
      displayId: 'DVF-0083',
      projectId: 'project-1',
      status: 'todo',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Next valid card',
      description: 'This should start after skips are recorded.',
      logs: [],
      createdAt: '2026-06-13T00:03:00.000Z',
      updatedAt: '2026-06-13T00:03:00.000Z',
    },
  ],
  projectsCache: [
    { id: 'project-1', name: 'p1', repoUrl: 'https://github.com/anusornNeal/dev-flow', localPath: repoPathWithSpaces },
  ],
  countersCache: {},
  settingsCache: { autoWork: false, ngrokUrl: '', githubToken: '', jiraToken: '', jiraBaseUrl: '', jiraEmail: '' },
  skillsRegistry: [],
};

saveProjects(state);

const loggedMessages: string[] = [];
const deps: ApiRouteDeps = {
  state,
  writeAgentLog: (level, msg) => { loggedMessages.push(`[${level}] ${msg}`); },
};

console.log('[verify] Testing missing project.localPath blocks setup...');
state.projectsCache[0].localPath = '';
const noPathResult = triggerTaskAgent(state.tasksCache[0], deps, 'test');
assert.equal(noPathResult.triggered, false);
assert.equal(noPathResult.reason, 'Project localPath is missing. Task cannot be run.');
assert.equal(state.tasksCache[0].status, 'todo');

console.log('[verify] Testing real prompt rendering and startup handoff...');
state.projectsCache[0].localPath = repoPathWithSpaces;
const triggerResult = triggerTaskAgent(state.tasksCache[0], deps, 'test');
assert.equal(triggerResult.triggered, true);
assert.equal(state.tasksCache[0].status, 'in-progress');

await new Promise((resolve) => setTimeout(resolve, 250));
await waitFor(() => getLatestAgentRunForTask('task-1')?.status === 'running');

const run1 = getLatestAgentRunForTask('task-1');
assert.ok(run1);
assert.equal(run1?.status, 'running');
const promptPath = path.join(process.cwd(), '.devflow', 'runs', run1!.id, 'prompt.md');
const prompt = fs.readFileSync(promptPath, 'utf8');
assert.ok(prompt.includes('Generate the prompt from the real production agent context.'));
assert.ok(prompt.includes('Prompt includes description, acceptance criteria, verification, checklist, subtasks, repo, localPath, agent, model, and effort.'));
assert.ok(prompt.includes('Run prompt template and orchestration verification scripts.'));
assert.ok(prompt.includes('- [ ] Use real agent task context'));
assert.ok(prompt.includes('DVF-0081: Pass production context shape to prompt rendering'));
assert.ok(prompt.includes(repoPathWithSpaces));
assert.ok(prompt.includes('Agent: Codex, Model: GPT-5.5, Effort: xhigh'));

console.log('[verify] Testing failed completion leaves the card retryable...');
completeAgentRunForTask(state.tasksCache[0], run1!, deps, {
  success: false,
  exitCode: 1,
  errorMessage: 'Agent process exited with code 1',
});
assert.equal(state.tasksCache[0].status, 'todo');
assert.equal(getActiveRunForTask('task-1'), null);
assert.equal(getLatestAgentRunForTask('task-1')?.status, 'failed');
assert.match(state.tasksCache[0].logs.at(-1)?.message || '', /exitCode=1/);

console.log('[verify] Testing queue continuation records visible skip reasons...');
const queueResult = continueTaskQueueForProject('project-1', deps);
assert.equal(queueResult.triggered, true);

await new Promise((resolve) => setTimeout(resolve, 250));
await waitFor(() => getLatestAgentRunForTask('task-3')?.status === 'running');

assert.equal(state.tasksCache[1].status, 'backlog');
assert.equal(state.tasksCache[2].status, 'todo');
assert.equal(state.tasksCache[3].status, 'in-progress');
assert.match(state.tasksCache[0].logs.at(-1)?.message || '', /Manual retry is required/);
assert.match(state.tasksCache[2].logs.at(-1)?.message || '', /Invalid agent or task id characters/);
assert.equal(getLatestAgentRunForTask('task-3')?.status, 'running');

console.log('[verify] Testing parent review gating and evidence requirements...');
const parentState: AppState = {
  tasksCache: [
    {
      id: 'parent-1',
      displayId: 'DVF-0089',
      projectId: 'project-1',
      status: 'in-progress',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Parent review card',
      description: 'Parent should stay out of review until children are complete.',
      logs: [],
    },
    {
      id: 'child-status',
      displayId: 'DVF-0090',
      projectId: 'project-1',
      parentId: 'parent-1',
      status: 'backlog',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'medium',
      title: 'Blocking child status',
      acceptanceCriteria: 'Complete before parent review.',
      logs: [],
    },
    {
      id: 'child-evidence',
      displayId: 'DVF-0093',
      projectId: 'project-1',
      parentId: 'parent-1',
      status: 'ready-for-review',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'medium',
      title: 'Smoke evidence child',
      acceptanceCriteria: 'Evidence must include prompt.md excerpt and agent.log lines.',
      verification: 'Paste prompt.md and agent.log evidence into task logs before review.',
      targetFiles: ['.devflow/runs'],
      logs: [],
    },
  ],
  projectsCache: [{ id: 'project-1', name: 'p1', repoUrl: 'repo', localPath: repoPathWithSpaces }],
  countersCache: {},
  settingsCache: { autoWork: false, ngrokUrl: '', githubToken: '', jiraToken: '', jiraBaseUrl: '', jiraEmail: '' },
  skillsRegistry: [],
};
const parentDeps: ApiRouteDeps = {
  state: parentState,
  writeAgentLog: () => {},
};
saveTasks(parentState);
const app = express();
app.use(express.json());
registerTaskRoutes(app, parentDeps);
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to bind test server.');
const baseUrl = `http://127.0.0.1:${address.port}`;
try {
  const blockedByStatus = await fetch(`${baseUrl}/api/tasks/parent-1/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-request': 'true' },
    body: JSON.stringify({ status: 'ready-for-review' }),
  });
  assert.equal(blockedByStatus.status, 400);
  const blockedByStatusBody = await blockedByStatus.json();
  assert.match(blockedByStatusBody.error || '', /DVF-0090 is still backlog/);

  parentState.tasksCache[1].status = 'ready-for-review';
  saveTasks(parentState);
  const blockedByEvidence = await fetch(`${baseUrl}/api/tasks/parent-1/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-request': 'true' },
    body: JSON.stringify({ status: 'ready-for-review' }),
  });
  assert.equal(blockedByEvidence.status, 400);
  const blockedByEvidenceBody = await blockedByEvidence.json();
  assert.match(blockedByEvidenceBody.error || '', /DVF-0093 is missing visible prompt\.md and agent\.log evidence/i);

  parentState.tasksCache[2].logs.push({
    id: 'evidence-1',
    timestamp: '2026-06-13T00:04:00.000Z',
    message: 'prompt.md excerpt: Task context and repo path verified.',
    type: 'update',
  });
  parentState.tasksCache[2].logs.push({
    id: 'evidence-2',
    timestamp: '2026-06-13T00:05:00.000Z',
    message: 'agent.log lines: completion callback posted success and fresh-session details.',
    type: 'update',
  });
  saveTasks(parentState);

  const allowedMove = await fetch(`${baseUrl}/api/tasks/parent-1/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-request': 'true' },
    body: JSON.stringify({ status: 'ready-for-review' }),
  });
  assert.equal(allowedMove.status, 200);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('[verify] Testing backlog reset clears locks and cancels active runs...');
assert.equal(isValidTransition('todo', 'backlog'), true);
assert.equal(isValidTransition('in-progress', 'backlog'), true);
assert.equal(isValidTransition('ready-for-review', 'backlog'), true);

const resetState: AppState = {
  tasksCache: [
    {
      id: 'reset-todo',
      displayId: 'DVF-0099-A',
      projectId: 'project-1',
      status: 'todo',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'medium',
      title: 'Todo lock reset',
      description: 'Moving to backlog should clear a stale queued lock.',
      logs: [],
    },
    {
      id: 'reset-progress',
      displayId: 'DVF-0099-B',
      projectId: 'project-1',
      status: 'in-progress',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'medium',
      title: 'In-progress lock reset',
      description: 'Moving to backlog should cancel the active run immediately.',
      logs: [],
    },
    {
      id: 'reset-review',
      displayId: 'DVF-0099-C',
      projectId: 'project-1',
      status: 'ready-for-review',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'medium',
      title: 'Review lock reset',
      description: 'Moving to backlog should clear any lingering active lock state.',
      logs: [],
    },
    {
      id: 'queue-sibling',
      displayId: 'DVF-0099-D',
      projectId: 'project-1',
      status: 'todo',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'medium',
      title: 'Sibling todo card',
      description: 'Backlog reset must not re-trigger Auto Work.',
      logs: [],
    },
  ],
  projectsCache: [{ id: 'project-1', name: 'p1', repoUrl: 'repo', localPath: repoPathWithSpaces }],
  countersCache: {},
  settingsCache: { autoWork: true, ngrokUrl: '', githubToken: '', jiraToken: '', jiraBaseUrl: '', jiraEmail: '' },
  skillsRegistry: [],
};
const resetDeps: ApiRouteDeps = {
  state: resetState,
  writeAgentLog: () => {},
};
saveTasks(resetState);

const queuedRun = createAgentRun({ taskId: 'reset-todo', projectId: 'project-1', agent: 'Codex', model: 'GPT-5.5', effort: 'medium' });
const runningRun = createAgentRun({ taskId: 'reset-progress', projectId: 'project-1', agent: 'Codex', model: 'GPT-5.5', effort: 'medium' });
updateAgentRunStatus(runningRun.id, 'running', { startedAt: new Date().toISOString() });
const startingRun = createAgentRun({ taskId: 'reset-review', projectId: 'project-1', agent: 'Codex', model: 'GPT-5.5', effort: 'medium' });
updateAgentRunStatus(startingRun.id, 'starting');
saveTasks(resetState);

const resetApp = express();
resetApp.use(express.json());
registerTaskRoutes(resetApp, resetDeps);
const resetServer = http.createServer(resetApp);
await new Promise<void>((resolve) => resetServer.listen(0, resolve));
const resetAddress = resetServer.address();
if (!resetAddress || typeof resetAddress === 'string') throw new Error('Failed to bind reset test server.');
const resetBaseUrl = `http://127.0.0.1:${resetAddress.port}`;
try {
  const todoBacklog = await fetch(`${resetBaseUrl}/api/tasks/reset-todo`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...resetState.tasksCache[0], status: 'backlog' }),
  });
  assert.equal(todoBacklog.status, 200);

  const progressBacklog = await fetch(`${resetBaseUrl}/api/tasks/reset-progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...resetState.tasksCache[1], status: 'backlog', emergency: true }),
  });
  assert.equal(progressBacklog.status, 200);

  const reviewBacklog = await fetch(`${resetBaseUrl}/api/tasks/reset-review`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...resetState.tasksCache[2], status: 'backlog' }),
  });
  assert.equal(reviewBacklog.status, 200);
} finally {
  await new Promise<void>((resolve, reject) => resetServer.close((error) => error ? reject(error) : resolve()));
}

for (const taskId of ['reset-todo', 'reset-progress', 'reset-review']) {
  const task = resetState.tasksCache.find((entry) => entry.id === taskId);
  assert.ok(task);
  assert.equal(task?.status, 'backlog');
  assert.equal(task?.activeAgent, undefined);
  assert.equal(getActiveRunForTask(taskId), null);
  assert.equal(getLatestAgentRunForTask(taskId)?.status, 'cancelled');
  assert.match(getLatestAgentRunForTask(taskId)?.errorMessage || '', /Manual reset|backlog/i);
  assert.ok(task?.logs.some((entry: any) => /Manual reset: cleared active agent lock/i.test(entry.message)));
}
assert.equal(getLatestAgentRunForTask('queue-sibling'), null);

console.log('[verify-orchestration] all assertions passed');
