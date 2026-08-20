import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-commit-plan-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
const repoRoot = path.join(tempRoot, 'repo');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'owned.ts'), 'export const owned = 1;\n');
fs.writeFileSync(path.join(repoRoot, 'src', 'unrelated.ts'), 'export const unrelated = 1;\n');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

git(repoRoot, ['init']);
git(repoRoot, ['config', 'user.name', 'DevFlow Test']);
git(repoRoot, ['config', 'user.email', 'devflow@example.test']);
git(repoRoot, ['add', '.']);
git(repoRoot, ['commit', '-m', 'base']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { listExecutionSessionsForTask } = await import('../../src/server/repositories/executionSessionRepository.js');
const workspaceService = await import('../../src/server/services/sessionWorkspaceService.js');
const execution = await import('../../src/server/services/executionSessionService.js');
const claims = await import('../../src/server/services/taskClaimService.js');
const commitPlan = await import('../../src/server/services/taskCommitPlanService.js');

function createFixture(label: string, targetFiles: string[] = ['src/owned.ts']) {
  workspaceService.resetSessionWorkspaceRuntimeForTests();
  const projectId = `project-${label}`;
  createProject({
    id: projectId,
    name: projectId,
    repoUrl: `https://example.test/${projectId}.git`,
    localPath: repoRoot,
    taskIdPrefix: 'TCP',
    createdAt: new Date().toISOString(),
  });
  const taskId = `task-${label}`;
  const now = new Date().toISOString();
  saveTask({
    id: taskId,
    displayId: taskId,
    title: taskId,
    description: 'Task-aware commit-plan fixture.',
    projectId,
    status: 'todo',
    priority: 'medium',
    category: 'backend',
    tags: [],
    targetFiles,
    checklist: [],
    createdAt: now,
    updatedAt: now,
    logs: [],
  } as any);
  const claimed = claims.claimTaskForSession(taskId, { sessionId: `session-${label}`, ownerLabel: `Chat ${label}` });
  const workspace = workspaceService.resolveSessionWorkspace(claimed.claim.workspaceId)!;
  const session = listExecutionSessionsForTask(taskId).find((entry: any) => entry.status === 'active')!;
  return { projectId, workspace, taskId, session, claim: claimed.claim };
}

test('commit plan selects only execution-owned changed files and preserves unrelated changes', () => {
  const { workspace, taskId, session } = createFixture('scoped');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 2;\n');
  fs.writeFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'export const unrelated = 2;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: workspace.root });

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.ownedChangedFiles, ['src/owned.ts']);
  assert.deepEqual(plan.unrelatedChangedFiles, ['src/unrelated.ts']);
  assert.equal(plan.verificationFresh, true);
  assert.equal(plan.verificationState, 'authoritative-fresh');
  assert.ok(plan.verificationRecordedAt);

  const committed = commitPlan.commitTaskOwnedChanges({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId, message: 'fix(scope): scoped owned change' });
  assert.deepEqual(committed.committedFiles, ['src/owned.ts']);
  assert.deepEqual(committed.unrelatedChangesPreserved, ['src/unrelated.ts']);
  assert.match(git(workspace.root, ['status', '--porcelain']), /src\/unrelated\.ts/);
  assert.doesNotMatch(git(workspace.root, ['status', '--porcelain']), /src\/owned\.ts/);
  assert.equal(git(workspace.root, ['log', '-1', '--pretty=%s']), '[task-scoped] fix: scoped owned change');
});

test('commit plan matches execution-owned files inside a wholly new nested directory', () => {
  const ownedPath = 'src/generated/region/RegionSummary.kt';
  const { workspace, taskId, session } = createFixture('new-nested', [ownedPath]);
  fs.mkdirSync(path.dirname(path.join(workspace.root, ownedPath)), { recursive: true });
  fs.writeFileSync(path.join(workspace.root, ownedPath), 'class RegionSummary\n');
  execution.recordExecutionOwnedChanges(session.id, [ownedPath], { repoRoot: workspace.root, source: 'task-edit' });
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: workspace.root });

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.ownedChangedFiles, [ownedPath]);
  assert.deepEqual(plan.unrelatedChangedFiles, []);
  assert.deepEqual(plan.scopeDrift, []);
  assert.equal(plan.verificationState, 'authoritative-fresh');
  assert.deepEqual(plan.blockers, []);
});

test('commit plan accepts owned repair drift only when fresh verification covers the current revisions', () => {
  const { workspace, taskId, session } = createFixture('verified-repair');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 10;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 11;\n');

  let ownership = execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root });
  assert.deepEqual(ownership.ownershipDrift.map((entry: any) => entry.path), ['src/owned.ts']);
  assert.equal(ownership.verificationFresh, null);
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'recovery', status: 'passed' }], { repoRoot: workspace.root });

  ownership = execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root });
  assert.equal(ownership.verificationFresh, true);
  assert.deepEqual(ownership.verifiedOwnershipDrift.map((entry: any) => entry.path), ['src/owned.ts']);
  let plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.verifiedOwnershipDrift.map((entry: any) => entry.path), ['src/owned.ts']);
  assert.equal(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'), false);

  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 12;\n');
  plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, false);
  assert.equal(plan.verificationFresh, false);
  assert.deepEqual(plan.verifiedOwnershipDrift, []);
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'));
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH'));
});

test('commit plan distinguishes missing authoritative verification from stale verification', () => {
  const { workspace, taskId, session } = createFixture('missing-verification');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 20;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, false);
  assert.equal(plan.verificationFresh, null);
  assert.equal(plan.verificationState, 'missing');
  assert.equal(plan.verificationRecordedAt, null);
  const blocker = plan.blockers.find((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH');
  assert.equal((blocker?.details as any)?.verificationState, 'missing');
  assert.equal((blocker?.details as any)?.ownershipDriftCount, 0);
});

test('task-level passed verification metadata cannot substitute for execution-bound freshness', () => {
  const { projectId, workspace, taskId, session } = createFixture('task-level-only');
  const now = new Date().toISOString();
  const task = getTask(taskId)!;
  saveTask({
    ...task,
    verificationEvidence: [{ name: 'task-only', command: 'task-only', status: 'passed', recordedAt: now }],
    updatedAt: now,
  } as any);
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 21;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, false);
  assert.equal(plan.verificationState, 'missing');
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH'));
});

test('no owned changes and inactive sessions remain independent commit blockers', () => {
  const empty = createFixture('no-owned');
  execution.recordExecutionVerificationEvidence(empty.session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: empty.workspace.root });
  const emptyPlan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId: empty.taskId, workspaceId: empty.workspace.workspaceId });
  assert.equal(emptyPlan.verificationState, 'authoritative-fresh');
  assert.equal(emptyPlan.commitAllowed, false);
  assert.ok(emptyPlan.blockers.some((entry: any) => entry.code === 'TASK_COMMIT_NO_OWNED_CHANGES'));

  const inactive = createFixture('inactive');
  fs.writeFileSync(path.join(inactive.workspace.root, 'src', 'owned.ts'), 'export const owned = 22;\n');
  execution.recordExecutionOwnedChanges(inactive.session.id, ['src/owned.ts'], { repoRoot: inactive.workspace.root, source: 'task-edit' });
  execution.recordExecutionVerificationEvidence(inactive.session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: inactive.workspace.root });
  execution.completeExecutionSession(inactive.session.id);
  const inactivePlan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId: inactive.taskId, workspaceId: inactive.workspace.workspaceId });
  assert.equal(inactivePlan.verificationState, 'authoritative-fresh');
  assert.equal(inactivePlan.commitAllowed, false);
  assert.ok(inactivePlan.blockers.some((entry: any) => entry.code === 'EXECUTION_SESSION_NOT_ACTIVE'));
});

test('sequential verification batch blocks commit until every declared check passes on one frozen ownership revision', () => {
  const { workspace, taskId, session } = createFixture('sequential-batch');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 30;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  const captured = execution.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const requiredChecks = ['focused', 'typecheck'];

  const first = execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root,
    batchId: 'batch-sequential-1',
    requiredChecks,
    checkId: 'focused',
    status: 'passed',
    captured,
    memberCandidate: { candidateId: 'vc-focused', repoRevision: captured.repoRevision, executionKey: 'cmd-focused' },
  });
  assert.equal(first.authoritative, false);
  assert.equal(first.state.status, 'pending');
  assert.deepEqual(first.state.pending, ['typecheck']);

  let plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, false);
  assert.notEqual(plan.verificationFresh, true);
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE'));

  const replay = execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root,
    batchId: 'batch-sequential-1',
    requiredChecks,
    checkId: 'focused',
    status: 'passed',
    captured,
    memberCandidate: { candidateId: 'vc-focused', repoRevision: captured.repoRevision, executionKey: 'cmd-focused' },
  });
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.state.pending, ['typecheck']);

  const second = execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root,
    batchId: 'batch-sequential-1',
    requiredChecks,
    checkId: 'typecheck',
    status: 'passed',
    captured,
    memberCandidate: { candidateId: 'vc-typecheck', repoRevision: captured.repoRevision, executionKey: 'cmd-typecheck' },
  });
  assert.equal(second.authoritative, true);
  assert.equal(second.state.status, 'complete');
  assert.equal(second.state.canComplete, true);

  plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.equal(plan.verificationFresh, true);
  assert.equal(plan.blockers.some((entry: any) => entry.code.startsWith('EXECUTION_VERIFICATION_BATCH_')), false);
});

test('failed batch member remains terminal and a newer explicit batch id is required for retry', () => {
  const { workspace, session } = createFixture('sequential-batch-failure');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 31;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  const captured = execution.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const requiredChecks = ['focused', 'typecheck'];

  execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root, batchId: 'batch-fail-1', requiredChecks, checkId: 'focused', status: 'passed', captured,
    memberCandidate: { candidateId: 'vc-fail-focused', repoRevision: captured.repoRevision, executionKey: 'cmd-fail-focused' },
  });
  const failed = execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root, batchId: 'batch-fail-1', requiredChecks, checkId: 'typecheck', status: 'failed', captured,
    memberCandidate: { candidateId: 'vc-fail-typecheck', repoRevision: captured.repoRevision, executionKey: 'cmd-fail-typecheck' },
  });
  assert.equal(failed.state.status, 'failed');
  assert.equal(failed.authoritative, false);
  assert.throws(() => execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root, batchId: 'batch-fail-1', requiredChecks, checkId: 'typecheck', status: 'passed', captured,
    memberCandidate: { candidateId: 'vc-fail-typecheck-retry', repoRevision: captured.repoRevision, executionKey: 'cmd-fail-typecheck-retry' },
  }), /terminal|batch/i);

  const retry = execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root, batchId: 'batch-fail-2', requiredChecks, checkId: 'focused', status: 'passed', captured,
    memberCandidate: { candidateId: 'vc-retry-focused', repoRevision: captured.repoRevision, executionKey: 'cmd-retry-focused' },
  });
  assert.equal(retry.state.batchId, 'batch-fail-2');
  assert.equal(retry.state.status, 'pending');
});

test('ownership drift terminalizes a pending verification batch as stale and requires a new batch', () => {
  const { workspace, taskId, session } = createFixture('sequential-batch-stale');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 32;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  const captured = execution.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const requiredChecks = ['focused', 'typecheck'];
  execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root, batchId: 'batch-stale-1', requiredChecks, checkId: 'focused', status: 'passed', captured,
    memberCandidate: { candidateId: 'vc-stale-focused', repoRevision: captured.repoRevision, executionKey: 'cmd-stale-focused' },
  });

  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 33;\n');
  const stale = execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root, batchId: 'batch-stale-1', requiredChecks, checkId: 'typecheck', status: 'passed', captured,
    memberCandidate: { candidateId: 'vc-stale-typecheck', repoRevision: captured.repoRevision, executionKey: 'cmd-stale-typecheck' },
  });
  assert.equal(stale.authoritative, false);
  assert.equal(stale.state.status, 'stale');
  assert.equal(stale.state.stale.includes('typecheck'), true);

  let plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, false);
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_STALE'));

  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-repair' });
  const recaptured = execution.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const retry = execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root, batchId: 'batch-stale-2', requiredChecks, checkId: 'focused', status: 'passed', captured: recaptured,
    memberCandidate: { candidateId: 'vc-stale-retry', repoRevision: recaptured.repoRevision, executionKey: 'cmd-stale-retry' },
  });
  assert.equal(retry.state.status, 'pending');
  assert.equal(retry.state.batchId, 'batch-stale-2');
});

test('verification debt commit requires infra-blocked authority and preserves an auditable debt without faking fresh verification', () => {
  const { workspace, taskId, session } = createFixture('verification-debt');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 40;\n');
  fs.writeFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'export const unrelated = 40;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  execution.recordExecutionLifecycleTransition(session.id, {
    toStage: 'context-ready', reasonCode: 'debt-context', evidence: { id: 'debt-context', kind: 'context-bundle', status: 'completed' },
  });
  execution.recordExecutionLifecycleTransition(session.id, {
    toStage: 'implementing', reasonCode: 'debt-implementing', evidence: { id: 'debt-implementing', kind: 'owned-change', status: 'completed' },
  });
  execution.recordExecutionLifecycleTransition(session.id, {
    toStage: 'verifying', reasonCode: 'debt-verifying', evidence: { id: 'debt-verifying', kind: 'verification-result', status: 'completed' },
  });
  execution.recordExecutionLifecycleTransition(session.id, {
    toStage: 'verification-infra-blocked', reasonCode: 'debt-infra', evidence: { id: 'debt-infra', kind: 'verification-result', status: 'completed' },
  });
  execution.recordExecutionSessionEvidence(session.id, [{
    evidenceId: 'debt-infra-failure',
    kind: 'verification-result',
    revisionIdentity: 'debt-infra-failure',
    metadata: { outcome: 'failed', terminal: true, failureClass: 'infrastructure', status: 'timed_out', timedOut: true },
  }]);

  assert.throws(
    () => commitPlan.commitTaskOwnedChanges({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId, message: 'ordinary commit stays blocked' }),
    /blocked/i,
  );
  assert.throws(
    () => commitPlan.commitTaskOwnedChanges({ countersCache: {} }, {
      taskId, workspaceId: workspace.workspaceId, message: 'debt commit missing authorization', preserveVerificationDebt: true,
    }),
    /emergency|authorization|reason/i,
  );

  const committed = commitPlan.commitTaskOwnedChanges({ countersCache: {} }, {
    taskId,
    workspaceId: workspace.workspaceId,
    message: 'fix: preserve verification debt',
    preserveVerificationDebt: true,
    emergency: true,
    reason: 'Verification failed because the runner exhausted heap.',
    actorLabel: 'Operator Test',
  });
  assert.equal(committed.verificationDebtPreserved, true);
  assert.deepEqual(committed.committedFiles, ['src/owned.ts']);
  assert.deepEqual(committed.unrelatedChangesPreserved, ['src/unrelated.ts']);
  assert.equal(execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, null);
  const debt = execution.getExecutionSessionState(session.id).evidence.find((entry: any) => entry.kind === 'verification-debt');
  assert.equal(debt?.metadata?.status, 'outstanding');
  assert.equal(debt?.metadata?.failureClass, 'infrastructure');
  assert.equal(debt?.metadata?.commitHash, committed.commitHash);
  assert.equal((debt?.metadata as any)?.authorization?.reason, 'Verification failed because the runner exhausted heap.');
  assert.equal(fs.readFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'utf8'), 'export const unrelated = 40;\n');
});

test('commit plan blocks stale verification after an owned file changes again', () => {
  const { workspace, taskId, session } = createFixture('stale');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 3;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: workspace.root });
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 4;\n');

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, false);
  assert.equal(plan.verificationFresh, false);
  assert.equal(plan.verificationState, 'stale');
  const verificationBlocker = plan.blockers.find((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH');
  assert.equal((verificationBlocker?.details as any)?.verificationState, 'stale');
  assert.ok((verificationBlocker?.details as any)?.verificationRecordedAt);
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'));
  assert.ok(verificationBlocker);
  assert.throws(() => commitPlan.commitTaskOwnedChanges({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId, message: 'should not commit' }), /blocked/i);
});
