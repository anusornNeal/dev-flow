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

process.env.DEVFLOW_RUNTIME_SOURCE_ROOT = repoRoot;

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { listExecutionSessionsForTask, listExecutionSessionEvidence } = await import('../../src/server/repositories/executionSessionRepository.js');
const claims = await import('../../src/server/services/taskClaimService.js');
const externalStatus = await import('../../src/server/services/externalTaskStatusService.js');
const commitPlan = await import('../../src/server/services/taskCommitPlanService.js');
const workspaces = await import('../../src/server/services/sessionWorkspaceService.js');
const execution = await import('../../src/server/services/executionSessionService.js');
const checkpoints = await import('../../src/server/services/executionCheckpointService.js');
const jobService = await import('../../src/server/services/mcpToolJobService.js') as any;
const jobRepo = await import('../../src/server/repositories/mcpToolJobRepository.js') as any;

const claimProject = {
  id: 'project-claim',
  name: 'Claim Project',
  repoUrl: 'https://example.test/claim.git',
  localPath: repoRoot,
  taskIdPrefix: 'CLM',
  createdAt: new Date().toISOString(),
};
createProject(claimProject);

function seedTask(id: string, targetFiles: string[], parentId?: string, displayId?: string, branch?: string) {
  const now = new Date().toISOString();
  saveTask({
    id,
    displayId: displayId || id.toUpperCase(),
    projectId: 'project-claim',
    title: id,
    description: '',
    status: 'backlog',
    priority: 'medium',
    branch,
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
  prerequisiteTaskIds?: string[];
  displayId?: string;
} = {}) {
  const now = options.createdAt || new Date().toISOString();
  saveTask({
    id,
    displayId: options.displayId || id.toUpperCase(),
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
    prerequisiteTaskIds: options.prerequisiteTaskIds || [],
    createdAt: now,
    updatedAt: now,
    logs: [],
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function activeExecution(taskId: string) {
  return listExecutionSessionsForTask(taskId).find((entry: any) => entry.status === 'active') || null;
}

function advanceExecutionToVerifying(sessionId: string, prefix: string) {
  execution.recordExecutionLifecycleTransition(sessionId, {
    toStage: 'context-ready', reasonCode: `${prefix}-context`, evidence: { id: `${prefix}-context`, kind: 'context', status: 'completed' },
  });
  execution.recordExecutionLifecycleTransition(sessionId, {
    toStage: 'implementing', reasonCode: `${prefix}-implementing`, evidence: { id: `${prefix}-implementing`, kind: 'mutation', status: 'completed' },
  });
  execution.recordExecutionLifecycleTransition(sessionId, {
    toStage: 'verifying', reasonCode: `${prefix}-verifying`, evidence: { id: `${prefix}-verifying`, kind: 'verification', status: 'completed' },
  });
}

test('claim moves task to in-progress, binds opaque workspace, and is idempotent for the same session', () => {
  const first = claims.claimTaskForSession('task-a', { sessionId: 'chat-alpha-secret', ownerKind: 'chat', ownerLabel: 'Chat A3' });
  assert.equal(first.task.status, 'in-progress');
  assert.equal(first.claim.ownerLabel, 'Chat A3');
  assert.equal(first.claim.ownerKind, 'chat');
  assert.match(first.claim.sessionIdHash, /^[a-f0-9]{16}$/);
  assert.match(String(first.claim.ownershipEpochId || ''), /^claim-epoch-[0-9a-f-]{36}$/);
  assert.match(first.claim.workspaceId, /^ws_[a-f0-9]{16}$/);
  assert.match(String(first.executionSessionId || ''), /^exec-/);
  const preparedForOwner = workspaces.createOrReuseSessionWorkspace(claimProject as any, 'chat-alpha-secret');
  assert.equal(preparedForOwner.workspaceId, first.claim.workspaceId);
  assert.equal(JSON.stringify(first.claim).includes('chat-alpha-secret'), false);
  assert.equal(JSON.stringify(first.claim).includes(repoRoot), false);

  const same = claims.claimTaskForSession('task-a', { sessionId: 'chat-alpha-secret', ownerKind: 'chat', ownerLabel: 'Chat A3' });
  assert.equal(same.reused, true);
  assert.equal(same.claim.workspaceId, first.claim.workspaceId);
  assert.equal(same.claim.ownershipEpochId, first.claim.ownershipEpochId);
  assert.equal(same.executionSessionId, first.executionSessionId);
  const sessions = listExecutionSessionsForTask('task-a').filter((entry: any) => entry.workspaceId === first.claim.workspaceId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, 'active');
  assert.equal(sessions[0].projectId, 'project-claim');
  assert.equal(execution.getExecutionSessionOwnershipEpoch(sessions[0].id).ownershipEpochId, first.claim.ownershipEpochId);
  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId: 'task-a', workspaceId: first.claim.workspaceId });
  assert.equal(plan.executionSessionId, sessions[0].id);
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'TASK_COMMIT_NO_OWNED_CHANGES'));

  assert.throws(
    () => claims.claimTaskForSession('task-a', { sessionId: 'chat-beta-secret', ownerKind: 'chat', ownerLabel: 'Chat B4' }),
    (error: any) => error?.payload?.code === 'TASK_ALREADY_CLAIMED',
  );
});

test('live owner can renew claim lease without changing ownership epoch, workspace, execution, or scope', () => {
  seedTask('task-renew-live', ['src/RenewLive.ts'], undefined, 'DVF-0786');
  const first = claims.claimTaskForSession('task-renew-live', { sessionId: 'renew-owner', ownerKind: 'agent', ownerLabel: 'Worker A', ttlMs: 60_000 });
  const firstExecution = activeExecution('task-renew-live');
  assert.ok(firstExecution);
  const before = getTask('task-renew-live');
  const beforeClaim = { ...before.claim };

  const renewed = claims.renewTaskClaim('task-renew-live', { sessionId: 'renew-owner', ttlMs: 120_000 });
  const after = getTask('task-renew-live');
  const afterExecution = activeExecution('task-renew-live');

  assert.equal(renewed.renewed, true);
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(renewed.previousExpiresAt));
  assert.equal(after.claim.sessionIdHash, beforeClaim.sessionIdHash);
  assert.equal(after.claim.ownershipEpochId, beforeClaim.ownershipEpochId);
  assert.equal(after.claim.workspaceId, beforeClaim.workspaceId);
  assert.deepEqual(after.claim.reservedPaths, beforeClaim.reservedPaths);
  assert.equal(after.status, before.status);
  assert.equal(after.branch, before.branch);
  assert.equal(afterExecution?.id, firstExecution.id);
  assert.ok((after.logs || []).some((entry: any) => /claim lease renewed/i.test(entry.message)));
  assert.ok((after.logs || []).some((entry: any) => /Worker A/.test(entry.message)));
  assert.equal(JSON.stringify(after.logs).includes('renew-owner'), false);
  assert.throws(
    () => claims.claimTaskForSession('task-renew-live', { sessionId: 'renew-contender', ownerLabel: 'Contender' }),
    (error: any) => error?.payload?.code === 'TASK_ALREADY_CLAIMED',
  );
});

test('claim renewal rejects foreign and expired owners and cannot overwrite a rotated ownership epoch', () => {
  seedTask('task-renew-guard', ['src/RenewGuard.ts'], undefined, 'DVF-0789');
  const first = claims.claimTaskForSession('task-renew-guard', { sessionId: 'renew-old-owner', ownerLabel: 'Old Owner' });

  assert.throws(
    () => claims.renewTaskClaim('task-renew-guard', { sessionId: 'renew-foreign-owner' }),
    (error: any) => error?.payload?.code === 'TASK_CLAIM_OWNER_MISMATCH',
  );

  const staleTask = getTask('task-renew-guard');
  staleTask.claim = { ...staleTask.claim, expiresAt: new Date(Date.now() - 1_000).toISOString() };
  staleTask.updatedAt = new Date().toISOString();
  saveTask(staleTask);
  assert.throws(
    () => claims.renewTaskClaim('task-renew-guard', { sessionId: 'renew-old-owner' }),
    (error: any) => error?.payload?.code === 'TASK_CLAIM_EXPIRED',
  );

  const reclaimed = claims.claimTaskForSession('task-renew-guard', { sessionId: 'renew-new-owner', ownerLabel: 'New Owner' });
  assert.notEqual(reclaimed.claim.ownershipEpochId, first.claim.ownershipEpochId);
  assert.throws(
    () => claims.renewTaskClaim('task-renew-guard', { sessionId: 'renew-old-owner' }),
    (error: any) => error?.payload?.code === 'TASK_CLAIM_OWNER_MISMATCH',
  );
  assert.equal(getTask('task-renew-guard').claim.ownershipEpochId, reclaimed.claim.ownershipEpochId);
});

test('claim renewal clamps requested TTL and never shortens an existing live lease', () => {
  seedTask('task-renew-bounds', ['src/RenewBounds.ts'], undefined, 'DVF-0792');
  const first = claims.claimTaskForSession('task-renew-bounds', { sessionId: 'renew-bounds-owner', ttlMs: 7 * 24 * 60 * 60 * 1000 });
  const firstExpiry = Date.parse(first.claim.expiresAt);
  const shortRequest = claims.renewTaskClaim('task-renew-bounds', { sessionId: 'renew-bounds-owner', ttlMs: 1 });
  assert.equal(Date.parse(shortRequest.expiresAt), firstExpiry);

  const stored = getTask('task-renew-bounds');
  stored.claim = { ...stored.claim, expiresAt: new Date(Date.now() + 30_000).toISOString() };
  saveTask(stored);
  const minBound = claims.renewTaskClaim('task-renew-bounds', { sessionId: 'renew-bounds-owner', ttlMs: 1 });
  const remainingMs = Date.parse(minBound.expiresAt) - Date.now();
  assert.ok(remainingMs >= 59_000 && remainingMs <= 61_000, `expected ~60s minimum lease, got ${remainingMs}ms`);
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

test('task claim freezes the declared target branch without switching the shared checkout', () => {
  const targetBranch = 'feature/task-branch-authority-test';
  seedTask('task-branch-authority', ['src/BranchAuthority.ts'], undefined, 'DVF-0693', targetBranch);
  const sharedBranchBefore = git(['branch', '--show-current']);
  assert.notEqual(sharedBranchBefore, targetBranch);

  const claimed = claims.claimTaskForSession('task-branch-authority', { sessionId: 'branch-authority-owner', ownerLabel: 'Chat Branch' });
  const workspace = workspaces.resolveSessionWorkspace(claimed.claim.workspaceId);
  assert.ok(workspace);
  assert.equal(workspace.baseBranch, targetBranch);
  assert.equal(workspace.baseRevision, git(['rev-parse', targetBranch]));
  assert.equal(git(['branch', '--show-current']), sharedBranchBefore);
});

test('claim blocks a legacy task workspace whose frozen target disagrees with task branch authority', () => {
  const displayId = 'DVF-0694';
  const targetBranch = 'feature/task-branch-legacy-mismatch';
  const sessionId = 'legacy-branch-authority-owner';
  seedTask('task-branch-legacy-mismatch', ['src/BranchLegacy.ts'], undefined, displayId, targetBranch);
  const legacy = workspaces.createOrReuseSessionWorkspace(claimProject, sessionId, { taskDisplayId: displayId } as any);
  let unexpectedlyClaimed = false;
  try {
    assert.notEqual(legacy.baseBranch, targetBranch);
    assert.throws(
      () => {
        claims.claimTaskForSession('task-branch-legacy-mismatch', { sessionId, ownerLabel: 'Chat Legacy' });
        unexpectedlyClaimed = true;
      },
      (error: any) => error?.payload?.code === 'TASK_WORKSPACE_BRANCH_AUTHORITY_MISMATCH',
    );
  } finally {
    if (unexpectedlyClaimed) claims.releaseTaskClaim('task-branch-legacy-mismatch', { sessionId, nextStatus: 'backlog' });
    workspaces.cleanupSessionWorkspace(legacy.workspaceId);
  }
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

test('numeric task-root collision with a different exact task identity fails closed instead of creating a suffixed worktree', () => {
  seedTask('task-folder-collision', ['src/CollisionFolder.ts'], undefined, 'DVF-0500');
  const occupied = workspaces.createOrReuseSessionWorkspace(claimProject, 'collision-owner', { taskDisplayId: 'BSA-0500' } as any);
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

test('released task preserves WIP workspace but rotates ownership epoch and execution identity', () => {
  seedTask('task-folder-resume', ['src/ResumeFolder.ts'], undefined, 'DVF-0501');
  const first = claims.claimTaskForSession('task-folder-resume', { sessionId: 'resume-owner-a', ownerLabel: 'Chat Resume A' });
  const firstWorkspace = workspaces.resolveSessionWorkspace(first.claim.workspaceId);
  const firstExecution = activeExecution('task-folder-resume');
  assert.ok(firstWorkspace);
  assert.ok(firstExecution);
  fs.writeFileSync(path.join(firstWorkspace.root, 'src', 'ResumeFolder.ts'), 'export const resumedWip = 1;\n', 'utf8');
  execution.updateExecutionSessionProgress(firstExecution.id, {
    contextHandle: 'ctx-old-owner',
    changedFiles: ['src/ResumeFolder.ts'],
    verification: [{ name: 'old-owner-check', status: 'passed' }],
  });
  execution.recordExecutionLifecycleTransition(firstExecution.id, {
    toStage: 'context-ready', reasonCode: 'old-context', evidence: { id: 'old-context-0501', kind: 'context', status: 'completed' },
  });
  execution.recordExecutionLifecycleTransition(firstExecution.id, {
    toStage: 'implementing', reasonCode: 'old-implementation', evidence: { id: 'old-impl-0501', kind: 'mutation', status: 'completed' },
  });
  execution.recordExecutionLifecycleTransition(firstExecution.id, {
    toStage: 'verifying', reasonCode: 'old-verification', evidence: { id: 'old-verify-0501', kind: 'verification', status: 'completed' },
  });

  claims.releaseTaskClaim('task-folder-resume', { sessionId: 'resume-owner-a', nextStatus: 'todo' });
  assert.equal(listExecutionSessionsForTask('task-folder-resume').find((entry: any) => entry.id === firstExecution.id)?.status, 'cancelled');
  assert.equal(fs.readFileSync(path.join(firstWorkspace.root, 'src', 'ResumeFolder.ts'), 'utf8'), 'export const resumedWip = 1;\n');

  const resumed = claims.claimTaskForSession('task-folder-resume', { sessionId: 'resume-owner-b', ownerLabel: 'Chat Resume B' });
  const resumedWorkspace = workspaces.resolveSessionWorkspace(resumed.claim.workspaceId);
  const resumedExecution = activeExecution('task-folder-resume');
  assert.ok(resumedWorkspace);
  assert.ok(resumedExecution);
  assert.equal(resumed.claim.workspaceId, first.claim.workspaceId);
  assert.notEqual(resumed.claim.ownershipEpochId, first.claim.ownershipEpochId);
  assert.notEqual(resumedExecution.id, firstExecution.id);
  assert.equal(execution.getExecutionSessionOwnershipEpoch(resumedExecution.id).ownershipEpochId, resumed.claim.ownershipEpochId);
  assert.equal(resumedExecution.lifecycle.stage, 'created');
  assert.equal(resumedExecution.contextHandle, null);
  assert.deepEqual(resumedExecution.changedFiles, []);
  assert.deepEqual(resumedExecution.verification, []);
  assert.equal(path.basename(resumedWorkspace.root), '0501');
  assert.equal(resumedWorkspace.root, firstWorkspace.root);
  assert.equal(firstWorkspace.branch, '0501');
  assert.equal(resumedWorkspace.branch, '0501');
  assert.equal(fs.readFileSync(path.join(resumedWorkspace.root, 'src', 'ResumeFolder.ts'), 'utf8'), 'export const resumedWip = 1;\n');
});

test('release then reclaim by the same caller still creates a new ownership epoch and execution', () => {
  seedTask('task-same-owner-reclaim', ['src/SameOwner.ts'], undefined, 'DVF-0502');
  const first = claims.claimTaskForSession('task-same-owner-reclaim', { sessionId: 'same-owner', ownerLabel: 'Chat Same Owner' });
  const firstExecution = activeExecution('task-same-owner-reclaim');
  assert.ok(firstExecution);

  claims.releaseTaskClaim('task-same-owner-reclaim', { sessionId: 'same-owner', nextStatus: 'todo' });
  const second = claims.claimTaskForSession('task-same-owner-reclaim', { sessionId: 'same-owner', ownerLabel: 'Chat Same Owner' });
  const secondExecution = activeExecution('task-same-owner-reclaim');
  assert.ok(secondExecution);
  assert.equal(second.claim.sessionIdHash, first.claim.sessionIdHash);
  assert.equal(second.claim.workspaceId, first.claim.workspaceId);
  assert.notEqual(second.claim.ownershipEpochId, first.claim.ownershipEpochId);
  assert.notEqual(secondExecution.id, firstExecution.id);
  assert.equal(firstExecution.id === secondExecution.id, false);
  assert.equal(secondExecution.lifecycle.stage, 'created');
});

test('same owner re-entry reconciles task presentation drift from lifecycle authority', () => {
  seedTask('task-authority-status-reconcile', ['src/AuthorityStatusReconcile.ts'], undefined, 'DVF-0510');
  const first = claims.claimTaskForSession('task-authority-status-reconcile', { sessionId: 'authority-status-owner', ownerLabel: 'Chat Authority' });
  const firstExecution = activeExecution('task-authority-status-reconcile');
  assert.ok(firstExecution);
  const drifted = getTask('task-authority-status-reconcile');
  drifted.status = 'todo';
  drifted.updatedAt = new Date().toISOString();
  saveTask(drifted);

  const same = claims.claimTaskForSession('task-authority-status-reconcile', { sessionId: 'authority-status-owner', ownerLabel: 'Chat Authority' });
  assert.equal(same.reused, true);
  assert.equal(same.task.status, 'in-progress');
  assert.equal(same.claim.workspaceId, first.claim.workspaceId);
  assert.equal(activeExecution('task-authority-status-reconcile')?.id, firstExecution.id);
  assert.ok((same.task.logs || []).some((entry: any) => /presentation reconciled.*lifecycle authority/i.test(entry.message)));
});

test('same owner can re-enter an active claim even if presentation drifted to done, then normal projection converges it', () => {
  seedTask('task-authority-done-reconcile', ['src/AuthorityDoneReconcile.ts'], undefined, 'DVF-0511');
  const first = claims.claimTaskForSession('task-authority-done-reconcile', { sessionId: 'authority-done-owner', ownerLabel: 'Chat Authority Done' });
  const firstExecution = activeExecution('task-authority-done-reconcile');
  assert.ok(firstExecution);
  const drifted = getTask('task-authority-done-reconcile');
  drifted.status = 'done';
  drifted.updatedAt = new Date().toISOString();
  saveTask(drifted);

  const same = claims.claimTaskForSession('task-authority-done-reconcile', { sessionId: 'authority-done-owner', ownerLabel: 'Chat Authority Done' });
  assert.equal(same.reused, true);
  assert.equal(same.task.status, 'in-progress');
  assert.equal(same.claim.workspaceId, first.claim.workspaceId);
  assert.equal(activeExecution('task-authority-done-reconcile')?.id, firstExecution.id);
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

test('expired claim reclaim rotates epoch and execution while reusing the same workspace', () => {
  const first = claims.claimTaskForSession('task-stale', { sessionId: 'stale-owner', ownerKind: 'chat', ownerLabel: 'Chat Old', ttlMs: 1 });
  const firstExecution = activeExecution('task-stale');
  assert.ok(firstExecution);
  const staleTask = getTask('task-stale');
  staleTask.claim = { ...first.claim, expiresAt: new Date(Date.now() - 1_000).toISOString() };
  staleTask.updatedAt = new Date().toISOString();
  saveTask(staleTask);

  const reclaimed = claims.claimTaskForSession('task-stale', { sessionId: 'fresh-owner', ownerKind: 'codex', ownerLabel: 'Codex C7' });
  const reclaimedExecution = activeExecution('task-stale');
  assert.ok(reclaimedExecution);
  assert.equal(reclaimed.reused, false);
  assert.equal(reclaimed.claim.ownerLabel, 'Codex C7');
  assert.notEqual(reclaimed.claim.sessionIdHash, first.claim.sessionIdHash);
  assert.notEqual(reclaimed.claim.ownershipEpochId, first.claim.ownershipEpochId);
  assert.equal(reclaimed.claim.workspaceId, first.claim.workspaceId);
  assert.notEqual(reclaimedExecution.id, firstExecution.id);
  assert.equal(listExecutionSessionsForTask('task-stale').find((entry: any) => entry.id === firstExecution.id)?.status, 'cancelled');
  assert.equal(reclaimedExecution.lifecycle.stage, 'created');
});

test('claim reconciles one pre-fix orphan execution and preserves dirty workspace bytes', () => {
  seedTask('task-pre-fix-orphan', ['src/PreFixOrphan.ts'], undefined, 'DVF-0504');
  const workspace = workspaces.createOrReuseSessionWorkspace(claimProject, 'pre-fix-orphan-workspace', { taskDisplayId: 'DVF-0504' } as any);
  const wipPath = path.join(workspace.root, 'src', 'PreFixOrphan.ts');
  fs.mkdirSync(path.dirname(wipPath), { recursive: true });
  fs.writeFileSync(wipPath, 'export const preservedOrphanWip = 1;\n', 'utf8');
  const orphan = execution.createExecutionSession({
    projectId: claimProject.id,
    taskId: 'task-pre-fix-orphan',
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
  });
  advanceExecutionToVerifying(orphan.id, 'pre-fix-orphan');

  const claimed = claims.claimTaskForSession('task-pre-fix-orphan', { sessionId: 'pre-fix-reclaimer', ownerLabel: 'Chat Reclaimer' });
  const sessions = listExecutionSessionsForTask('task-pre-fix-orphan');
  const replacement = sessions.find((entry: any) => entry.status === 'active');

  assert.equal(claimed.claim.workspaceId, workspace.workspaceId);
  assert.ok(replacement);
  assert.notEqual(replacement.id, orphan.id);
  assert.equal(sessions.find((entry: any) => entry.id === orphan.id)?.status, 'cancelled');
  assert.equal(fs.readFileSync(wipPath, 'utf8'), 'export const preservedOrphanWip = 1;\n');
  assert.ok(listExecutionSessionEvidence(orphan.id).some((entry: any) =>
    entry.kind === 'lifecycle-reconciliation' && entry.metadata?.reasonCode === 'claim-epoch-replaced'));
});

test('claim blocks a pre-fix orphan with unresolved durable operation', () => {
  seedTask('task-pre-fix-pending', ['src/PreFixPending.ts'], undefined, 'DVF-0505');
  const workspace = workspaces.createOrReuseSessionWorkspace(claimProject, 'pre-fix-pending-workspace', { taskDisplayId: 'DVF-0505' } as any);
  const orphan = execution.createExecutionSession({
    projectId: claimProject.id,
    taskId: 'task-pre-fix-pending',
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
  });
  checkpoints.recordExecutionPendingOperationReference(orphan.id, {
    operationId: 'job-pre-fix-pending',
    evidenceId: 'evidence-pre-fix-pending',
    kind: 'run_project_command',
    status: 'running',
  });

  assert.throws(
    () => claims.claimTaskForSession('task-pre-fix-pending', { sessionId: 'pre-fix-pending-reclaimer', ownerLabel: 'Chat Pending Reclaimer' }),
    (error: any) => error?.payload?.code === 'TASK_CLAIM_PENDING_OPERATION'
      && error?.payload?.details?.operationIds?.includes('job-pre-fix-pending'),
  );
  assert.equal(getTask('task-pre-fix-pending')?.claim, undefined);
  assert.equal(getTask('task-pre-fix-pending')?.status, 'backlog');
  assert.equal(listExecutionSessionsForTask('task-pre-fix-pending').find((entry: any) => entry.id === orphan.id)?.status, 'active');
});

test('multiple active executions for one task workspace fail closed without heuristic selection', () => {
  seedTask('task-pre-fix-ambiguous', ['src/PreFixAmbiguous.ts'], undefined, 'DVF-0506');
  const workspace = workspaces.createOrReuseSessionWorkspace(claimProject, 'pre-fix-ambiguous-workspace', { taskDisplayId: 'DVF-0506' } as any);
  const first = execution.createExecutionSession({ projectId: claimProject.id, taskId: 'task-pre-fix-ambiguous', workspaceId: workspace.workspaceId, repoRoot: workspace.root, branch: workspace.branch });
  const second = execution.createExecutionSession({ projectId: claimProject.id, taskId: 'task-pre-fix-ambiguous', workspaceId: workspace.workspaceId, repoRoot: workspace.root, branch: workspace.branch });

  assert.throws(
    () => claims.claimTaskForSession('task-pre-fix-ambiguous', { sessionId: 'pre-fix-ambiguous-reclaimer', ownerLabel: 'Chat Ambiguous' }),
    (error: any) => error?.payload?.code === 'TASK_EXECUTION_RECONCILIATION_AMBIGUOUS'
      && error?.payload?.details?.executionSessionIds?.includes(first.id)
      && error?.payload?.details?.executionSessionIds?.includes(second.id),
  );
  assert.equal(listExecutionSessionsForTask('task-pre-fix-ambiguous').filter((entry: any) => entry.status === 'active').length, 2);
  assert.equal(getTask('task-pre-fix-ambiguous')?.claim, undefined);
});

test('scoped reconciliation expires only the target execution and leaves unrelated sessions active', () => {
  seedTask('task-pre-fix-expired', ['src/PreFixExpired.ts'], undefined, 'DVF-0507');
  seedTask('task-pre-fix-unrelated', ['src/PreFixUnrelated.ts'], undefined, 'DVF-0508');
  const expiredWorkspace = workspaces.createOrReuseSessionWorkspace(claimProject, 'pre-fix-expired-workspace', { taskDisplayId: 'DVF-0507' } as any);
  const unrelatedWorkspace = workspaces.createOrReuseSessionWorkspace(claimProject, 'pre-fix-unrelated-workspace', { taskDisplayId: 'DVF-0508' } as any);
  const expired = execution.createExecutionSession({
    projectId: claimProject.id,
    taskId: 'task-pre-fix-expired',
    workspaceId: expiredWorkspace.workspaceId,
    repoRoot: expiredWorkspace.root,
    branch: expiredWorkspace.branch,
    ttlMs: 1,
    now: new Date(Date.now() - 60_000),
  });
  const unrelated = execution.createExecutionSession({
    projectId: claimProject.id,
    taskId: 'task-pre-fix-unrelated',
    workspaceId: unrelatedWorkspace.workspaceId,
    repoRoot: unrelatedWorkspace.root,
    branch: unrelatedWorkspace.branch,
  });

  claims.claimTaskForSession('task-pre-fix-expired', { sessionId: 'pre-fix-expired-reclaimer', ownerLabel: 'Chat Expiry' });
  assert.equal(listExecutionSessionsForTask('task-pre-fix-expired').find((entry: any) => entry.id === expired.id)?.status, 'expired');
  assert.equal(listExecutionSessionsForTask('task-pre-fix-unrelated').find((entry: any) => entry.id === unrelated.id)?.status, 'active');
  assert.ok(listExecutionSessionEvidence(expired.id).some((entry: any) =>
    entry.kind === 'lifecycle-reconciliation' && entry.metadata?.reasonCode === 'scoped-expiry'));
});

test('active claim with missing execution recreates exactly one execution idempotently', () => {
  seedTask('task-missing-execution', ['src/MissingExecution.ts'], undefined, 'DVF-0509');
  const first = claims.claimTaskForSession('task-missing-execution', { sessionId: 'missing-execution-owner', ownerLabel: 'Chat Missing' });
  const firstExecution = activeExecution('task-missing-execution');
  assert.ok(firstExecution);
  execution.cancelExecutionSession(firstExecution.id);

  const repaired = claims.claimTaskForSession('task-missing-execution', { sessionId: 'missing-execution-owner', ownerLabel: 'Chat Missing' });
  const repeated = claims.claimTaskForSession('task-missing-execution', { sessionId: 'missing-execution-owner', ownerLabel: 'Chat Missing' });
  const active = listExecutionSessionsForTask('task-missing-execution').filter((entry: any) => entry.status === 'active');
  assert.equal(repaired.claim.ownershipEpochId, first.claim.ownershipEpochId);
  assert.equal(repeated.claim.ownershipEpochId, first.claim.ownershipEpochId);
  assert.equal(active.length, 1);
  assert.notEqual(active[0].id, firstExecution.id);
  assert.equal(execution.getExecutionSessionOwnershipEpoch(active[0].id).ownershipEpochId, first.claim.ownershipEpochId);
});

test('finalization directly reconciles stale lifecycle stage from observed terminal evidence', () => {
  seedTask('task-finalize-direct-reconcile', ['src/FinalizeDirectReconcile.ts'], undefined, 'DVF-0709');
  const claimed = claims.claimTaskForSession('task-finalize-direct-reconcile', { sessionId: 'finalize-direct-owner', ownerLabel: 'Chat Direct' });
  const before = activeExecution('task-finalize-direct-reconcile');
  assert.ok(before);
  assert.notEqual(before.lifecycle.stage, 'finalized');

  const result = claims.finalizeTaskLifecycleDisposition(
    'task-finalize-direct-reconcile',
    claimed.claim.workspaceId,
    (task: any) => ({ ...task, status: 'done' }),
    { repoRevision: 'direct-finalization-revision' },
  );

  assert.equal(result.task.status, 'done');
  const terminal = listExecutionSessionsForTask('task-finalize-direct-reconcile').find((entry: any) => entry.id === before.id)!;
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.lifecycle.stage, 'finalized');
  assert.ok(listExecutionSessionEvidence(before.id).some((entry: any) =>
    entry.kind === 'lifecycle-transition'
    && entry.metadata?.toStage === 'finalized'
    && entry.metadata?.directReconciliation === true));
});

test('finalization boundary fails closed on ambiguous active execution authority before mutating task state', () => {
  seedTask('task-finalize-authority-ambiguous', ['src/FinalizeAuthorityAmbiguous.ts'], undefined, 'DVF-0512');
  const claimed = claims.claimTaskForSession('task-finalize-authority-ambiguous', { sessionId: 'finalize-authority-owner', ownerLabel: 'Chat Finalize Authority' });
  const first = activeExecution('task-finalize-authority-ambiguous');
  assert.ok(first);
  const workspace = workspaces.resolveSessionWorkspace(claimed.claim.workspaceId)!;
  const second = execution.createExecutionSession({
    projectId: claimProject.id,
    taskId: 'task-finalize-authority-ambiguous',
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
    ownershipEpochId: claimed.claim.ownershipEpochId,
  });

  assert.throws(
    () => claims.finalizeTaskLifecycleDisposition(
      'task-finalize-authority-ambiguous',
      workspace.workspaceId,
      (task: any) => ({ ...task, status: 'done' }),
      { repoRevision: 'test-finalization-revision' },
    ),
    (error: any) => error?.payload?.code === 'TASK_LIFECYCLE_AUTHORITY_CONFLICT'
      && error?.payload?.details?.blockers?.some((entry: any) => entry.code === 'MULTIPLE_ACTIVE_EXECUTIONS'),
  );
  assert.equal(getTask('task-finalize-authority-ambiguous')?.status, 'in-progress');
  assert.equal(listExecutionSessionsForTask('task-finalize-authority-ambiguous').filter((entry: any) => entry.status === 'active').length, 2);
  assert.equal(listExecutionSessionsForTask('task-finalize-authority-ambiguous').some((entry: any) => entry.id === second.id), true);
});

test('real durable pending operation blocks normal and emergency release without partial ownership mutation', async () => {
  seedTask('task-pending-rotation', ['src/PendingRotation.ts'], undefined, 'DVF-0503');
  const claimed = claims.claimTaskForSession('task-pending-rotation', { sessionId: 'pending-owner', ownerLabel: 'Chat Pending' });
  const executionBefore = activeExecution('task-pending-rotation');
  assert.ok(executionBefore);
  const gate = deferred();
  jobService.__setToolJobTestRunner('run_project_command', async (_state: any, _args: any, _logger: any, setCancelFn: (fn: () => void) => void) => {
    setCancelFn(() => gate.resolve());
    await gate.promise;
    return { ok: true, status: 'succeeded' };
  });

  const job = jobService.enqueueToolJob({ projects: [claimProject] } as any, 'run_project_command', {
    projectId: claimProject.id,
    workspaceId: claimed.claim.workspaceId,
    command: 'typecheck',
    singleFlight: false,
  }, 'repo-command');
  try {
    await waitUntil(() => jobRepo.getJob(job.jobId)?.status === 'running', 'Expected lifecycle job to run');
    await waitUntil(
      () => checkpoints.getLatestExecutionCheckpoint(executionBefore.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId) === true,
      'Expected real durable job to populate pending execution evidence',
    );
    const claimBefore = getTask('task-pending-rotation')?.claim;

    for (const request of [
      { sessionId: 'pending-owner', nextStatus: 'todo' as const },
      { sessionId: '', nextStatus: 'todo' as const, emergency: true },
    ]) {
      assert.throws(
        () => claims.releaseTaskClaim('task-pending-rotation', request),
        (error: any) => error?.payload?.code === 'TASK_CLAIM_PENDING_OPERATION'
          && error?.payload?.details?.operationIds?.includes(job.jobId),
      );
      assert.deepEqual(getTask('task-pending-rotation')?.claim, claimBefore);
      assert.equal(activeExecution('task-pending-rotation')?.id, executionBefore.id);
    }

    const expiredTask = getTask('task-pending-rotation');
    expiredTask.claim = { ...claimBefore, expiresAt: new Date(Date.now() - 1_000).toISOString() };
    expiredTask.updatedAt = new Date().toISOString();
    saveTask(expiredTask);
    const expiredClaimBefore = getTask('task-pending-rotation')?.claim;
    assert.throws(
      () => claims.claimTaskForSession('task-pending-rotation', { sessionId: 'replacement-owner', ownerLabel: 'Chat Replacement' }),
      (error: any) => error?.payload?.code === 'TASK_CLAIM_PENDING_OPERATION'
        && error?.payload?.details?.operationIds?.includes(job.jobId),
    );
    assert.deepEqual(getTask('task-pending-rotation')?.claim, expiredClaimBefore);
    assert.equal(activeExecution('task-pending-rotation')?.id, executionBefore.id);

    assert.equal(jobService.cancelToolJob(job.jobId), true);
    gate.resolve();
    await waitUntil(() => !jobService.getJobMetrics().activeJobs.some((entry: any) => entry.jobId === job.jobId), 'Expected cancelled durable worker to exit');
    await waitUntil(
      () => checkpoints.getLatestExecutionCheckpoint(executionBefore.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId) !== true,
      'Expected terminal durable operation to reconcile pending evidence',
    );

    const replacement = claims.claimTaskForSession('task-pending-rotation', { sessionId: 'replacement-owner', ownerLabel: 'Chat Replacement' });
    const replacementExecution = activeExecution('task-pending-rotation');
    assert.ok(replacementExecution);
    assert.equal(replacement.claim.workspaceId, claimed.claim.workspaceId);
    assert.notEqual(replacement.claim.ownershipEpochId, claimed.claim.ownershipEpochId);
    assert.notEqual(replacementExecution.id, executionBefore.id);
    assert.equal(listExecutionSessionsForTask('task-pending-rotation').find((entry: any) => entry.id === executionBefore.id)?.status, 'cancelled');
    assert.equal(replacementExecution.lifecycle.stage, 'created');
  } finally {
    gate.resolve();
    jobService.__setToolJobTestRunner('run_project_command', null);
  }
});

test('status mutation auto-converges one claimless safe orphan while preserving dirty workspace bytes', () => {
  seedTask('task-status-safe-orphan', ['src/StatusSafeOrphan.ts'], undefined, 'DVF-0513');
  seedTask('task-status-unrelated', ['src/StatusUnrelated.ts'], undefined, 'DVF-0514');
  const workspace = workspaces.createOrReuseSessionWorkspace(claimProject, 'status-safe-orphan-workspace', { taskDisplayId: 'DVF-0513' } as any);
  const unrelatedWorkspace = workspaces.createOrReuseSessionWorkspace(claimProject, 'status-unrelated-workspace', { taskDisplayId: 'DVF-0514' } as any);
  const wipPath = path.join(workspace.root, 'src', 'StatusSafeOrphan.ts');
  fs.mkdirSync(path.dirname(wipPath), { recursive: true });
  fs.writeFileSync(wipPath, 'export const preservedStatusWip = 1;\n', 'utf8');
  const orphan = execution.createExecutionSession({
    projectId: claimProject.id,
    taskId: 'task-status-safe-orphan',
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
  });
  const unrelated = execution.createExecutionSession({
    projectId: claimProject.id,
    taskId: 'task-status-unrelated',
    workspaceId: unrelatedWorkspace.workspaceId,
    repoRoot: unrelatedWorkspace.root,
    branch: unrelatedWorkspace.branch,
  });

  const result = claims.mutateTaskStatusWithLifecycle(
    'task-status-safe-orphan',
    'done',
    (task: any) => ({ ...task, status: 'done' }),
    { reason: 'operator completed task presentation' },
  );

  assert.equal(result.task.status, 'done');
  assert.equal(result.disposed, true);
  assert.deepEqual(result.executionSessionIds, [orphan.id]);
  assert.equal(listExecutionSessionsForTask('task-status-safe-orphan').find((entry: any) => entry.id === orphan.id)?.status, 'cancelled');
  assert.ok(listExecutionSessionEvidence(orphan.id).some((entry: any) =>
    entry.kind === 'lifecycle-reconciliation' && entry.metadata?.reasonCode === 'status-safe-orphan-converged'));
  assert.equal(fs.readFileSync(wipPath, 'utf8'), 'export const preservedStatusWip = 1;\n');
  assert.equal(listExecutionSessionsForTask('task-status-unrelated').find((entry: any) => entry.id === unrelated.id)?.status, 'active');
});

test('claimless pending durable operation blocks status and release convergence without partial mutation', () => {
  seedTask('task-claimless-pending', ['src/ClaimlessPending.ts'], undefined, 'DVF-0516');
  const task = getTask('task-claimless-pending');
  task.status = 'in-progress';
  saveTask(task);
  const workspace = workspaces.createOrReuseSessionWorkspace(claimProject, 'claimless-pending-workspace', { taskDisplayId: 'DVF-0516' } as any);
  const orphan = execution.createExecutionSession({
    projectId: claimProject.id,
    taskId: 'task-claimless-pending',
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
  });
  checkpoints.recordExecutionPendingOperationReference(orphan.id, {
    operationId: 'job-claimless-pending',
    evidenceId: 'evidence-claimless-pending',
    kind: 'run_project_command',
    status: 'running',
  });

  assert.throws(
    () => claims.mutateTaskStatusWithLifecycle(
      'task-claimless-pending',
      'done',
      (current: any) => ({ ...current, status: 'done' }),
      { reason: 'must not cancel live durable work' },
    ),
    (error: any) => error?.payload?.code === 'TASK_LIFECYCLE_PENDING_OPERATION'
      && error?.payload?.details?.operationIds?.includes('job-claimless-pending'),
  );
  assert.throws(
    () => claims.releaseTaskClaim('task-claimless-pending', { sessionId: 'claimless-pending-release', nextStatus: 'todo' }),
    (error: any) => error?.payload?.code === 'TASK_LIFECYCLE_PENDING_OPERATION'
      && error?.payload?.details?.operationIds?.includes('job-claimless-pending'),
  );
  assert.equal(getTask('task-claimless-pending')?.status, 'in-progress');
  assert.equal(getTask('task-claimless-pending')?.claim, undefined);
  assert.equal(listExecutionSessionsForTask('task-claimless-pending').find((entry: any) => entry.id === orphan.id)?.status, 'active');
});

test('release re-entry converges one claimless safe orphan instead of leaving residual execution authority', () => {
  seedTask('task-release-safe-orphan', ['src/ReleaseSafeOrphan.ts'], undefined, 'DVF-0515');
  const task = getTask('task-release-safe-orphan');
  task.status = 'in-progress';
  saveTask(task);
  const workspace = workspaces.createOrReuseSessionWorkspace(claimProject, 'release-safe-orphan-workspace', { taskDisplayId: 'DVF-0515' } as any);
  const orphan = execution.createExecutionSession({
    projectId: claimProject.id,
    taskId: 'task-release-safe-orphan',
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
  });

  const released = claims.releaseTaskClaim('task-release-safe-orphan', { sessionId: 'safe-orphan-release', nextStatus: 'todo' });
  assert.equal(released.released, true);
  assert.equal(released.task.status, 'todo');
  assert.equal(released.task.claim, undefined);
  assert.equal(listExecutionSessionsForTask('task-release-safe-orphan').find((entry: any) => entry.id === orphan.id)?.status, 'cancelled');
  assert.ok(listExecutionSessionEvidence(orphan.id).some((entry: any) =>
    entry.kind === 'lifecycle-reconciliation' && entry.metadata?.reasonCode === 'release-safe-orphan-converged'));

  const replay = claims.releaseTaskClaim('task-release-safe-orphan', { sessionId: 'safe-orphan-release', nextStatus: 'todo' });
  assert.equal(replay.released, false);
  assert.equal(listExecutionSessionsForTask('task-release-safe-orphan').filter((entry: any) => entry.status === 'active').length, 0);
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
  seedCandidateTask(projectId, 'next-parent', ['src/Parent.ts'], { priority: 'high', status: 'todo', createdAt: '2026-08-10T00:00:00.000Z' });
  seedCandidateTask(projectId, 'next-child', ['src/Child.ts'], { parentId: 'next-parent', priority: 'medium', status: 'todo', createdAt: '2026-08-10T00:00:01.000Z' });
  seedCandidateTask(projectId, 'next-final', ['src/Final.ts'], { priority: 'high', status: 'todo', tags: ['final-gate'], createdAt: '2026-08-10T00:00:02.000Z' });
  seedCandidateTask(projectId, 'next-blocked', ['src/Blocked.ts'], { priority: 'high', status: 'todo', tags: ['depends-on:missing-task'], createdAt: '2026-08-10T00:00:02.500Z' });
  seedCandidateTask(projectId, 'next-high', ['src/High.ts'], { priority: 'high', status: 'todo', createdAt: '2026-08-10T00:00:03.000Z' });
  seedCandidateTask(projectId, 'next-low', ['src/Low.ts'], { priority: 'low', status: 'todo', createdAt: '2026-08-10T00:00:04.000Z' });

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

test('structured prerequisites block direct claim, are skipped with details by claim-next, and unlock without lane churn', () => {
  const projectId = 'project-next-prerequisites';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'prereq-foundation', ['src/Foundation.ts'], { status: 'in-progress', priority: 'high' });
  seedCandidateTask(projectId, 'prereq-dependent', ['src/Dependent.ts'], { priority: 'high', status: 'todo', prerequisiteTaskIds: ['prereq-foundation'], createdAt: '2026-08-10T00:00:01.000Z' });
  seedCandidateTask(projectId, 'prereq-parallel-a', ['src/ParallelA.ts'], { priority: 'medium', status: 'todo', createdAt: '2026-08-10T00:00:02.000Z' });
  seedCandidateTask(projectId, 'prereq-parallel-b', ['src/ParallelB.ts'], { priority: 'medium', status: 'todo', createdAt: '2026-08-10T00:00:03.000Z' });

  assert.throws(
    () => claims.claimTaskForSession('prereq-dependent', { sessionId: 'dep-direct', ownerLabel: 'Chat Dep' }),
    (error: any) => error?.payload?.code === 'TASK_PREREQUISITES_BLOCKING'
      && error?.payload?.details?.blockers?.[0]?.taskId === 'prereq-foundation',
  );

  const first = claims.claimNextTaskForSession(projectId, { sessionId: 'dep-loop-a', ownerLabel: 'Chat Loop A', limit: 10 });
  assert.equal(first.status, 'claimed');
  assert.equal(first.task.id, 'prereq-parallel-a');
  assert.equal(first.dependencyBlocked.some((entry: any) => entry.taskId === 'prereq-dependent'), true);

  const second = claims.claimNextTaskForSession(projectId, { sessionId: 'dep-loop-b', ownerLabel: 'Chat Loop B', limit: 10 });
  assert.equal(second.status, 'claimed');
  assert.equal(second.task.id, 'prereq-parallel-b');
  assert.notEqual(first.claim.workspaceId, second.claim.workspaceId, 'independent siblings remain parallel-claimable');

  const prerequisite = getTask('prereq-foundation')!;
  prerequisite.status = 'done';
  saveTask(prerequisite);
  assert.equal(getTask('prereq-dependent')?.status, 'todo', 'unlock must not require lane churn');

  const unlocked = claims.claimNextTaskForSession(projectId, { sessionId: 'dep-loop-c', ownerLabel: 'Chat Loop C', limit: 10 });
  assert.equal(unlocked.status, 'claimed');
  assert.equal(unlocked.task.id, 'prereq-dependent');
});

test('claim next defers ambiguous and conflicting scope instead of overriding it', () => {
  const projectId = 'project-next-deferred';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'next-anchor', ['src/Shared.ts'], { priority: 'high' });
  seedCandidateTask(projectId, 'next-overlap', ['src/Shared.ts'], { priority: 'high', status: 'todo' });
  seedCandidateTask(projectId, 'next-uncertain', [], { priority: 'high', status: 'todo' });
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
  seedCandidateTask(projectId, 'next-only', ['src/Only.ts'], { priority: 'high', status: 'todo' });

  const attempts = ['A', 'B', 'C', 'D', 'E'].map((label) =>
    claims.claimNextTaskForSession(projectId, { sessionId: `race-worker-${label}`, ownerLabel: `Chat ${label}`, limit: 10 }));
  const winners = attempts.filter((result: any) => result.status === 'claimed') as Array<{ status: 'claimed'; task: any }>;
  const misses = attempts.filter((result: any) => result.status === 'no-eligible');
  assert.equal(winners.length, 1);
  assert.equal(winners[0].task.id, 'next-only');
  assert.equal(misses.length, 4);
  assert.equal(getTask('next-only')?.claim?.ownerLabel, 'Chat A');
});

test('claim next partitions atomic selection before the bounded window and excludes unpartitionable tasks', () => {
  const projectId = 'project-next-partition';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'partition-other-high', ['src/PartitionOtherHigh.ts'], { priority: 'high', status: 'todo', displayId: 'NXT-099' });
  seedCandidateTask(projectId, 'partition-other-medium', ['src/PartitionOtherMedium.ts'], { priority: 'medium', status: 'todo', displayId: 'NXT-102' });
  seedCandidateTask(projectId, 'partition-target', ['src/PartitionTarget.ts'], { priority: 'low', status: 'todo', displayId: 'NXT-103' });
  seedCandidateTask(projectId, 'partition-unparseable', ['src/PartitionUnknown.ts'], { priority: 'high', status: 'todo', displayId: 'NXT-UNKNOWN' });

  const claimed = (claims.claimNextTaskForSession as any)(projectId, {
    sessionId: 'partition-worker-1', ownerLabel: 'Partition 1', partitionCount: 3, partitionIndex: 1, limit: 1,
  });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.task.id, 'partition-target');
  assert.deepEqual(claimed.partition, { count: 3, index: 1 });
  assert.equal(claimed.unpartitionable, 1);
  assert.equal(getTask('partition-other-high')?.claim, undefined);
  assert.equal(getTask('partition-unparseable')?.claim, undefined);
});

test('claim next validates partition pairs before mutation', () => {
  const projectId = 'project-next-partition-invalid';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'partition-invalid-target', ['src/PartitionInvalid.ts'], { priority: 'high', status: 'todo', displayId: 'NXT-301' });

  for (const input of [
    { partitionCount: 3 },
    { partitionIndex: 1 },
    { partitionCount: 0, partitionIndex: 0 },
    { partitionCount: 3, partitionIndex: 3 },
    { partitionCount: 3.5, partitionIndex: 1 },
  ]) {
    assert.throws(
      () => (claims.claimNextTaskForSession as any)(projectId, { sessionId: 'partition-invalid-worker', ...input }),
      (error: any) => error?.payload?.code === 'TASK_CLAIM_PARTITION_INVALID',
    );
  }
  assert.equal(getTask('partition-invalid-target')?.status, 'todo');
  assert.equal(getTask('partition-invalid-target')?.claim, undefined);
});

test('durable board loop preserves its partition across reconnects and rejects conflicting lane input', () => {
  const projectId = 'project-next-partition-loop';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'partition-loop-first', ['src/PartitionLoopFirst.ts'], { priority: 'high', status: 'todo', displayId: 'NXT-401' });
  seedCandidateTask(projectId, 'partition-loop-other', ['src/PartitionLoopOther.ts'], { priority: 'high', status: 'todo', displayId: 'NXT-402' });
  seedCandidateTask(projectId, 'partition-loop-second', ['src/PartitionLoopSecond.ts'], { priority: 'medium', status: 'todo', displayId: 'NXT-404' });

  const started = (claims.claimNextTaskForSession as any)(projectId, {
    sessionId: 'partition-loop-a', ownerLabel: 'Partition Loop A', boardLoopRequested: true,
    partitionCount: 3, partitionIndex: 2, limit: 10,
  });
  assert.equal(started.status, 'claimed');
  assert.equal(started.task.id, 'partition-loop-first');
  assert.equal(started.loop?.partitionCount, 3);
  assert.equal(started.loop?.partitionIndex, 2);

  const executionSession = listExecutionSessionsForTask('partition-loop-first').find((entry: any) => entry.status === 'active');
  assert.ok(executionSession);
  execution.completeExecutionSession(executionSession!.id);
  const first = getTask('partition-loop-first')!;
  saveTask({ ...first, status: 'done', claim: undefined, updatedAt: new Date().toISOString() });

  assert.throws(
    () => (claims.claimNextTaskForSession as any)(projectId, {
      sessionId: 'partition-loop-conflict', ownerLabel: 'Partition Loop Conflict', partitionCount: 3, partitionIndex: 0, limit: 10,
    }),
    (error: any) => error?.payload?.code === 'BOARD_LOOP_PARTITION_CONFLICT',
  );

  const reconnected = (claims.claimNextTaskForSession as any)(projectId, {
    sessionId: 'partition-loop-b', ownerLabel: 'Partition Loop B', limit: 10,
  });
  assert.equal(reconnected.status, 'claimed');
  assert.equal(reconnected.task.id, 'partition-loop-second');
  assert.deepEqual(reconnected.partition, { count: 3, index: 2 });
  assert.equal(getTask('partition-loop-other')?.claim, undefined);
});

test('runtime scope expansion reserves discovered paths without mutating targetFiles and release frees them', () => {
  seedTask('task-runtime-owner', ['src/RuntimeOwner.ts']);
  seedTask('task-runtime-contender', ['src/RuntimeShared.ts']);
  seedTask('task-runtime-expander', ['src/RuntimeOther.ts']);
  const owner = claims.claimTaskForSession('task-runtime-owner', { sessionId: 'runtime-owner', ownerLabel: 'Chat Runtime' });
  assert.throws(
    () => claims.expandTaskClaimScope('task-runtime-owner', { sessionId: 'wrong-runtime-owner', paths: ['src/RuntimeShared.ts'] }),
    (error: any) => error?.payload?.code === 'TASK_CLAIM_OWNER_MISMATCH',
  );
  const expanded = claims.expandTaskClaimScope('task-runtime-owner', { sessionId: 'runtime-owner', paths: ['SRC/RuntimeShared.ts', 'src/RuntimeShared.ts'] });
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
    () => claims.expandTaskClaimScope('task-runtime-expander', { sessionId: 'runtime-expander', paths: ['src/RuntimeShared.ts'] }),
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
  seedCandidateTask(projectId, 'runtime-candidate', ['src/RuntimeShared.ts'], { priority: 'high', status: 'todo' });
  claims.claimTaskForSession('runtime-anchor', { sessionId: 'runtime-next-owner', ownerLabel: 'Chat Runtime Next' });
  claims.expandTaskClaimScope('runtime-anchor', { sessionId: 'runtime-next-owner', paths: ['src/RuntimeShared.ts'] });
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

test('orchestration projection gives each task one durable state and keeps independent ready work available beside attention', () => {
  const projectId = 'project-orchestration-projection';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'queue-attention', ['src/QueueAttention.ts'], { priority: 'high' });
  seedCandidateTask(projectId, 'queue-dependent', ['src/QueueDependent.ts'], { priority: 'high', status: 'todo', prerequisiteTaskIds: ['queue-attention'], createdAt: '2026-08-10T00:00:01.000Z' });
  seedCandidateTask(projectId, 'queue-ready', ['src/QueueReady.ts'], { priority: 'medium', status: 'todo', createdAt: '2026-08-10T00:00:02.000Z' });
  seedCandidateTask(projectId, 'queue-ready-second', ['src/QueueReadySecond.ts'], { priority: 'low', status: 'todo', createdAt: '2026-08-10T00:00:03.000Z' });

  claims.claimTaskForSession('queue-attention', { sessionId: 'queue-attention-owner', ownerLabel: 'Chat Queue Attention' });
  const attentionExecution = listExecutionSessionsForTask('queue-attention')[0];
  assert.ok(attentionExecution);
  execution.cancelExecutionSession(attentionExecution.id);

  const firstProjection = claims.getProjectOrchestrationProjection(projectId);
  const ids = firstProjection.entries.map((entry: any) => entry.taskId);
  assert.equal(new Set(ids).size, ids.length, 'one task must have exactly one canonical orchestration entry');
  const byId = new Map(firstProjection.entries.map((entry: any) => [entry.taskId, entry]));
  assert.equal((byId.get('queue-attention') as any)?.state, 'attention');
  assert.equal((byId.get('queue-dependent') as any)?.state, 'blocked');
  assert.equal((byId.get('queue-dependent') as any)?.reasons?.[0]?.code, 'TASK_PREREQUISITES_BLOCKING');
  assert.equal((byId.get('queue-ready') as any)?.state, 'ready');
  assert.equal(firstProjection.counts.attention >= 1, true);
  assert.equal(firstProjection.counts.ready >= 2, true, 'attention on one task must not serialize independent runnable work');

  const projectedNext = firstProjection.entries.find((entry: any) => entry.state === 'ready');
  const claimedNext = claims.claimNextTaskForSession(projectId, { sessionId: 'queue-next-worker', ownerLabel: 'Chat Queue Next', limit: 10 });
  assert.equal(claimedNext.status, 'claimed');
  assert.equal(claimedNext.task.id, projectedNext?.taskId, 'claim-next and orchestration projection must share the same eligibility/order rules');

  const secondProjection = claims.getProjectOrchestrationProjection(projectId);
  assert.equal(secondProjection.entries.find((entry: any) => entry.taskId === claimedNext.task.id)?.state, 'execution');
});

test('local-native in-progress work is scheduler-visible, reserves target scope, and can yield durable attention to a replacement worker', () => {
  const projectId = 'project-external-native-scheduler';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'native-active', ['src/NativeShared.ts'], { priority: 'high', createdAt: '2026-08-10T00:00:00.000Z' });
  seedCandidateTask(projectId, 'native-conflict', ['src/NativeShared.ts'], { priority: 'high', status: 'todo', createdAt: '2026-08-10T00:00:01.000Z' });
  seedCandidateTask(projectId, 'native-safe', ['src/NativeSafe.ts'], { priority: 'medium', status: 'todo', createdAt: '2026-08-10T00:00:02.000Z' });

  externalStatus.updateExternalTaskStatus('native-active', {
    status: 'in-progress',
    worker: 'Codex Native A',
    action: 'IMPLEMENT_TASK',
    contextRef: 'ctx-native-resume',
    summary: 'editing shared native scope',
  });

  const workingProjection = claims.getProjectOrchestrationProjection(projectId);
  const active = workingProjection.entries.find((entry: any) => entry.taskId === 'native-active') as any;
  assert.equal(active?.state, 'execution');
  assert.equal(active?.reasons?.[0]?.code, 'EXTERNAL_NATIVE_WORK_IN_PROGRESS');
  assert.equal(active?.context?.externalNative?.repositoryExecutionOwner, 'worker');
  assert.equal(active?.context?.externalNative?.evidenceAuthority, 'orchestration-only');

  const claimed = claims.claimNextTaskForSession(projectId, { sessionId: 'native-parallel-chat', ownerLabel: 'Chat Native Parallel', limit: 10 });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.task.id, 'native-safe', 'overlapping managed candidate must be deferred while native worker reserves the same target file');
  assert.equal(getTask('native-conflict')?.status, 'todo');

  externalStatus.updateExternalTaskStatus('native-active', {
    status: 'in-progress',
    worker: 'Codex Native A',
    action: 'IMPLEMENT_TASK',
    resultState: 'HANDOFF_READY',
    contextRef: 'ctx-native-resume',
    summary: 'yielded after an atomic local edit',
  });
  const attentionProjection = claims.getProjectOrchestrationProjection(projectId);
  const attention = attentionProjection.entries.find((entry: any) => entry.taskId === 'native-active') as any;
  assert.equal(attention?.state, 'attention');
  assert.equal(attention?.reasons?.[0]?.code, 'EXTERNAL_NATIVE_HANDOFF_READY');
  assert.equal(attention?.context?.externalNative?.contextRef, 'ctx-native-resume');
  assert.equal(attention?.context?.externalNative?.workerReplaceable, true);

  const replacement = claims.getNextActionForSession(projectId, { sessionId: 'replacement-native-worker', limit: 10 });
  assert.equal(replacement.action, 'resolve-attention');
  assert.equal(replacement.task?.taskId, 'native-active');
});

test('stale local-native work becomes scheduler attention while retaining its target-file reservation', () => {
  const projectId = 'project-external-native-stale';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'native-stale', ['src/StaleShared.ts'], { priority: 'high' });
  seedCandidateTask(projectId, 'native-stale-conflict', ['src/StaleShared.ts'], { priority: 'medium' });

  externalStatus.updateExternalTaskStatus('native-stale', {
    status: 'in-progress',
    worker: 'Codex Native Gone',
    action: 'IMPLEMENT_TASK',
    contextRef: 'ctx-native-stale',
    summary: 'last known native edit',
  });
  const staleTask = getTask('native-stale')!;
  const prefix = '[external-task-status:v1] ';
  const lastLog = staleTask.logs.at(-1)!;
  const record = JSON.parse(String(lastLog.message).slice(prefix.length));
  const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  record.recordedAt = staleAt;
  lastLog.timestamp = staleAt;
  lastLog.message = `${prefix}${JSON.stringify(record)}`;
  saveTask(staleTask);

  const projection = claims.getProjectOrchestrationProjection(projectId);
  const stale = projection.entries.find((entry: any) => entry.taskId === 'native-stale') as any;
  const conflict = projection.entries.find((entry: any) => entry.taskId === 'native-stale-conflict') as any;
  assert.equal(stale?.state, 'attention');
  assert.equal(stale?.reasons?.[0]?.code, 'EXTERNAL_NATIVE_WORKER_STALE');
  assert.equal(stale?.context?.externalNative?.contextRef, 'ctx-native-stale');
  assert.equal(stale?.context?.externalNative?.workerReplaceable, true);
  assert.equal(conflict?.state, 'blocked');
  assert.equal(conflict?.reasons?.some((reason: any) => reason.code === 'TASK_SCOPE_CONFLICT'), true);

  const replacement = claims.getNextActionForSession(projectId, { sessionId: 'native-stale-replacement', limit: 10 });
  assert.equal(replacement.action, 'resolve-attention');
  assert.equal(replacement.task?.taskId, 'native-stale');
});

test('next action is read-only, project-pinned, and prioritizes attention over owned continuation and new work', () => {
  const projectId = 'project-next-action-attention';
  const otherProjectId = 'project-next-action-other';
  createCandidateProject(projectId);
  createCandidateProject(otherProjectId);
  seedCandidateTask(projectId, 'next-owned', ['src/NextOwned.ts'], { priority: 'medium' });
  seedCandidateTask(projectId, 'next-attention', ['src/NextAttention.ts'], { priority: 'high' });
  seedCandidateTask(projectId, 'next-ready', ['src/NextReady.ts'], { priority: 'high' });
  seedCandidateTask(otherProjectId, 'next-other-project', ['src/OtherProject.ts'], { priority: 'high' });

  claims.claimTaskForSession('next-owned', { sessionId: 'scheduler-owner', ownerLabel: 'Chat Scheduler Owner' });
  claims.claimTaskForSession('next-attention', { sessionId: 'attention-owner', ownerLabel: 'Chat Attention Owner' });
  const attentionSession = listExecutionSessionsForTask('next-attention').find((entry: any) => entry.status === 'active');
  assert.ok(attentionSession);
  execution.cancelExecutionSession(attentionSession!.id);

  const beforeReady = getTask('next-ready');
  const first = claims.getNextActionForSession(projectId, { sessionId: 'scheduler-owner', limit: 10 });
  const second = claims.getNextActionForSession(projectId, { sessionId: 'scheduler-owner', limit: 10 });
  assert.equal(first.action, 'resolve-attention');
  assert.equal(first.task?.taskId, 'next-attention');
  assert.equal(second.action, first.action);
  assert.equal(second.task?.taskId, first.task?.taskId);
  assert.equal(getTask('next-ready')?.status, beforeReady?.status, 'scheduler pull must not claim new work');
  assert.equal(JSON.stringify(first).includes('scheduler-owner'), false, 'raw caller session id must not be echoed');
  assert.equal(JSON.stringify(first).includes('next-other-project'), false, 'scheduler result must stay pinned to the selected project');
});

test('next action recovers owned durable work before recommending a fresh atomic claim', () => {
  const projectId = 'project-next-action-recovery';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'recover-owned', ['src/RecoverOwned.ts'], { priority: 'medium' });
  seedCandidateTask(projectId, 'recover-ready', ['src/RecoverReady.ts'], { priority: 'high' });
  const owned = claims.claimTaskForSession('recover-owned', { sessionId: 'recover-worker', ownerLabel: 'Chat Recover Worker' });
  const ownedSession = listExecutionSessionsForTask('recover-owned').find((entry: any) => entry.status === 'active');
  assert.ok(ownedSession);
  const jobId = 'job-next-action-recovery';
  jobRepo.createJob(jobId, 'run_project_command', {
    projectId,
    taskId: 'recover-owned',
    workspaceId: owned.claim.workspaceId,
    __executionJobBinding: {
      operationId: jobId,
      executionSessionId: ownedSession!.id,
      taskId: 'recover-owned',
      workspaceId: owned.claim.workspaceId,
      projectId,
      toolName: 'run_project_command',
    },
  }, `next-action:${jobId}`, { eagerArtifacts: false });
  checkpoints.recordExecutionPendingOperationReference(ownedSession!.id, { operationId: jobId, evidenceId: `pending-${jobId}`, kind: 'run_project_command', status: 'running' });

  const next = claims.getNextActionForSession(projectId, { sessionId: 'recover-worker', limit: 10 });
  assert.equal(next.action, 'recover-current');
  assert.equal(next.task?.taskId, 'recover-owned');
  assert.equal(next.continuation?.nextAction?.action, 'query-pending-jobs');
  assert.deepEqual(next.continuation?.jobIds, [jobId]);
  assert.equal(getTask('recover-ready')?.status, 'backlog');
});

test('next action recommends claim_next_task without mutating and reports bounded no-action when the window has no eligible task', () => {
  const projectId = 'project-next-action-new';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'new-ready', ['src/NewReady.ts'], { priority: 'high', status: 'todo' });
  const first = claims.getNextActionForSession(projectId, { sessionId: 'new-worker', limit: 10 });
  const replay = claims.getNextActionForSession(projectId, { sessionId: 'new-worker', limit: 10 });
  assert.equal(first.action, 'claim-new');
  assert.equal(first.task?.taskId, 'new-ready');
  assert.equal(first.claim?.tool, 'claim_next_task');
  assert.equal(replay.action, 'claim-new');
  assert.equal(getTask('new-ready')?.status, 'todo');

  const claimed = claims.claimNextTaskForSession(projectId, { sessionId: 'new-worker', ownerLabel: 'Chat New Worker', limit: 10 });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.task.id, 'new-ready');

  const blockedProjectId = 'project-next-action-none';
  createCandidateProject(blockedProjectId);
  seedCandidateTask(blockedProjectId, 'new-unbounded', [], { priority: 'high', status: 'todo' });
  const none = claims.getNextActionForSession(blockedProjectId, { sessionId: 'none-worker', limit: 10 });
  assert.equal(none.action, 'no-action');
  assert.deepEqual(none.reasonCodes, ['NO_ELIGIBLE_TASK']);
  assert.equal(none.blocked?.[0]?.taskId, 'new-unbounded');
});

test('automatic selection defaults to todo-only and include-backlog persists across workers', () => {
  const defaultProjectId = 'project-policy-default';
  createCandidateProject(defaultProjectId);
  seedCandidateTask(defaultProjectId, 'policy-backlog-high', ['src/PolicyBacklog.ts'], { priority: 'high', status: 'backlog' });
  seedCandidateTask(defaultProjectId, 'policy-todo-low', ['src/PolicyTodo.ts'], { priority: 'low', status: 'todo' });

  const defaultNext = claims.getNextActionForSession(defaultProjectId, { sessionId: 'policy-default-worker', limit: 10 });
  assert.equal(defaultNext.action, 'claim-new');
  assert.equal(defaultNext.task?.taskId, 'policy-todo-low');
  assert.equal(defaultNext.claim?.selectionPolicy, 'todo-only');
  const defaultClaim = claims.claimNextTaskForSession(defaultProjectId, { sessionId: 'policy-default-worker', limit: 10 });
  assert.equal(defaultClaim.status, 'claimed');
  assert.equal(defaultClaim.task.id, 'policy-todo-low');
  assert.equal(getTask('policy-backlog-high')?.status, 'backlog');

  const backlogOnlyProjectId = 'project-policy-backlog-only';
  createCandidateProject(backlogOnlyProjectId);
  seedCandidateTask(backlogOnlyProjectId, 'policy-backlog-only', ['src/PolicyBacklogOnly.ts'], { priority: 'high', status: 'backlog' });
  const backlogOnlyNext = claims.getNextActionForSession(backlogOnlyProjectId, { sessionId: 'policy-backlog-only-worker', limit: 10 });
  assert.equal(backlogOnlyNext.action, 'no-action');
  assert.deepEqual(backlogOnlyNext.reasonCodes, ['NO_ELIGIBLE_TASK']);
  const backlogOnlyClaim = claims.claimNextTaskForSession(backlogOnlyProjectId, { sessionId: 'policy-backlog-only-worker', limit: 10 });
  assert.equal(backlogOnlyClaim.status, 'no-eligible');
  assert.equal(getTask('policy-backlog-only')?.status, 'backlog');

  const includeProjectId = 'project-policy-include-backlog';
  createCandidateProject(includeProjectId);
  seedCandidateTask(includeProjectId, 'policy-include-a', ['src/PolicyIncludeA.ts'], { priority: 'high', status: 'backlog' });
  seedCandidateTask(includeProjectId, 'policy-include-b', ['src/PolicyIncludeB.ts'], { priority: 'medium', status: 'backlog' });
  const includeStarted = claims.claimNextTaskForSession(includeProjectId, {
    sessionId: 'policy-include-a', ownerLabel: 'Chat Include A', boardLoopRequested: true, selectionPolicy: 'include-backlog', limit: 10,
  });
  assert.equal(includeStarted.status, 'claimed');
  assert.equal(includeStarted.task.id, 'policy-include-a');
  assert.equal(includeStarted.loop?.selectionPolicy, 'include-backlog');

  const inheritedRead = claims.getNextActionForSession(includeProjectId, { sessionId: 'policy-include-b', limit: 10 });
  assert.equal(inheritedRead.action, 'claim-new');
  assert.equal(inheritedRead.task?.taskId, 'policy-include-b');
  assert.equal(inheritedRead.loop?.selectionPolicy, 'include-backlog');
  assert.equal(inheritedRead.claim?.selectionPolicy, 'include-backlog');
  const inheritedClaim = claims.claimNextTaskForSession(includeProjectId, { sessionId: 'policy-include-b', ownerLabel: 'Chat Include B', limit: 10 });
  assert.equal(inheritedClaim.status, 'claimed');
  assert.equal(inheritedClaim.task.id, 'policy-include-b');
  assert.equal(inheritedClaim.loop?.selectionPolicy, 'include-backlog');

  assert.throws(
    () => claims.claimNextTaskForSession(includeProjectId, { sessionId: 'policy-conflict', selectionPolicy: 'todo-only', limit: 10 }),
    (error: any) => error?.payload?.code === 'BOARD_LOOP_SELECTION_POLICY_CONFLICT',
  );
});

test('todo-only loop can stop while backlog remains after prerequisite completion', () => {
  const projectId = 'project-policy-terminal-backlog';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'policy-prerequisite', ['src/PolicyPrerequisite.ts'], { priority: 'high', status: 'todo' });
  seedCandidateTask(projectId, 'policy-dependent-backlog', ['src/PolicyDependent.ts'], { priority: 'high', status: 'backlog', prerequisiteTaskIds: ['policy-prerequisite'] });

  const started = claims.claimNextTaskForSession(projectId, {
    sessionId: 'policy-terminal-a', ownerLabel: 'Chat Terminal A', boardLoopRequested: true, limit: 10,
  });
  assert.equal(started.status, 'claimed');
  assert.equal(started.task.id, 'policy-prerequisite');
  assert.equal(started.loop?.selectionPolicy, 'todo-only');

  const prerequisiteExecution = listExecutionSessionsForTask('policy-prerequisite').find((entry: any) => entry.status === 'active');
  assert.ok(prerequisiteExecution);
  execution.completeExecutionSession(prerequisiteExecution!.id);
  const prerequisite = getTask('policy-prerequisite')!;
  saveTask({ ...prerequisite, status: 'done', claim: undefined, updatedAt: new Date().toISOString() });

  const stopRead = claims.getNextActionForSession(projectId, { sessionId: 'policy-terminal-b', limit: 10 });
  assert.equal(stopRead.action, 'confirm-loop-stop');
  assert.equal(stopRead.loop?.selectionPolicy, 'todo-only');
  assert.equal(getTask('policy-dependent-backlog')?.status, 'backlog');
  const stopped = claims.claimNextTaskForSession(projectId, { sessionId: 'policy-terminal-b', limit: 10 });
  assert.equal(stopped.status, 'no-eligible');
  assert.ok('loop' in stopped);
  assert.equal(stopped.loop?.status, 'terminal');
  assert.equal(getTask('policy-dependent-backlog')?.status, 'backlog');
});

test('shared board-loop intent resumes current work only for the same worker and lets a different worker claim distinct work', () => {
  const projectId = 'project-board-loop-resume';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'loop-current', ['src/LoopCurrent.ts'], { priority: 'high', status: 'todo' });
  seedCandidateTask(projectId, 'loop-next', ['src/LoopNext.ts'], { priority: 'medium', status: 'todo' });

  const started = (claims.claimNextTaskForSession as any)(projectId, {
    sessionId: 'loop-worker-a',
    ownerLabel: 'Chat Loop A',
    boardLoopRequested: true,
    limit: 10,
  });
  assert.equal(started.status, 'claimed');
  assert.equal(started.task.id, 'loop-current');
  assert.equal(started.loop?.status, 'active');
  assert.equal(started.loop?.projectId, projectId);
  assert.ok(started.loop?.loopId);

  const sameWorker = claims.getNextActionForSession(projectId, { sessionId: 'loop-worker-a', limit: 10 });
  assert.equal(sameWorker.action, 'continue-owned');
  assert.equal(sameWorker.task?.taskId, 'loop-current');
  assert.equal(sameWorker.loop?.loopId, started.loop.loopId);

  const differentWorker = claims.getNextActionForSession(projectId, { sessionId: 'fresh-worker-b', limit: 10 });
  assert.equal(differentWorker.action, 'claim-new');
  assert.equal(differentWorker.task?.taskId, 'loop-next');
  assert.equal(differentWorker.claim?.tool, 'claim_next_task');
  assert.equal(differentWorker.loop?.status, 'active');
  assert.equal(differentWorker.loop?.loopId, started.loop.loopId);
  assert.equal(differentWorker.loop?.projectId, projectId);
  assert.equal(getTask('loop-next')?.status, 'todo', 'scheduler pull must remain read-only for the second worker');
  assert.equal(JSON.stringify(differentWorker).includes('loop-worker-a'), false, 'shared loop state must not expose the original caller identity');

  const claimedByDifferentWorker = (claims.claimNextTaskForSession as any)(projectId, {
    sessionId: 'fresh-worker-b', ownerLabel: 'Chat Loop B', limit: 10,
  });
  assert.equal(claimedByDifferentWorker.status, 'claimed');
  assert.equal(claimedByDifferentWorker.task.id, 'loop-next');
  assert.notEqual(claimedByDifferentWorker.claim.workspaceId, started.claim.workspaceId);
  assert.equal(claimedByDifferentWorker.loop?.loopId, started.loop.loopId);

  const resumedAgain = claims.getNextActionForSession(projectId, { sessionId: 'loop-worker-a', limit: 10 });
  assert.equal(resumedAgain.action, 'continue-owned');
  assert.equal(resumedAgain.task?.taskId, 'loop-current');
});

test('shared board-loop gives three chat workers distinct tasks and presence labels', () => {
  const projectId = 'project-board-loop-three-workers';
  createCandidateProject(projectId);
  for (const [index, suffix] of ['a', 'b', 'c'].entries()) {
    seedCandidateTask(projectId, `three-worker-${suffix}`, [`src/Worker${suffix.toUpperCase()}.ts`], {
      priority: 'high', status: 'todo', createdAt: `2026-08-10T00:00:0${index + 1}.000Z`,
    });
  }

  const results = ['a', 'b', 'c'].map((suffix, index) => {
    const next = claims.getNextActionForSession(projectId, { sessionId: `three-session-${suffix}`, limit: 10 });
    assert.equal(next.action, 'claim-new');
    return (claims.claimNextTaskForSession as any)(projectId, {
      sessionId: `three-session-${suffix}`, ownerLabel: 'Chat Loop', boardLoopRequested: index === 0, limit: 10,
    });
  });

  assert.equal(results.every((entry: any) => entry.status === 'claimed'), true);
  assert.equal(new Set(results.map((entry: any) => entry.task.id)).size, 3);
  assert.equal(new Set(results.map((entry: any) => entry.claim.workspaceId)).size, 3);
  assert.equal(new Set(results.map((entry: any) => entry.claim.ownerLabel)).size, 3);
  assert.equal(results.every((entry: any) => /^Chat Loop [A-F0-9]{4}$/.test(entry.claim.ownerLabel)), true);

  const firstReconnect = claims.getNextActionForSession(projectId, { sessionId: 'three-session-a', limit: 10 });
  assert.equal(firstReconnect.action, 'continue-owned');
  assert.equal(firstReconnect.task?.taskId, results[0].task.id);
});

test('shared board-loop keeps extra workers away when one task is already owned', () => {
  const projectId = 'project-board-loop-one-task';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'one-loop-task', ['src/OneLoop.ts'], { priority: 'high', status: 'todo' });
  const owner = (claims.claimNextTaskForSession as any)(projectId, {
    sessionId: 'one-worker-a', ownerLabel: 'Chat Loop', boardLoopRequested: true, limit: 10,
  });
  assert.equal(owner.status, 'claimed');

  for (const suffix of ['b', 'c']) {
    const next = claims.getNextActionForSession(projectId, { sessionId: `one-worker-${suffix}`, limit: 10 });
    assert.equal(next.action, 'no-action');
    assert.ok(next.reasonCodes.includes('BOARD_LOOP_WORKER_OWNERSHIP_MISMATCH'));
    assert.equal(next.blocked?.[0]?.taskId, 'one-loop-task');
  }

  const miss = (claims.claimNextTaskForSession as any)(projectId, {
    sessionId: 'one-worker-b', ownerLabel: 'Chat Loop', limit: 10,
  });
  assert.equal(miss.status, 'no-eligible');
  assert.equal(miss.loop?.status, 'active');
  assert.ok(miss.loop?.reasonCodes?.includes('BOARD_LOOP_WORKER_ACTIVE'));
  assert.equal(getTask('one-loop-task')?.claim?.sessionIdHash, owner.claim.sessionIdHash);
});

test('board-loop stop remains active until requested scope is terminal, then claim-next atomically marks the loop terminal', () => {
  const projectId = 'project-board-loop-stop';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'loop-parent', [], { status: 'in-progress', priority: 'high' });
  seedCandidateTask(projectId, 'loop-child', ['src/LoopChild.ts'], { parentId: 'loop-parent', priority: 'high', status: 'todo' });

  const started = (claims.claimNextTaskForSession as any)(projectId, {
    sessionId: 'loop-stop-a',
    ownerLabel: 'Chat Loop Stop A',
    boardLoopRequested: true,
    requestedTaskId: 'loop-parent',
    limit: 10,
  });
  assert.equal(started.status, 'claimed');
  assert.equal(started.task.id, 'loop-child');
  const loopId = started.loop?.loopId;
  assert.ok(loopId);

  const childExecution = listExecutionSessionsForTask('loop-child').find((entry: any) => entry.status === 'active');
  assert.ok(childExecution);
  execution.completeExecutionSession(childExecution!.id);
  const child = getTask('loop-child')!;
  saveTask({ ...child, status: 'done', claim: undefined, updatedAt: new Date().toISOString() });

  const waiting = (claims.claimNextTaskForSession as any)(projectId, {
    sessionId: 'loop-stop-b',
    ownerLabel: 'Chat Loop Stop B',
    limit: 10,
  });
  assert.equal(waiting.status, 'no-eligible');
  assert.equal(waiting.loop?.status, 'active');
  assert.equal(waiting.loop?.loopId, loopId);
  assert.equal(waiting.loop?.requestedTaskId, 'loop-parent');
  assert.equal(waiting.loop?.stopEligible, false);
  assert.ok(waiting.loop?.reasonCodes?.includes('BOARD_LOOP_REQUESTED_SCOPE_NOT_TERMINAL'));

  const attention = claims.getNextActionForSession(projectId, { sessionId: 'loop-stop-c', limit: 10 });
  assert.equal(attention.action, 'resolve-attention');
  assert.equal(attention.task?.taskId, 'loop-parent');
  assert.ok(attention.reasonCodes.includes('BOARD_LOOP_REQUESTED_SCOPE_NOT_TERMINAL'));

  const parent = getTask('loop-parent')!;
  saveTask({ ...parent, status: 'done', updatedAt: new Date().toISOString() });
  const stopped = (claims.claimNextTaskForSession as any)(projectId, {
    sessionId: 'loop-stop-d',
    ownerLabel: 'Chat Loop Stop D',
    limit: 10,
  });
  assert.equal(stopped.status, 'no-eligible');
  assert.equal(stopped.loop?.status, 'terminal');
  assert.equal(stopped.loop?.loopId, loopId);
  assert.equal(stopped.loop?.stopEligible, true);
  assert.ok(stopped.loop?.reasonCodes?.includes('BOARD_LOOP_TERMINAL'));

  const terminalRead = claims.getNextActionForSession(projectId, { sessionId: 'loop-stop-e', limit: 10 });
  assert.equal(terminalRead.action, 'no-action');
  assert.equal(terminalRead.loop?.status, 'terminal');
  assert.equal(terminalRead.loop?.loopId, loopId);
});

test('contract-sensitive stale runtime blocks unowned scheduler selection and atomic claim until source refreshes', () => {
  const projectId = 'project-runtime-refresh-gate';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'runtime-gated-ready', ['src/RuntimeGatedReady.ts'], { priority: 'high', status: 'todo', displayId: 'NXT-900' });
  const originalHead = git(['rev-parse', 'HEAD']);
  const contractRelativePath = 'src/server/contracts/devflowContract.ts';
  const contractPath = path.join(repoRoot, ...contractRelativePath.split('/'));

  try {
    const before = claims.getNextActionForSession(projectId, { sessionId: 'runtime-gate-worker', limit: 10 });
    assert.equal(before.action, 'claim-new');
    assert.equal(before.task?.taskId, 'runtime-gated-ready');

    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    fs.writeFileSync(contractPath, 'export const runtimeGateFixture = 1;\n', 'utf8');
    git(['add', contractRelativePath]);
    git(['commit', '-m', 'contract-sensitive scheduler gap']);

    const blocked = claims.getNextActionForSession(projectId, { sessionId: 'runtime-gate-worker', limit: 10 }) as any;
    assert.equal(blocked.action, 'no-action');
    assert.deepEqual(blocked.reasonCodes, ['RUNTIME_REFRESH_REQUIRED']);
    assert.equal(blocked.blocked?.[0]?.code, 'RUNTIME_REFRESH_REQUIRED');
    assert.match(String(blocked.blocked?.[0]?.message || ''), /currently advertised|runtime refresh/i);
    assert.match(String(blocked.blocked?.[0]?.nextAction || ''), /audit|author|follow-up|card/i);

    const refused = claims.claimNextTaskForSession(projectId, { sessionId: 'runtime-gate-worker', ownerLabel: 'Chat Runtime Gate', limit: 10 }) as any;
    assert.equal(refused.status, 'no-eligible');
    assert.equal(refused.code, 'RUNTIME_REFRESH_REQUIRED');
    assert.deepEqual(refused.reasonCodes, ['RUNTIME_REFRESH_REQUIRED']);
    assert.equal(getTask('runtime-gated-ready')?.status, 'todo');
    assert.equal(listExecutionSessionsForTask('runtime-gated-ready').length, 0);

    git(['reset', '--hard', originalHead]);
    const resumed = claims.getNextActionForSession(projectId, { sessionId: 'runtime-gate-worker', limit: 10 });
    assert.equal(resumed.action, 'claim-new');
    assert.equal(resumed.task?.taskId, 'runtime-gated-ready');
  } finally {
    git(['reset', '--hard', originalHead]);
  }
});

test('owned scheduler continuation wins over the stale-contract new-work gate', () => {
  const projectId = 'project-runtime-refresh-owned-first';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'runtime-owned', ['src/RuntimeOwned.ts'], { priority: 'medium', status: 'todo', displayId: 'NXT-902' });
  seedCandidateTask(projectId, 'runtime-owned-ready', ['src/RuntimeOwnedReady.ts'], { priority: 'high', status: 'todo', displayId: 'NXT-903' });
  claims.claimTaskForSession('runtime-owned', { sessionId: 'runtime-owned-worker', ownerLabel: 'Chat Runtime Owned' });
  const originalHead = git(['rev-parse', 'HEAD']);
  const contractRelativePath = 'src/server/contracts/devflowContract.ts';
  const contractPath = path.join(repoRoot, ...contractRelativePath.split('/'));

  try {
    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    fs.writeFileSync(contractPath, 'export const runtimeOwnedFixture = 1;\n', 'utf8');
    git(['add', contractRelativePath]);
    git(['commit', '-m', 'contract-sensitive owned-work gap']);

    const owned = claims.getNextActionForSession(projectId, { sessionId: 'runtime-owned-worker', limit: 10 });
    assert.equal(owned.action, 'continue-owned');
    assert.equal(owned.task?.taskId, 'runtime-owned');
    assert.equal(owned.reasonCodes.includes('RUNTIME_REFRESH_REQUIRED'), false);

    const duplicateClaim = claims.claimNextTaskForSession(projectId, { sessionId: 'runtime-owned-worker', ownerLabel: 'Chat Runtime Owned', limit: 10 }) as any;
    assert.equal(duplicateClaim.status, 'no-eligible');
    assert.equal(duplicateClaim.reasonCodes.includes('RUNTIME_REFRESH_REQUIRED'), false);

    const freshWorker = claims.getNextActionForSession(projectId, { sessionId: 'runtime-unowned-worker', limit: 10 }) as any;
    assert.equal(freshWorker.action, 'no-action');
    assert.deepEqual(freshWorker.reasonCodes, ['RUNTIME_REFRESH_REQUIRED']);
  } finally {
    git(['reset', '--hard', originalHead]);
  }
});

test('docs-only stale source preserves partitioned scheduler selection and claim behavior', () => {
  const projectId = 'project-runtime-refresh-docs-only';
  createCandidateProject(projectId);
  seedCandidateTask(projectId, 'runtime-docs-even', ['src/RuntimeDocsEven.ts'], { priority: 'high', status: 'todo', displayId: 'NXT-910' });
  seedCandidateTask(projectId, 'runtime-docs-odd', ['src/RuntimeDocsOdd.ts'], { priority: 'high', status: 'todo', displayId: 'NXT-911' });
  const originalHead = git(['rev-parse', 'HEAD']);
  const docsRelativePath = 'docs/runtime-refresh-note.md';
  const docsPath = path.join(repoRoot, ...docsRelativePath.split('/'));

  try {
    fs.mkdirSync(path.dirname(docsPath), { recursive: true });
    fs.writeFileSync(docsPath, 'docs-only scheduler drift\n', 'utf8');
    git(['add', docsRelativePath]);
    git(['commit', '-m', 'docs-only scheduler gap']);

    const next = claims.getNextActionForSession(projectId, {
      sessionId: 'runtime-docs-worker', limit: 10, partitionCount: 2, partitionIndex: 1,
    });
    assert.equal(next.action, 'claim-new');
    assert.equal(next.task?.taskId, 'runtime-docs-odd');
    assert.equal(next.reasonCodes.includes('RUNTIME_REFRESH_REQUIRED'), false);

    const claimed = claims.claimNextTaskForSession(projectId, {
      sessionId: 'runtime-docs-worker', ownerLabel: 'Chat Runtime Docs', limit: 10, partitionCount: 2, partitionIndex: 1,
    }) as any;
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.task.id, 'runtime-docs-odd');
    assert.equal(claimed.partition?.count, 2);
    assert.equal(claimed.partition?.index, 1);
  } finally {
    git(['reset', '--hard', originalHead]);
  }
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
