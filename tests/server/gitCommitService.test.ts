import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-git-commit-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { commitGitChanges, getGitStatus, getGitLog } = await import('../../src/server/services/gitService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function createRepo(name: string) {
  const repo = path.join(tempRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'DevFlow Test']);
  git(repo, ['config', 'user.email', 'devflow@example.com']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}

function stateFor(repo: string): any {
  return {
    projectsCache: [
      { id: 'project-git', name: 'Git Fixture', repoUrl: 'https://example.com/git', localPath: repo },
    ],
  };
}

test('commitGitChanges rejects missing commit messages', () => {
  const repo = createRepo('missing-message');
  assert.throws(
    () => commitGitChanges(stateFor(repo), { projectId: 'project-git', stageAll: true, message: '   ' }),
    /COMMIT_MESSAGE_REQUIRED/,
  );
});

test('commitGitChanges rejects an empty working tree', () => {
  const repo = createRepo('empty-tree');
  assert.throws(
    () => commitGitChanges(stateFor(repo), { projectId: 'project-git', stageAll: true, message: 'chore: no changes' }),
    /NO_CHANGES_TO_COMMIT/,
  );
});

test('commitGitChanges stages and commits all local changes', () => {
  const repo = createRepo('stage-all');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'updated\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');

  const result = commitGitChanges(stateFor(repo), {
    projectId: 'project-git',
    stageAll: true,
    message: 'feat: commit all changes',
  });

  assert.match(result.hash, /^[a-f0-9]{40}$/);
  assert.equal(result.commitHash, result.hash);
  assert.equal(result.dryRun, false);
  assert.equal(result.message, 'feat: commit all changes');
  assert.deepEqual(result.changedFiles.sort(), ['base.txt', 'new.txt']);
  assert.equal(getGitStatus(stateFor(repo), { projectId: 'project-git' }).count, 0);
  assert.equal(getGitLog(stateFor(repo), { projectId: 'project-git', limit: 1 }).commits[0].message, 'feat: commit all changes');
});

test('commitGitChanges commits selected files without staging unrelated changes', () => {
  const repo = createRepo('selected-files');
  fs.writeFileSync(path.join(repo, 'selected.txt'), 'selected\n');
  fs.writeFileSync(path.join(repo, 'unselected.txt'), 'unselected\n');

  const result = commitGitChanges(stateFor(repo), {
    projectId: 'project-git',
    files: ['selected.txt'],
    message: 'feat: commit selected file',
  });

  assert.deepEqual(result.changedFiles, ['selected.txt']);
  const status = getGitStatus(stateFor(repo), { projectId: 'project-git' });
  assert.equal(status.count, 1);
  assert.equal(status.files[0].path, 'unselected.txt');
});

test('commitGitChanges dryRun previews without staging or committing', () => {
  const repo = createRepo('dry-run');
  fs.writeFileSync(path.join(repo, 'preview.txt'), 'preview\n');
  const beforeHead = git(repo, ['rev-parse', 'HEAD']);

  const result = commitGitChanges(stateFor(repo), {
    projectId: 'project-git',
    stageAll: true,
    dryRun: true,
    message: 'feat: preview commit',
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.hash, null);
  assert.equal(result.commitHash, null);
  assert.deepEqual(result.changedFiles, ['preview.txt']);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(getGitStatus(stateFor(repo), { projectId: 'project-git' }).files[0].staged, false);
});

test('commitGitChanges rejects unsafe selected paths', () => {
  const repo = createRepo('unsafe-path');
  fs.writeFileSync(path.join(repo, 'safe.txt'), 'safe\n');

  assert.throws(
    () => commitGitChanges(stateFor(repo), {
      projectId: 'project-git',
      files: ['../escape.txt'],
      message: 'feat: unsafe path',
    }),
    /FILE_ACCESS_DENIED/,
  );
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('devflowContract exposes commit_git_changes', async () => {
  const { getToolDefinitionByName } = await import('../../src/server/contracts/devflowContract.js');
  const tool = getToolDefinitionByName('commit_git_changes');
  assert.ok(tool, 'commit_git_changes should be defined');
  assert.equal(tool.name, 'commit_git_changes');

  assert.ok(tool.inputSchema.properties.message, 'Schema should include message');
  assert.ok(tool.inputSchema.properties.stageAll, 'Schema should include stageAll');
  assert.ok(tool.inputSchema.properties.files, 'Schema should include files');
  assert.ok(tool.inputSchema.properties.dryRun, 'Schema should include dryRun');

  const req = tool.buildHttpRequest({ projectId: 'project-git', message: 'test', stageAll: true });
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/git/commit');
});
