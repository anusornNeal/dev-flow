import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-git-diff-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
const { getGitDiff } = await import('../../src/server/services/gitService.js');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: tempDir, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

test.before(() => {
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  fs.writeFileSync(path.join(tempDir, 'large.txt'), 'base\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(tempDir, 'large.txt'), `${'x'.repeat(6000)}\n`, 'utf8');
});

test('getGitDiff compact mode caps returned diff and reports original bytes', () => {
  const state: any = { projectsCache: [{ id: 'project-diff', name: 'Diff', repoUrl: 'https://example.com/diff', localPath: tempDir }] };
  const result = getGitDiff(state, { projectId: 'project-diff', responseMode: 'compact' });

  assert.equal(result.responseMode, 'compact');
  assert.equal(result.truncated, true);
  assert.equal(result.diffBytes > result.returnedBytes, true);
  assert.equal(result.returnedBytes < 5000, true);
});

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
