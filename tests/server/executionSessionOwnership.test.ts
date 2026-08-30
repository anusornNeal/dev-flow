import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-session-ownership-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 1;\n', 'utf8');
fs.writeFileSync(path.join(repoRoot, 'src', 'B.ts'), 'export const B = 1;\n', 'utf8');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const workspaceService = await import('../../src/server/services/sessionWorkspaceService.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const sessions = await import('../../src/server/services/executionSessionService.js');
const { getExecutionOwnershipReviewBlockers } = await import('../../src/server/services/taskGitWorkflowService.js');
const { getFileRevision } = await import('../../src/server/services/localFileService.js');

const now = new Date().toISOString();
createProject({ id: 'project-owned', name: 'owned', repoUrl: '', localPath: repoRoot, createdAt: now });
saveTask({
  id: 'task-owned',
  displayId: 'DVF-OWNED',
  title: 'Execution ownership fixture',
  description: 'fixture',
  projectId: 'project-owned',
  status: 'in-progress',
  priority: 'medium',
  branch: 'develop',
  category: 'backend',
  tags: [],
  targetFiles: ['src/A.ts'],
  checklist: [],
  createdAt: now,
  updatedAt: now,
  logs: [],
});

const state = {
  projects: [{ id: 'project-owned', name: 'owned', repoUrl: '', localPath: repoRoot, createdAt: now }],
  countersCache: {},
} as any;

function resetRepo() {
  git(['reset', '--hard', 'HEAD']);
  git(['clean', '-fd']);
}

function createSession() {
  return sessions.createExecutionSession({
    projectId: 'project-owned',
    taskId: 'task-owned',
    branch: 'develop',
    repoRoot,
  });
}

function createTaskBoundSession(label: string) {
  workspaceService.resetSessionWorkspaceRuntimeForTests();
  const workspace = workspaceService.createOrReuseSessionWorkspace({ id: 'project-owned', localPath: repoRoot }, `verification-${label}`);
  const task = getTask('task-owned')!;
  const claimedAt = new Date().toISOString();
  saveTask({
    ...task,
    claim: {
      workspaceId: workspace.workspaceId,
      sessionIdHash: `fixture-${label}`,
      ownerKind: 'chat',
      ownerLabel: `Verification ${label}`,
      claimedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      reservedPaths: [],
    },
    updatedAt: claimedAt,
  } as any);
  const session = sessions.createExecutionSession({
    projectId: 'project-owned',
    taskId: 'task-owned',
    workspaceId: workspace.workspaceId,
    branch: 'develop',
    repoRoot: workspace.root,
  });
  return { workspace, session };
}

function currentVerificationResult(provenance: { repoRevision: string }, suffix: string) {
  return {
    ok: true,
    status: 'succeeded',
    verificationCandidate: {
      current: true,
      candidateId: `vc_${suffix}`,
      repoRevision: provenance.repoRevision,
      executionKey: `execution-${suffix}`,
    },
  };
}

test('owned-change projection keeps one current state per path when the execution context handle rotates', () => {
  const { workspace, session } = createTaskBoundSession('context-rotation-owned-state');
  const ownedPath = path.join(workspace.root, 'src', 'A.ts');

  fs.writeFileSync(ownedPath, 'export const A = 30;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot: workspace.root, source: 'first-edit' });

  sessions.recordTaskExecutionContextReady(
    { taskId: 'task-owned', workspaceId: workspace.workspaceId },
    { contextHandle: 'ctx-owned-state-rotated' },
  );
  fs.writeFileSync(ownedPath, 'export const A = 31;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot: workspace.root, source: 'second-edit' });

  const ownership = sessions.getExecutionOwnershipState(session.id, { repoRoot: workspace.root });
  assert.equal(ownership.ownedFiles.filter((entry: any) => entry.path === 'src/A.ts').length, 1);
  assert.deepEqual(ownership.ownershipDrift, []);
  assert.equal(ownership.ownedFiles.find((entry: any) => entry.path === 'src/A.ts')?.source, 'second-edit');
});

test('owned revision policy is extracted behind the execution-session facade', async () => {
  const ownedRevisionPolicy = await import('../../src/server/services/executionOwnedRevisionService.js');
  for (const name of [
    'recordExecutionOwnedChanges',
    'getExecutionOwnershipState',
    'adoptExecutionOwnedChanges',
  ] as const) {
    assert.equal(sessions[name], ownedRevisionPolicy[name], `${name} must remain a direct facade export`);
  }
  assert.equal(typeof ownedRevisionPolicy.reconcileExecutionOwnedRevisionDrift, 'function');
});

test('verification authority core is extracted behind the execution-session facade', async () => {
  const verificationPolicy = await import('../../src/server/services/executionVerificationAuthorityService.js');
  for (const name of [
    'captureExecutionVerificationProvenance',
    'getExecutionVerificationBatchState',
    'getExecutionVerificationBatchStateById',
    'getExecutionVerificationBatchLiveOperations',
    'recordExecutionVerificationBatchResult',
    'recordExecutionVerificationEvidence',
    'getExecutionVerificationCoverageEvidence',
  ] as const) {
    assert.equal(sessions[name], verificationPolicy[name], `${name} must remain a direct facade export`);
  }
  assert.equal(typeof verificationPolicy.invalidateExecutionVerificationAuthorityForOwnedRevisionReconciliation, 'function');
});

test('separates execution-owned changes from unrelated working-tree changes and reports scope drift', () => {
  resetRepo();
  const session = createSession();
  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot, source: 'ChatGPT' });

  let ownership = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.deepEqual(ownership.ownedChanges, ['src/A.ts']);
  assert.deepEqual(ownership.unrelatedChanges, []);
  assert.deepEqual(ownership.scopeDrift, []);
  assert.equal(ownership.ownedFiles[0].source, 'ChatGPT');

  fs.writeFileSync(path.join(repoRoot, 'src', 'B.ts'), 'export const B = 2;\n', 'utf8');
  ownership = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.deepEqual(ownership.ownedChanges, ['src/A.ts']);
  assert.deepEqual(ownership.unrelatedChanges, ['src/B.ts']);
  assert.deepEqual(ownership.scopeDrift, ['src/B.ts']);
});

test('owned-change evidence does not authorize paths outside the claimed task scope', () => {
  resetRepo();
  const session = createSession();
  fs.writeFileSync(path.join(repoRoot, 'src', 'B.ts'), 'export const B = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/B.ts'], { repoRoot, source: 'ChatGPT' });

  const ownership = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.deepEqual(ownership.ownedChanges, ['src/B.ts']);
  assert.deepEqual(ownership.unrelatedChanges, []);
  assert.deepEqual(ownership.scopeDrift, ['src/B.ts']);
});

test('detects ownership drift while preserving the original acquisition revision across refreshes', () => {
  resetRepo();
  const session = createSession();
  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot, source: 'ChatGPT' });
  const before = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  const acquisitionRevision = before.ownedFiles[0].acquisitionFileRevision;
  const firstKnownRevision = before.ownedFiles[0].knownFileRevision;

  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 3;\n', 'utf8');
  const drifted = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.deepEqual(drifted.ownershipDrift.map((entry: any) => entry.path), ['src/A.ts']);

  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot, source: 'Codex' });
  const refreshed = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.deepEqual(refreshed.ownershipDrift, []);
  assert.equal(refreshed.ownedFiles[0].acquisitionFileRevision, acquisitionRevision);
  assert.notEqual(refreshed.ownedFiles[0].knownFileRevision, firstKnownRevision);
  assert.equal(refreshed.ownedFiles[0].source, 'Codex');
});

test('binds verification freshness to owned content only and exposes review blockers after relevant drift', () => {
  resetRepo();
  const session = createSession();
  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot, source: 'ChatGPT' });
  sessions.recordExecutionVerificationEvidence(session.id, [
    { name: 'focused', command: 'ownership-fixture', status: 'passed', summary: 'green' },
  ], { repoRoot });

  let ownership = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.equal(ownership.verificationFresh, true);

  fs.writeFileSync(path.join(repoRoot, 'src', 'B.ts'), 'export const B = 2;\n', 'utf8');
  ownership = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.equal(ownership.verificationFresh, true, 'unrelated file changes must not stale owned verification');

  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 3;\n', 'utf8');
  ownership = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.equal(ownership.verificationFresh, false);

  const blockers = getExecutionOwnershipReviewBlockers(state, { id: 'task-owned', projectId: 'project-owned' }, {});
  assert.ok(blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'));
  assert.ok(blockers.some((entry: any) => entry.code === 'EXECUTION_SCOPE_DRIFT'));
  assert.ok(blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_STALE'));
});

test('review ownership drift is non-blocking only when fresh verification covers the current owned revisions', () => {
  resetRepo();
  const session = createSession();
  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot, source: 'ChatGPT' });
  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 3;\n', 'utf8');
  sessions.recordExecutionVerificationEvidence(session.id, [
    { name: 'recovery', command: 'ownership-fixture', status: 'passed', summary: 'green repaired state' },
  ], { repoRoot });

  let ownership = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.equal(ownership.verificationFresh, true);
  assert.deepEqual(ownership.ownershipDrift.map((entry: any) => entry.path), ['src/A.ts']);
  assert.deepEqual(ownership.verifiedOwnershipDrift.map((entry: any) => entry.path), ['src/A.ts']);
  let blockers = getExecutionOwnershipReviewBlockers(state, { id: 'task-owned', projectId: 'project-owned' }, {});
  assert.equal(blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'), false);
  assert.equal(blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_STALE'), false);

  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 4;\n', 'utf8');
  ownership = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.equal(ownership.verificationFresh, false);
  assert.deepEqual(ownership.verifiedOwnershipDrift, []);
  blockers = getExecutionOwnershipReviewBlockers(state, { id: 'task-owned', projectId: 'project-owned' }, {});
  assert.ok(blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'));
  assert.ok(blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_STALE'));
});

test('legacy ownership adoption requires explicit dirty paths, revisions, and audit reason', () => {
  resetRepo();
  const session = createSession();
  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'B.ts'), 'export const B = 2;\n', 'utf8');
  const before = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.deepEqual(before.unrelatedChanges, ['src/A.ts', 'src/B.ts']);
  const aRevision = getFileRevision(path.join(repoRoot, 'src', 'A.ts')).token;
  const bRevision = getFileRevision(path.join(repoRoot, 'src', 'B.ts')).token;

  assert.throws(
    () => sessions.adoptExecutionOwnedChanges(session.id, [
      { path: 'src/A.ts', expectedRevision: 'stale-revision' },
    ], { repoRoot, reason: 'Recover a verified legacy mutation from before ownership plumbing.' }),
    (error: any) => error?.code === 'EXECUTION_ADOPTION_REVISION_MISMATCH',
  );
  assert.deepEqual(sessions.getExecutionOwnershipState(session.id, { repoRoot }).ownedChanges, []);

  const adopted = sessions.adoptExecutionOwnedChanges(session.id, [
    { path: 'src/A.ts', expectedRevision: aRevision },
  ], { repoRoot, reason: 'Recover a verified legacy mutation from before ownership plumbing.' });
  assert.deepEqual(adopted.adoptedPaths, ['src/A.ts']);
  const after = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.deepEqual(after.ownedChanges, ['src/A.ts']);
  assert.deepEqual(after.unrelatedChanges, ['src/B.ts']);
  assert.equal(after.ownedFiles[0].source, 'legacy-adoption');

  assert.throws(
    () => sessions.adoptExecutionOwnedChanges(session.id, [
      { path: 'src/B.ts', expectedRevision: bRevision },
    ], { repoRoot, reason: 'short' }),
    (error: any) => error?.code === 'EXECUTION_ADOPTION_REASON_REQUIRED',
  );
});

test('owned revision reconciliation is guarded, atomic, audited, and idempotent without legacy adoption', () => {
  resetRepo();
  const session = createSession();
  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 20;\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'B.ts'), 'export const B = 20;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts', 'src/B.ts'], { repoRoot, source: 'ChatGPT' });
  const first = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  const known = new Map(first.ownedFiles.map((entry: any) => [entry.path, entry.knownFileRevision]));

  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 21;\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'B.ts'), 'export const B = 21;\n', 'utf8');
  const drifted = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.deepEqual(drifted.ownershipDrift.map((entry: any) => entry.path), ['src/A.ts', 'src/B.ts']);
  const current = new Map(drifted.ownershipDrift.map((entry: any) => [entry.path, entry.currentFileRevision]));

  assert.throws(
    () => sessions.adoptExecutionOwnedChanges(session.id, [
      { path: 'src/A.ts', expectedRevision: current.get('src/A.ts')! },
    ], { repoRoot, reason: 'Legacy adoption must not impersonate already-owned drift recovery.' }),
    (error: any) => error?.code === 'EXECUTION_ADOPTION_NOT_UNOWNED_DIRTY',
  );

  assert.throws(
    () => sessions.reconcileExecutionOwnedRevisionDrift(session.id, [
      { path: 'src/A.ts', expectedKnownRevision: known.get('src/A.ts')!, expectedCurrentRevision: current.get('src/A.ts')! },
      { path: 'src/B.ts', expectedKnownRevision: known.get('src/B.ts')!, expectedCurrentRevision: 'stale-current-revision' },
    ], { repoRoot, reason: 'Reconcile a missed mutation recorder after exact drift evidence was captured.', provenance: 'executionSessionOwnership atomicity fixture' }),
    (error: any) => error?.code === 'EXECUTION_RECONCILIATION_CURRENT_REVISION_MISMATCH',
  );
  const afterAtomicFailure = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.deepEqual(afterAtomicFailure.ownershipDrift.map((entry: any) => entry.path), ['src/A.ts', 'src/B.ts']);
  assert.equal(afterAtomicFailure.ownedFiles.find((entry: any) => entry.path === 'src/A.ts')?.knownFileRevision, known.get('src/A.ts'));

  assert.throws(
    () => sessions.reconcileExecutionOwnedRevisionDrift(session.id, [
      { path: 'src/A.ts', expectedKnownRevision: 'stale-known-revision', expectedCurrentRevision: current.get('src/A.ts')! },
    ], { repoRoot, reason: 'Reject stale prior ownership evidence before any reconciliation write occurs.', provenance: 'executionSessionOwnership stale guard fixture' }),
    (error: any) => error?.code === 'EXECUTION_RECONCILIATION_PRIOR_REVISION_MISMATCH',
  );

  const input = [
    { path: 'src/B.ts', expectedKnownRevision: known.get('src/B.ts')!, expectedCurrentRevision: current.get('src/B.ts')! },
    { path: 'src/A.ts', expectedKnownRevision: known.get('src/A.ts')!, expectedCurrentRevision: current.get('src/A.ts')! },
  ];
  const reconciled = sessions.reconcileExecutionOwnedRevisionDrift(session.id, input, {
    repoRoot,
    reason: 'Reconcile a missed mutation recorder after exact drift evidence was captured.',
    provenance: 'executionSessionOwnership successful recovery fixture',
  });
  assert.equal(reconciled.idempotent, false);
  assert.deepEqual(reconciled.reconciledPaths, ['src/A.ts', 'src/B.ts']);
  assert.deepEqual(reconciled.ownership.ownershipDrift, []);
  assert.equal(reconciled.ownership.ownedFiles.every((entry: any) => entry.source === 'owned-revision-reconciliation'), true);

  const replay = sessions.reconcileExecutionOwnedRevisionDrift(session.id, input, {
    repoRoot,
    reason: 'Reconcile a missed mutation recorder after exact drift evidence was captured.',
    provenance: 'executionSessionOwnership successful recovery fixture',
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.reconciliationId, reconciled.reconciliationId);
});

test('explicit no-check-required verification binds freshness and later owned mutation stales it', () => {
  resetRepo();
  const session = createSession();
  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot, source: 'ChatGPT' });
  const provenance = sessions.captureExecutionVerificationProvenance(session.id, { repoRoot });
  const recorded = sessions.recordExecutionVerificationEvidence(session.id, [], {
    repoRoot,
    provenance: {
      policy: 'no-checks-required',
      expectedRepoRevision: provenance.repoRevision,
      expectedOwnedFingerprint: provenance.ownedFingerprint,
    },
  });
  assert.equal(recorded.binding.metadata.verificationPolicy, 'no-checks-required');
  assert.equal(recorded.ownership.verificationFresh, true);

  const ownedPath = path.join(repoRoot, 'src', 'A.ts');
  const stat = fs.statSync(ownedPath);
  fs.utimesSync(ownedPath, stat.atime, new Date(stat.mtimeMs + 5_000));
  const mtimeOnly = sessions.getExecutionOwnershipState(session.id, { repoRoot });
  assert.deepEqual(mtimeOnly.ownershipDrift, []);
  assert.equal(mtimeOnly.verificationFresh, true);
  assert.notEqual(mtimeOnly.ownedFiles[0].observedFileRevision, mtimeOnly.ownedFiles[0].knownFileRevision);
  assert.equal(mtimeOnly.ownedFiles[0].currentFileRevision, mtimeOnly.ownedFiles[0].knownFileRevision);

  fs.writeFileSync(ownedPath, 'export const A = 3;\n', 'utf8');
  assert.equal(sessions.getExecutionOwnershipState(session.id, { repoRoot }).verificationFresh, false);
});

test('strict verification provenance rejects stale candidate rebinding', () => {
  resetRepo();
  const session = createSession();
  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot, source: 'ChatGPT' });
  const provenance = sessions.captureExecutionVerificationProvenance(session.id, { repoRoot });

  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 3;\n', 'utf8');
  assert.throws(
    () => sessions.recordExecutionVerificationEvidence(session.id, [
      { name: 'focused', command: 'ownership-fixture', status: 'passed' },
    ], {
      repoRoot,
      provenance: {
        policy: 'checks-passed',
        expectedRepoRevision: provenance.repoRevision,
        expectedOwnedFingerprint: provenance.ownedFingerprint,
        candidateId: 'vc_fixture',
        candidateRepoRevision: provenance.repoRevision,
        executionKey: 'execution-fixture',
      },
    }),
    (error: any) => error?.code === 'EXECUTION_VERIFICATION_STALE',
  );
  assert.notEqual(sessions.getExecutionOwnershipState(session.id, { repoRoot }).verificationFresh, true);
});

test('strict verification provenance persists candidate identity only for current passed checks', () => {
  resetRepo();
  const session = createSession();
  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot, source: 'ChatGPT' });
  const provenance = sessions.captureExecutionVerificationProvenance(session.id, { repoRoot });
  const recorded = sessions.recordExecutionVerificationEvidence(session.id, [
    { name: 'focused', command: 'ownership-fixture', status: 'passed' },
  ], {
    repoRoot,
    provenance: {
      policy: 'checks-passed',
      expectedRepoRevision: provenance.repoRevision,
      expectedOwnedFingerprint: provenance.ownedFingerprint,
      candidateId: 'vc_fixture_current',
      candidateRepoRevision: provenance.repoRevision,
      executionKey: 'execution-current',
    },
  });
  assert.equal(recorded.ownership.verificationFresh, true);
  assert.equal(recorded.binding.metadata.candidateId, 'vc_fixture_current');
  assert.equal(recorded.binding.metadata.verificationPolicy, 'checks-passed');
});


test('task-bound verification result returns authoritative fresh binding and duplicate evidence is idempotent', () => {
  resetRepo();
  const { workspace, session } = createTaskBoundSession('authoritative');
  fs.writeFileSync(path.join(workspace.root, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot: workspace.root, source: 'ChatGPT' });
  const provenance = sessions.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const result = currentVerificationResult(provenance, 'authoritative');

  const first = sessions.recordTaskExecutionVerificationResult({ workspaceId: workspace.workspaceId, command: 'focused' }, result, provenance);
  assert.equal(first.authoritative, true);
  assert.equal(first.reasonCode, 'EXECUTION_VERIFICATION_AUTHORITATIVE');
  assert.equal(first.verificationFresh, true);
  assert.equal(sessions.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, true);

  const replay = sessions.recordTaskExecutionVerificationResult({ workspaceId: workspace.workspaceId, command: 'focused' }, result, provenance);
  assert.equal(replay.authoritative, true);
  assert.equal(replay.verificationFresh, true);
  assert.equal(replay.binding?.id, first.binding?.id);
});

test('task-bound verification result explains missing binding, provenance, candidate, and failed verification', () => {
  resetRepo();
  const unbound = sessions.recordTaskExecutionVerificationResult({}, { ok: true, status: 'succeeded' }, null);
  assert.equal(unbound.authoritative, false);
  assert.equal(unbound.reasonCode, 'EXECUTION_VERIFICATION_TASK_BINDING_MISSING');

  const { workspace, session } = createTaskBoundSession('missing');
  fs.writeFileSync(path.join(workspace.root, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot: workspace.root, source: 'ChatGPT' });

  const missingProvenance = sessions.recordTaskExecutionVerificationResult(
    { workspaceId: workspace.workspaceId },
    { ok: true, status: 'succeeded', verificationPolicy: 'no-checks-required' },
    null,
  );
  assert.equal(missingProvenance.reasonCode, 'EXECUTION_VERIFICATION_PROVENANCE_REQUIRED');
  assert.notEqual(missingProvenance.verificationFresh, true);

  const missingCandidate = sessions.recordTaskExecutionVerificationResult(
    { workspaceId: workspace.workspaceId },
    { ok: true, status: 'succeeded' },
    sessions.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root }),
  );
  assert.equal(missingCandidate.reasonCode, 'EXECUTION_VERIFICATION_CANDIDATE_REQUIRED');
  assert.notEqual(missingCandidate.verificationFresh, true);

  const failed = sessions.recordTaskExecutionVerificationResult(
    { workspaceId: workspace.workspaceId },
    { ok: false, status: 'failed' },
    null,
  );
  assert.equal(failed.reasonCode, 'EXECUTION_VERIFICATION_RESULT_NOT_SUCCEEDED');
  assert.equal(failed.authoritative, false);
});

test('task-bound verification rejects stale revision and fingerprint without resurrecting old freshness', () => {
  resetRepo();
  const { workspace, session } = createTaskBoundSession('stale');
  const ownedPath = path.join(workspace.root, 'src', 'A.ts');
  fs.writeFileSync(ownedPath, 'export const A = 2;\n', 'utf8');
  sessions.recordExecutionOwnedChanges(session.id, ['src/A.ts'], { repoRoot: workspace.root, source: 'ChatGPT' });
  const provenance = sessions.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const result = currentVerificationResult(provenance, 'stale');
  const recorded = sessions.recordTaskExecutionVerificationResult({ workspaceId: workspace.workspaceId }, result, provenance);
  assert.equal(recorded.authoritative, true);

  const current = sessions.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const staleRepo = sessions.recordTaskExecutionVerificationResult(
    { workspaceId: workspace.workspaceId },
    currentVerificationResult(current, 'stale-repo'),
    { ...current, repoRevision: 'stale-revision' },
  );
  assert.equal(staleRepo.reasonCode, 'EXECUTION_VERIFICATION_REPO_REVISION_STALE');

  const staleFingerprint = sessions.recordTaskExecutionVerificationResult(
    { workspaceId: workspace.workspaceId },
    currentVerificationResult(current, 'stale-fingerprint'),
    { ...current, ownedFingerprint: 'stale-fingerprint' },
  );
  assert.equal(staleFingerprint.reasonCode, 'EXECUTION_VERIFICATION_FINGERPRINT_STALE');

  const staleCandidateResult = currentVerificationResult(current, 'stale-candidate');
  staleCandidateResult.verificationCandidate.repoRevision = 'stale-candidate-revision';
  const staleCandidate = sessions.recordTaskExecutionVerificationResult(
    { workspaceId: workspace.workspaceId },
    staleCandidateResult,
    current,
  );
  assert.equal(staleCandidate.reasonCode, 'EXECUTION_VERIFICATION_CANDIDATE_STALE');

  fs.writeFileSync(ownedPath, 'export const A = 3;\n', 'utf8');
  assert.equal(sessions.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, false);
  const replay = sessions.recordTaskExecutionVerificationResult({ workspaceId: workspace.workspaceId }, result, provenance);
  assert.equal(replay.authoritative, false);
  assert.ok([
    'EXECUTION_VERIFICATION_REPO_REVISION_STALE',
    'EXECUTION_VERIFICATION_FINGERPRINT_STALE',
  ].includes(replay.reasonCode));
  assert.equal(sessions.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, false);
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
