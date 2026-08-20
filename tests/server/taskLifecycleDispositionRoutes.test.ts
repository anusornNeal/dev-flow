import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-lifecycle-disposition-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'shared.ts'), 'export const shared = 1;\n');
fs.writeFileSync(path.join(repoRoot, 'src', 'other.ts'), 'export const other = 1;\n');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.test']);
git(['add', '.']);
git(['commit', '-m', 'base']);
git(['branch', '-M', 'develop']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { listExecutionSessionsForTask } = await import('../../src/server/repositories/executionSessionRepository.js');
const claims = await import('../../src/server/services/taskClaimService.js');
const workspaces = await import('../../src/server/services/sessionWorkspaceService.js');
const { sanitizeStartupTasks } = await import('../../src/server/bootstrap.js');
const jobService = await import('../../src/server/services/mcpToolJobService.js') as any;
const jobRepo = await import('../../src/server/repositories/mcpToolJobRepository.js') as any;
const checkpoints = await import('../../src/server/services/executionCheckpointService.js') as any;

const project = {
  id: 'project-lifecycle-disposition',
  name: 'Lifecycle disposition',
  repoUrl: 'https://example.test/lifecycle-disposition.git',
  localPath: repoRoot,
  taskIdPrefix: 'LIFE',
  createdAt: new Date().toISOString(),
};
createProject(project as any);
workspaces.resetSessionWorkspaceRuntimeForTests();
const state: any = { countersCache: {}, projectsCache: [project], skillsRegistry: [] };

let taskSequence = 0;
function seedTask(label: string, targetFiles?: string[], options: { parentId?: string; status?: string } = {}) {
  taskSequence += 1;
  const id = `task-lifecycle-${label}-${taskSequence}`;
  const now = new Date().toISOString();
  const focusedTargets = targetFiles || [`src/${label}.ts`];
  saveTask({
    id,
    displayId: `LIFE-${String(taskSequence).padStart(4, '0')}`,
    title: label,
    description: 'User explicitly asked to execute this lifecycle mutation regression fixture.',
    reasoning: 'User explicitly asked to execute this focused lifecycle regression task.',
    repoContext: `Implementation map:\n- File: ${focusedTargets[0]}\n- Class/function: lifecycle regression fixture\n- Current behavior: lifecycle writers may drift claim, execution, and status.\n- Expected change: preserve one coordinated lifecycle disposition boundary.`,
    projectId: project.id,
    status: options.status || 'todo',
    priority: 'medium',
    category: 'backend',
    tags: [],
    targetFiles: focusedTargets,
    checklist: [],
    parentId: options.parentId,
    createdAt: now,
    updatedAt: now,
    logs: [],
    bugs: [],
    images: [],
  } as any);
  return id;
}

function claimTask(id: string, sessionId = `session-${id}`) {
  return claims.claimTaskForSession(id, { sessionId, ownerKind: 'chat', ownerLabel: `Chat ${id.slice(-4)}` });
}

function activeExecution(id: string) {
  return listExecutionSessionsForTask(id).find((entry: any) => entry.status === 'active') || null;
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

const app = express();
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server did not bind');
const base = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function jsonRequest(pathname: string, init: RequestInit) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  let body: any = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

test('manual move disposes claimed execution ownership before leaving in-progress', async () => {
  const id = seedTask('manual-move');
  claimTask(id);
  const before = activeExecution(id);
  assert.ok(before);

  const result = await jsonRequest(`/api/tasks/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ status: 'todo', emergency: true }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const saved = getTask(id)!;
  assert.equal(saved.status, 'todo');
  assert.equal(saved.claim, undefined);
  assert.equal(activeExecution(id), null);
  assert.equal(listExecutionSessionsForTask(id).find((entry: any) => entry.id === before!.id)?.status, 'cancelled');
});

test('direct task update cannot clear a claim while leaving its execution active', async () => {
  const id = seedTask('direct-update');
  claimTask(id);
  const before = activeExecution(id);
  assert.ok(before);

  const result = await jsonRequest(`/api/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'todo', emergency: true }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const saved = getTask(id)!;
  assert.equal(saved.status, 'todo');
  assert.equal(saved.claim, undefined);
  assert.equal(activeExecution(id), null);
  assert.equal(listExecutionSessionsForTask(id).find((entry: any) => entry.id === before!.id)?.status, 'cancelled');
});

test('batch move uses the same lifecycle disposition as single-task status writers', async () => {
  const id = seedTask('batch-move');
  claimTask(id);
  const before = activeExecution(id);
  assert.ok(before);

  const result = await jsonRequest('/api/tasks/batch/move', {
    method: 'POST',
    body: JSON.stringify({ moves: [{ taskId: id, status: 'todo', emergency: true }] }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.results?.[0]?.success, true, JSON.stringify(result.body));
  const saved = getTask(id)!;
  assert.equal(saved.status, 'todo');
  assert.equal(saved.claim, undefined);
  assert.equal(activeExecution(id), null);
  assert.equal(listExecutionSessionsForTask(id).find((entry: any) => entry.id === before!.id)?.status, 'cancelled');
});

test('recursive delete fails closed before deleting any task when one descendant still owns lifecycle state', async () => {
  const parentId = seedTask('delete-parent', ['src/other.ts'], { status: 'todo' });
  const childId = seedTask('delete-child', ['src/shared.ts'], { parentId });
  claimTask(childId);

  const result = await jsonRequest(`/api/tasks/${parentId}?emergency=true`, { method: 'DELETE' });
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, 'TASK_DELETE_LIFECYCLE_BLOCKED');
  assert.ok(getTask(parentId));
  assert.ok(getTask(childId));
  assert.ok(getTask(childId)?.claim);
  assert.ok(activeExecution(childId));
});

test('startup sanitation preserves a valid Chat claim and an unclaimed orchestration parent with an active child', () => {
  const parentId = seedTask('startup-parent', ['src/startup-parent.ts'], { status: 'in-progress' });
  const childId = seedTask('startup-child', ['src/startup-child.ts'], { parentId });
  claimTask(childId);
  assert.equal(getTask(parentId)?.claim, undefined);
  assert.equal(getTask(parentId)?.status, 'in-progress');
  assert.equal(getTask(childId)?.status, 'in-progress');

  sanitizeStartupTasks(state);

  assert.equal(getTask(childId)?.status, 'in-progress');
  assert.ok(getTask(childId)?.claim);
  assert.ok(activeExecution(childId));
  assert.equal(getTask(parentId)?.status, 'in-progress');
  assert.equal(getTask(parentId)?.claim, undefined);
});

test('scope conflict remains authoritative even if task status drifted away from in-progress while its claim is still live', () => {
  const firstId = seedTask('scope-owner', ['src/scope-shared.ts']);
  const secondId = seedTask('scope-contender', ['src/scope-shared.ts']);
  claimTask(firstId, 'scope-owner-session');
  const drifted = getTask(firstId)!;
  drifted.status = 'todo';
  saveTask(drifted);

  assert.throws(
    () => claimTask(secondId, 'scope-contender-session'),
    (error: any) => error?.payload?.code === 'TASK_SCOPE_CONFLICT',
  );
  assert.equal(getTask(secondId)?.claim, undefined);
});

test('emergency manual move remains blocked while a real durable lifecycle job is running and leaves ownership untouched', async () => {
  const id = seedTask('pending-operation');
  const claimed = claimTask(id, 'pending-owner-session');
  const execution = activeExecution(id);
  assert.ok(execution);
  const workspace = workspaces.resolveSessionWorkspace(claimed.claim.workspaceId)!;
  const blocker = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  })();

  jobService.__setToolJobTestRunner('edit_local_files_batch', async (_state: any, _args: any, _logger: any, setCancelFn: (fn: () => void) => void) => {
    setCancelFn(() => blocker.resolve());
    await blocker.promise;
    return { ok: true, status: 'succeeded' };
  });
  const job = jobService.enqueueToolJob(state, 'edit_local_files_batch', {
    projectId: project.id,
    workspaceId: workspace.workspaceId,
    mode: 'apply',
    files: [{ filePath: 'src/shared.ts', edits: [{ type: 'replace', find: 'shared = 1', replaceWith: 'shared = 2' }] }],
    singleFlight: false,
  }, 'repo-command');

  try {
    await waitUntil(() => jobRepo.getJob(job.jobId)?.status === 'running', 'Expected durable lifecycle job to enter running');
    assert.equal(checkpoints.getLatestExecutionCheckpoint(execution!.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId && entry.status === 'running'), true);

    const result = await jsonRequest(`/api/tasks/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ status: 'todo', emergency: true }),
    });
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body?.error?.code, 'TASK_LIFECYCLE_PENDING_OPERATION');
    assert.equal(getTask(id)?.status, 'in-progress');
    assert.equal(getTask(id)?.claim?.workspaceId, workspace.workspaceId);
    assert.equal(activeExecution(id)?.id, execution!.id);
  } finally {
    jobService.cancelToolJob(job.jobId);
    blocker.resolve();
    await waitUntil(() => !jobService.getJobMetrics().activeJobs.some((entry: any) => entry.jobId === job.jobId), 'Expected pending job worker to stop');
    jobService.__setToolJobTestRunner('edit_local_files_batch', null);
  }
});
