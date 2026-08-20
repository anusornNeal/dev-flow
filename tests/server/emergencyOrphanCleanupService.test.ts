import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-emergency-orphan-cleanup-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTask } = await import('../../src/server/repositories/taskRepository.js');
const {
  createExecutionSessionRecord,
  getExecutionSessionById,
  listExecutionSessionEvidence,
} = await import('../../src/server/repositories/executionSessionRepository.js');
const { recordExecutionPendingOperationReference } = await import('../../src/server/services/executionCheckpointService.js');
const {
  cleanupOrphanExecutions,
  __setEmergencyOrphanCleanupFaultAfterForTests,
} = await import('../../src/server/services/emergencyOrphanCleanupService.js');

const projectId = 'project-emergency-orphan-cleanup';
const otherProjectId = 'project-emergency-orphan-cleanup-other';
createProject({ id: projectId, name: 'Emergency Orphan Cleanup', repoUrl: 'https://example.test/orphan.git', localPath: tempRoot });
createProject({ id: otherProjectId, name: 'Emergency Orphan Cleanup Other', repoUrl: 'https://example.test/orphan-other.git', localPath: tempRoot });
const { emergencyToolDefinitions } = await import('../../src/server/contracts/devflowEmergencyTools.js');

test.beforeEach(() => {
  db.exec('DELETE FROM execution_session_evidence; DELETE FROM execution_sessions; DELETE FROM tasks;');
  __setEmergencyOrphanCleanupFaultAfterForTests(null);
});

let seq = 0;
function now(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function seedTask(label: string, options: { projectId?: string; claim?: any; status?: string } = {}) {
  seq += 1;
  const id = `task-orphan-${label}-${seq}`;
  const createdAt = now();
  const task = {
    id,
    displayId: `ORP-${seq}`,
    title: `Orphan cleanup ${label}`,
    description: '',
    projectId: options.projectId || projectId,
    status: options.status || 'in-progress',
    priority: 'high',
    category: 'backend',
    tags: [],
    targetFiles: [],
    checklist: [],
    logs: [],
    bugs: [],
    images: [],
    createdAt,
    updatedAt: createdAt,
    ...(options.claim ? { claim: options.claim } : {}),
  } as any;
  saveTask(task);
  return task;
}

function seedExecution(label: string, taskId: string | null, workspaceId: string | null, options: { projectId?: string; updatedAt?: string } = {}) {
  seq += 1;
  const createdAt = now();
  return createExecutionSessionRecord({
    id: `exec-orphan-${label}-${seq}`,
    projectId: options.projectId || projectId,
    taskId,
    workspaceId,
    branch: workspaceId ? `devflow/ws/${workspaceId}` : null,
    baseRevision: 'base',
    repoRevision: 'candidate',
    status: 'active',
    contextHandle: null,
    createdAt,
    updatedAt: options.updatedAt || createdAt,
    expiresAt: now(60 * 60 * 1000),
    endedAt: null,
  });
}

function applyInput(operationId: string, extra: Record<string, unknown> = {}) {
  return {
    projectId,
    operationId,
    mode: 'apply' as const,
    actorLabel: 'Operator Test',
    reason: 'bounded orphan cleanup test',
    limit: 100,
    ...extra,
  };
}

test('dry-run classifies safe and fail-closed orphan cases without mutation', () => {
  const safeTask = seedTask('safe');
  const safe = seedExecution('safe', safeTask.id, 'ws-safe');

  const liveTask = seedTask('live-claim', {
    claim: { sessionIdHash: 'livehash', workspaceId: 'ws-live', ownerKind: 'chat', ownerLabel: 'Live', claimedAt: now(), expiresAt: now(60_000) },
  });
  const live = seedExecution('live-claim', liveTask.id, 'ws-live');

  const malformedTask = seedTask('malformed-claim', { claim: { workspaceId: 'ws-malformed' } });
  const malformed = seedExecution('malformed-claim', malformedTask.id, 'ws-malformed');

  const pendingTask = seedTask('pending');
  const pending = seedExecution('pending', pendingTask.id, 'ws-pending');
  recordExecutionPendingOperationReference(pending.id, { operationId: 'job-pending', evidenceId: 'evidence-pending', kind: 'repo-command', status: 'running' });

  const missingTaskId = seedExecution('missing-task-id', null, 'ws-missing-task');
  const missingWorkspaceTask = seedTask('missing-workspace');
  const missingWorkspace = seedExecution('missing-workspace', missingWorkspaceTask.id, null);

  const crossProjectTask = seedTask('cross-project', { projectId: otherProjectId });
  const crossProject = seedExecution('cross-project', crossProjectTask.id, 'ws-cross', { projectId });

  const duplicateTask = seedTask('duplicate-task');
  const duplicateTaskA = seedExecution('duplicate-task-a', duplicateTask.id, 'ws-duplicate-task-a');
  const duplicateTaskB = seedExecution('duplicate-task-b', duplicateTask.id, 'ws-duplicate-task-b');

  const duplicateWorkspaceTaskA = seedTask('duplicate-workspace-a');
  const duplicateWorkspaceTaskB = seedTask('duplicate-workspace-b');
  const duplicateWorkspaceA = seedExecution('duplicate-workspace-a', duplicateWorkspaceTaskA.id, 'ws-shared');
  const duplicateWorkspaceB = seedExecution('duplicate-workspace-b', duplicateWorkspaceTaskB.id, 'ws-shared');

  const result = cleanupOrphanExecutions({ ...applyInput('dry-run-matrix'), mode: 'dry-run' });
  const byId = new Map(result.candidates.map((entry: any) => [entry.executionSessionId, entry]));

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.cancelledCount, 0);
  assert.equal(byId.get(safe.id)?.classification, 'safe');
  assert.equal(byId.get(live.id)?.reasonCode, 'ACTIVE_CLAIM');
  assert.equal(byId.get(malformed.id)?.reasonCode, 'MALFORMED_CLAIM');
  assert.equal(byId.get(pending.id)?.reasonCode, 'PENDING_OPERATION');
  assert.equal(byId.get(missingTaskId.id)?.reasonCode, 'TASK_ID_MISSING');
  assert.equal(byId.get(missingWorkspace.id)?.reasonCode, 'WORKSPACE_ID_MISSING');
  assert.equal(byId.get(crossProject.id)?.reasonCode, 'TASK_PROJECT_MISMATCH');
  assert.equal(byId.get(duplicateTaskA.id)?.reasonCode, 'MULTIPLE_ACTIVE_TASK_EXECUTIONS');
  assert.equal(byId.get(duplicateTaskB.id)?.reasonCode, 'MULTIPLE_ACTIVE_TASK_EXECUTIONS');
  assert.equal(byId.get(duplicateWorkspaceA.id)?.reasonCode, 'MULTIPLE_ACTIVE_WORKSPACE_EXECUTIONS');
  assert.equal(byId.get(duplicateWorkspaceB.id)?.reasonCode, 'MULTIPLE_ACTIVE_WORKSPACE_EXECUTIONS');
  for (const id of [safe.id, live.id, malformed.id, pending.id, missingTaskId.id, missingWorkspace.id, crossProject.id, duplicateTaskA.id, duplicateTaskB.id, duplicateWorkspaceA.id, duplicateWorkspaceB.id]) {
    assert.equal(getExecutionSessionById(id)?.status, 'active', id);
  }
});

test('apply cancels only safe orphan executions, preserves task state, and records deterministic audit evidence', () => {
  const task = seedTask('apply-safe');
  const execution = seedExecution('apply-safe', task.id, 'ws-apply-safe');
  const beforeTask = structuredClone(getTask(task.id));

  const result = cleanupOrphanExecutions(applyInput('apply-safe-op'));
  assert.equal(result.cancelledCount, 1);
  assert.equal(result.safeCount, 1);
  assert.equal(getExecutionSessionById(execution.id)?.status, 'cancelled');
  assert.equal(getTask(task.id)?.status, beforeTask?.status);
  assert.deepEqual(getTask(task.id)?.claim || null, beforeTask?.claim || null);

  const evidence = listExecutionSessionEvidence(execution.id);
  const cleanupEvidence = evidence.find((entry: any) => entry.kind === 'lifecycle-reconciliation' && entry.metadata?.reasonCode === 'emergency-orphan-cleanup');
  assert.ok(cleanupEvidence);
  assert.equal(cleanupEvidence?.metadata?.operationId, 'apply-safe-op');
  assert.equal(cleanupEvidence?.metadata?.actorLabel, 'Operator Test');
  assert.equal(cleanupEvidence?.metadata?.reason, 'bounded orphan cleanup test');
});

test('same apply operation id replays its frozen result and never sweeps the next bounded batch', () => {
  const sessions: any[] = [];
  for (let index = 0; index < 3; index += 1) {
    const task = seedTask(`replay-${index}`);
    sessions.push(seedExecution(`replay-${index}`, task.id, `ws-replay-${index}`, { updatedAt: now(index) }));
  }

  const request = applyInput('bounded-replay-op', { limit: 2 });
  const first = cleanupOrphanExecutions(request as any);
  assert.equal(first.cancelledCount, 2);
  assert.equal(first.truncated, true);
  const stillActiveAfterFirst = sessions.filter((entry) => getExecutionSessionById(entry.id)?.status === 'active').map((entry) => entry.id);
  assert.equal(stillActiveAfterFirst.length, 1);

  const replay = cleanupOrphanExecutions(request as any);
  assert.equal(replay.replayed, true);
  assert.equal(replay.cancelledCount, 2);
  assert.deepEqual(sessions.filter((entry) => getExecutionSessionById(entry.id)?.status === 'active').map((entry) => entry.id), stillActiveAfterFirst);

  assert.throws(
    () => cleanupOrphanExecutions({ ...(request as any), reason: 'different request under same operation id' }),
    (error: any) => error?.code === 'EMERGENCY_ORPHAN_CLEANUP_OPERATION_CONFLICT' || error?.payload?.code === 'EMERGENCY_ORPHAN_CLEANUP_OPERATION_CONFLICT',
  );
});

test('apply is transactional: injected failure rolls back cancellation and audit evidence', () => {
  const taskA = seedTask('atomic-a');
  const taskB = seedTask('atomic-b');
  const execA = seedExecution('atomic-a', taskA.id, 'ws-atomic-a');
  const execB = seedExecution('atomic-b', taskB.id, 'ws-atomic-b');

  __setEmergencyOrphanCleanupFaultAfterForTests(1);
  assert.throws(() => cleanupOrphanExecutions(applyInput('atomic-op')), /Injected emergency orphan cleanup fault/);
  __setEmergencyOrphanCleanupFaultAfterForTests(null);

  assert.equal(getExecutionSessionById(execA.id)?.status, 'active');
  assert.equal(getExecutionSessionById(execB.id)?.status, 'active');
  assert.equal(listExecutionSessionEvidence(execA.id).some((entry: any) => entry.metadata?.operationId === 'atomic-op'), false);
  assert.equal(listExecutionSessionEvidence(execB.id).some((entry: any) => entry.metadata?.operationId === 'atomic-op'), false);
});test('cleanup orphan execution contract exposes one explicit bounded dry-run/apply mutation route', () => {
  const tool = emergencyToolDefinitions.find((entry) => entry.name === 'cleanup_orphan_executions');
  assert.ok(tool);
  const schema = tool!.inputSchema as any;
  for (const field of ['projectId', 'operationId', 'mode', 'actorLabel', 'reason']) assert.ok(schema.required.includes(field), field);
  assert.deepEqual(schema.properties.mode.enum, ['dry-run', 'apply']);
  assert.equal(schema.properties.limit.maximum, 100);
  assert.equal(tool!.buildHttpRequest({ projectId, operationId: 'op', mode: 'dry-run', actorLabel: 'operator', reason: 'inspect' }).path, '/api/lifecycle/orphan-executions/cleanup');
  const routeSource = fs.readFileSync('src/server/routes/devflow.ts', 'utf8');
  assert.match(routeSource, /\/api\/lifecycle\/orphan-executions\/cleanup/);
});
