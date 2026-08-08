import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-apply-verify-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { applyAndVerify, applyAndVerifyAsync } = await import('../../src/server/services/applyAndVerifyService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

function fixture(name: string) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'test.mjs'), "process.stdout.write('verified\\n');\n", 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node scripts/test.mjs' } }, null, 2), 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  git(root, ['config', 'user.email', 'devflow@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

function stateFor(root: string): any {
  return { projectsCache: [{ id: 'project-apply-verify', name: 'Apply Verify', repoUrl: 'https://example.com/apply-verify', localPath: root }] };
}

test('applyAndVerify applies a batch, returns diff, and runs targeted verification in one result', () => {
  const root = fixture('success');
  const result = applyAndVerify(stateFor(root), {
    projectId: 'project-apply-verify',
    files: [{ filePath: 'src/value.ts', edits: [{ type: 'replace', find: 'value = 1', replaceWith: 'value = 2' }] }],
    requestedCommands: ['test'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.edit.changed, true);
  assert.match(result.diff.diff, /value = 2/);
  assert.equal(result.verification.length, 1);
  assert.equal(result.verification[0].status, 'succeeded');
  assert.equal(result.plan.lane, 'fast');
});

test('applyAndVerify short-circuits verification for a proven no-op unless forced', () => {
  const root = fixture('noop');
  const result = applyAndVerify(stateFor(root), {
    projectId: 'project-apply-verify',
    files: [{ filePath: 'src/value.ts', edits: [{ type: 'replace', find: 'value = 1', replaceWith: 'value = 1' }] }],
    requestedCommands: ['test'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.edit.changed, false);
  assert.equal(result.noChanges, true);
  assert.deepEqual(result.verification, []);
});

test('applyAndVerifyAsync runs explicitly resource-isolated verification commands concurrently', async () => {
  const root = fixture('parallel');
  fs.writeFileSync(path.join(root, 'scripts', 'typecheck.mjs'), "await new Promise((resolve) => setTimeout(resolve, 800)); process.stdout.write('typecheck ok\\n');\n", 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'lint.mjs'), "await new Promise((resolve) => setTimeout(resolve, 800)); process.stdout.write('lint ok\\n');\n", 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: {
      test: 'node scripts/test.mjs',
      typecheck: 'node scripts/typecheck.mjs',
      lint: 'node scripts/lint.mjs',
    },
  }, null, 2), 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'parallel fixtures']);

  const startedAt = Date.now();
  const result = await applyAndVerifyAsync(stateFor(root), {
    projectId: 'project-apply-verify',
    files: [{ filePath: 'src/value.ts', edits: [{ type: 'replace', find: 'value = 1', replaceWith: 'value = 3' }] }],
    requestedCommands: ['typecheck', 'lint'],
    resourceIsolatedCommands: ['typecheck', 'lint'],
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, true);
  assert.equal(result.parallelVerification, true);
  assert.equal(result.verification.length, 2);
  assert.equal(result.verification.every((entry: any) => entry.status === 'succeeded'), true);
  assert.equal(elapsedMs < 1500, true, `expected concurrent verification under 1500ms, got ${elapsedMs}ms`);
});

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
