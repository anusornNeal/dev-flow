import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-session-ownership-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
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
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
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

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
