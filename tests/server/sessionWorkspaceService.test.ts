import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  cleanupSessionWorkspace,
  createOrReuseSessionWorkspace,
  resolveSessionWorkspace,
  resetSessionWorkspaceRuntimeForTests,
} from '../../src/server/services/sessionWorkspaceService.js';

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
  assert.equal(fs.existsSync(workspace.root), false);
});
