import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-external-status-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { createExecutionSessionRecord, listExecutionSessionsForTask } = await import('../../src/server/repositories/executionSessionRepository.js');
const { updateExternalTaskStatus } = await import('../../src/server/services/externalTaskStatusService.js');

const project = {
  id: 'project-external-status',
  name: 'External status',
  repoUrl: 'https://example.test/external-status.git',
  localPath: tempRoot,
  taskIdPrefix: 'EXT',
  createdAt: new Date().toISOString(),
};
createProject(project as any);
const state: any = { countersCache: {}, projectsCache: [project], skillsRegistry: [] };

let sequence = 0;
function seedTask(status = 'backlog', patch: Record<string, any> = {}) {
  sequence += 1;
  const id = `external-status-${sequence}`;
  const now = new Date().toISOString();
  const value = {
    id,
    displayId: `EXT-${String(sequence).padStart(4, '0')}`,
    projectId: project.id,
    title: id,
    description: 'External status route fixture',
    status,
    priority: 'medium',
    category: 'backend',
    tags: [],
    targetFiles: [`src/${id}.ts`],
    checklist: [{ id: 'check-1', text: 'managed checklist', completed: false }],
    verificationEvidence: [{ command: 'managed verify', status: 'passed', recordedAt: now }],
    gitEvidence: {
      branch: 'managed-branch', commit: 'abc123', remote: 'origin', ahead: 1, behind: 0,
      diverged: false, pushed: false, workingTreeClean: false, recordedAt: now,
    },
    bugs: [{
      id: `bug-${sequence}`, taskId: id, title: 'managed bug', status: 'open', source: 'user', severity: 'medium',
      versions: [], createdAt: now, updatedAt: now,
    }],
    images: [],
    logs: [],
    createdAt: now,
    updatedAt: now,
    ...patch,
  } as any;
  saveTask(value);
  return value;
}

function externalLogs(taskId: string) {
  return (getTask(taskId)?.logs || []).filter((entry: any) => String(entry.id || '').startsWith('external-task-status-op-'));
}

function activeExecution(taskId: string) {
  return listExecutionSessionsForTask(taskId).find((entry: any) => entry.status === 'active') || null;
}

function seedActiveExecution(taskId: string) {
  const now = new Date().toISOString();
  const execution = createExecutionSessionRecord({
    id: `exec-${taskId}`,
    projectId: project.id,
    taskId,
    workspaceId: `ws-${taskId}`,
    branch: `branch-${taskId}`,
    baseRevision: 'base-revision',
    repoRevision: 'repo-revision',
    status: 'active',
    contextHandle: 'ctx-managed',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    endedAt: null,
  });
  assert.ok(execution);
  return execution;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server did not bind');
const base = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(taskId: string, body: any) {
  const response = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/external-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = await response.json(); } catch {}
  return { response, body: parsed };
}

test('external status accepts direct status moves without managed transition hops', async () => {
  const cases = [
    ['backlog', 'in-progress'],
    ['backlog', 'done'],
    ['todo', 'ready-for-review'],
    ['ready-for-review', 'in-progress'],
    ['done', 'done'],
  ] as const;

  for (const [source, target] of cases) {
    const task = seedTask(source);
    const result = await post(task.id, { status: target });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.sourceStatus, source);
    assert.equal(result.body.targetStatus, target);
    assert.equal(result.body.changed, source !== target);
    assert.equal(result.body.replayed, false);
    assert.equal(getTask(task.id)?.status, target);
    assert.equal(externalLogs(task.id).length, 1);
  }
});

test('same idempotency key and normalized request replay exactly one durable status/audit effect', async () => {
  const task = seedTask('backlog');
  const key = 'retry-after-response-loss';
  const request = { status: 'done', summary: ' completed ', commit: 'abc123', verification: 'tests passed', idempotencyKey: key };
  const first = await post(task.id, request);
  const second = await post(task.id, { ...request, summary: 'completed' });

  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(second.response.status, 200, JSON.stringify(second.body));
  assert.equal(first.body.replayed, false);
  assert.equal(second.body.replayed, true);
  assert.equal(first.body.operationId, second.body.operationId);  assert.match(first.body.operationId, /^external-task-status-op-/);
  assert.equal(externalLogs(task.id).length, 1);
  const persisted = externalLogs(task.id)[0];
  assert.ok(persisted.message.includes(crypto.createHash('sha256').update(key).digest('hex')));
  assert.equal(persisted.message.includes(key), false, 'raw idempotency key must not be persisted');
});

test('same idempotency key with different payload fails closed without a second mutation', async () => {
  const task = seedTask('backlog');
  const first = await post(task.id, { status: 'in-progress', idempotencyKey: 'same-key' });
  assert.equal(first.response.status, 200);
  const conflict = await post(task.id, { status: 'done', idempotencyKey: 'same-key' });
  assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body?.error?.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(getTask(task.id)?.status, 'in-progress');
  assert.equal(externalLogs(task.id).length, 1);
});

test('concurrent same-key requests converge to one operation and different keys serialize safely', async () => {
  const same = seedTask('backlog');
  const sameResults = await Promise.all([
    post(same.id, { status: 'done', idempotencyKey: 'concurrent-same' }),
    post(same.displayId, { status: 'done', idempotencyKey: 'concurrent-same' }),
  ]);
  assert.ok(sameResults.every((entry) => entry.response.status === 200), JSON.stringify(sameResults.map((entry) => entry.body)));
  assert.equal(externalLogs(same.id).length, 1);
  assert.equal(new Set(sameResults.map((entry) => entry.body.operationId)).size, 1);
  assert.ok(sameResults.some((entry) => entry.body.replayed === true));

  const different = seedTask('backlog');
  const differentResults = await Promise.all([
    post(different.id, { status: 'in-progress', idempotencyKey: 'concurrent-a' }),
    post(different.displayId, { status: 'ready-for-review', idempotencyKey: 'concurrent-b' }),
  ]);
  assert.ok(differentResults.every((entry) => entry.response.status === 200), JSON.stringify(differentResults.map((entry) => entry.body)));
  assert.equal(externalLogs(different.id).length, 2);
  assert.equal(new Set(externalLogs(different.id).map((entry: any) => entry.id)).size, 2);
});

test('fault before task save persists neither status nor replay marker', () => {
  const task = seedTask('backlog');
  assert.throws(() => updateExternalTaskStatus(task.id, { status: 'done', idempotencyKey: 'fault-before-save' }, {
    beforeSave: () => { throw new Error('simulated-before-save'); },
  }), /simulated-before-save/);
  assert.equal(getTask(task.id)?.status, 'backlog');
  assert.equal(externalLogs(task.id).length, 0);
});

test('failure after task save can be retried from durable task state without a second effect', () => {
  const task = seedTask('backlog');
  const request = { status: 'done' as const, summary: 'durable result', idempotencyKey: 'fault-after-save' };
  assert.throws(() => updateExternalTaskStatus(task.id, request, {
    afterSave: () => { throw new Error('simulated-response-failure'); },
  }), /simulated-response-failure/);
  assert.equal(getTask(task.id)?.status, 'done');
  assert.equal(externalLogs(task.id).length, 1);

  const replay = updateExternalTaskStatus(task.id, request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.sourceStatus, 'backlog');
  assert.equal(replay.targetStatus, 'done');
  assert.equal(externalLogs(task.id).length, 1);
});

test('replay authority is persisted in the task record rather than process-memory idempotency state', async () => {
  const task = seedTask('todo');
  const request = { status: 'ready-for-review' as const, idempotencyKey: 'persisted-reload-key' };
  const first = updateExternalTaskStatus(task.id, request);
  assert.equal(first.replayed, false);

  const moduleUrl = new URL('../../src/server/services/externalTaskStatusService.ts', import.meta.url);
  moduleUrl.searchParams.set('reload', `${Date.now()}-${Math.random()}`);
  const reloaded = await import(moduleUrl.href);
  const replay = reloaded.updateExternalTaskStatus(task.id, request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.operationId, first.operationId);
  assert.equal(externalLogs(task.id).length, 1);
});

test('validation rejects unknown task, invalid status, malformed metadata, and oversized metadata before mutation', async () => {
  const missing = await post('missing-task', { status: 'done' });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body?.error?.code, 'TASK_NOT_FOUND');

  const invalid = seedTask('backlog');
  const badStatus = await post(invalid.id, { status: 'todo' });
  assert.equal(badStatus.response.status, 400);
  assert.equal(badStatus.body?.error?.code, 'EXTERNAL_STATUS_INVALID_TARGET');
  assert.equal(getTask(invalid.id)?.status, 'backlog');

  const malformed = await post(invalid.id, { status: 'done', summary: 42 });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body?.error?.code, 'EXTERNAL_STATUS_INVALID_METADATA');
  assert.equal(externalLogs(invalid.id).length, 0);

  const oversized = await post(invalid.id, { status: 'done', summary: 'x'.repeat(4001) });
  assert.equal(oversized.response.status, 400);
  assert.equal(oversized.body?.error?.code, 'EXTERNAL_STATUS_METADATA_TOO_LARGE');
  assert.equal(getTask(invalid.id)?.status, 'backlog');

  const badAction = await post(invalid.id, { status: 'in-progress', action: 'RUN_SHELL' });
  assert.equal(badAction.response.status, 400);
  assert.equal(badAction.body?.error?.code, 'EXTERNAL_STATUS_INVALID_ACTION');

  const missingAction = await post(invalid.id, { status: 'in-progress', resultState: 'BLOCKED' });
  assert.equal(missingAction.response.status, 400);
  assert.equal(missingAction.body?.error?.code, 'EXTERNAL_STATUS_ACTION_REQUIRED');

  const completeMismatch = await post(invalid.id, { status: 'in-progress', action: 'IMPLEMENT_TASK', resultState: 'COMPLETE' });
  assert.equal(completeMismatch.response.status, 400);
  assert.equal(completeMismatch.body?.error?.code, 'EXTERNAL_STATUS_RESULT_STATUS_MISMATCH');

  const attentionMismatch = await post(invalid.id, { status: 'ready-for-review', action: 'RESOLVE_FAILURE', resultState: 'NEEDS_CONTEXT' });
  assert.equal(attentionMismatch.response.status, 400);
  assert.equal(attentionMismatch.body?.error?.code, 'EXTERNAL_STATUS_RESULT_STATUS_MISMATCH');
});

test('empty metadata is omitted and exact maximum metadata is accepted as informational audit data only', async () => {
  const task = seedTask('todo');
  const result = await post(task.id, {
    status: 'done',
    summary: '   ',
    commit: 'c'.repeat(1000),
    verification: 'v'.repeat(8000),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.externalMetadata.summary, undefined);
  assert.equal(result.body.externalMetadata.commit.length, 1000);
  assert.equal(result.body.externalMetadata.verification.length, 8000);

  const saved = getTask(task.id)!;
  assert.deepEqual(saved.gitEvidence, task.gitEvidence);
  assert.deepEqual(saved.verificationEvidence, task.verificationEvidence);
  assert.deepEqual(saved.checklist, task.checklist);
  assert.deepEqual(saved.bugs, task.bugs);
});

test('local-native orchestration metadata is durable, replaceable, and never creates managed execution authority', async () => {
  const task = seedTask('backlog');
  const before = getTask(task.id)!;
  const started = await post(task.id, {
    status: 'in-progress',
    worker: 'Codex Native A',
    action: 'IMPLEMENT_TASK',
    contextRef: 'ctx-native-a',
    summary: 'editing native scope',
  });
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.externalMetadata.worker, 'Codex Native A');
  assert.equal(started.body.externalMetadata.action, 'IMPLEMENT_TASK');
  assert.equal(started.body.externalMetadata.contextRef, 'ctx-native-a');
  assert.equal(listExecutionSessionsForTask(task.id).length, 0, 'native sync must not create managed execution authority');

  const blocked = await post(task.id, {
    status: 'in-progress',
    worker: 'Codex Native A',
    action: 'RESOLVE_FAILURE',
    resultState: 'BLOCKED',
    contextRef: 'ctx-native-blocked',
    summary: 'needs an external decision',
  });
  assert.equal(blocked.response.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.externalMetadata.resultState, 'BLOCKED');

  const completed = await post(task.id, {
    status: 'ready-for-review',
    worker: 'Codex Native B',
    action: 'IMPLEMENT_TASK',
    resultState: 'COMPLETE',
    contextRef: 'ctx-native-replacement',
    summary: 'replacement worker completed repository work',
    commit: 'native-commit',
    verification: 'native tests passed',
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.externalMetadata.worker, 'Codex Native B');
  assert.equal(completed.body.externalMetadata.resultState, 'COMPLETE');
  assert.equal(listExecutionSessionsForTask(task.id).length, 0);

  const after = getTask(task.id)!;
  assert.deepEqual(after.gitEvidence, before.gitEvidence, 'native commit text remains informational');
  assert.deepEqual(after.verificationEvidence, before.verificationEvidence, 'native verification text remains informational');
  assert.equal(externalLogs(task.id).length, 3);
});

test('active managed authority blocks by default without changing status or authority', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const task = seedTask('in-progress', {
    claim: {
      sessionIdHash: 'managed-session', ownershipEpochId: 'managed-epoch', workspaceId: 'managed-workspace',
      ownerKind: 'chat', ownerLabel: 'Managed Chat', claimedAt: new Date().toISOString(), expiresAt,
      reservedPaths: ['src/managed.ts'],
    },
  });
  const execution = seedActiveExecution(task.id);
  const before = getTask(task.id)!;
  const result = await post(task.id, { status: 'done' });

  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, 'EXTERNAL_STATUS_MANAGED_AUTHORITY_CONFLICT');
  const after = getTask(task.id)!;
  assert.equal(after.status, 'in-progress');
  assert.deepEqual(after.claim, before.claim);
  assert.equal(activeExecution(task.id)?.id, execution.id);
  assert.equal(externalLogs(task.id).length, 0);
});

test('explicit overlap override changes only presentation status/audit and preserves exact managed authority and evidence', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const task = seedTask('in-progress', {
    claim: {
      sessionIdHash: 'preserve-session', ownershipEpochId: 'preserve-epoch', workspaceId: 'preserve-workspace',
      ownerKind: 'chat', ownerLabel: 'Preserve Chat', claimedAt: new Date().toISOString(), expiresAt,
      reservedPaths: ['src/preserve.ts'],
    },
  });
  const execution = seedActiveExecution(task.id);
  const before = getTask(task.id)!;
  const executionBefore = activeExecution(task.id)!;

  const result = await post(task.id, {
    status: 'done',
    summary: 'Codex finished repository work externally',
    commit: 'deadbeef',
    verification: 'external tests passed',
    idempotencyKey: 'managed-overlap',
    allowManagedAuthorityOverlap: true,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.warnings?.[0]?.code, 'MANAGED_AUTHORITY_PRESERVED');

  const after = getTask(task.id)!;
  assert.equal(after.status, 'done');
  assert.deepEqual(after.claim, before.claim);
  assert.deepEqual(after.gitEvidence, before.gitEvidence);
  assert.deepEqual(after.verificationEvidence, before.verificationEvidence);
  assert.deepEqual(after.checklist, before.checklist);
  assert.deepEqual(after.bugs, before.bugs);
  const executionAfter = activeExecution(task.id)!;
  assert.equal(executionAfter.id, execution.id);
  assert.deepEqual(executionAfter, executionBefore);
  assert.equal(externalLogs(task.id).length, 1);
});
