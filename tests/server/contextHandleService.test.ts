import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-context-handle-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
fs.writeFileSync(path.join(tempDir, 'src', 'Example.ts'), 'export function Example() { return 1; }\n', 'utf8');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: tempDir, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}
git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const state: any = {
  projectsCache: [
    { id: 'project-context-handle', name: 'Context Handle', repoUrl: 'https://example.com/context', localPath: tempDir },
  ],
};

const { clearContextHandles, getRepoContextWithHandle } = await import('../../src/server/services/contextHandleService.js');

test.beforeEach(() => clearContextHandles());

test('context handle returns NOT_MODIFIED without returning full snippets again', () => {
  const first = getRepoContextWithHandle(state, {
    projectId: 'project-context-handle', q: 'Example', limit: 5, snippetLimit: 2,
  });
  assert.equal(first.status, 'full');
  assert.ok(first.contextHandle);
  assert.ok(first.bundle?.snippets.length >= 1);

  const second = getRepoContextWithHandle(state, {
    projectId: 'project-context-handle', q: 'Example', limit: 5, snippetLimit: 2, contextHandle: first.contextHandle,
  });
  assert.equal(second.status, 'not_modified');
  assert.equal(second.bundle, undefined);
});

test('context handle returns only changed snippet revisions after a file edit', () => {
  const first = getRepoContextWithHandle(state, {
    projectId: 'project-context-handle', q: 'Example', limit: 5, snippetLimit: 2,
  });
  fs.writeFileSync(path.join(tempDir, 'src', 'Example.ts'), 'export function Example() { return 2; }\n', 'utf8');

  const second = getRepoContextWithHandle(state, {
    projectId: 'project-context-handle', q: 'Example', limit: 5, snippetLimit: 2, contextHandle: first.contextHandle,
  });
  assert.equal(second.status, 'delta');
  assert.equal(second.changedSnippets.length, 1);
  assert.equal(second.changedSnippets[0].path.replace(/\\/g, '/'), 'src/Example.ts');
});

test.after(() => {
  clearContextHandles();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
