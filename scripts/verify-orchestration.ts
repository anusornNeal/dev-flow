import { getSettings } from '../src/server/repositories/settingsRepository.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
const { registerSettingsRoutes } = await import('../src/server/routes/settings.js');

const {
  createAgentRun,
  getActiveRunForTask,
  getLatestAgentRunForTask,
  listAgentRunsForTask,
  updateAgentRunStatus,
} = await import('../src/server/repositories/agentRunRepository.js');

const { buildTaskStatusMoveRequest } = await import('../src/lib/taskStatusMove.js');
const { createProject, getProjects, updateProject } = await import('../src/server/repositories/projectRepository.js');
const { saveTasks } = await import('../src/server/repositories/taskRepository.js');
const { getAgentTaskContext } = await import('../src/server/services/taskService.js');
const { renderTaskPrompt } = await import('../src/server/services/taskService.js');
const { isValidTransition } = await import('../src/lib/statusTransitions.js');
const { default: TaskCard } = await import('../src/components/TaskCard.js');
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
  countersCache: {},
  
  skillsRegistry: [],
};



try { createProject({ id: 'project-1', name: 'p1', repoUrl: 'https://github.com/anusornNeal/dev-flow', localPath: repoPathWithSpaces }); } catch(e) {}
  const loggedMessages: string[] = [];
const deps: ApiRouteDeps = {
  state,
  writeAgentLog: (level, msg) => { loggedMessages.push(`[${level}] ${msg}`); },
};

console.log('[verify] Testing missing project.localPath blocks setup...');
const p0 = getProjects()[0]; p0.localPath = undefined; updateProject(p0);
const noPathResult = triggerTaskAgent(state.tasksCache[0], deps, 'test');
assert.equal(noPathResult.triggered, false);
assert.equal(noPathResult.reason, 'Project localPath is missing. Task cannot be run.');
assert.equal(state.tasksCache[0].status, 'todo');

console.log('[verify] Testing real prompt rendering and startup handoff...');
const p1 = getProjects()[0]; p1.localPath = repoPathWithSpaces; updateProject(p1);
const taskContext = getAgentTaskContext(state, 'task-1');
assert.ok(taskContext?.projectRules?.workflow);
assert.equal(taskContext.projectRules.title, 'DevFlow Workflow Rules');
assert.ok(taskContext.projectRules.workflow.some((rule: string) => rule.includes('todo cards') && rule.includes('in-progress')));
assert.ok(taskContext.projectRules.workflow.some((rule: string) => rule.includes('default to develop')));
assert.ok(taskContext.projectRules.workflow.some((rule: string) => rule.includes('checklist')));
assert.ok(taskContext.projectRules.workflow.some((rule: string) => rule.includes('push') && rule.includes('ready-for-review')));
assert.equal(taskContext.projectRules.implementation, undefined);
const overrideDir = path.join(repoPathWithSpaces, '.devflow', 'prompt-overrides');
fs.mkdirSync(overrideDir, { recursive: true });
fs.writeFileSync(path.join(overrideDir, 'prompt.header.md'), '\nOVERRIDE HEADER {{run.id}}\n', 'utf8');
const previewPrompt = renderTaskPrompt(state, 'task-1');
assert.ok(previewPrompt.renderResult.content.includes('OVERRIDE HEADER preview-run-id'));
const triggerResult = triggerTaskAgent(state.tasksCache[0], deps, 'test');
assert.equal(triggerResult.triggered, true);
assert.equal(state.tasksCache[0].status, 'in-progress');

await new Promise((resolve) => setTimeout(resolve, 250));
await waitFor(() => getLatestAgentRunForTask('task-1')?.status === 'running');

const run1 = getLatestAgentRunForTask('task-1');
assert.ok(run1);
assert.equal(run1?.status, 'running');
const promptPath = path.join(repoPathWithSpaces, '.devflow', 'runs', run1!.id, 'prompt.md');
const prompt = fs.readFileSync(promptPath, 'utf8');
const resultPath = path.join(repoPathWithSpaces, '.devflow', 'runs', run1!.id, 'result.json');
const runPrompt = renderTaskPrompt(state, 'task-1', { runId: run1!.id });
assert.equal(prompt, runPrompt.renderResult.content);
const historyApp = express();
historyApp.use(express.json());
registerTaskRoutes(historyApp, deps);
const historyServer = http.createServer(historyApp);
await new Promise<void>((resolve) => historyServer.listen(0, resolve));
const historyAddress = historyServer.address();
if (!historyAddress || typeof historyAddress === 'string') throw new Error('Failed to bind history test server.');
const historyBaseUrl = `http://127.0.0.1:${historyAddress.port}`;
try {
  const historyResponse = await fetch(`${historyBaseUrl}/api/tasks/task-1/agent-runs/${run1!.id}/history`);
  assert.equal(historyResponse.status, 200);
  const historyBody = await historyResponse.json();
  assert.equal(historyBody.runId, run1!.id);
  assert.equal(historyBody.files.promptPath, promptPath);
  assert.ok(historyBody.files.launchMetadataPath.endsWith(path.join(run1!.id, 'launch.json')));
  assert.ok(historyBody.files.outputSummaryPath.endsWith(path.join(run1!.id, 'summary.txt')));
  assert.ok(historyBody.files.resultPath.endsWith(path.join(run1!.id, 'result.json')));
} finally {
  await new Promise<void>((resolve, reject) => historyServer.close((error) => error ? reject(error) : resolve()));
}
const runningResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
assert.equal(runningResult.runId, run1!.id);
assert.equal(runningResult.status, 'running');
assert.equal(runningResult.success, null);
assert.equal(runningResult.resultCode, 'RUNNING');
assert.equal(typeof runningResult.updatedAt, 'string');
assert.equal(runPrompt.context.instruction.description, 'Generate the prompt from the real production agent context.');
assert.equal(runPrompt.context.instruction.reasoning, 'Review blockers found the old flat task shape still in use.');
assert.equal(runPrompt.context.requirements.acceptanceCriteria, 'Prompt includes description, acceptance criteria, verification, checklist, subtasks, repo, localPath, agent, model, and effort.');
assert.equal(runPrompt.context.requirements.verification, 'Run prompt template and orchestration verification scripts.');
assert.ok(runPrompt.context.requirements.checklist.some((item: any) => item.text.includes('Use real agent task context')));
assert.ok(runPrompt.context.orchestration.subtasks.some((sub: any) => sub.title.includes('Pass production context shape')));
assert.equal(runPrompt.context.workspace.localPath, repoPathWithSpaces);
assert.equal(runPrompt.context.assignment.agent, 'Codex');
assert.equal(runPrompt.context.assignment.model, 'GPT-5.5');
assert.equal(runPrompt.context.assignment.effort, 'xhigh');
assert.ok(prompt.includes(`OVERRIDE HEADER ${run1!.id}`));

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
const failedResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
assert.equal(failedResult.runId, run1!.id);
assert.equal(failedResult.status, 'failed');
assert.equal(failedResult.success, false);
assert.equal(failedResult.resultCode, 'FAILED');
assert.equal(failedResult.exitCode, 1);
assert.match(failedResult.errorMessage || '', /code 1/);
assert.equal(typeof failedResult.completedAt, 'string');

console.log('[verify] Testing duplicate trigger reuses the same active run...');
const duplicateState: AppState = {
  tasksCache: [
    {
      id: 'dup-task-1',
      displayId: 'DVF-0111-X',
      projectId: 'project-dup',
      status: 'todo',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Duplicate trigger reuse',
      description: 'Repeated trigger attempts should reuse the same active run.',
      logs: [],
      createdAt: '2026-06-13T00:20:00.000Z',
      updatedAt: '2026-06-13T00:20:00.000Z',
    },
  ],
  countersCache: {},
  
  skillsRegistry: [],
};
try { createProject({ id: 'project-dup', name: 'dup', repoUrl: 'https://github.com/anusornNeal/dev-flow', localPath: repoPathWithSpaces }); } catch(e) {}
  const duplicateDeps: ApiRouteDeps = {
  state: duplicateState,
  writeAgentLog: () => {},
};
saveTasks(duplicateState);
const firstDuplicateTrigger = triggerTaskAgent(duplicateState.tasksCache[0], duplicateDeps, 'dup-test');
assert.equal(firstDuplicateTrigger.triggered, true);
const firstDuplicateRunId = firstDuplicateTrigger.run.id;
const secondDuplicateTrigger = triggerTaskAgent(duplicateState.tasksCache[0], duplicateDeps, 'dup-test');
assert.equal(secondDuplicateTrigger.triggered, false);
assert.equal(secondDuplicateTrigger.run?.id, firstDuplicateRunId);
assert.match(secondDuplicateTrigger.reason, /already running for this task/i);
assert.equal(listAgentRunsForTask('dup-task-1').length, 1);
assert.equal(getActiveRunForTask('dup-task-1')?.id, firstDuplicateRunId);

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
  countersCache: {},
  
  skillsRegistry: [],
};
try { createProject({ id: 'project-1', name: 'p1', repoUrl: 'repo', localPath: repoPathWithSpaces }); } catch(e) {}
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

console.log('[verify] Testing lane move requests preserve latest assignment fields...');
assert.deepEqual(
  buildTaskStatusMoveRequest('task-1', 'todo'),
  {
    url: '/api/tasks/task-1/move',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'todo' }),
    },
  },
);
assert.deepEqual(
  buildTaskStatusMoveRequest('task-1', 'backlog', { emergency: true }),
  {
    url: '/api/tasks/task-1/move',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'backlog', emergency: true }),
    },
  },
);

const moveState: AppState = {
  tasksCache: [
    {
      id: 'move-task-1',
      displayId: 'DVF-0104-X',
      projectId: 'project-1',
      status: 'backlog',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Move should not restore stale effort',
      description: 'Editing effort to low before moving lanes must survive.',
      logs: [],
      createdAt: '2026-06-13T00:10:00.000Z',
      updatedAt: '2026-06-13T00:10:00.000Z',
    },
  ],
  countersCache: {},
  
  skillsRegistry: [],
};
try { createProject({ id: 'project-1', name: 'p1', repoUrl: 'repo', localPath: repoPathWithSpaces }); } catch(e) {}
  const moveDeps: ApiRouteDeps = {
  state: moveState,
  writeAgentLog: () => {},
};
saveTasks(moveState);

const moveApp = express();
moveApp.use(express.json());
registerTaskRoutes(moveApp, moveDeps);
const moveServer = http.createServer(moveApp);
await new Promise<void>((resolve) => moveServer.listen(0, resolve));
const moveAddress = moveServer.address();
if (!moveAddress || typeof moveAddress === 'string') throw new Error('Failed to bind move test server.');
const moveBaseUrl = `http://127.0.0.1:${moveAddress.port}`;
try {
  const staleTaskSnapshot = { ...moveState.tasksCache[0] };

  const updateResponse = await fetch(`${moveBaseUrl}/api/tasks/move-task-1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...moveState.tasksCache[0],
      model: 'GPT-5.4 Mini',
      effort: 'low',
    }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal(moveState.tasksCache[0].effort, 'low');
  assert.equal(moveState.tasksCache[0].model, 'GPT-5.4 Mini');

  const moveRequest = buildTaskStatusMoveRequest(staleTaskSnapshot.id, 'todo');
  const moveResponse = await fetch(`${moveBaseUrl}${moveRequest.url}`, moveRequest.init);
  assert.equal(moveResponse.status, 200);
  assert.equal(moveState.tasksCache[0].status, 'todo');
  assert.equal(moveState.tasksCache[0].effort, 'low');
  assert.equal(moveState.tasksCache[0].model, 'GPT-5.4 Mini');
} finally {
  await new Promise<void>((resolve, reject) => moveServer.close((error) => error ? reject(error) : resolve()));
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
  countersCache: {},
  
  skillsRegistry: [],
};
try { createProject({ id: 'project-1', name: 'p1', repoUrl: 'repo', localPath: repoPathWithSpaces }); } catch(e) {}
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

console.log('[verify] Testing stale runs reconcile during normal reads...');
const staleReadState: AppState = {
  tasksCache: [
    {
      id: 'stale-read-task',
      displayId: 'DVF-0112-X',
      projectId: 'project-1',
      status: 'in-progress',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'medium',
      title: 'Stale read cleanup',
      description: 'Reading task state should cancel stale active runs.',
      logs: [],
    },
  ],
  countersCache: {},
  
  skillsRegistry: [],
};
try { createProject({ id: 'project-1', name: 'p1', repoUrl: 'repo', localPath: repoPathWithSpaces }); } catch(e) {}
  const staleReadDeps: ApiRouteDeps = {
  state: staleReadState,
  writeAgentLog: () => {},
};
saveTasks(staleReadState);
const staleRun = createAgentRun({ taskId: 'stale-read-task', projectId: 'project-1', agent: 'Codex', model: 'GPT-5.5', effort: 'medium' });
updateAgentRunStatus(staleRun.id, 'running', { startedAt: '2026-06-12T00:00:00.000Z' });
const staleReadApp = express();
staleReadApp.use(express.json());
registerTaskRoutes(staleReadApp, staleReadDeps);
const staleReadServer = http.createServer(staleReadApp);
await new Promise<void>((resolve) => staleReadServer.listen(0, resolve));
const staleReadAddress = staleReadServer.address();
if (!staleReadAddress || typeof staleReadAddress === 'string') throw new Error('Failed to bind stale read server.');
const staleReadBaseUrl = `http://127.0.0.1:${staleReadAddress.port}`;
try {
  const staleReadResponse = await fetch(`${staleReadBaseUrl}/api/tasks`);
  assert.equal(staleReadResponse.status, 200);
  const staleReadTasks = await staleReadResponse.json();
  const staleReadTask = staleReadTasks.find((entry: any) => entry.id === 'stale-read-task');
  assert.equal(staleReadTask.latestAgentRun.status, 'cancelled');
  assert.match(staleReadTask.latestAgentRun.errorMessage || '', /stale active run cancelled/i);
} finally {
  await new Promise<void>((resolve, reject) => staleReadServer.close((error) => error ? reject(error) : resolve()));
}

console.log('[verify] Testing Auto Work enable validation blocks invalid queued tasks...');
const autoWorkValidationState: AppState = {
  tasksCache: [
    {
      id: 'auto-work-invalid-task',
      displayId: 'DVF-0118-X',
      projectId: 'project-1',
      status: 'todo',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'medium',
      title: 'Queued task with invalid config',
      description: 'Enabling Auto Work should fail fast when queued work cannot launch.',
      logs: [],
    },
  ],
  countersCache: {},
  
  skillsRegistry: [],
};
try { createProject({ id: 'project-1', name: 'p1', repoUrl: 'repo', localPath: path.join(tempDir, 'missing-project-path') }); } catch(e) {}
  const autoWorkValidationDeps: ApiRouteDeps = {
  state: autoWorkValidationState,
  writeAgentLog: () => {},
};
const autoWorkValidationApp = express();
autoWorkValidationApp.use(express.json());
registerSettingsRoutes(autoWorkValidationApp, autoWorkValidationDeps);
const autoWorkValidationServer = http.createServer(autoWorkValidationApp);
await new Promise<void>((resolve) => autoWorkValidationServer.listen(0, resolve));
const autoWorkValidationAddress = autoWorkValidationServer.address();
if (!autoWorkValidationAddress || typeof autoWorkValidationAddress === 'string') throw new Error('Failed to bind Auto Work validation server.');
const autoWorkValidationBaseUrl = `http://127.0.0.1:${autoWorkValidationAddress.port}`;
try {
  const autoWorkEnableResponse = await fetch(`${autoWorkValidationBaseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoWork: true }),
  });
  assert.equal(autoWorkEnableResponse.status, 409);
  const autoWorkEnableBody = await autoWorkEnableResponse.json();
  assert.equal(autoWorkEnableBody.code, 'AUTO_WORK_CONFIG_INVALID');
  assert.match(autoWorkEnableBody.error || '', /auto work/i);
  assert.match(autoWorkEnableBody.error || '', /DVF-0118-X/);
  assert.equal(getSettings().autoWork, false);
} finally {
  await new Promise<void>((resolve, reject) => autoWorkValidationServer.close((error) => error ? reject(error) : resolve()));
}

console.log('[verify] Testing Auto Work enable triggers queued task...');
const autoWorkTriggerState: AppState = {
  tasksCache: [
    {
      id: 'auto-work-valid-task',
      displayId: 'DVF-0119-X',
      projectId: 'project-autowork-1',
      status: 'todo',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'medium',
      title: 'Queued valid task',
      description: 'Enabling Auto Work should trigger this.',
      logs: [],
    },
    {
      id: 'unrelated-task',
      displayId: 'DVF-0120-X',
      projectId: 'project-autowork-1',
      status: 'backlog',
      agent: 'Claude',
      model: 'Claude 4.8 Opus',
      effort: 'low',
      title: 'Unrelated backlog task',
      description: 'Should not be modified.',
      logs: [],
    }
  ],
  countersCache: {},
  
  skillsRegistry: [],
};
try { createProject({ id: 'project-autowork-1', name: 'p1', repoUrl: 'repo', localPath: tempDir }); } catch(e) {}
  const autoWorkTriggerDeps: ApiRouteDeps = {
  state: autoWorkTriggerState,
  writeAgentLog: (level, msg) => console.log(`[AutoWorkTrigger Log] ${level}: ${msg}`),
};
const autoWorkTriggerApp = express();
autoWorkTriggerApp.use(express.json());
registerSettingsRoutes(autoWorkTriggerApp, autoWorkTriggerDeps);
const autoWorkTriggerServer = http.createServer(autoWorkTriggerApp);
await new Promise<void>((resolve) => autoWorkTriggerServer.listen(0, resolve));
const autoWorkTriggerAddress = autoWorkTriggerServer.address();
if (!autoWorkTriggerAddress || typeof autoWorkTriggerAddress === 'string') throw new Error('Failed to bind Auto Work trigger server.');
const autoWorkTriggerBaseUrl = `http://127.0.0.1:${autoWorkTriggerAddress.port}`;
try {
  const response = await fetch(`${autoWorkTriggerBaseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoWork: true }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.autoWork, true);
  assert.equal(body.autoWorkTrigger.triggered, true);
  assert.equal(getSettings().autoWork, true);
  
  // Unrelated task should not be mutated
  const unrelatedTask = autoWorkTriggerState.tasksCache.find(t => t.id === 'unrelated-task');
  assert.equal(unrelatedTask?.agent, 'Claude');
  assert.equal(unrelatedTask?.model, 'Claude 4.8 Opus');
  
  // Test disabling
  const disableResponse = await fetch(`${autoWorkTriggerBaseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoWork: false }),
  });
  const disableBody = await disableResponse.json();
  assert.equal(disableBody.success, true);
  assert.equal(getSettings().autoWork, false);
} finally {
  await new Promise<void>((resolve, reject) => autoWorkTriggerServer.close((error) => error ? reject(error) : resolve()));
}

console.log('[verify] Testing agent completion callback API...');
const completionState: AppState = {
  tasksCache: [
    {
      id: 'completion-success',
      displayId: 'DVF-0151-A',
      projectId: 'project-1',
      status: 'in-progress',
      branch: 'test/reply-exactly-hi',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Successful completion callback',
      description: 'Success should move task to ready-for-review.',
      logs: [],
      createdAt: '2026-06-14T00:00:00.000Z',
      updatedAt: '2026-06-14T00:00:00.000Z',
    },
    {
      id: 'completion-failed',
      displayId: 'DVF-0151-B',
      projectId: 'project-1',
      status: 'in-progress',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Failed completion callback',
      description: 'Failure should preserve safe state.',
      logs: [],
      createdAt: '2026-06-14T00:01:00.000Z',
      updatedAt: '2026-06-14T00:01:00.000Z',
    },
    {
      id: 'completion-cancelled',
      displayId: 'DVF-0151-C',
      projectId: 'project-1',
      status: 'in-progress',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Cancelled completion callback',
      description: 'Cancellation should not auto-complete task.',
      logs: [],
      createdAt: '2026-06-14T00:02:00.000Z',
      updatedAt: '2026-06-14T00:02:00.000Z',
    },
  ],
  countersCache: {},
  
  skillsRegistry: [],
};
try { createProject({ id: 'project-1', name: 'p1', repoUrl: 'repo', localPath: repoPathWithSpaces }); } catch(e) {}
  const completionDeps: ApiRouteDeps = {
  state: completionState,
  writeAgentLog: () => {},
};
saveTasks(completionState);
const successRun = createAgentRun({ taskId: 'completion-success', projectId: 'project-1', agent: 'Codex', model: 'GPT-5.5', effort: 'high' });
updateAgentRunStatus(successRun.id, 'running', { startedAt: new Date().toISOString() });
const failedRun = createAgentRun({ taskId: 'completion-failed', projectId: 'project-1', agent: 'Codex', model: 'GPT-5.5', effort: 'high' });
updateAgentRunStatus(failedRun.id, 'running', { startedAt: new Date().toISOString() });
const cancelledRun = createAgentRun({ taskId: 'completion-cancelled', projectId: 'project-1', agent: 'Codex', model: 'GPT-5.5', effort: 'high' });
updateAgentRunStatus(cancelledRun.id, 'running', { startedAt: new Date().toISOString() });
saveTasks(completionState);

const completionApp = express();
completionApp.use(express.json());
registerTaskRoutes(completionApp, completionDeps);
const completionServer = http.createServer(completionApp);
await new Promise<void>((resolve) => completionServer.listen(0, resolve));
const completionAddress = completionServer.address();
if (!completionAddress || typeof completionAddress === 'string') throw new Error('Failed to bind completion server.');
const completionBaseUrl = `http://127.0.0.1:${completionAddress.port}`;
try {
  const invalidPayloadResponse = await fetch(`${completionBaseUrl}/api/tasks/completion-success/agent-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-request': 'true' },
    body: JSON.stringify({ status: 'bogus' }),
  });
  assert.equal(invalidPayloadResponse.status, 400);

  const successResponse = await fetch(`${completionBaseUrl}/api/tasks/completion-success/agent-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-request': 'true' },
    body: JSON.stringify({
      runId: successRun.id,
      status: 'success',
      summary: 'Implemented callback flow',
      changedFiles: ['src/server/routes/tasks.ts', 'src/components/TaskCard.tsx'],
      tests: [{ command: 'npm run verify', result: 'passed', output: 'all assertions passed' }],
      notes: 'Ready for review',
    }),
  });
  assert.equal(successResponse.status, 200);
  const successBody = await successResponse.json();
  assert.equal(successBody.task.status, 'ready-for-review');
  assert.equal(successBody.run.status, 'succeeded');
  assert.match(JSON.stringify(successBody.task.logs), /Implemented callback flow/);

  const failedResponse = await fetch(`${completionBaseUrl}/api/tasks/completion-failed/agent-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-request': 'true' },
    body: JSON.stringify({
      runId: failedRun.id,
      status: 'failed',
      summary: 'Lint failure',
      changedFiles: ['src/server/routes/tasks.ts'],
      tests: [{ command: 'npm run verify', result: 'failed', output: 'lint error' }],
      notes: 'Need another pass',
    }),
  });
  assert.equal(failedResponse.status, 200);
  const failedBody = await failedResponse.json();
  assert.equal(failedBody.task.status, 'todo');
  assert.equal(failedBody.run.status, 'failed');

  const cancelledResponse = await fetch(`${completionBaseUrl}/api/tasks/completion-cancelled/agent-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-request': 'true' },
    body: JSON.stringify({
      runId: cancelledRun.id,
      status: 'cancelled',
      summary: 'User cancelled run',
      changedFiles: [],
      tests: [],
      notes: 'Cancelled before completion',
    }),
  });
  assert.equal(cancelledResponse.status, 200);
  const cancelledBody = await cancelledResponse.json();
  assert.equal(cancelledBody.task.status, 'todo');
  assert.equal(cancelledBody.run.status, 'cancelled');

  const missingRunResponse = await fetch(`${completionBaseUrl}/api/tasks/completion-success/agent-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-request': 'true' },
    body: JSON.stringify({
      runId: 'run-missing',
      status: 'success',
      summary: 'No-op',
      changedFiles: [],
      tests: [],
    }),
  });
  assert.equal(missingRunResponse.status, 409);
} finally {
  await new Promise<void>((resolve, reject) => completionServer.close((error) => error ? reject(error) : resolve()));
}

console.log('[verify] Testing task card branch metadata rendering...');
const branchCardMarkup = renderToStaticMarkup(
  React.createElement(TaskCard, {
    task: {
      id: 'branch-card-1',
      displayId: 'DVF-0151-D',
      projectId: 'project-1',
      title: 'Branch metadata card',
      description: 'Should show active branch as shared metadata.',
      status: 'todo',
      branch: 'test/reply-exactly-hi',
      priority: 'high',
      tags: [],
      createdAt: '2026-06-14T00:03:00.000Z',
      updatedAt: '2026-06-14T00:03:00.000Z',
      logs: [],
    },
    subtasks: [],
    onSelect: () => {},
    onDelete: () => {},
    onDragStart: () => {},
    onUpdate: () => {},
  }),
);
assert.match(branchCardMarkup, /🌿 test\/reply-exactly-hi/);

console.log('[verify-orchestration] all assertions passed');
