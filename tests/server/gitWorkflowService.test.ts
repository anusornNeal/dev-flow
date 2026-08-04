import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-git-workflow-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();

const {
  ensureGitBranch,
  pushGitBranch,
  getGitSyncStatus,
} = await import('../../src/server/services/gitService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function createRepository(name: string) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-b', 'develop']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

function createBareRemote(name: string) {
  const root = path.join(tempRoot, `${name}.git`);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '--bare']);
  return root;
}

function commitFile(root: string, fileName: string, content: string, message: string) {
  fs.writeFileSync(path.join(root, fileName), content);
  git(root, ['add', fileName]);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

const state = {} as any;

test('ensureGitBranch previews and creates a branch without discarding changes', () => {
  const root = createRepository('ensure-create');
  fs.writeFileSync(path.join(root, 'dirty.txt'), 'local change\n');

  const preview = ensureGitBranch(state, {
    localPath: root,
    branch: 'feature/safe-branch',
    baseBranch: 'develop',
    createIfMissing: true,
    switch: true,
    dryRun: true,
  });

  assert.equal(preview.currentBranchBefore, 'develop');
  assert.equal(preview.targetBranch, 'feature/safe-branch');
  assert.equal(preview.wouldCreate, true);
  assert.equal(preview.wouldSwitch, true);
  assert.equal(preview.workingTreeClean, false);
  assert.equal(git(root, ['branch', '--show-current']), 'develop');

  const applied = ensureGitBranch(state, {
    localPath: root,
    branch: 'feature/safe-branch',
    baseBranch: 'develop',
    createIfMissing: true,
    switch: true,
  });

  assert.equal(applied.created, true);
  assert.equal(applied.switched, true);
  assert.equal(git(root, ['branch', '--show-current']), 'feature/safe-branch');
  assert.equal(fs.readFileSync(path.join(root, 'dirty.txt'), 'utf8'), 'local change\n');
});

test('ensureGitBranch blocks switching to an existing branch with a dirty tree', () => {
  const root = createRepository('ensure-dirty-existing');
  git(root, ['branch', 'feature/existing']);
  fs.writeFileSync(path.join(root, 'README.md'), '# changed\n');

  assert.throws(
    () => ensureGitBranch(state, {
      localPath: root,
      branch: 'feature/existing',
      switch: true,
    }),
    (error: any) => error?.payload?.code === 'GIT_DIRTY_SWITCH_BLOCKED',
  );
  assert.equal(git(root, ['branch', '--show-current']), 'develop');
});

test('pushGitBranch previews commits, publishes, and getGitSyncStatus confirms parity', () => {
  const root = createRepository('publish');
  const remote = createBareRemote('publish-origin');
  git(root, ['remote', 'add', 'origin', remote]);
  const localHead = commitFile(root, 'feature.txt', 'feature\n', 'feature commit');

  const preview = pushGitBranch(state, {
    localPath: root,
    remote: 'origin',
    branch: 'develop',
    setUpstream: true,
    dryRun: true,
  });

  assert.equal(preview.pushed, false);
  assert.equal(preview.localHead, localHead);
  assert.equal(preview.remoteHeadBefore, null);
  assert.equal(preview.commits.length, 2);

  const published = pushGitBranch(state, {
    localPath: root,
    remote: 'origin',
    branch: 'develop',
    setUpstream: true,
  });

  assert.equal(published.pushed, true);
  assert.equal(published.remoteHeadAfter, localHead);
  assert.equal(published.setUpstream, true);

  const status = getGitSyncStatus(state, { localPath: root, remote: 'origin', fetch: true });
  assert.equal(status.localHead, localHead);
  assert.equal(status.remoteHead, localHead);
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
  assert.equal(status.diverged, false);
  assert.equal(status.pushed, true);
  assert.equal(status.workingTreeClean, true);
  assert.equal(status.trackingBranch, 'origin/develop');
});

test('pushGitBranch blocks when local and remote histories diverge', () => {
  const root = createRepository('diverged-local');
  const remote = createBareRemote('diverged-origin');
  git(root, ['remote', 'add', 'origin', remote]);
  pushGitBranch(state, { localPath: root, remote: 'origin', branch: 'develop', setUpstream: true });

  const peer = path.join(tempRoot, 'diverged-peer');
  git(tempRoot, ['clone', remote, peer]);
  git(peer, ['config', 'user.email', 'peer@example.test']);
  git(peer, ['config', 'user.name', 'Peer Test']);
  git(peer, ['switch', 'develop']);
  commitFile(peer, 'remote.txt', 'remote\n', 'remote commit');
  git(peer, ['push', 'origin', 'develop']);

  commitFile(root, 'local.txt', 'local\n', 'local commit');

  assert.throws(
    () => pushGitBranch(state, { localPath: root, remote: 'origin', branch: 'develop', dryRun: true }),
    (error: any) => error?.payload?.code === 'GIT_BRANCH_DIVERGED',
  );

  const status = getGitSyncStatus(state, { localPath: root, remote: 'origin', fetch: true });
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 1);
  assert.equal(status.diverged, true);
  assert.equal(status.pushed, false);
});
