import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-revision-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { getRepoRevisionForRoot } = await import('../../src/server/services/repoRevisionService.js');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: tempDir, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

test.before(() => {
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'one\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
});

test('repo revision is stable while HEAD and working tree are unchanged', () => {
  const first = getRepoRevisionForRoot(tempDir);
  const second = getRepoRevisionForRoot(tempDir);

  assert.equal(first.token, second.token);
  assert.equal(first.head, second.head);
  assert.equal(first.changedFiles.length, 0);
});

test('repo revision changes when tracked content changes again without status-shape changes', () => {
  fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'two\n', 'utf8');
  const firstDirty = getRepoRevisionForRoot(tempDir);
  fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'three\n', 'utf8');
  const secondDirty = getRepoRevisionForRoot(tempDir);

  assert.notEqual(firstDirty.token, secondDirty.token);
  assert.equal(secondDirty.changedFiles.some((entry: any) => entry.path === 'tracked.txt'), true);
});

test('repo revision includes untracked files and committed HEAD changes', () => {
  const before = getRepoRevisionForRoot(tempDir);
  fs.writeFileSync(path.join(tempDir, 'new.txt'), 'new\n', 'utf8');
  const withUntracked = getRepoRevisionForRoot(tempDir);
  assert.notEqual(withUntracked.token, before.token);

  git(['add', '.']);
  git(['commit', '-m', 'update']);
  const committed = getRepoRevisionForRoot(tempDir);
  assert.notEqual(committed.head, before.head);
  assert.equal(committed.changedFiles.length, 0);
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
