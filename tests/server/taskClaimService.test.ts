import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-claim-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
fs.mkdirSync(repoRoot, { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'README.md'), 'claim fixture\n', 'utf8');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 1;\n', 'utf8');
fs.writeFileSync(path.join(repoRoot, 'src', 'B.ts'), 'export const B = 1;\n', 'utf8');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.test']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const claims = await import('../../src/server/services/taskClaimService.js');

createProject({
  id: 'project-claim',
  name: 'Claim Project',
  repoUrl: 'https://example.test/claim.git',
  localPath: repoRoot,
  taskIdPrefix: 'CLM',
  createdAt: new Date().toISOString(),
});

function seedTask(id: string, targetFiles: string[], parentId?: string) {
  const now = new Date().toISOString();
  saveTask({
    id,
    displayId: id.toUpperCase(),
    projectId: 'project-claim',
    title: id,
    description: '',
    status: 'backlog',
    priority: 'medium',
    category: 'backend',
    tags: [],
    targetFiles,
    checklist: [],
    parentId,
    createdAt: now,
    updatedAt: now,
    logs: [],
  });
}

seedTask('task-a', ['src/A.ts'], 'parent');
seedTask('task-b', ['src/A.ts'], 'parent');
seedTask('task-c', ['src/B.ts'], 'parent');
seedTask('task-stale', ['README.md']);
seedTask('task-release', ['src/Release.ts']);

test('claim moves task to in-progress, binds opaque workspace, and is idempotent for the same session', () => {
  const first = claims.claimTaskForSession('task-a', { sessionId: 'chat-alpha-secret', ownerKind: 'chat', ownerLabel: 'Chat A3' });
  assert.equal(first.task.status, 'in-progress');
  assert.equal(first.claim.ownerLabel, 'Chat A3');
  assert.equal(first.claim.ownerKind, 'chat');
  assert.match(first.claim.sessionIdHash, /^[a-f0-9]{16}$/);
  assert.match(first.claim.workspaceId, /^ws_[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(first.claim).includes('chat-alpha-secret'), false);
  assert.equal(JSON.stringify(first.claim).includes(repoRoot), false);

  const same = claims.claimTaskForSession('task-a', { sessionId: 'chat-alpha-secret', ownerKind: 'chat', ownerLabel: 'Chat A3' });
  assert.equal(same.reused, true);
  assert.equal(same.claim.workspaceId, first.claim.workspaceId);

  assert.throws(
    () => claims.claimTaskForSession('task-a', { sessionId: 'chat-beta-secret', ownerKind: 'chat', ownerLabel: 'Chat B4' }),
    (error: any) => error?.payload?.code === 'TASK_ALREADY_CLAIMED',
  );
});

test('overlapping active target-file scope blocks while disjoint sibling scope can run in parallel', () => {
  assert.throws(
    () => claims.claimTaskForSession('task-b', { sessionId: 'chat-beta-scope', ownerKind: 'chat', ownerLabel: 'Chat B4' }),
    (error: any) => error?.payload?.code === 'TASK_SCOPE_CONFLICT' && error?.payload?.details?.conflicts?.[0]?.taskId === 'task-a',
  );

  const disjoint = claims.claimTaskForSession('task-c', { sessionId: 'chat-gamma-scope', ownerKind: 'chat', ownerLabel: 'Chat C5' });
  assert.equal(disjoint.task.status, 'in-progress');
  assert.equal(disjoint.claim.ownerLabel, 'Chat C5');
});

test('expired claim is reclaimable by another session', () => {
  const first = claims.claimTaskForSession('task-stale', { sessionId: 'stale-owner', ownerKind: 'chat', ownerLabel: 'Chat Old', ttlMs: 1 });
  const staleTask = getTask('task-stale');
  staleTask.claim = { ...first.claim, expiresAt: new Date(Date.now() - 1_000).toISOString() };
  staleTask.updatedAt = new Date().toISOString();
  saveTask(staleTask);

  const reclaimed = claims.claimTaskForSession('task-stale', { sessionId: 'fresh-owner', ownerKind: 'codex', ownerLabel: 'Codex C7' });
  assert.equal(reclaimed.reused, false);
  assert.equal(reclaimed.claim.ownerLabel, 'Codex C7');
  assert.notEqual(reclaimed.claim.sessionIdHash, first.claim.sessionIdHash);
});

test('release is owner-guarded, clears claim, and returns task to requested runnable lane', () => {
  claims.claimTaskForSession('task-release', { sessionId: 'release-owner', ownerKind: 'chat', ownerLabel: 'Chat R1' });
  assert.throws(
    () => claims.releaseTaskClaim('task-release', { sessionId: 'wrong-owner', nextStatus: 'todo' }),
    (error: any) => error?.payload?.code === 'TASK_CLAIM_OWNER_MISMATCH',
  );

  const released = claims.releaseTaskClaim('task-release', { sessionId: 'release-owner', nextStatus: 'todo' });
  assert.equal(released.task.status, 'todo');
  assert.equal(released.task.claim, undefined);
  assert.equal(getTask('task-release')?.claim, undefined);
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
