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

function project(root: string, gitWorkflowPolicy?: Record<string, unknown>) {
  return {
    id: `project-${path.basename(root)}`,
    name: 'Fixture',
    localPath: root,
    repoUrl: 'https://invalid.example/devflow/no-network.git',
    gitWorkflowPolicy,
  } as any;
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
  assert.equal(result.strategy, 'rebase-ff');
  assert.equal(result.baseHeadBefore, before);
  assert.notEqual(result.baseHeadAfter, before);
  assert.equal(result.sourceCommits.length, 2);
  const integratedParents = git(root, ['rev-list', '--parents', `${before}..${result.baseHeadAfter}`]).stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(integratedParents.length, 2);
  assert.equal(integratedParents.every((line) => line.trim().split(/\s+/).length === 2), true, 'default integration must preserve linear commits without a merge bubble');
  assert.deepEqual(result.changedFiles.sort(), ['workspace-2.txt', 'workspace.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'workspace.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\n');
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.equal(git(root, ['rev-parse', '--verify', workspace.branch]).status, 0);
});

test('task-owned workspace rejects malformed commit subjects before integration', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-task-branch-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root), 'chat-task-branch', { taskDisplayId: 'CARD-0801' });
  assert.equal(workspace.branch, '0801');
  commitFile(workspace.root, 'task-branch.txt', 'task branch\n', 'task branch change');

  assert.throws(
    () => integrateWorkspaceCommits(workspace.workspaceId, { task: { displayId: 'CARD-0801', projectId: workspace.projectId } }),
    (error: any) => error?.payload?.code === 'TASK_COMMIT_SUBJECT_INVALID' && /commit_task_owned_changes/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(root, 'task-branch.txt')), false);
});

test('task-owned workspace integrates canonical subjects with custom policy and Jira ticket context', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-task-policy-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const gitWorkflowPolicy = { commitMessageTemplate: '{ticket}::{type}::{title}' };
  const workspace = createOrReuseSessionWorkspace(project(root, gitWorkflowPolicy), 'chat-task-policy', { taskDisplayId: 'CARD-0802' });
  commitFile(workspace.root, 'task-policy.txt', 'task policy\n', 'QCA-9002::fix::preserve policy');

  const result = integrateWorkspaceCommits(workspace.workspaceId, {
    task: { displayId: 'CARD-0802', jiraKey: 'QCA-9002', projectId: workspace.projectId },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(fs.readFileSync(path.join(root, 'task-policy.txt'), 'utf8').replace(/\r\n/g, '\n'), 'task policy\n');
});

test('advanced base rebases workspace commits and fast-forwards linearly', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-advanced-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root), 'chat-advanced');
  commitFile(workspace.root, 'workspace.txt', 'one\n', 'workspace one');
  commitFile(workspace.root, 'workspace-2.txt', 'two\n', 'workspace two');
  commitFile(root, 'base-only.txt', 'base\nadvanced\n', 'advance base');
  const baseHeadBefore = git(root, ['rev-parse', 'HEAD']).stdout;
  const originalSourceHead = git(workspace.root, ['rev-parse', 'HEAD']).stdout;

  const result = integrateWorkspaceCommits(workspace.workspaceId);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.strategy, 'rebase-ff');
  assert.equal(result.baseHeadBefore, baseHeadBefore);
  assert.equal(result.sourceHead, originalSourceHead);
  assert.notEqual(result.baseHeadAfter, originalSourceHead);
  assert.equal(git(root, ['merge-base', '--is-ancestor', baseHeadBefore, result.baseHeadAfter]).status, 0);
  const integratedParents = git(root, ['rev-list', '--parents', `${baseHeadBefore}..${result.baseHeadAfter}`]).stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(integratedParents.length, 2);
  assert.equal(integratedParents.every((line) => line.trim().split(/\s+/).length === 2), true);
  assert.equal(fs.readFileSync(path.join(root, 'base-only.txt'), 'utf8').replace(/\r\n/g, '\n'), 'base\nadvanced\n');
  assert.equal(fs.readFileSync(path.join(root, 'workspace.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\n');
  const repeated = integrateWorkspaceCommits(workspace.workspaceId);
  assert.equal(repeated.status, 'succeeded');
  assert.equal(repeated.alreadyIntegrated, true);
  assert.equal(repeated.baseHeadAfter, result.baseHeadAfter);
  assert.equal(repeated.sourceCommits.length, 0, 'already-integrated evidence must not reclassify advanced-base commits as workspace commits');
  assert.equal(repeated.integratedCommits.length, 0);
});

test('recreated patch-equivalent workspace is recognized without replaying an empty commit', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-equivalent-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root), 'chat-equivalent');
  commitFile(workspace.root, 'workspace.txt', 'same patch\n', 'old workspace implementation');
  const sourceHead = git(workspace.root, ['rev-parse', 'HEAD']).stdout;
  commitFile(root, 'workspace.txt', 'same patch\n', 'recreated implementation on latest develop');
  const baseHeadBefore = git(root, ['rev-parse', 'HEAD']).stdout;
  assert.notEqual(sourceHead, baseHeadBefore);

  const result = integrateWorkspaceCommits(workspace.workspaceId);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.alreadyIntegrated, true);
  assert.equal(result.patchEquivalent, true);
  assert.equal(result.baseHeadBefore, baseHeadBefore);
  assert.equal(result.baseHeadAfter, baseHeadBefore, 'patch-equivalent recovery must not add an empty/replayed commit');
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, baseHeadBefore);
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
});

test('explicit merge policy preserves merge topology and ticket-aware merge marker', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-merge-policy-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root, {
    integrationStrategy: 'merge',
    mergeMessageTemplate: 'Merge {ticket}',
  }), 'chat-merge-policy');
  commitFile(workspace.root, 'workspace.txt', 'workspace\n', '[QCA-3617] fix: workspace change');
  commitFile(root, 'base-only.txt', 'base\nadvanced\n', 'advance base');
  const baseHeadBefore = git(root, ['rev-parse', 'HEAD']).stdout;

  const result = integrateWorkspaceCommits(workspace.workspaceId, {
    task: { jiraKey: 'QCA-3617', displayId: 'DVF-0453', title: 'Fix installer summary', category: 'Fix' },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.strategy, 'merge');
  assert.equal(result.baseHeadBefore, baseHeadBefore);
  assert.equal(git(root, ['log', '-1', '--format=%s']).stdout, 'Merge QCA-3617');
  const parents = git(root, ['rev-list', '--parents', '-n', '1', result.baseHeadAfter]).stdout.trim().split(/\s+/);
  assert.equal(parents.length, 3, 'explicit merge policy must preserve a two-parent merge commit');
  assert.equal(fs.readFileSync(path.join(root, 'workspace.txt'), 'utf8').replace(/\r\n/g, '\n'), 'workspace\n');
  assert.equal(fs.readFileSync(path.join(root, 'base-only.txt'), 'utf8').replace(/\r\n/g, '\n'), 'base\nadvanced\n');
});

test('explicit merge conflicts can abort and retry without mutating the shared base early', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-merge-conflict-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root, {
    integrationStrategy: 'merge',
    mergeMessageTemplate: 'Merge {ticket}',
  }), 'chat-merge-conflict');
  commitFile(workspace.root, 'shared.txt', 'workspace changed\n', '[QCA-3617] fix: workspace conflict');
  const sourceHeadBefore = git(workspace.root, ['rev-parse', 'HEAD']).stdout;
  commitFile(root, 'shared.txt', 'base changed\n', 'base conflict');
  const baseHeadBefore = git(root, ['rev-parse', 'HEAD']).stdout;
  const options = {
    task: { jiraKey: 'QCA-3617', displayId: 'DVF-0453', title: 'Fix installer summary', category: 'Fix' },
  };

  const firstConflict = integrateWorkspaceCommits(workspace.workspaceId, options);
  assert.equal(firstConflict.status, 'conflict');
  assert.equal(firstConflict.strategy, 'merge');
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, baseHeadBefore, 'shared base must remain unchanged while merge conflict is isolated');
  assert.equal(git(workspace.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).status, 0);

  const aborted = abortWorkspaceIntegration(workspace.workspaceId);
  assert.equal(aborted.status, 'aborted');
  assert.equal(git(workspace.root, ['rev-parse', 'HEAD']).stdout, sourceHeadBefore);
  assert.equal(git(workspace.root, ['status', '--porcelain']).stdout, '');
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, baseHeadBefore);

  const secondConflict = integrateWorkspaceCommits(workspace.workspaceId, options);
  assert.equal(secondConflict.status, 'conflict');
  fs.writeFileSync(path.join(workspace.root, 'shared.txt'), 'resolved\n');
  git(workspace.root, ['add', 'shared.txt']);
  const retried = retryWorkspaceIntegration(workspace.workspaceId);
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.strategy, 'merge');
  assert.equal(git(root, ['log', '-1', '--format=%s']).stdout, 'Merge QCA-3617');
  const parents = git(root, ['rev-list', '--parents', '-n', '1', retried.baseHeadAfter]).stdout.trim().split(/\s+/);
  assert.equal(parents.length, 3);
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8').replace(/\r\n/g, '\n'), 'resolved\n');
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
  const sourceHeadBefore = git(workspace.root, ['rev-parse', 'HEAD']).stdout;

  const conflict = integrateWorkspaceCommits(workspace.workspaceId);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.code, 'INTEGRATION_CONFLICT');
  assert.equal(conflict.strategy, 'rebase-ff');
  assert.deepEqual(conflict.conflictedPaths, ['shared.txt']);
  assert.equal(conflict.baseHeadBefore, baseHeadBefore);
  assert.equal(conflict.sourceHead, sourceHeadBefore);
  assert.notEqual(git(workspace.root, ['rev-parse', 'HEAD']).stdout, sourceHeadBefore, 'rebase conflict may move the worktree HEAD while preserving original source evidence');
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, baseHeadBefore);
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.equal(git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).status, 1);
  assert.equal(git(workspace.root, ['rev-parse', '-q', '--verify', 'REBASE_HEAD'], true).status, 0);

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
  assert.equal(retried.strategy, 'rebase-ff');
  assert.notEqual(retried.baseHeadAfter, conflict.sourceHead);
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8').replace(/\r\n/g, '\n'), 'resolved\n');
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.equal(git(workspace.root, ['status', '--porcelain']).stdout, '');
  assert.equal(git(workspace.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).status, 1);
  assert.equal(git(root, ['cat-file', '-e', `${conflict.sourceHead}^{commit}`]).status, 0);
});


test('integration rejects a worktree checked out on a branch different from its recorded physical workspace branch', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-physical-branch-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root), 'chat-physical-branch');
  commitFile(workspace.root, 'workspace.txt', 'workspace\n', 'workspace change');
  git(workspace.root, ['switch', '-c', 'unexpected-physical-branch']);
  const baseHeadBefore = git(root, ['rev-parse', 'HEAD']).stdout;

  assert.throws(
    () => integrateWorkspaceCommits(workspace.workspaceId),
    (error: any) => error?.payload?.code === 'WORKSPACE_SOURCE_BRANCH_MISMATCH'
      || error?.payload?.code === 'WORKSPACE_NOT_FOUND',
  );
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, baseHeadBefore, 'physical branch drift must fail before mutating the shared base');
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
});

test('integration reports combined target-branch changed files including sibling commits', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-integration-combined-impact-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = repoFixture();
  const workspace = createOrReuseSessionWorkspace(project(root), 'chat-combined-impact');
  commitFile(workspace.root, 'workspace.txt', 'workspace\n', 'workspace change');
  commitFile(root, 'base-only.txt', 'base\nsibling\n', 'sibling base change');

  const result = integrateWorkspaceCommits(workspace.workspaceId);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.changedFiles, ['workspace.txt']);
  assert.deepEqual(result.combinedChangedFiles.sort(), ['base-only.txt', 'workspace.txt']);
  assert.equal(result.combinedImpactBaseRevision, workspace.baseRevision);
  assert.equal(result.combinedImpactHead, result.baseHeadAfter);
});
