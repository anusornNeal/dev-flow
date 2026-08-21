import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-as-code-workspace-runtime-'));
process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
process.env.DEVFLOW_DB_PATH = path.join(runtimeRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const {
  cleanupSessionWorkspace,
  createOrReuseSessionWorkspace,
  resetSessionWorkspaceRuntimeForTests,
} = await import('../../src/server/services/sessionWorkspaceService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-as-code-workspace-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n', 'utf8');
  fs.writeFileSync(path.join(root, '.devflow', 'project.json'), JSON.stringify({
    version: 1,
    gitWorkflowPolicy: {
      integrationStrategy: 'rebase-ff',
      commitMessageTemplate: '[{ticket}] {type}: {title}',
      mergeMessageTemplate: 'Merge {ticket}',
    },
  }, null, 2), 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['add', '-f', '.devflow/project.json']);
  git(root, ['commit', '-m', 'base with repo policy']);
  return root;
}

test('managed workspace freezes repository workflow policy ahead of conflicting SQLite project metadata', () => {
  resetSessionWorkspaceRuntimeForTests();
  const root = createRepo();
  const workspace = createOrReuseSessionWorkspace({
    id: 'project-repo-as-code-workspace',
    localPath: root,
    gitWorkflowPolicy: {
      integrationStrategy: 'merge',
      commitMessageTemplate: 'db::{ticket}',
      mergeMessageTemplate: 'DB merge {ticket}',
    },
  }, 'repo-as-code-chat');

  assert.deepEqual(workspace.gitWorkflowPolicy, {
    integrationStrategy: 'rebase-ff',
    commitMessageTemplate: '[{ticket}] {type}: {title}',
    mergeMessageTemplate: 'Merge {ticket}',
  });

  assert.equal(cleanupSessionWorkspace(workspace.workspaceId).removed, true);
});
