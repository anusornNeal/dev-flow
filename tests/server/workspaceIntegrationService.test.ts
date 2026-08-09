import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createOrReuseSessionWorkspace, resetSessionWorkspaceRuntimeForTests } from '../../src/server/services/sessionWorkspaceService.js';
import {
  abortWorkspaceIntegration,
  integrateWorkspaceCommits,
  retryWorkspaceIntegration,
} from '../../src/server/services/workspaceIntegrationService.js';

function git(root: string, args: string[], allowFailure = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return { status: result.status ?? -1, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

function repoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-repo-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(root, 'shared.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'base-only.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['remote', 'add', 'origin', 'https://invalid.example/devflow/no-network.git']);
  return root;
}

function project(root: string) {
  return { id: `project-${path.basename(root)}`, name: 'Fixture', localPath: root, repoUrl: 'https://invalid.example/devflow/no-network.git' } as any;
}

function commitFile(root: string, file: string, content: string, message: string) {
  fs.writeFileSync(path.join(root, file), content);
  git(root, ['add', file]);
  git(root, ['commit', '-m', message]);
}

test('clean committed workspace integrates locally with source/base evidence and no network', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-runtime-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root), 'chat-clean');
  commitFile(workspace.root, 'workspace.txt', 'one\n', 'workspace one');
  commitFile(workspace.root, 'workspace-2.txt', 'two\n', 'workspace two');

  const before = git(root, ['rev-parse', 'HEAD']).stdout;
  const result = integrateWorkspaceCommits(workspace.workspaceId);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.strategy, 'merge');
  assert.equal(result.baseHeadBefore, before);
  assert.notEqual(result.baseHeadAfter, before);
  assert.equal(result.sourceCommits.length, 2);
  assert.deepEqual(result.changedFiles.sort(), ['workspace-2.txt', 'workspace.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'workspace.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\n');
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.equal(git(root, ['rev-parse', '--verify', workspace.branch]).status, 0);
});

test('dirty base blocks integration before mutation', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-dirty-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root), 'chat-dirty');
  commitFile(workspace.root, 'workspace.txt', 'one\n', 'workspace one');
  fs.appendFileSync(path.join(root, 'base-only.txt'), 'dirty\n');
  const before = git(root, ['rev-parse', 'HEAD']).stdout;
  assert.throws(() => integrateWorkspaceCommits(workspace.workspaceId), /dirty/i);
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, before);
});

test('rewritten base history blocks stale workspace integration before merge mutation', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-rewritten-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root), 'chat-rewritten');
  commitFile(workspace.root, 'workspace.txt', 'one\n', 'workspace one');

  const originalBranch = workspace.baseBranch;
  git(root, ['checkout', '--orphan', 'rewritten-base']);
  for (const entry of fs.readdirSync(root)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(root, 'rewritten.txt'), 'new root\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'rewritten root']);
  git(root, ['branch', '-D', originalBranch]);
  git(root, ['branch', '-m', originalBranch]);
  const before = git(root, ['rev-parse', 'HEAD']).stdout;

  assert.throws(() => integrateWorkspaceCommits(workspace.workspaceId), /no longer descends|rewritten/i);
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, before);
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
});

test('same-line conflict returns INTEGRATION_CONFLICT and abort restores clean base', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-conflict-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root), 'chat-conflict');
  commitFile(workspace.root, 'shared.txt', 'workspace\n', 'workspace change');
  commitFile(root, 'shared.txt', 'base changed\n', 'base change');
  const baseHeadBefore = git(root, ['rev-parse', 'HEAD']).stdout;

  const conflict = integrateWorkspaceCommits(workspace.workspaceId);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.code, 'INTEGRATION_CONFLICT');
  assert.deepEqual(conflict.conflictedPaths, ['shared.txt']);
  assert.equal(conflict.baseHeadBefore, baseHeadBefore);
  assert.equal(conflict.sourceHead, git(workspace.root, ['rev-parse', 'HEAD']).stdout);
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, baseHeadBefore);
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.equal(git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).status, 1);
  assert.equal(git(workspace.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).status, 0);

  const unrelated = createOrReuseSessionWorkspace(project(root), 'chat-unrelated');
  commitFile(unrelated.root, 'unrelated.txt', 'unrelated\n', 'unrelated change');
  const unrelatedResult = integrateWorkspaceCommits(unrelated.workspaceId);
  assert.equal(unrelatedResult.status, 'succeeded');
  assert.equal(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8').replace(/\r\n/g, '\n'), 'unrelated\n');
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  const baseHeadAfterUnrelated = git(root, ['rev-parse', 'HEAD']).stdout;
  assert.notEqual(baseHeadAfterUnrelated, baseHeadBefore);

  const aborted = abortWorkspaceIntegration(workspace.workspaceId);
  assert.equal(aborted.status, 'aborted');
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, baseHeadAfterUnrelated);
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.equal(fs.existsSync(workspace.root), true);
});

test('retry completes a deliberately resolved conflict without losing source commits', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-retry-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root), 'chat-retry');
  commitFile(workspace.root, 'shared.txt', 'workspace\n', 'workspace change');
  commitFile(root, 'shared.txt', 'base changed\n', 'base change');
  const conflict = integrateWorkspaceCommits(workspace.workspaceId);
  assert.equal(conflict.status, 'conflict');

  fs.writeFileSync(path.join(workspace.root, 'shared.txt'), 'resolved\n');
  git(workspace.root, ['add', 'shared.txt']);
  const retried = retryWorkspaceIntegration(workspace.workspaceId);
  assert.equal(retried.status, 'succeeded');
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8').replace(/\r\n/g, '\n'), 'resolved\n');
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.equal(git(workspace.root, ['status', '--porcelain']).stdout, '');
  assert.equal(git(workspace.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).status, 1);
  assert.equal(git(root, ['cat-file', '-e', `${conflict.sourceHead}^{commit}`]).status, 0);
});
