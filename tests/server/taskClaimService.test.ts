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
const { listExecutionSessionsForTask } = await import('../../src/server/repositories/executionSessionRepository.js');
const claims = await import('../../src/server/services/taskClaimService.js');
const commitPlan = await import('../../src/server/services/taskCommitPlanService.js');
const workspaces = await import('../../src/server/services/sessionWorkspaceService.js');

const claimProject = {
  id: 'project-claim',
  name: 'Claim Project',
  repoUrl: 'https://example.test/claim.git',
  localPath: repoRoot,
  taskIdPrefix: 'CLM',
  createdAt: new Date().toISOString(),
};
createProject(claimProject);

function seedTask(id: string, targetFiles: string[], parentId?: string, displayId?: string) {
  const now = new Date().toISOString();
  saveTask({
    id,
    displayId: displayId || id.toUpperCase(),
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

function createCandidateProject(projectId: string) {
  createProject({
    id: projectId,
    name: projectId,
    repoUrl: `https://example.test/${projectId}.git`,
    localPath: repoRoot,
    taskIdPrefix: 'NXT',
    createdAt: new Date().toISOString(),
  });
}

function seedCandidateTask(projectId: string, id: string, targetFiles: string[], options: {
  priority?: 'high' | 'medium' | 'low';
  parentId?: string;
  tags?: string[];
  status?: 'backlog' | 'todo' | 'in-progress';
  createdAt?: string;
} = {}) {
  const now = options.createdAt || new Date().toISOString();
  saveTask({
    id,
    displayId: id.toUpperCase(),
    projectId,
    title: id,
    description: '',
    status: options.status || 'backlog',
    priority: options.priority || 'medium',
    category: 'backend',
    tags: options.tags || [],
    targetFiles,
    checklist: [],
    parentId: options.parentId,
    createdAt: now,
    updatedAt: now,
    logs: [],
  });
}

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
  const sessions = listExecutionSessionsForTask('task-a').filter((entry: any) => entry.workspaceId === first.claim.workspaceId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, 'active');
  assert.equal(sessions[0].projectId, 'project-claim');
  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId: 'task-a', workspaceId: first.claim.workspaceId });
  assert.equal(plan.executionSessionId, sessions[0].id);
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'TASK_COMMIT_NO_OWNED_CHANGES'));

  assert.throws(
    () => claims.claimTaskForSession('task-a', { sessionId: 'chat-beta-secret', ownerKind: 'chat', ownerLabel: 'Chat B4' }),
    (error: any) => error?.payload?.code === 'TASK_ALREADY_CLAIMED',
  );
});

test('task claims use the trailing card number for the visible worktree folder and Git branch', () => {
  seedTask('task-folder-dvf', ['src/DvfFolder.ts'], undefined, 'DVF-0469');
  seedTask('task-folder-bsa', ['src/BsaFolder.ts'], undefined, 'BSA-0057');

  const dvf = claims.claimTaskForSession('task-folder-dvf', { sessionId: 'folder-dvf', ownerLabel: 'Chat DVF' });
  const dvfWorkspace = workspaces.resolveSessionWorkspace(dvf.claim.workspaceId);
  assert.ok(dvfWorkspace);
  assert.equal(path.basename(dvfWorkspace.root), '0469');
  assert.match(dvfWorkspace.workspaceId, /^ws_[a-f0-9]{16}$/);
  assert.equal(dvfWorkspace.branch, '0469');

  const bsa = claims.claimTaskForSession('task-folder-bsa', { sessionId: 'folder-bsa', ownerLabel: 'Chat BSA' });
  const bsaWorkspace = workspaces.resolveSessionWorkspace(bsa.claim.workspaceId);
  assert.ok(bsaWorkspace);
  assert.equal(path.basename(bsaWorkspace.root), '0057');
  assert.match(bsaWorkspace.workspaceId, /^ws_[a-f0-9]{16}$/);
  assert.equal(bsaWorkspace.branch, '0057');
});

test('same chat session claiming different cards receives isolated task-numbered workspaces', () => {
  seedTask('task-same-session-a', ['src/SameSessionA.ts'], undefined, 'DVF-0601');
  seedTask('task-same-session-b', ['src/SameSessionB.ts'], undefined, 'DVF-0602');

  const first = claims.claimTaskForSession('task-same-session-a', { sessionId: 'shared-task-session', ownerLabel: 'Chat Shared' });
  const second = claims.claimTaskForSession('task-same-session-b', { sessionId: 'shared-task-session', ownerLabel: 'Chat Shared' });
  const firstWorkspace = workspaces.resolveSessionWorkspace(first.claim.workspaceId);
  const secondWorkspace = workspaces.resolveSessionWorkspace(second.claim.workspaceId);

  assert.ok(firstWorkspace);
  assert.ok(secondWorkspace);
  assert.notEqual(first.claim.workspaceId, second.claim.workspaceId);
  assert.notEqual(firstWorkspace.root, secondWorkspace.root);
  assert.notEqual(firstWorkspace.branch, secondWorkspace.branch);
  assert.equal(path.basename(firstWorkspace.root), '0601');
  assert.equal(path.basename(secondWorkspace.root), '0602');
  assert.equal(firstWorkspace.branch, '0601');
  assert.equal(secondWorkspace.branch, '0602');
});

test('occupied task-number root fails closed instead of creating a suffixed worktree', () => {
  seedTask('task-folder-collision', ['src/CollisionFolder.ts'], undefined, 'DVF-0500');
  const occupied = workspaces.createOrReuseSessionWorkspace(claimProject, 'collision-owner', { taskDisplayId: 'DVF-0500' } as any);
  const rootsDir = path.dirname(occupied.root);
  try {
    assert.throws(
      () => claims.claimTaskForSession('task-folder-collision', { sessionId: 'collision-claim', ownerLabel: 'Chat Collision' }),
      (error: any) => error?.payload?.code === 'WORKSPACE_ROOT_OCCUPIED',
    );
    assert.equal(fs.existsSync(path.join(rootsDir, '0500-2')), false);
  } finally {
    workspaces.cleanupSessionWorkspace(occupied.workspaceId);
  }
});

test('released task resumes its existing numbered workspace instead of creating another one', () => {
  seedTask('task-folder-resume', ['src/ResumeFolder.ts'], undefined, 'DVF-0501');
  const first = claims.claimTaskForSession('task-folder-resume', { sessionId: 'resume-owner-a', ownerLabel: 'Chat Resume A' });
  const firstWorkspace = workspaces.resolveSessionWorkspace(first.claim.workspaceId);
  assert.ok(firstWorkspace);

  claims.releaseTaskClaim('task-folder-resume', { sessionId: 'resume-owner-a', nextStatus: 'todo' });
  const resumed = claims.claimTaskForSession('task-folder-resume', { sessionId: 'resume-owner-b', ownerLabel: 'Chat Resume B' });
  const resumedWorkspace = workspaces.resolveSessionWorkspace(resumed.claim.workspaceId);
  assert.ok(resumedWorkspace);
  assert.equal(resumed.claim.workspaceId, first.claim.workspaceId);
  assert.equal(path.basename(resumedWorkspace.root), '0501');
  assert.equal(resumedWorkspace.root, firstWorkspace.root);
  assert.equal(firstWorkspace.branch, '0501');
  assert.equal(resumedWorkspace.branch, '0501');
});

test('claiming a child promotes its immediate parent without creating parent execution ownership', () => {
  seedTask('parent-promote', ['src/ParentPromote.ts'], undefined, 'DVF-0700');
  seedTask('child-promote', ['src/ChildPromote.ts'], 'parent-promote', 'DVF-0701');
  const parentBefore = getTask('parent-promote');
  parentBefore.status = 'todo';
  saveTask(parentBefore);

  const claimed = claims.claimTaskForSession('child-promote', { sessionId: 'parent-promote-owner', ownerLabel: 'Chat Parent Promote' });
  assert.equal(claimed.task.status, 'in-progress');

  const parentAfter = getTask('parent-promote');
  assert.equal(parentAfter.status, 'in-progress');
  assert.equal(parentAfter.claim, undefined);
  assert.equal(listExecutionSessionsForTask('parent-promote').length, 0);

  claims.releaseTaskClaim('child-promote', { sessionId: 'parent-promote-owner', nextStatus: 'todo' });
  assert.equal(getTask('parent-promote')?.status, 'in-progress');
});

test('same-session child claim reconciles parent drift without duplicate promotion logs', () => {
  seedTask('parent-reconcile', ['src/ParentReconcile.ts'], undefined, 'DVF-0710');
  seedTask('child-reconcile', ['src/ChildReconcile.ts'], 'parent-reconcile', 'DVF-0711');

  const first = claims.claimTaskForSession('child-reconcile', { sessionId: 'parent-reconcile-owner', ownerLabel: 'Chat Parent Reconcile' });
  const parentAfterFirst = getTask('parent-reconcile');
  assert.equal(parentAfterFirst.status, 'in-progress');
  const firstPromotionLogs = (parentAfterFirst.logs || []).filter((entry: any) => /active child/i.test(entry.message));
  assert.equal(firstPromotionLogs.length, 1);

  const same = claims.claimTaskForSession('child-reconcile', { sessionId: 'parent-reconcile-owner', ownerLabel: 'Chat Parent Reconcile' });
  assert.equal(same.reused, true);
  const parentAfterSame = getTask('parent-reconcile');
  assert.equal((parentAfterSame.logs || []).filter((entry: any) => /active child/i.test(entry.message)).length, 1);

  parentAfterSame.status = 'done';
  parentAfterSame.updatedAt = new Date().toISOString();
  saveTask(parentAfterSame);
  claims.claimTaskForSession('child-reconcile', { sessionId: 'parent-reconcile-owner', ownerLabel: 'Chat Parent Reconcile' });
  const repaired = getTask('parent-reconcile');
  assert.equal(repaired.status, 'in-progress');
  assert.equal((repaired.logs || []).filter((entry: any) => /active child/i.test(entry.message)).length, 2);
  assert.equal(repaired.claim, undefined);
});

test('sibling child claims keep one stable parent promotion across review and done states', () => {
  for (const [suffix, status] of [['a', 'ready-for-review'], ['b', 'done']] as const) {
    const parentId = `parent-sibling-${suffix}`;
    const firstChildId = `child-sibling-${suffix}-1`;
    const secondChildId = `child-sibling-${suffix}-2`;
    seedTask(parentId, [`src/ParentSibling${suffix}.ts`], undefined, suffix === 'a' ? 'DVF-0720' : 'DVF-0730');
    seedTask(firstChildId, [`src/ChildSibling${suffix}1.ts`], parentId, suffix === 'a' ? 'DVF-0721' : 'DVF-0731');
    seedTask(secondChildId, [`src/ChildSibling${suffix}2.ts`], parentId, suffix === 'a' ? 'DVF-0722' : 'DVF-0732');
    const parent = getTask(parentId);
    parent.status = status;
    saveTask(parent);

    claims.claimTaskForSession(firstChildId, { sessionId: `sibling-${suffix}-1`, ownerLabel: `Chat Sibling ${suffix}1` });
    claims.claimTaskForSession(secondChildId, { sessionId: `sibling-${suffix}-2`, ownerLabel: `Chat Sibling ${suffix}2` });

    const promoted = getTask(parentId);
    assert.equal(promoted.status, 'in-progress');
    assert.equal(promoted.claim, undefined);
    assert.equal(listExecutionSessionsForTask(parentId).length, 0);
    assert.equal((promoted.logs || []).filter((entry: any) => /active child/i.test(entry.message)).length, 1);
  }
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


test('claim next selects the highest-priority eligible leaf and keeps final gates and parents out of auto-selection', () => {
  const projectId = 'project-next-selection';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'next-parent', ['src/Parent.ts'], { priority: 'high', createdAt: '2026-08-10T00:00:00.000Z' });
  seedCandidateTask(projectId, 'next-child', ['src/Child.ts'], { parentId: 'next-parent', priority: 'medium', createdAt: '2026-08-10T00:00:01.000Z' });
  seedCandidateTask(projectId, 'next-final', ['src/Final.ts'], { priority: 'high', tags: ['final-gate'], createdAt: '2026-08-10T00:00:02.000Z' });
  seedCandidateTask(projectId, 'next-blocked', ['src/Blocked.ts'], { priority: 'high', tags: ['depends-on:missing-task'], createdAt: '2026-08-10T00:00:02.500Z' });
  seedCandidateTask(projectId, 'next-high', ['src/High.ts'], { priority: 'high', createdAt: '2026-08-10T00:00:03.000Z' });
  seedCandidateTask(projectId, 'next-low', ['src/Low.ts'], { priority: 'low', createdAt: '2026-08-10T00:00:04.000Z' });

  const first = claims.claimNextTaskForSession(projectId, { sessionId: 'next-worker-alpha', ownerLabel: 'Chat N1', limit: 10 });
  assert.equal(first.status, 'claimed');
  assert.equal(first.task.id, 'next-high');
  assert.match(first.workspace.workspaceId, /^ws_[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(first).includes('next-worker-alpha'), false);
  assert.equal(JSON.stringify(first).includes(repoRoot), false);

  const second = claims.claimNextTaskForSession(projectId, { sessionId: 'next-worker-beta', ownerLabel: 'Chat N2', limit: 10 });
  assert.equal(second.status, 'claimed');
  assert.equal(second.task.id, 'next-child');
  assert.notEqual(second.task.id, first.task.id);
});

test('claim next defers ambiguous and conflicting scope instead of overriding it', () => {
  const projectId = 'project-next-deferred';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'next-anchor', ['src/Shared.ts'], { priority: 'high' });
  seedCandidateTask(projectId, 'next-overlap', ['src/Shared.ts'], { priority: 'high' });
  seedCandidateTask(projectId, 'next-uncertain', [], { priority: 'high' });
  claims.claimTaskForSession('next-anchor', { sessionId: 'anchor-owner', ownerLabel: 'Chat Anchor' });

  const result = claims.claimNextTaskForSession(projectId, { sessionId: 'deferred-worker', ownerLabel: 'Chat Deferred', limit: 10 });
  assert.equal(result.status, 'no-eligible');
  assert.equal(result.code, 'NO_ELIGIBLE_TASK');
  assert.equal(result.scanned, 2);
  assert.equal(result.deferred >= 2, true);
});

test('claim next gives one winner when multiple workers contend for one eligible task', () => {
  const projectId = 'project-next-race';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'next-only', ['src/Only.ts'], { priority: 'high' });

  const attempts = ['A', 'B', 'C', 'D', 'E'].map((label) =>
    claims.claimNextTaskForSession(projectId, { sessionId: `race-worker-${label}`, ownerLabel: `Chat ${label}`, limit: 10 }));
  const winners = attempts.filter((result: any) => result.status === 'claimed') as Array<{ status: 'claimed'; task: any }>;
  const misses = attempts.filter((result: any) => result.status === 'no-eligible');
  assert.equal(winners.length, 1);
  assert.equal(winners[0].task.id, 'next-only');
  assert.equal(misses.length, 4);
  assert.equal(getTask('next-only')?.claim?.ownerLabel, 'Chat A');
});

test('runtime scope expansion reserves discovered paths without mutating targetFiles and release frees them', () => {
  seedTask('task-runtime-owner', ['src/RuntimeOwner.ts']);
  seedTask('task-runtime-contender', ['src/RuntimeShared.ts']);
  seedTask('task-runtime-expander', ['src/RuntimeOther.ts']);
  const owner = claims.claimTaskForSession('task-runtime-owner', { sessionId: 'runtime-owner', ownerLabel: 'Chat Runtime' });
  assert.throws(
    () => (claims as any).expandTaskClaimScope('task-runtime-owner', { sessionId: 'wrong-runtime-owner', paths: ['src/RuntimeShared.ts'] }),
    (error: any) => error?.payload?.code === 'TASK_CLAIM_OWNER_MISMATCH',
  );
  const expanded = (claims as any).expandTaskClaimScope('task-runtime-owner', { sessionId: 'runtime-owner', paths: ['SRC/RuntimeShared.ts', 'src/RuntimeShared.ts'] });
  assert.deepEqual(getTask('task-runtime-owner')?.targetFiles, ['src/RuntimeOwner.ts']);
  assert.deepEqual(expanded.addedPaths, ['src/runtimeshared.ts']);
  assert.deepEqual(expanded.claim.reservedPaths, ['src/runtimeshared.ts']);
  assert.deepEqual(expanded.effectiveScope, ['src/runtimeowner.ts', 'src/runtimeshared.ts']);
  assert.equal(expanded.claim.workspaceId, owner.claim.workspaceId);
  assert.throws(
    () => claims.claimTaskForSession('task-runtime-contender', { sessionId: 'runtime-contender', ownerLabel: 'Chat Contender' }),
    (error: any) => error?.payload?.code === 'TASK_SCOPE_CONFLICT' && error?.payload?.details?.conflicts?.[0]?.files?.includes('src/runtimeshared.ts'),
  );
  claims.claimTaskForSession('task-runtime-expander', { sessionId: 'runtime-expander', ownerLabel: 'Chat Expander' });
  assert.throws(
    () => (claims as any).expandTaskClaimScope('task-runtime-expander', { sessionId: 'runtime-expander', paths: ['src/RuntimeShared.ts'] }),
    (error: any) => error?.payload?.code === 'TASK_SCOPE_CONFLICT' && error?.payload?.details?.conflicts?.[0]?.taskId === 'task-runtime-owner',
  );
  claims.releaseTaskClaim('task-runtime-owner', { sessionId: 'runtime-owner', nextStatus: 'todo' });
  const contender = claims.claimTaskForSession('task-runtime-contender', { sessionId: 'runtime-contender', ownerLabel: 'Chat Contender' });
  assert.equal(contender.task.status, 'in-progress');
  assert.ok((getTask('task-runtime-owner')?.logs || []).some((entry: any) => /scope.*src\/runtimeshared\.ts/i.test(entry.message)));
});

test('claim-next defers a candidate that overlaps an active runtime reservation', () => {
  const projectId = 'project-runtime-next';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'runtime-anchor', ['src/Anchor.ts'], { priority: 'high' });
  seedCandidateTask(projectId, 'runtime-candidate', ['src/RuntimeShared.ts'], { priority: 'high' });
  claims.claimTaskForSession('runtime-anchor', { sessionId: 'runtime-next-owner', ownerLabel: 'Chat Runtime Next' });
  (claims as any).expandTaskClaimScope('runtime-anchor', { sessionId: 'runtime-next-owner', paths: ['src/RuntimeShared.ts'] });
  const result = claims.claimNextTaskForSession(projectId, { sessionId: 'runtime-next-worker', ownerLabel: 'Chat Runtime Worker', limit: 10 });
  assert.equal(result.status, 'no-eligible');
  assert.equal(result.code, 'NO_ELIGIBLE_TASK');
});

test('expired runtime reservations stop blocking new claims', () => {
  seedTask('task-runtime-expired-owner', ['src/ExpiredOwner.ts']);
  seedTask('task-runtime-expired-contender', ['src/ExpiredShared.ts']);
  const owner = claims.claimTaskForSession('task-runtime-expired-owner', { sessionId: 'runtime-expired-owner', ownerLabel: 'Chat Expired Owner' });
  (claims as any).expandTaskClaimScope('task-runtime-expired-owner', { sessionId: 'runtime-expired-owner', paths: ['src/ExpiredShared.ts'] });
  const staleTask = getTask('task-runtime-expired-owner');
  staleTask.claim = { ...owner.claim, reservedPaths: ['src/expiredshared.ts'], expiresAt: new Date(Date.now() - 1000).toISOString() };
  saveTask(staleTask);
  const contender = claims.claimTaskForSession('task-runtime-expired-contender', { sessionId: 'runtime-expired-contender', ownerLabel: 'Chat Expired Contender' });
  assert.equal(contender.task.status, 'in-progress');
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
