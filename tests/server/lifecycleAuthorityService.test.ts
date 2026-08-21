import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-lifecycle-authority-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
  fs.writeFileSync(path.join(repoRoot, 'src', `${name}.ts`), `export const ${name} = 1;\n`, 'utf8');
}

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
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { listExecutionSessionEvidence, listExecutionSessionsForTask } = await import('../../src/server/repositories/executionSessionRepository.js');
const claims = await import('../../src/server/services/taskClaimService.js');
const workspaces = await import('../../src/server/services/sessionWorkspaceService.js');
const execution = await import('../../src/server/services/executionSessionService.js');
const checkpoints = await import('../../src/server/services/executionCheckpointService.js');
const authority = await import('../../src/server/services/lifecycleAuthorityService.js');

const project = {
  id: 'project-lifecycle-authority',
  name: 'Lifecycle Authority',
  repoUrl: 'https://example.test/lifecycle-authority.git',
  localPath: repoRoot,
  taskIdPrefix: 'AUTH',
  createdAt: new Date().toISOString(),
};
createProject(project as any);
workspaces.resetSessionWorkspaceRuntimeForTests();

let sequence = 0;
function seedTask(label: string, target: string, options: { status?: string; parentId?: string } = {}) {
  sequence += 1;
  const id = `task-authority-${label}-${sequence}`;
  const now = new Date().toISOString();
  saveTask({
    id,
    displayId: `AUTH-${String(sequence).padStart(4, '0')}`,
    projectId: project.id,
    title: label,
    description: 'Lifecycle authority test fixture.',
    status: options.status || 'todo',
    priority: 'high',
    category: 'backend',
    tags: [],
    targetFiles: [target],
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

function claim(id: string, sessionId = `session-${id}`) {
  return claims.claimTaskForSession(id, { sessionId, ownerKind: 'chat', ownerLabel: `Chat ${id.slice(-4)}` });
}

function activeExecution(id: string) {
  return listExecutionSessionsForTask(id).find((entry: any) => entry.status === 'active') || null;
}

function driftTaskStatus(id: string, status: string) {
  const task = getTask(id)!;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  saveTask(task);
}

test('valid claim and execution remain authoritative when presentation status drifts to todo', () => {
  const id = seedTask('status-drift', 'src/A.ts');
  const claimed = claim(id, 'authority-status-drift');
  const executionBefore = activeExecution(id);
  assert.ok(executionBefore);
  driftTaskStatus(id, 'todo');

  const snapshot = authority.computeLifecycleAuthoritySnapshot(id, { workspaceId: claimed.claim.workspaceId });
  assert.equal(snapshot.task.status, 'todo');
  assert.equal(snapshot.claim.active, true);
  assert.equal(snapshot.execution.current?.id, executionBefore!.id);
  assert.equal(snapshot.mutation.authorized, true);
  assert.equal(snapshot.presentation.expectedStatus, 'in-progress');
  assert.equal(snapshot.classification, 'projection-drift');
  assert.ok(snapshot.softDrift.some((entry: any) => entry.code === 'TASK_STATUS_PROJECTION_DRIFT'));
  assert.deepEqual(snapshot.hardBlockers, []);
});

test('done presentation with live execution and pending operation is not safely terminal', () => {
  const id = seedTask('done-live', 'src/B.ts');
  claim(id, 'authority-done-live');
  const session = activeExecution(id)!;
  checkpoints.recordExecutionPendingOperationReference(session.id, {
    operationId: 'job-authority-running',
    evidenceId: 'evidence-authority-running',
    kind: 'run_project_command',
    status: 'running',
  });
  driftTaskStatus(id, 'done');

  const snapshot = authority.computeLifecycleAuthoritySnapshot(id);
  assert.equal(snapshot.task.status, 'done');
  assert.equal(snapshot.execution.current?.id, session.id);
  assert.equal(snapshot.pending.operationIds.includes('job-authority-running'), true);
  assert.equal(snapshot.finalization.safelyTerminal, false);
  assert.equal(snapshot.mutation.authorized, false);
  assert.ok(snapshot.softDrift.some((entry: any) => entry.code === 'TASK_DONE_WITH_LIVE_EXECUTION'));
  assert.ok(snapshot.softDrift.some((entry: any) => entry.code === 'TASK_PENDING_OPERATIONS'));
});

test('parent in-progress due active child is a valid presentation projection without parent ownership', () => {
  const parentId = seedTask('parent', 'src/C.ts', { status: 'todo' });
  const childId = seedTask('child', 'src/D.ts', { parentId });
  claim(childId, 'authority-child');

  const parent = getTask(parentId)!;
  assert.equal(parent.status, 'in-progress');
  assert.equal(parent.claim, undefined);
  const snapshot = authority.computeLifecycleAuthoritySnapshot(parentId);
  assert.equal(snapshot.parentProjection.activeChildCount, 1);
  assert.equal(snapshot.parentProjection.valid, true);
  assert.equal(snapshot.presentation.expectedStatus, 'in-progress');
  assert.equal(snapshot.mutation.authorized, false);
  assert.equal(snapshot.classification, 'healthy');
  assert.equal(snapshot.softDrift.some((entry: any) => entry.code === 'TASK_STATUS_PROJECTION_DRIFT'), false);
});

test('verification quality and lifecycle stage are debt, not commit authority', () => {
  const id = seedTask('verification', 'src/E.ts');
  const claimed = claim(id, 'authority-verification');
  const binding = execution.getTaskExecutionMutationBinding({ workspaceId: claimed.claim.workspaceId })!;
  execution.recordTaskExecutionContextReady({ workspaceId: claimed.claim.workspaceId }, {
    contextHandle: 'ctx-authority-verification',
    repoRevision: binding.session.repoRevision,
  });
  execution.recordExecutionLifecycleTransition(binding.session.id, {
    toStage: 'implementing',
    reasonCode: 'authority-fixture-implementing',
    evidence: { id: 'authority-fixture-implementing', kind: 'mutation', status: 'completed' },
  });
  fs.writeFileSync(path.join(binding.workspace.root, 'src', 'E.ts'), 'export const E = 2;\n', 'utf8');
  execution.recordExecutionOwnedChanges(binding.session.id, ['src/E.ts'], { repoRoot: binding.workspace.root, source: 'authority-test' });
  const captured = execution.captureExecutionVerificationProvenance(binding.session.id, { repoRoot: binding.workspace.root });
  const requiredChecks = ['focused', 'typecheck'];
  execution.recordExecutionVerificationBatchResult(binding.session.id, {
    repoRoot: binding.workspace.root,
    batchId: 'authority-batch',
    requiredChecks,
    checkId: 'focused',
    status: 'passed',
    captured,
    memberCandidate: { candidateId: 'authority-focused', repoRevision: captured.repoRevision, executionKey: 'authority-focused-key' },
  });

  let snapshot = authority.computeLifecycleAuthoritySnapshot(id, { workspaceId: claimed.claim.workspaceId });
  assert.equal(snapshot.execution.current?.lifecycleStage, 'implementing');
  assert.equal(snapshot.verification.batch?.status, 'pending');
  assert.equal(snapshot.verification.authoritative, false);
  assert.equal(snapshot.commit.ready, true);
  assert.equal(snapshot.commit.reasonCodes.includes('EXECUTION_NOT_COMMIT_READY'), false);
  assert.equal(snapshot.commit.reasonCodes.includes('EXECUTION_VERIFICATION_NOT_AUTHORITATIVE'), false);
  assert.ok(snapshot.guardrails.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE'));

  execution.recordExecutionVerificationBatchResult(binding.session.id, {
    repoRoot: binding.workspace.root,
    batchId: 'authority-batch',
    requiredChecks,
    checkId: 'typecheck',
    status: 'failed',
    captured,
    memberCandidate: { candidateId: 'authority-typecheck', repoRevision: captured.repoRevision, executionKey: 'authority-typecheck-key' },
  });
  snapshot = authority.computeLifecycleAuthoritySnapshot(id, { workspaceId: claimed.claim.workspaceId });
  assert.equal(snapshot.execution.current?.lifecycleStage, 'implementing');
  assert.equal(snapshot.verification.batch?.status, 'failed');
  assert.equal(snapshot.verification.authoritative, false);
  assert.equal(snapshot.commit.ready, true);
  assert.ok(snapshot.guardrails.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_FAILED'));
});

test('multiple active executions fail closed without timestamp-based authority selection', () => {
  const id = seedTask('ambiguous', 'src/F.ts');
  const claimed = claim(id, 'authority-ambiguous');
  const first = activeExecution(id)!;
  const workspace = workspaces.resolveSessionWorkspace(claimed.claim.workspaceId)!;
  const second = execution.createExecutionSession({
    projectId: project.id,
    taskId: id,
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
    ownershipEpochId: claimed.claim.ownershipEpochId,
  });

  const snapshot = authority.computeLifecycleAuthoritySnapshot(id, { workspaceId: workspace.workspaceId });
  assert.equal(snapshot.execution.activeSessionIds.includes(first.id), true);
  assert.equal(snapshot.execution.activeSessionIds.includes(second.id), true);
  assert.equal(snapshot.execution.current, null);
  assert.equal(snapshot.mutation.authorized, false);
  assert.equal(snapshot.classification, 'ambiguous');
  assert.ok(snapshot.hardBlockers.some((entry: any) => entry.code === 'MULTIPLE_ACTIVE_EXECUTIONS'));
});

test('same task active across workspaces is bounded ambiguity and never selects a timestamp winner', () => {
  const id = seedTask('cross-workspace', 'src/H.ts');
  const claimed = claim(id, 'authority-cross-workspace');
  const first = activeExecution(id)!;
  const secondWorkspace = workspaces.createOrReuseSessionWorkspace(project, 'authority-cross-workspace-foreign');
  const second = execution.createExecutionSession({
    projectId: project.id,
    taskId: id,
    workspaceId: secondWorkspace.workspaceId,
    repoRoot: secondWorkspace.root,
    branch: secondWorkspace.branch,
    ownershipEpochId: claimed.claim.ownershipEpochId,
  });

  const snapshot = authority.computeLifecycleAuthoritySnapshot(id, { workspaceId: claimed.claim.workspaceId });
  assert.equal(snapshot.execution.activeSessionIds.includes(first.id), true);
  assert.equal(snapshot.execution.activeSessionIds.includes(second.id), true);
  assert.equal(snapshot.execution.activeWorkspaceIds.length, 2);
  assert.equal(snapshot.execution.current, null);
  assert.equal(snapshot.classification, 'ambiguous');
  assert.ok(snapshot.hardBlockers.some((entry: any) => entry.code === 'TASK_ACTIVE_ACROSS_WORKSPACES'));
});

test('claim and execution ownership epoch mismatch is a hard identity conflict', () => {
  const id = seedTask('epoch-mismatch', 'src/I.ts');
  const claimed = claim(id, 'authority-epoch-mismatch');
  const original = activeExecution(id)!;
  execution.cancelExecutionSession(original.id);
  const workspace = workspaces.resolveSessionWorkspace(claimed.claim.workspaceId)!;
  const replacement = execution.createExecutionSession({
    projectId: project.id,
    taskId: id,
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
    ownershipEpochId: 'claim-epoch-mismatched-authority',
  });

  const snapshot = authority.computeLifecycleAuthoritySnapshot(id, { workspaceId: workspace.workspaceId });
  assert.deepEqual(snapshot.execution.activeSessionIds, [replacement.id]);
  assert.equal(snapshot.execution.current, null);
  assert.equal(snapshot.classification, 'hard-conflict');
  assert.ok(snapshot.hardBlockers.some((entry: any) => entry.code === 'OWNERSHIP_EPOCH_MISMATCH'));
  assert.equal(listExecutionSessionsForTask(id).find((entry: any) => entry.id === replacement.id)?.status, 'active');
});

test('authority computation is read-only for task, execution evidence, workspace bytes and Git state', () => {
  const id = seedTask('readonly', 'src/G.ts');
  const claimed = claim(id, 'authority-readonly');
  const session = activeExecution(id)!;
  const workspace = workspaces.resolveSessionWorkspace(claimed.claim.workspaceId)!;
  const taskBefore = JSON.stringify(getTask(id));
  const sessionBefore = JSON.stringify(listExecutionSessionsForTask(id));
  const evidenceBefore = JSON.stringify(listExecutionSessionEvidence(session.id));
  const bytesBefore = fs.readFileSync(path.join(workspace.root, 'src', 'G.ts'), 'utf8');
  const gitBefore = git(['status', '--porcelain=v1']);

  const observedAt = new Date('2026-08-20T01:00:00.000Z');
  const first = authority.computeLifecycleAuthoritySnapshot(id, { workspaceId: workspace.workspaceId, now: observedAt });
  const second = authority.computeLifecycleAuthoritySnapshot(id, { workspaceId: workspace.workspaceId, now: observedAt });
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(getTask(id)), taskBefore);
  assert.equal(JSON.stringify(listExecutionSessionsForTask(id)), sessionBefore);
  assert.equal(JSON.stringify(listExecutionSessionEvidence(session.id)), evidenceBefore);
  assert.equal(fs.readFileSync(path.join(workspace.root, 'src', 'G.ts'), 'utf8'), bytesBefore);
  assert.equal(git(['status', '--porcelain=v1']), gitBefore);
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
