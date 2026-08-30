import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import db from '../../src/db/index.js';
import { executeAllMigrations } from '../../src/db/migrations/index.js';
import { createExecutionSessionRecord, updateExecutionSessionRecord } from '../../src/server/repositories/executionSessionRepository.js';
import { recordExecutionPendingOperationReference, reconcileExecutionPendingOperationReference } from '../../src/server/services/executionCheckpointService.js';
import {
  __setSessionWorkspaceCleanupBeforeRemovalHookForTests,
  classifySessionWorkspaceTaskMatch,
  cleanupManagedWorkspaceBranches,
  cleanupSessionWorkspace,
  createOrReuseSessionWorkspace,
  findSessionWorkspaceRecoveryCandidatesForTask,
  listSessionWorkspaceMetadataForRecovery,
  resolveSessionWorkspace,
  resetSessionWorkspaceRuntimeForTests,
} from '../../src/server/services/sessionWorkspaceService.js';

const lifecycleDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-lifecycle-db-'));
process.env.DEVFLOW_DB_PATH = path.join(lifecycleDbRoot, 'devflow.db');
executeAllMigrations();
let lifecycleFixtureCounter = 0;

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-repo-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

function project(root: string) {
  return { id: 'project-workspace-test', name: 'Workspace Test', localPath: root, repoUrl: 'https://example.test/workspace.git' } as any;
}

function addActiveClaim(workspace: { workspaceId: string }, label: string) {
  lifecycleFixtureCounter += 1;
  const taskId = `workspace-cleanup-task-${label}-${lifecycleFixtureCounter}`;
  const now = new Date().toISOString();
  const claim = {
    ownerKind: 'chat',
    ownerLabel: `test-${label}`,
    sessionIdHash: `hash-${label}`,
    workspaceId: workspace.workspaceId,
    ownershipEpochId: `epoch-${label}-${lifecycleFixtureCounter}`,
    claimedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  db.prepare('INSERT INTO tasks (id, displayId, title, projectId, status, createdAt, updatedAt, claim) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, `TEST-${lifecycleFixtureCounter}`, `Lifecycle ${label}`, 'project-workspace-test', 'in-progress', now, now, JSON.stringify(claim));
  return taskId;
}

function removeLifecycleTask(taskId: string) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
}

function createWorkspaceExecution(workspace: { workspaceId: string; projectId: string; branch: string; baseRevision: string }, label: string, status: 'active' | 'cancelled' | 'completed' = 'active') {
  lifecycleFixtureCounter += 1;
  const now = new Date().toISOString();
  return createExecutionSessionRecord({
    id: `workspace-cleanup-exec-${label}-${lifecycleFixtureCounter}`,
    projectId: workspace.projectId,
    taskId: null,
    workspaceId: workspace.workspaceId,
    branch: workspace.branch,
    baseRevision: workspace.baseRevision,
    repoRevision: workspace.baseRevision,
    status,
    contextHandle: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    endedAt: status === 'active' ? null : now,
  });
}

function completeWorkspaceExecution(sessionId: string) {
  const now = new Date().toISOString();
  updateExecutionSessionRecord(sessionId, { status: 'completed', updatedAt: now, endedAt: now });
}

test('two session ids create distinct opaque workspaces and same session reuses its worktree', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-runtime-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const first = createOrReuseSessionWorkspace(project(repo), 'chat-a');
  const same = createOrReuseSessionWorkspace(project(repo), 'chat-a');
  const second = createOrReuseSessionWorkspace(project(repo), 'chat-b');

  assert.match(first.workspaceId, /^ws_[a-f0-9]{16}$/);
  assert.equal(same.workspaceId, first.workspaceId);
  assert.equal(same.root, first.root);
  assert.notEqual(second.workspaceId, first.workspaceId);
  assert.notEqual(second.root, first.root);
  assert.notEqual(second.branch, first.branch);
  assert.equal(fs.existsSync(path.join(first.root, 'README.md')), true);
  assert.equal(resolveSessionWorkspace(first.workspaceId)?.root, first.root);
});

test('same session creates distinct task-owned workspaces while standalone reuse stays session-scoped', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-task-identity-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const standalone = createOrReuseSessionWorkspace(project(repo), 'shared-chat');
  const standaloneAgain = createOrReuseSessionWorkspace(project(repo), 'shared-chat');
  assert.equal(standaloneAgain.workspaceId, standalone.workspaceId);
  assert.match(standalone.branch, /^devflow\/ws\//);

  const taskA = createOrReuseSessionWorkspace(project(repo), 'task-chat', { taskDisplayId: 'DVF-0489' });
  const taskB = createOrReuseSessionWorkspace(project(repo), 'task-chat', { taskDisplayId: 'DVF-0490' });
  const taskAAgain = createOrReuseSessionWorkspace(project(repo), 'task-chat', { taskDisplayId: 'DVF-0489' });

  assert.notEqual(taskA.workspaceId, taskB.workspaceId);
  assert.notEqual(taskA.root, taskB.root);
  assert.notEqual(taskA.branch, taskB.branch);
  assert.equal(path.basename(taskA.root), '0489');
  assert.equal(path.basename(taskB.root), '0490');
  assert.equal(taskA.branch, '0489');
  assert.equal(taskB.branch, '0490');
  assert.equal(taskAAgain.workspaceId, taskA.workspaceId);
  assert.equal(taskAAgain.root, taskA.root);
});

test('recovery metadata exposes exact task identity without leaking workspace paths or session identity', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-recovery-identity-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(repo), 'recovery-identity-chat', { taskDisplayId: 'DVF-0607' });

  const registry = listSessionWorkspaceMetadataForRecovery('project-workspace-test', 50);
  const metadata = registry.workspaces.find((candidate) => candidate.workspaceId === workspace.workspaceId);
  assert.ok(metadata);
  assert.equal(metadata.taskDisplayId, 'DVF-0607');
  assert.equal(metadata.taskRootLeaf, '0607');
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'root'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'projectRoot'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'sessionIdHash'), false);

  const discovery = findSessionWorkspaceRecoveryCandidatesForTask('project-workspace-test', 'DVF-0607', 50);
  assert.deepEqual(discovery.exactMatches.map((candidate) => candidate.workspaceId), [workspace.workspaceId]);
  assert.deepEqual(discovery.legacyMatches, []);
  assert.equal(classifySessionWorkspaceTaskMatch(metadata, 'project-workspace-test', 'DVF-0607'), 'exact');
  assert.equal(classifySessionWorkspaceTaskMatch(metadata, 'project-workspace-test', 'BSA-0607'), 'incompatible');

  const legacyOnly = { ...metadata, taskDisplayId: undefined, taskRootLeaf: '0607' };
  assert.equal(classifySessionWorkspaceTaskMatch(legacyOnly, 'project-workspace-test', 'DVF-0607'), 'legacy-compatible');
  assert.equal(classifySessionWorkspaceTaskMatch(legacyOnly, 'project-workspace-test', 'BSA-0607'), 'legacy-compatible');
});

test('task-owned numeric branch collisions fail closed and clean task workspaces can remove their branch', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-task-branch-collision-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  git(repo, ['branch', '0499']);

  assert.throws(
    () => createOrReuseSessionWorkspace(project(repo), 'collision-chat', { taskDisplayId: 'DVF-0499' }),
    (error: any) => error?.payload?.code === 'WORKSPACE_BRANCH_COLLISION',
  );

  const taskWorkspace = createOrReuseSessionWorkspace(project(repo), 'cleanup-task-chat', { taskDisplayId: 'DVF-0502' });
  assert.equal(taskWorkspace.branch, '0502');
  const result = cleanupSessionWorkspace(taskWorkspace.workspaceId);
  assert.equal(result.removed, true);
  assert.equal(result.branchRemoved, true);
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/0502'], { cwd: repo, shell: false }).status, 0);
});

test('task-aware creation preserves a dirty legacy session workspace instead of reusing or deleting it', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-legacy-preserve-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const legacy = createOrReuseSessionWorkspace(project(repo), 'legacy-shared-chat');
  fs.appendFileSync(path.join(legacy.root, 'README.md'), 'legacy dirty\n');

  const taskWorkspace = createOrReuseSessionWorkspace(project(repo), 'legacy-shared-chat', { taskDisplayId: 'DVF-0491' });

  assert.notEqual(taskWorkspace.workspaceId, legacy.workspaceId);
  assert.notEqual(taskWorkspace.root, legacy.root);
  assert.equal(path.basename(taskWorkspace.root), '0491');
  assert.equal(fs.existsSync(legacy.root), true);
  assert.match(fs.readFileSync(path.join(legacy.root, 'README.md'), 'utf8'), /legacy dirty/);
});

test('workspace metadata can be rediscovered after runtime reset without duplicating the worktree', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-restart-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const created = createOrReuseSessionWorkspace(project(repo), 'restart-chat');
  resetSessionWorkspaceRuntimeForTests();
  const rediscovered = createOrReuseSessionWorkspace(project(repo), 'restart-chat');
  assert.equal(rediscovered.root, created.root);
  assert.equal(rediscovered.branch, created.branch);
  const worktreeList = git(repo, ['worktree', 'list', '--porcelain']);
  assert.equal(worktreeList.split(`branch refs/heads/${created.branch}`).length - 1, 1);
});

test('normal cleanup purges stale registry metadata when both worktree and managed branch are already gone', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-stale-registry-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(repo), 'stale-registry-chat');

  git(repo, ['worktree', 'remove', workspace.root]);
  git(repo, ['branch', '-D', workspace.branch]);
  assert.equal(fs.existsSync(workspace.root), false);
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: repo, shell: false }).status, 0);
  assert.equal(listSessionWorkspaceMetadataForRecovery(workspace.projectId, 100, 0).workspaces.some((entry) => entry.workspaceId === workspace.workspaceId), true);

  const result = cleanupSessionWorkspace(workspace.workspaceId);
  assert.equal(result.removed, true);
  assert.equal(result.branchRemoved, false);
  assert.equal(result.branchDisposition, 'stale-registry');
  assert.equal(listSessionWorkspaceMetadataForRecovery(workspace.projectId, 100, 0).workspaces.some((entry) => entry.workspaceId === workspace.workspaceId), false);
  assert.deepEqual(cleanupSessionWorkspace(workspace.workspaceId), { removed: false, reason: 'not-found' });
});


test('normal cleanup refuses dirty workspace and clean cleanup removes worktree', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-cleanup-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(repo), 'cleanup-chat');
  fs.appendFileSync(path.join(workspace.root, 'README.md'), 'dirty\n');
  assert.throws(() => cleanupSessionWorkspace(workspace.workspaceId), /dirty/i);
  git(workspace.root, ['checkout', '--', 'README.md']);
  const result = cleanupSessionWorkspace(workspace.workspaceId);
  assert.equal(result.removed, true);
  assert.equal(result.branchRemoved, true);
  assert.equal(fs.existsSync(workspace.root), false);
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: repo, shell: false }).status, 0);
  assert.deepEqual(cleanupSessionWorkspace(workspace.workspaceId), { removed: false, reason: 'not-found' });
});

test('normal cleanup preserves a stale-root registry when its managed branch still has unique commits', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-stale-unique-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(repo), 'stale-unique-chat');
  fs.writeFileSync(path.join(workspace.root, 'unique.txt'), 'unique\n');
  git(workspace.root, ['add', 'unique.txt']);
  git(workspace.root, ['commit', '-m', 'unique stale workspace commit']);
  git(repo, ['worktree', 'remove', workspace.root]);

  assert.equal(fs.existsSync(workspace.root), false);
  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: repo, shell: false }).status, 0);
  assert.throws(
    () => cleanupSessionWorkspace(workspace.workspaceId),
    (error: any) => error?.payload?.code === 'WORKSPACE_UNINTEGRATED_COMMITS'
      && error?.payload?.details?.disposition === 'unique-commits',
  );
  assert.equal(listSessionWorkspaceMetadataForRecovery(workspace.projectId, 100, 0).workspaces.some((entry) => entry.workspaceId === workspace.workspaceId), true);
  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: repo, shell: false }).status, 0);
});

test('normal cleanup rejects an active durable claim even after in-memory workspace refs are reset', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-active-claim-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(repo), 'active-claim-chat');
  resetSessionWorkspaceRuntimeForTests();
  const taskId = addActiveClaim(workspace, 'active-claim');

  assert.throws(
    () => cleanupSessionWorkspace(workspace.workspaceId),
    (error: any) => error?.payload?.code === 'WORKSPACE_LIFECYCLE_AUTHORITY_ACTIVE',
  );
  assert.equal(fs.existsSync(workspace.root), true);

  removeLifecycleTask(taskId);
  assert.equal(cleanupSessionWorkspace(workspace.workspaceId).removed, true);
});

test('normal cleanup rejects active execution ownership without a task claim', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-active-execution-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(repo), 'active-execution-chat');
  resetSessionWorkspaceRuntimeForTests();
  const execution = createWorkspaceExecution(workspace, 'active-execution');

  assert.throws(
    () => cleanupSessionWorkspace(workspace.workspaceId),
    (error: any) => error?.payload?.code === 'WORKSPACE_LIFECYCLE_AUTHORITY_ACTIVE',
  );
  assert.equal(fs.existsSync(workspace.root), true);

  completeWorkspaceExecution(execution.id);
  assert.equal(cleanupSessionWorkspace(workspace.workspaceId).removed, true);
});

test('unresolved durable operation blocks cleanup even after its execution is no longer active', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-pending-operation-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(repo), 'pending-operation-chat');
  const execution = createWorkspaceExecution(workspace, 'pending-operation');
  recordExecutionPendingOperationReference(execution.id, {
    operationId: 'op-pending-cleanup',
    evidenceId: 'evidence-pending-cleanup',
    kind: 'repo-command',
    status: 'running',
  });
  const endedAt = new Date().toISOString();
  updateExecutionSessionRecord(execution.id, { status: 'cancelled', updatedAt: endedAt, endedAt });

  assert.throws(
    () => cleanupSessionWorkspace(workspace.workspaceId),
    (error: any) => error?.payload?.code === 'WORKSPACE_LIFECYCLE_AUTHORITY_ACTIVE'
      && error?.payload?.details?.pendingOperations?.some((entry: any) => entry.operationId === 'op-pending-cleanup'),
  );
  assert.equal(fs.existsSync(workspace.root), true);

  reconcileExecutionPendingOperationReference(execution.id, 'op-pending-cleanup');
  assert.equal(cleanupSessionWorkspace(workspace.workspaceId).removed, true);
});

test('cleanup rechecks lifecycle authority immediately before deletion and fails closed on an interleaved claim', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-cleanup-race-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(repo), 'cleanup-race-chat');
  let injectedTaskId: string | null = null;
  __setSessionWorkspaceCleanupBeforeRemovalHookForTests(() => {
    injectedTaskId = addActiveClaim(workspace, 'cleanup-race');
  });

  try {
    assert.throws(
      () => cleanupSessionWorkspace(workspace.workspaceId),
      (error: any) => error?.payload?.code === 'WORKSPACE_LIFECYCLE_AUTHORITY_ACTIVE',
    );
  } finally {
    __setSessionWorkspaceCleanupBeforeRemovalHookForTests(null);
  }
  assert.equal(fs.existsSync(workspace.root), true);
  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: repo, shell: false }).status, 0);

  assert.ok(injectedTaskId);
  removeLifecycleTask(injectedTaskId!);
  assert.equal(cleanupSessionWorkspace(workspace.workspaceId).removed, true);
});

test('managed branch cleanup preserves a branch with active durable execution authority even if its worktree disappeared', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-branch-authority-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(repo), 'branch-authority-chat');
  const execution = createWorkspaceExecution(workspace, 'branch-authority');
  git(repo, ['worktree', 'remove', workspace.root]);

  const blocked = cleanupManagedWorkspaceBranches(project(repo));
  assert.deepEqual(blocked.removed, []);
  assert.equal(blocked.preserved.some((entry) => entry.branch === workspace.branch && entry.disposition === 'lifecycle-authority-active'), true);
  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: repo, shell: false }).status, 0);

  completeWorkspaceExecution(execution.id);
  const cleaned = cleanupManagedWorkspaceBranches(project(repo));
  assert.equal(cleaned.removed.some((entry) => entry.branch === workspace.branch), true);
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: repo, shell: false }).status, 0);
});

test('normal cleanup preserves clean workspace with unique commits', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-unique-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(repo), 'unique-chat');
  fs.writeFileSync(path.join(workspace.root, 'unique.txt'), 'unique\n');
  git(workspace.root, ['add', 'unique.txt']);
  git(workspace.root, ['commit', '-m', 'unique workspace commit']);

  assert.throws(() => cleanupSessionWorkspace(workspace.workspaceId), /unique|unintegrated/i);
  assert.equal(fs.existsSync(workspace.root), true);
  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: repo, shell: false }).status, 0);
});
