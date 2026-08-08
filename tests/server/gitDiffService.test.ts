import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-git-diff-'));
process.env.DEVFLOW_DB_PATH = path.join(os.tmpdir(), `devflow-git-diff-db-${path.basename(tempDir)}.sqlite`);
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
createProject({ id: 'project-diff', name: 'Diff', repoUrl: 'https://example.com/diff', localPath: tempDir });
const { getGitDiff, getGitShow } = await import('../../src/server/services/gitService.js');

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
  fs.writeFileSync(path.join(tempDir, 'large.txt'), `${'x'.repeat(12000)}\n`, 'utf8');
  git(['add', 'large.txt']);
  git(['commit', '-m', 'large change']);
  fs.writeFileSync(path.join(tempDir, 'large.txt'), `${'y'.repeat(12000)}\n`, 'utf8');
});

test('getGitDiff compact mode caps returned diff and reports original bytes', () => {
  const state: any = { projectsCache: [{ id: 'project-diff', name: 'Diff', repoUrl: 'https://example.com/diff', localPath: tempDir }] };
  const result = getGitDiff(state, { projectId: 'project-diff', responseMode: 'compact' });

  assert.equal(result.responseMode, 'compact');
  assert.equal(result.truncated, true);
  assert.equal(result.diffBytes > result.returnedBytes, true);
  assert.equal(result.returnedBytes < 5000, true);
});

test('getGitShow compact mode preserves commit metadata while capping patch bytes', () => {
  const state: any = { projectsCache: [{ id: 'project-diff', name: 'Diff', repoUrl: 'https://example.com/diff', localPath: tempDir }] };
  const compact = getGitShow(state, { projectId: 'project-diff', commit: 'HEAD', responseMode: 'compact' });
  const standard = getGitShow(state, { projectId: 'project-diff', commit: 'HEAD', responseMode: 'standard' });

  assert.equal(compact.responseMode, 'compact');
  assert.equal(compact.truncated, true);
  assert.equal(typeof compact.commit.hash, 'string');
  assert.equal(compact.commit.message, 'large change');
  assert.equal(compact.diffBytes > compact.returnedBytes, true);
  assert.equal(compact.returnedBytes < 5000, true);
  assert.equal(standard.responseMode, 'standard');
  assert.equal(standard.returnedBytes > compact.returnedBytes, true);
  assert.equal(compact.returnedBytes / standard.returnedBytes < 0.6, true);
});

test.after(() => {
  // SQLite remains open for the process on Windows; OS temp cleanup owns tempDir.
});
