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

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
