import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-manual-move-'));
const repoRoot = path.join(tempDir, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempDir, 'runtime');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'shared.ts'), 'export const shared = 1;\n');
fs.writeFileSync(path.join(repoRoot, 'src', 'other.ts'), 'export const other = 1;\n');
fs.writeFileSync(path.join(repoRoot, 'src', 'pending.ts'), 'export const pending = 1;\n');
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
const remoteRoot = path.join(tempDir, 'origin.git');
const remoteInit = spawnSync('git', ['init', '--bare', remoteRoot], { cwd: tempDir, encoding: 'utf8', shell: false });
assert.equal(remoteInit.status, 0, remoteInit.stderr || remoteInit.stdout);
git(['remote', 'add', 'origin', remoteRoot]);
git(['push', '-u', 'origin', 'develop']);
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTask } = await import('../../src/server/repositories/taskRepository.js');
const { createAgentRun } = await import('../../src/server/repositories/agentRunRepository.js');
const { listExecutionSessionsForTask } = await import('../../src/server/repositories/executionSessionRepository.js');
const { buildTaskGitWarnings } = await import('../../src/server/services/taskGitWorkflowService.js');
const claims = await import('../../src/server/services/taskClaimService.js');
const workspaces = await import('../../src/server/services/sessionWorkspaceService.js');
const jobService = await import('../../src/server/services/mcpToolJobService.js') as any;
const jobRepo = await import('../../src/server/repositories/mcpToolJobRepository.js') as any;
const checkpoints = await import('../../src/server/services/executionCheckpointService.js') as any;

const project = { id: 'project-manual-move', name: 'Manual Move', repoUrl: remoteRoot, localPath: repoRoot };
createProject(project as any);
const state: any = { projectsCache: [project], countersCache: {}, skillsRegistry: [] };

function task(id: string) {
  return {
    id,
    displayId: id.toUpperCase(),
    title: id,
    description: 'Manual status move fixture',
    projectId: project.id,
    status: 'in-progress',
    priority: 'medium',
    branch: null,
    tags: [],
    targetFiles: [],
    checklist: [{ id: 'c1', text: 'unfinished', completed: false }],
    verificationEvidence: [],
    logs: [],
    bugs: [],
    images: [],
    designImages: [],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  } as any;
}

for (const id of ['manual-debt-done', 'manual-debt-ready', 'manual-hard', 'strict-default', 'manual-path']) saveTask(task(id));
createAgentRun({ taskId: 'manual-hard', projectId: project.id, agent: 'Codex', model: 'GPT-5.5', effort: 'medium' });

const app = express();
app.use(express.json());
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server did not bind');
const base = `http://127.0.0.1:${address.port}`;

test.after(() => server.close());

async function post(id: string, body: any, route: 'move' | 'move-to' = 'move') {
  const response = await fetch(`${base}/api/tasks/${id}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function jsonRequest(pathname: string, init: RequestInit) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  let body: any = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

let lifecycleSequence = 0;
function lifecycleTask(label: string, targetFiles?: string[], options: { parentId?: string; status?: string; agent?: string } = {}) {
  lifecycleSequence += 1;
  const id = `lifecycle-${label}-${lifecycleSequence}`;
  const focusedTargets = targetFiles || [`src/${label}-${lifecycleSequence}.ts`];
  const now = new Date().toISOString();
  const value = {
    id,
    displayId: `LIFE-${String(lifecycleSequence).padStart(4, '0')}`,
    title: label,
    description: 'User explicitly asked to execute this lifecycle route regression fixture.',
    reasoning: 'User explicitly asked to execute this focused lifecycle regression task.',
    repoContext: `Implementation map:\n- File: ${focusedTargets[0]}\n- Class/function: lifecycle route regression\n- Current behavior: status writers may drift claim and execution ownership.\n- Expected change: use the coordinated lifecycle disposition boundary.`,
    projectId: project.id,
    status: options.status || 'todo',
    priority: 'medium',
    category: 'backend',
    tags: [],
    targetFiles: focusedTargets,
    checklist: [],
    parentId: options.parentId,
    agent: options.agent,
    branch: 'develop',
    verificationEvidence: [],
    createdAt: now,
    updatedAt: now,
    logs: [],
    bugs: [],
    images: [],
  } as any;
  saveTask(value);
  return id;
}

function claimLifecycleTask(id: string, sessionId = `session-${id}`) {
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

test('manual DONE accepts quality debt without confirmation, override, or recovery disposition', async () => {
  const result = await post('manual-debt-done', { status: 'done' }, 'move-to');
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.task.status, 'done');
  assert.deepEqual(result.body.bypassedBlockers, []);
  const persisted = getTask('manual-debt-done');
  assert.ok(persisted);
  assert.equal((persisted?.logs || []).some((entry: any) => /\[recovery-disposition\]/.test(entry.message)), false);
  const warningCodes = new Set(buildTaskGitWarnings(persisted).map((entry: any) => entry.code));
  assert.ok(warningCodes.has('DONE_CHECKLIST_DEBT'));
  assert.ok(warningCodes.has('DONE_VERIFICATION_MISSING'));
  assert.ok(warningCodes.has('DONE_GIT_EVIDENCE_MISSING'));
});

test('manual ready-for-review move can coexist with quality debt without an escape hatch', async () => {
  const result = await post('manual-debt-ready', { status: 'ready-for-review', intent: 'manual' });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.task.status, 'ready-for-review');
  assert.equal(result.body.autoWorkTrigger, null);
  assert.deepEqual(result.body.bypassedBlockers, []);
});

test('active agent ownership stays a hard blocker even with manualOverride', async () => {
  const result = await post('manual-hard', { status: 'ready-for-review', intent: 'manual', manualOverride: true });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, 'MOVE_HARD_BLOCKED');
  assert.equal(result.body.blockers[0].code, 'ACTIVE_AGENT_LOCK');
  assert.equal(getTask('manual-hard')?.status, 'in-progress');
});

test('default API move does not turn quality debt into lifecycle authority', async () => {
  const result = await post('strict-default', { status: 'ready-for-review' });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.task.status, 'ready-for-review');
  assert.deepEqual(result.body.bypassedBlockers, []);
});
test('move tool contract exposes structured recoveryDisposition for manual DONE recovery', async () => {
  const { getToolDefinitionByName } = await import('../../src/server/contracts/devflowContract.js');
  for (const name of ['move_task_status', 'move_task_to_status']) {
    const schema = getToolDefinitionByName(name)?.inputSchema?.properties?.recoveryDisposition;
    assert.equal(schema?.type, 'object');
    assert.deepEqual(schema?.properties?.classification?.enum, ['confirmed-missing', 'recoverable-workspace', 'implemented-metadata-drift', 'superseded', 'follow-up']);
    assert.ok(schema?.required?.includes('classification'));
    assert.ok(schema?.required?.includes('summary'));
  }
});

test('move-to reaches DONE with quality debt and no manual recovery ceremony', async () => {
  const result = await post('manual-path', { status: 'done' }, 'move-to');
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.task.status, 'done');
  assert.equal(result.body.autoWorkTrigger, null);
  assert.ok(Array.isArray(result.body.path));
  assert.deepEqual(result.body.bypassedBlockers, []);
  const persisted = getTask('manual-path');
  assert.equal((persisted?.logs || []).some((entry: any) => /\[recovery-disposition\]/.test(entry.message)), false);
});

test('claimed manual move disposes execution ownership before leaving in-progress', async () => {
  const id = lifecycleTask('claimed-manual');
  claimLifecycleTask(id);
  const execution = activeExecution(id);
  assert.ok(execution);

  const result = await post(id, { status: 'todo', emergency: true });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(getTask(id)?.status, 'todo');
  assert.equal(getTask(id)?.claim, undefined);
  assert.equal(activeExecution(id), null);
  assert.equal(listExecutionSessionsForTask(id).find((entry: any) => entry.id === execution!.id)?.status, 'cancelled');
});

test('direct and list task updates route status exits through lifecycle disposition', async () => {
  for (const mode of ['direct', 'list'] as const) {
    const id = lifecycleTask(`update-${mode}`);
    claimLifecycleTask(id);
    const execution = activeExecution(id);
    assert.ok(execution);
    const result = mode === 'direct'
      ? await jsonRequest(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'todo', emergency: true }) })
      : await jsonRequest('/api/tasks', { method: 'PUT', body: JSON.stringify([{ id, status: 'todo', emergency: true }]) });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(getTask(id)?.status, 'todo');
    assert.equal(getTask(id)?.claim, undefined);
    assert.equal(activeExecution(id), null);
    assert.equal(listExecutionSessionsForTask(id).find((entry: any) => entry.id === execution!.id)?.status, 'cancelled');
  }
});

test('batch move routes claimed task through the same lifecycle disposition', async () => {
  const id = lifecycleTask('batch-move');
  claimLifecycleTask(id);
  const execution = activeExecution(id);
  assert.ok(execution);
  const result = await jsonRequest('/api/tasks/batch/move', {
    method: 'POST',
    body: JSON.stringify({ moves: [{ taskId: id, status: 'todo', emergency: true }] }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.results?.[0]?.success, true, JSON.stringify(result.body));
  assert.equal(getTask(id)?.status, 'todo');
  assert.equal(getTask(id)?.claim, undefined);
  assert.equal(activeExecution(id), null);
  assert.equal(listExecutionSessionsForTask(id).find((entry: any) => entry.id === execution!.id)?.status, 'cancelled');
});

test('submit-review cannot clear claim while leaving execution active', async () => {
  const id = lifecycleTask('submit-review');
  const claimed = claimLifecycleTask(id);
  const execution = activeExecution(id);
  assert.ok(execution);
  const result = await jsonRequest(`/api/tasks/${id}/submit-review`, {
    method: 'POST',
    body: JSON.stringify({
      emergency: true,
      workspaceId: claimed.claim.workspaceId,
      requireCleanTree: false,
      requirePushedHead: false,
      requireBranchMatch: false,
      requireChecklistComplete: false,
      requireVerificationEvidence: false,
    }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(getTask(id)?.status, 'ready-for-review');
  assert.equal(getTask(id)?.claim, undefined);
  assert.equal(activeExecution(id), null);
  assert.equal(listExecutionSessionsForTask(id).find((entry: any) => entry.id === execution!.id)?.status, 'cancelled');
});

test('recursive delete fails before deleting parent or claimed descendant', async () => {
  const parentId = lifecycleTask('delete-parent', ['src/other.ts']);
  const childId = lifecycleTask('delete-child', ['src/shared.ts'], { parentId });
  claimLifecycleTask(childId);
  const result = await jsonRequest(`/api/tasks/${parentId}?emergency=true`, { method: 'DELETE' });
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, 'TASK_DELETE_LIFECYCLE_BLOCKED');
  assert.ok(getTask(parentId));
  assert.ok(getTask(childId)?.claim);
  assert.ok(activeExecution(childId));
});

test('legacy agent cancellation settles its run without stealing Chat lifecycle ownership', async () => {
  const id = lifecycleTask('legacy-cancel', undefined, { agent: 'Codex' });
  const claimed = claimLifecycleTask(id);
  const execution = activeExecution(id);
  assert.ok(execution);
  createAgentRun({ taskId: id, projectId: project.id, agent: 'Codex', model: 'GPT-5.5', effort: 'medium' });

  const result = await jsonRequest(`/api/tasks/${id}/agent-runs/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'test cancellation' }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.cancelledCount > 0);
  assert.equal(getTask(id)?.status, 'in-progress');
  assert.equal(getTask(id)?.claim?.workspaceId, claimed.claim.workspaceId);
  assert.equal(activeExecution(id)?.id, execution!.id);
});

test('emergency move cannot bypass a real running durable operation', async () => {
  const id = lifecycleTask('pending-operation', ['src/pending.ts']);
  const claimed = claimLifecycleTask(id, 'pending-owner-session');
  const execution = activeExecution(id);
  assert.ok(execution);
  const workspace = workspaces.resolveSessionWorkspace(claimed.claim.workspaceId)!;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  jobService.__setToolJobTestRunner('edit_local_files_batch', async (_state: any, _args: any, _logger: any, setCancelFn: (fn: () => void) => void) => {
    setCancelFn(unblock);
    await blocked;
    return { ok: true, status: 'succeeded' };
  });
  const job = jobService.enqueueToolJob(state, 'edit_local_files_batch', {
    projectId: project.id,
    workspaceId: workspace.workspaceId,
    mode: 'apply',
    files: [{ filePath: 'src/pending.ts', edits: [{ type: 'replace', find: 'pending = 1', replaceWith: 'pending = 2' }] }],
    singleFlight: false,
  }, 'repo-command');

  try {
    await waitUntil(() => jobRepo.getJob(job.jobId)?.status === 'running', 'Expected durable job to enter running');
    assert.equal(checkpoints.getLatestExecutionCheckpoint(execution!.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId && entry.status === 'running'), true);
    const result = await post(id, { status: 'todo', emergency: true });
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body?.error?.code, 'TASK_LIFECYCLE_PENDING_OPERATION');
    assert.equal(getTask(id)?.status, 'in-progress');
    assert.equal(getTask(id)?.claim?.workspaceId, workspace.workspaceId);
    assert.equal(activeExecution(id)?.id, execution!.id);
  } finally {
    jobService.cancelToolJob(job.jobId);
    unblock();
    await waitUntil(() => !jobService.getJobMetrics().activeJobs.some((entry: any) => entry.jobId === job.jobId), 'Expected durable job worker to stop');
    jobService.__setToolJobTestRunner('edit_local_files_batch', null);
  }
});
