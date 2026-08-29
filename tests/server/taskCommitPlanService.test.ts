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
fs.mkdirSync(path.join(repoRoot, '.devflow'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, '.devflow', 'commands.json'), JSON.stringify({
  commands: {
    'focused-check': {
      executable: 'node',
      args: ['-e', 'process.exit(0)'],
      acceptsTargets: true,
      category: 'test',
    },
  },
}, null, 2));

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
const projectCommands = await import('../../src/server/services/projectCommandService.js');
const verificationBatch = await import('../../src/server/services/verificationBatchService.js');
const { getFileRevision } = await import('../../src/server/services/localFileService.js');

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

test('replacement execution can adopt exact preserved WIP before task commit planning', () => {
  const { workspace, taskId, session } = createFixture('adopt-preserved-wip');
  const ownedPath = 'src/owned.ts';
  fs.writeFileSync(path.join(workspace.root, ownedPath), 'export const owned = 77;\n');
  const expectedRevision = getFileRevision(path.join(workspace.root, ownedPath)).token;
  const preservedBytes = fs.readFileSync(path.join(workspace.root, ownedPath), 'utf8');

  assert.throws(
    () => execution.adoptTaskExecutionOwnedChanges({
      taskId,
      workspaceId: workspace.workspaceId,
      executionSessionId: 'exec-foreign',
      files: [{ path: ownedPath, expectedRevision }],
      reason: 'Recover preserved WIP into the exact replacement execution.',
    }),
    (error: any) => error?.code === 'EXECUTION_ADOPTION_EXECUTION_MISMATCH' || error?.payload?.code === 'EXECUTION_ADOPTION_EXECUTION_MISMATCH',
  );

  const adopted = execution.adoptTaskExecutionOwnedChanges({
    taskId,
    workspaceId: workspace.workspaceId,
    executionSessionId: session.id,
    files: [{ path: ownedPath, expectedRevision }],
    reason: 'Recover preserved WIP into the exact replacement execution.',
  });
  assert.deepEqual(adopted.adoptedPaths, [ownedPath]);
  assert.equal(fs.readFileSync(path.join(workspace.root, ownedPath), 'utf8'), preservedBytes);
  assert.equal(adopted.ownership.verificationFresh, null);

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} } as any, { taskId, workspaceId: workspace.workspaceId });
  assert.deepEqual(plan.ownedChangedFiles, [ownedPath]);
  assert.deepEqual(plan.unrelatedChangedFiles, []);
  assert.equal(plan.blockers.some((entry: any) => entry.code === 'TASK_COMMIT_NO_OWNED_CHANGES'), false);
});

test('commit plan revalidates focused verification coverage with its recorded target paths', () => {
  const { projectId, workspace, taskId, session } = createFixture('focused-coverage');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 7;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  const captured = execution.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const state = { countersCache: {} } as any;
  const commandIdentity = projectCommands.getProjectCommandExecutionIdentity(state, {
    projectId,
    workspaceId: workspace.workspaceId,
    command: 'focused-check',
    targets: ['src/owned.ts'],
    affectedInputPaths: ['src/owned.ts', 'src/unrelated.ts'],
  });
  const coverage = verificationBatch.buildVerificationCoverageIdentity(commandIdentity);
  assert.ok(commandIdentity);
  assert.ok(coverage);
  assert.deepEqual(coverage?.targets, ['src/owned.ts']);
  assert.deepEqual(coverage?.affectedInputPaths, ['src/owned.ts', 'src/unrelated.ts']);
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused-check', status: 'passed' }], {
    repoRoot: workspace.root,
    provenance: {
      policy: 'checks-passed',
      expectedRepoRevision: captured.repoRevision,
      expectedOwnedFingerprint: captured.ownedFingerprint,
      candidateId: 'vc-focused-coverage',
      candidateRepoRevision: captured.repoRevision,
      executionKey: commandIdentity!.key,
      coverage: [coverage!],
    },
  });

  const plan = commitPlan.buildTaskCommitPlan(state, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.equal(plan.verificationCoverage.status, 'covered');
  assert.deepEqual(plan.verificationCoverage.coveredCommands, ['focused-check']);
  assert.deepEqual(plan.verificationCoverage.staleCommands, []);
});

test('commit plan preserves focused target order across verification recording and revalidation', () => {
  const { projectId, workspace, taskId, session } = createFixture('focused-target-order');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 8;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  const captured = execution.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const state = { countersCache: {} } as any;
  const targets = ['src/unrelated.ts', 'src/owned.ts'];
  const commandIdentity = projectCommands.getProjectCommandExecutionIdentity(state, {
    projectId,
    workspaceId: workspace.workspaceId,
    command: 'focused-check',
    targets,
    affectedInputPaths: targets,
  });
  const coverage = verificationBatch.buildVerificationCoverageIdentity(commandIdentity);
  assert.ok(commandIdentity);
  assert.ok(coverage);
  assert.deepEqual(coverage?.targets, targets, 'coverage must preserve argv-significant target order');
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused-check', status: 'passed' }], {
    repoRoot: workspace.root,
    provenance: {
      policy: 'checks-passed',
      expectedRepoRevision: captured.repoRevision,
      expectedOwnedFingerprint: captured.ownedFingerprint,
      candidateId: 'vc-focused-target-order',
      candidateRepoRevision: captured.repoRevision,
      executionKey: commandIdentity!.key,
      coverage: [coverage!],
    },
  });

  const plan = commitPlan.buildTaskCommitPlan(state, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.verificationCoverage.status, 'covered');
  assert.deepEqual(plan.verificationCoverage.staleCommands, []);
});

test('commit plan marks focused coverage stale when its recorded target no longer exists', () => {
  const { projectId, workspace, taskId, session } = createFixture('focused-coverage-missing-target');
  const targetPath = 'src/transient-target.ts';
  fs.writeFileSync(path.join(workspace.root, targetPath), 'export const transient = 1;\n');
  execution.recordExecutionOwnedChanges(session.id, [targetPath], { repoRoot: workspace.root, source: 'task-edit' });
  const captured = execution.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const state = { countersCache: {} } as any;
  const commandIdentity = projectCommands.getProjectCommandExecutionIdentity(state, {
    projectId,
    workspaceId: workspace.workspaceId,
    command: 'focused-check',
    targets: [targetPath],
    affectedInputPaths: [targetPath],
  });
  const coverage = verificationBatch.buildVerificationCoverageIdentity(commandIdentity);
  assert.ok(commandIdentity);
  assert.ok(coverage);
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused-check', status: 'passed' }], {
    repoRoot: workspace.root,
    provenance: {
      policy: 'checks-passed',
      expectedRepoRevision: captured.repoRevision,
      expectedOwnedFingerprint: captured.ownedFingerprint,
      candidateId: 'vc-focused-missing-target',
      candidateRepoRevision: captured.repoRevision,
      executionKey: commandIdentity!.key,
      coverage: [coverage!],
    },
  });
  fs.unlinkSync(path.join(workspace.root, targetPath));

  const plan = commitPlan.buildTaskCommitPlan(state, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, false);
  assert.equal(plan.verificationCoverage.status, 'stale');
  assert.deepEqual(plan.verificationCoverage.staleCommands, ['focused-check']);
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'));
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_COVERAGE_STALE'));
});

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

test('commit plan keeps ownership drift as hard safety even when verification is fresh', () => {
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
  assert.equal(plan.commitAllowed, false);
  assert.deepEqual(plan.verifiedOwnershipDrift.map((entry: any) => entry.path), ['src/owned.ts']);
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'));
  assert.deepEqual(plan.debts, []);

  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 12;\n');
  plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, false);
  assert.equal(plan.verificationFresh, false);
  assert.deepEqual(plan.verifiedOwnershipDrift, []);
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'));
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH'));
});

test('commit plan distinguishes missing authoritative verification from stale verification', () => {
  const { workspace, taskId, session } = createFixture('missing-verification');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 20;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.equal(plan.verificationFresh, null);
  assert.equal(plan.verificationState, 'missing');
  assert.equal(plan.verificationRecordedAt, null);
  assert.deepEqual(plan.blockers, []);
  const debt = plan.debts.find((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH');
  assert.equal((debt?.details as any)?.verificationState, 'missing');
  assert.equal((debt?.details as any)?.ownershipDriftCount, 0);
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
  assert.equal(plan.commitAllowed, true);
  assert.equal(plan.verificationState, 'missing');
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH'));
});

test('task-scoped owned revision reconciliation fences authority, stales verification, and unblocks the scoped commit plan', () => {
  const { workspace, taskId, session } = createFixture('owned-reconciliation');
  const ownedPath = path.join(workspace.root, 'src', 'owned.ts');
  fs.writeFileSync(ownedPath, 'export const owned = 50;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  const captured = execution.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const completedBatch = execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root,
    batchId: 'batch-owned-reconciliation',
    requiredChecks: ['focused'],
    checkId: 'focused',
    status: 'passed',
    captured,
    memberCandidate: { candidateId: 'vc-owned-reconciliation', repoRevision: captured.repoRevision, executionKey: 'cmd-owned-reconciliation' },
  });
  assert.equal(completedBatch.state.status, 'complete');
  assert.equal(execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, true);

  fs.writeFileSync(ownedPath, 'export const owned = 51;\n');
  let plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  const drift = plan.ownershipDrift[0];
  assert.ok(drift);
  const driftBlocker = plan.blockers.find((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT');
  assert.equal((driftBlocker?.details as any)?.nextTool, 'reconcile_task_owned_revision_drift');
  assert.equal(plan.commitAllowed, false);

  assert.throws(
    () => execution.reconcileTaskExecutionOwnedRevisionDrift({
      taskId, workspaceId: 'ws_missing', executionSessionId: session.id,
      files: [{ path: drift.path, expectedKnownRevision: drift.knownFileRevision, expectedCurrentRevision: drift.currentFileRevision }],
      reason: 'Reject reconciliation against a workspace that does not own this task execution.', provenance: 'taskCommitPlan wrong workspace fixture',
    }),
    (error: any) => error?.payload?.code === 'TASK_MUTATION_WORKSPACE_NOT_FOUND',
  );
  assert.throws(
    () => execution.reconcileTaskExecutionOwnedRevisionDrift({
      taskId, workspaceId: workspace.workspaceId, executionSessionId: 'exec_foreign',
      files: [{ path: drift.path, expectedKnownRevision: drift.knownFileRevision, expectedCurrentRevision: drift.currentFileRevision }],
      reason: 'Reject reconciliation against a foreign execution even in the correct workspace.', provenance: 'taskCommitPlan wrong execution fixture',
    }),
    (error: any) => error?.code === 'EXECUTION_RECONCILIATION_EXECUTION_MISMATCH',
  );
  fs.writeFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'export const unrelated = 51;\n');
  assert.throws(
    () => execution.reconcileTaskExecutionOwnedRevisionDrift({
      taskId, workspaceId: workspace.workspaceId, executionSessionId: session.id,
      files: [{ path: 'src/unrelated.ts', expectedKnownRevision: 'unknown', expectedCurrentRevision: 'unknown' }],
      reason: 'Reject paths outside the claimed task scope before ownership can be refreshed.', provenance: 'taskCommitPlan foreign path fixture',
    }),
    (error: any) => error?.payload?.code === 'TASK_SCOPE_EXPANSION_REQUIRED',
  );

  const request = {
    taskId,
    workspaceId: workspace.workspaceId,
    executionSessionId: session.id,
    files: [{ path: drift.path, expectedKnownRevision: drift.knownFileRevision, expectedCurrentRevision: drift.currentFileRevision }],
    reason: 'Recover an already-owned file after a missed mutation recorder using exact revision evidence.',
    provenance: 'taskCommitPlan ownership drift regression fixture',
  };
  const reconciled = execution.reconcileTaskExecutionOwnedRevisionDrift(request);
  assert.equal(reconciled.idempotent, false);
  assert.deepEqual(reconciled.ownership.ownershipDrift, []);
  assert.equal(execution.getExecutionVerificationBatchState(session.id)?.status, 'stale');
  assert.equal(execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, false);

  plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.ownershipDrift, []);
  assert.equal(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'), false);
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_STALE'));
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH'));

  const replay = execution.reconcileTaskExecutionOwnedRevisionDrift(request);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.reconciliationId, reconciled.reconciliationId);
});

test('proven task-owned commit at HEAD is idempotent and routes directly to finalization', () => {
  const { workspace, taskId, session } = createFixture('already-committed');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 21;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: workspace.root });

  const first = commitPlan.commitTaskOwnedChanges({ countersCache: {} }, {
    taskId,
    workspaceId: workspace.workspaceId,
    message: 'fix: commit once',
  });
  const countAfterFirst = Number(git(workspace.root, ['rev-list', '--count', 'HEAD']));
  assert.ok(first.commitHash);

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.equal(plan.commitDisposition, 'already-committed');
  assert.equal(plan.alreadyCommitted?.commitHash, first.commitHash);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.nextAction, { tool: 'finalize_task_workspace', taskId, workspaceId: workspace.workspaceId });

  const replay = commitPlan.commitTaskOwnedChanges({ countersCache: {} }, {
    taskId,
    workspaceId: workspace.workspaceId,
    message: 'fix: must not commit twice',
  });
  assert.equal(replay.status, 'already-committed');
  assert.equal(replay.idempotent, true);
  assert.equal(replay.commitHash, first.commitHash);
  assert.equal(Number(git(workspace.root, ['rev-list', '--count', 'HEAD'])), countAfterFirst, 'already-committed replay must not create another commit');
});

test('no owned changes and inactive sessions remain independent commit blockers', () => {
  const empty = createFixture('no-owned');
  execution.recordExecutionVerificationEvidence(empty.session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: empty.workspace.root });
  const emptyPlan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId: empty.taskId, workspaceId: empty.workspace.workspaceId });
  assert.equal(emptyPlan.verificationState, 'authoritative-fresh');
  assert.equal(emptyPlan.commitAllowed, false);
  assert.ok(emptyPlan.blockers.some((entry: any) => entry.code === 'TASK_COMMIT_NO_OWNED_CHANGES'));  assert.equal(emptyPlan.commitDisposition, 'ambiguous-no-changes');
  assert.equal(emptyPlan.alreadyCommitted, null);
  assert.equal(emptyPlan.nextAction, null);

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

test('sequential verification batch remains quality debt without live members until every declared check passes', () => {
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
  assert.equal(plan.commitAllowed, true);
  assert.notEqual(plan.verificationFresh, true);
  assert.equal(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_LIVE_MEMBERS'), false);
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_PENDING'));

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

test('failed batch member remains terminal debt and a newer explicit batch id is required for retry', () => {
  const { workspace, taskId, session } = createFixture('sequential-batch-failure');
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
  const failedPlan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(failedPlan.commitAllowed, true);
  assert.equal(failedPlan.blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_FAILED'), false);
  assert.ok(failedPlan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_FAILED'));
  assert.ok(failedPlan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH'));
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
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'));
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_STALE'));

  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-repair' });
  plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_STALE'));
  const recaptured = execution.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const retry = execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root, batchId: 'batch-stale-2', requiredChecks, checkId: 'focused', status: 'passed', captured: recaptured,
    memberCandidate: { candidateId: 'vc-stale-retry', repoRevision: recaptured.repoRevision, executionKey: 'cmd-stale-retry' },
  });
  assert.equal(retry.state.status, 'pending');
  assert.equal(retry.state.batchId, 'batch-stale-2');
});

test('ordinary commit automatically preserves missing verification as auditable debt without bypass flags', () => {
  const { workspace, taskId, session } = createFixture('verification-debt');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 40;\n');
  fs.writeFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'export const unrelated = 40;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH'));
  assert.equal(plan.qualityDebt.status, 'debt');
  assert.deepEqual(plan.qualityDebt.codes, ['EXECUTION_VERIFICATION_NOT_FRESH']);
  assert.equal(plan.qualityDebt.count, 1);

  const committed = commitPlan.commitTaskOwnedChanges({ countersCache: {} }, {
    taskId,
    workspaceId: workspace.workspaceId,
    message: 'fix: preserve verification debt automatically',
  });
  assert.equal(committed.verificationDebtPreserved, true);
  assert.equal(committed.ownerBreakGlassApplied, false);
  assert.deepEqual(committed.bypassedGates, []);
  assert.deepEqual(committed.committedFiles, ['src/owned.ts']);
  assert.deepEqual(committed.unrelatedChangesPreserved, ['src/unrelated.ts']);
  const debt = execution.getExecutionSessionState(session.id).evidence.find((entry: any) => entry.kind === 'verification-debt');
  assert.equal(debt?.metadata?.status, 'outstanding');
  assert.equal(debt?.metadata?.commitHash, committed.commitHash);
  assert.equal(debt?.metadata?.verificationState, 'missing');
  assert.deepEqual(debt?.metadata?.debtCodes, ['EXECUTION_VERIFICATION_NOT_FRESH']);
  assert.equal(fs.readFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'utf8'), 'export const unrelated = 40;\n');
});

test('stale verification is non-blocking debt once the changed ownership revision is explicitly re-adopted', () => {
  const { workspace, taskId, session } = createFixture('stale');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 3;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: workspace.root });
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 4;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-repair' });

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.equal(plan.verificationFresh, false);
  assert.equal(plan.verificationState, 'stale');
  assert.deepEqual(plan.ownershipDrift, []);
  assert.deepEqual(plan.blockers, []);
  const verificationDebt = plan.debts.find((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH');
  assert.equal((verificationDebt?.details as any)?.verificationState, 'stale');
  assert.ok((verificationDebt?.details as any)?.verificationRecordedAt);

  const committed = commitPlan.commitTaskOwnedChanges({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId, message: 'fix: commit stale verification debt' });
  assert.equal(committed.verificationDebtPreserved, true);
});
