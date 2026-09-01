import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-emergency-orphan-cleanup-'));
const repoRoot = path.join(tempRoot, 'repo');
fs.mkdirSync(repoRoot, { recursive: true });
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_APP_ROOT = tempRoot;

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.test']);
fs.writeFileSync(path.join(repoRoot, 'base.txt'), 'base\n', 'utf8');
git(['add', '.']);
git(['commit', '-m', 'base']);
git(['branch', '-M', 'develop']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTask } = await import('../../src/server/repositories/taskRepository.js');
const {
  createExecutionSessionRecord,
  getExecutionSessionById,
  listExecutionSessionEvidence,
  queryExecutionSessions,
} = await import('../../src/server/repositories/executionSessionRepository.js');
const { recordExecutionPendingOperationReference, reconcileExecutionPendingOperationReference } = await import('../../src/server/services/executionCheckpointService.js');
const { evaluateLifecycleTaskSlo } = await import('../../src/server/services/performanceSloService.js');
const sessionWorkspaces = await import('../../src/server/services/sessionWorkspaceService.js');
const {
  cleanupOrphanExecutions,
  __setEmergencyOrphanCleanupFaultAfterForTests,
} = await import('../../src/server/services/emergencyOrphanCleanupService.js');

const projectId = 'project-emergency-orphan-cleanup';
const otherProjectId = 'project-emergency-orphan-cleanup-other';
createProject({ id: projectId, name: 'Emergency Orphan Cleanup', repoUrl: 'https://example.test/orphan.git', localPath: repoRoot });
createProject({ id: otherProjectId, name: 'Emergency Orphan Cleanup Other', repoUrl: 'https://example.test/orphan-other.git', localPath: repoRoot });
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
function managedWorkspace(task: any, label: string) {
  return sessionWorkspaces.createOrReuseSessionWorkspace(
    { id: task.projectId, localPath: repoRoot },
    `orphan-cleanup-${label}-${seq}`,
    { taskDisplayId: task.displayId },
  );
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
  const safeWorkspace = managedWorkspace(safeTask, 'safe');
  const safe = seedExecution('safe', safeTask.id, safeWorkspace.workspaceId);

  const liveTask = seedTask('live-claim', {
    claim: { sessionIdHash: 'livehash', workspaceId: 'ws-live', ownerKind: 'chat', ownerLabel: 'Live', claimedAt: now(), expiresAt: now(60_000) },
  });
  const live = seedExecution('live-claim', liveTask.id, 'ws-live');

  const malformedTask = seedTask('malformed-claim', { claim: { workspaceId: 'ws-malformed' } });
  const malformed = seedExecution('malformed-claim', malformedTask.id, 'ws-malformed');

  const pendingTask = seedTask('pending');
  const pendingWorkspace = managedWorkspace(pendingTask, 'pending');
  const pending = seedExecution('pending', pendingTask.id, pendingWorkspace.workspaceId);
  recordExecutionPendingOperationReference(pending.id, { operationId: 'job-pending', evidenceId: 'evidence-pending', kind: 'repo-command', status: 'running' });

  const missingTaskId = seedExecution('missing-task-id', null, 'ws-missing-task');
  const missingWorkspaceTask = seedTask('missing-workspace');
  const missingWorkspace = seedExecution('missing-workspace', missingWorkspaceTask.id, null);

  const crossProjectTask = seedTask('cross-project', { projectId: otherProjectId });
  const crossProject = seedExecution('cross-project', crossProjectTask.id, 'ws-cross', { projectId });

  const duplicateTask = seedTask('duplicate-task');
  const duplicateTaskWorkspace = managedWorkspace(duplicateTask, 'duplicate-task');
  const duplicateTaskA = seedExecution('duplicate-task-a', duplicateTask.id, duplicateTaskWorkspace.workspaceId);
  const duplicateTaskB = seedExecution('duplicate-task-b', duplicateTask.id, duplicateTaskWorkspace.workspaceId);

  const duplicateWorkspaceTaskA = seedTask('duplicate-workspace-a');
  const duplicateWorkspaceTaskB = seedTask('duplicate-workspace-b');
  const duplicateWorkspace = managedWorkspace(duplicateWorkspaceTaskA, 'duplicate-workspace');
  const duplicateWorkspaceA = seedExecution('duplicate-workspace-a', duplicateWorkspaceTaskA.id, duplicateWorkspace.workspaceId);
  const duplicateWorkspaceB = seedExecution('duplicate-workspace-b', duplicateWorkspaceTaskB.id, duplicateWorkspace.workspaceId);

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

test('expired claim converges as safe orphan while preserving task metadata', () => {
  const task = seedTask('expired-claim', { status: 'done' });
  const workspace = managedWorkspace(task, 'expired-claim');
  const persisted = getTask(task.id)!;
  persisted.claim = {
    sessionIdHash: 'expired-session',
    workspaceId: workspace.workspaceId,
    ownerKind: 'chat',
    ownerLabel: 'Expired owner',
    claimedAt: now(-120_000),
    expiresAt: now(-60_000),
  } as any;
  saveTask(persisted);
  const execution = seedExecution('expired-claim', task.id, workspace.workspaceId);

  const result = cleanupOrphanExecutions(applyInput('expired-claim-op'));
  assert.equal(result.cancelledCount, 1);
  assert.equal(getExecutionSessionById(execution.id)?.status, 'cancelled');
  assert.equal(getTask(task.id)?.status, 'done');
  assert.equal(getTask(task.id)?.claim?.workspaceId, workspace.workspaceId);
});

test('retained claim with stale execution liveness is recoverable without deleting claim or workspace', () => {
  const task = seedTask('stale-retained-claim');
  const workspace = managedWorkspace(task, 'stale-retained-claim');
  const staleAt = now(-31 * 60_000);
  const persisted = getTask(task.id)!;
  persisted.claim = {
    sessionIdHash: 'stale-retained-session',
    workspaceId: workspace.workspaceId,
    ownerKind: 'chat',
    ownerLabel: 'Timed Out Worker',
    claimedAt: staleAt,
    expiresAt: now(23 * 60 * 60_000),
  } as any;
  saveTask(persisted);
  const execution = seedExecution('stale-retained-claim', task.id, workspace.workspaceId, { updatedAt: staleAt });

  const result = cleanupOrphanExecutions(applyInput('stale-retained-claim-op'));
  const candidate = result.candidates.find((entry: any) => entry.executionSessionId === execution.id);
  assert.equal(candidate?.classification, 'safe');
  assert.equal(candidate?.reasonCode, 'SAFE_ORPHAN');
  assert.equal(result.cancelledCount, 1);
  assert.equal(getExecutionSessionById(execution.id)?.status, 'cancelled');
  assert.equal(getTask(task.id)?.claim?.workspaceId, workspace.workspaceId);
  assert.equal(fs.existsSync(workspace.root), true);
});

test('missing managed workspace root is reported and preserved', () => {
  const task = seedTask('missing-root');
  const workspace = managedWorkspace(task, 'missing-root');
  const execution = seedExecution('missing-root', task.id, workspace.workspaceId);
  fs.rmSync(workspace.root, { recursive: true, force: true });

  const result = cleanupOrphanExecutions(applyInput('missing-root-op'));
  const candidate = result.candidates.find((entry: any) => entry.executionSessionId === execution.id);
  assert.equal(candidate?.classification, 'skipped');
  assert.equal(candidate?.reasonCode, 'INVALID_WORKSPACE_AUTHORITY');
  assert.equal(getExecutionSessionById(execution.id)?.status, 'active');
});

test('canonical cleanup preserves claimless dirty managed workspace WIP', () => {
  const task = seedTask('recoverable-wip');
  const workspace = managedWorkspace(task, 'recoverable-wip');
  const execution = seedExecution('recoverable-wip', task.id, workspace.workspaceId);
  fs.writeFileSync(path.join(workspace.root, 'base.txt'), 'dirty wip\n', 'utf8');

  const result = cleanupOrphanExecutions(applyInput('recoverable-wip-op'));
  const candidate = result.candidates.find((entry: any) => entry.executionSessionId === execution.id);

  assert.equal(candidate?.classification, 'skipped');
  assert.equal(candidate?.reasonCode, 'RECOVERABLE_WIP');
  assert.equal(getExecutionSessionById(execution.id)?.status, 'active');
  assert.equal(fs.readFileSync(path.join(workspace.root, 'base.txt'), 'utf8'), 'dirty wip\n');
});

test('apply cancels only safe orphan executions, preserves task state, and records deterministic audit evidence', () => {
  const task = seedTask('apply-safe');
  const workspace = managedWorkspace(task, 'apply-safe');
  const execution = seedExecution('apply-safe', task.id, workspace.workspaceId);
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
    const workspace = managedWorkspace(task, `replay-${index}`);
    sessions.push(seedExecution(`replay-${index}`, task.id, workspace.workspaceId, { updatedAt: now(index) }));
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
  const continuation = cleanupOrphanExecutions(applyInput('bounded-replay-next-op', { limit: 2 }));
  assert.equal(continuation.cancelledCount, 1);
  assert.equal(sessions.filter((entry) => getExecutionSessionById(entry.id)?.status === 'active').length, 0);
});

test('bounded migration scans past skipped rows so later safe orphans can converge', () => {
  const safeTask = seedTask('paged-safe');
  const safeWorkspace = managedWorkspace(safeTask, 'paged-safe');
  const safe = seedExecution('paged-safe', safeTask.id, safeWorkspace.workspaceId, { updatedAt: now(-1_000) });

  const blockedTask = seedTask('paged-blocked', { claim: { workspaceId: 'ws-malformed' } });
  const blocked = seedExecution('paged-blocked', blockedTask.id, 'ws-malformed', { updatedAt: now(1_000) });

  const result = cleanupOrphanExecutions(applyInput('paged-safe-op', { limit: 1 }));
  assert.equal(result.cancelledCount, 1);
  assert.equal(getExecutionSessionById(safe.id)?.status, 'cancelled');
  assert.equal(getExecutionSessionById(blocked.id)?.status, 'active');
  assert.equal(result.candidates.some((entry: any) => entry.executionSessionId === blocked.id && entry.classification === 'skipped'), true);
  assert.equal(result.scannedCount >= 2, true);
});

test('long-lived deterministic cleanup soak converges 200 cycles without safe-orphan accumulation', () => {
  const pool = Array.from({ length: 4 }, (_, index) => {
    const task = seedTask(`soak-${index}`, { status: 'done' });
    const workspace = managedWorkspace(task, `soak-${index}`);
    return { task, workspace };
  });
  const unrelatedTask = seedTask('soak-unrelated', { projectId: otherProjectId, status: 'done' });
  const unrelatedWorkspace = managedWorkspace(unrelatedTask, 'soak-unrelated');
  const unrelatedExecution = seedExecution('soak-unrelated', unrelatedTask.id, unrelatedWorkspace.workspaceId, { projectId: otherProjectId });

  let cleanupOverheadMs = 0;
  let replayCount = 0;
  let pendingPreservedCount = 0;
  const cycleCount = 200;
  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    const slot = pool[cycle % pool.length];
    const execution = seedExecution(`soak-cycle-${cycle}`, slot.task.id, slot.workspace.workspaceId, { updatedAt: now(cycle) });
    if (cycle % 40 === 0) {
      const pendingId = `soak-pending-${cycle}`;
      recordExecutionPendingOperationReference(execution.id, {
        operationId: pendingId,
        evidenceId: `evidence-${pendingId}`,
        kind: 'repo-command',
        status: 'running',
      });
      const blocked = cleanupOrphanExecutions(applyInput(`soak-blocked-${cycle}`, { limit: 1 }));
      assert.equal(blocked.cancelledCount, 0);
      assert.equal(getExecutionSessionById(execution.id)?.status, 'active');
      reconcileExecutionPendingOperationReference(execution.id, pendingId);
      pendingPreservedCount += 1;
    }

    const operationId = `soak-apply-${cycle}`;
    const startedAt = Date.now();
    const applied = cleanupOrphanExecutions(applyInput(operationId, { limit: 1 }));
    cleanupOverheadMs += Date.now() - startedAt;
    assert.equal(applied.cancelledCount, 1);
    assert.equal(getExecutionSessionById(execution.id)?.status, 'cancelled');

    if (cycle % 25 === 0) {
      const replay = cleanupOrphanExecutions(applyInput(operationId, { limit: 1 }));
      assert.equal(replay.replayed, true);
      assert.equal(replay.cancelledCount, 1);
      replayCount += 1;
    }
  }

  const finalDryRun = cleanupOrphanExecutions({ ...applyInput('soak-final-dry-run'), mode: 'dry-run' });
  assert.equal(finalDryRun.safeCount, 0);
  assert.equal(queryExecutionSessions({ projectId, status: 'active', limit: 100 }).total, 0);
  assert.equal(getExecutionSessionById(unrelatedExecution.id)?.status, 'active');

  const slo = evaluateLifecycleTaskSlo({
    taskId: 'DVF-0720-soak',
    outcome: 'succeeded',
    path: 'recovery',
    phaseDurationsMs: { cleanupOrchestration: cleanupOverheadMs },
    ownershipRotationsAfterInitialClaim: 0,
    reclaims: 0,
    automaticReconciliations: cycleCount,
    emergencyOperations: cycleCount,
    finalizationAttempts: 0,
    finalizationRetries: 0,
    cleanupPendingCount: 0,
    authoritativeTerminalOutcomes: 1,
    currentAuthorityCount: 0,
    duplicateSideEffects: 0,
    unauthorizedWipLossCount: 0,
    unrecoverableSoftStateCount: 0,
    unresolvedWriterCount: 0,
    visibleWriterBlockerCount: 0,
  });
  assert.equal(slo.status, 'within_slo');
  assert.equal(Number.isFinite(cleanupOverheadMs), true);
  console.log(`[lifecycle-soak] cycles=${cycleCount} pendingPreserved=${pendingPreservedCount} responseLossReplays=${replayCount} cleanupOverheadMs=${cleanupOverheadMs}`);
});

test('explicit destructive cleanup cancels only stale missing-workspace authority, including duplicate executions and deleted tasks', () => {
  const duplicateTask = seedTask('destructive-duplicate', { status: 'done' });
  const workspaceA = managedWorkspace(duplicateTask, 'destructive-duplicate-a');
  const execA = seedExecution('destructive-duplicate-a', duplicateTask.id, workspaceA.workspaceId);
  const missingWorkspaceId = `ws-destructive-missing-${seq}`;
  const execB = seedExecution('destructive-duplicate-b', duplicateTask.id, missingWorkspaceId);
  fs.rmSync(workspaceA.root, { recursive: true, force: true });

  const deletedTask = seedTask('destructive-deleted-task', { status: 'done' });
  const deletedWorkspace = managedWorkspace(deletedTask, 'destructive-deleted-task');
  const deletedExec = seedExecution('destructive-deleted-task', deletedTask.id, deletedWorkspace.workspaceId);
  fs.rmSync(deletedWorkspace.root, { recursive: true, force: true });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(deletedTask.id);

  const normal = cleanupOrphanExecutions({ ...applyInput('destructive-normal'), mode: 'dry-run' });
  assert.equal(normal.safeCount, 0);
  assert.equal(normal.candidates.find((entry: any) => entry.executionSessionId === execA.id)?.reasonCode, 'INVALID_WORKSPACE_AUTHORITY');
  assert.equal(normal.candidates.find((entry: any) => entry.executionSessionId === deletedExec.id)?.reasonCode, 'TASK_NOT_FOUND');

  const result = cleanupOrphanExecutions({ ...applyInput('destructive-apply'), destructiveAck: true } as any);
  assert.equal(result.cancelledCount, 3);
  assert.equal(result.safeCount, 3);
  for (const execution of [execA, execB, deletedExec]) {
    assert.equal(getExecutionSessionById(execution.id)?.status, 'cancelled', execution.id);
    const evidence = listExecutionSessionEvidence(execution.id);
    assert.equal(evidence.some((entry: any) => entry.kind === 'lifecycle-reconciliation' && entry.metadata?.reasonCode === 'emergency-orphan-cleanup'), true);
  }
});

test('apply is transactional: injected failure rolls back cancellation and audit evidence', () => {
  const taskA = seedTask('atomic-a');
  const taskB = seedTask('atomic-b');
  const workspaceA = managedWorkspace(taskA, 'atomic-a');
  const workspaceB = managedWorkspace(taskB, 'atomic-b');
  const execA = seedExecution('atomic-a', taskA.id, workspaceA.workspaceId);
  const execB = seedExecution('atomic-b', taskB.id, workspaceB.workspaceId);

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
