import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-local-patch-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject: upsertProject } = await import('../../src/server/repositories/projectRepository.js');
const {
  applyLocalPatch,
  applyLocalPatchAsync,
  validatePatchPaths,
} = await import('../../src/server/services/localPatchService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function readText(root: string, relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function createFixture(name: string, files: Record<string, string> = { 'note.txt': 'line1\nline2\nline3\n' }) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-b', 'develop']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);

  const projectId = `project-${name}`;
  upsertProject({
    id: projectId,
    name: `Project ${name}`,
    repoUrl: `https://example.com/${name}`,
    localPath: root,
  });
  const state = {
    projectsCache: [{ id: projectId, name: `Project ${name}`, repoUrl: `https://example.com/${name}`, localPath: root }],
  } as any;
  return { root, state, projectId };
}

function wrongCountPatch(relativePath = 'note.txt') {
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    '@@ -1,99 +1,77 @@',
    ' line1',
    '-line2',
    '+updated',
    ' line3',
    '',
  ].join('\n');
}

function callAsync(state: any, args: Record<string, any>) {
  return applyLocalPatchAsync(
    state,
    args,
    { stdout() {}, stderr() {} },
    () => {},
  );
}

test('validatePatchPaths rejects Begin Patch pseudo syntax with an actionable format error', () => {
  const fixture = createFixture('pseudo-format');
  const pseudoPatch = [
    '*** Begin Patch',
    '*** Update File: note.txt',
    '@@',
    '-line2',
    '+updated',
    '*** End Patch',
  ].join('\n');

  assert.throws(
    () => validatePatchPaths(fixture.root, pseudoPatch),
    (error: any) => {
      assert.equal(error?.payload?.code, 'UNSUPPORTED_PATCH_FORMAT');
      assert.match(error?.payload?.message || '', /Steno|structured/i);
      assert.match(error?.payload?.message || '', /native Git unified diff/i);
      return true;
    },
  );
});

test('applyLocalPatch dry-run and apply recover wrong hunk counts with recount', () => {
  const fixture = createFixture('sync-recount');
  const patch = wrongCountPatch();

  const preview = applyLocalPatch(fixture.state, {
    projectId: fixture.projectId,
    patch,
    dryRun: true,
  });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.applied, false);
  assert.equal(readText(fixture.root, 'note.txt'), 'line1\nline2\nline3\n');

  const applied = applyLocalPatch(fixture.state, {
    projectId: fixture.projectId,
    patch,
  });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.changedFiles, ['note.txt']);
  assert.equal(readText(fixture.root, 'note.txt'), 'line1\nupdated\nline3\n');
});

test('applyLocalPatchAsync uses the same recount behavior for dry-run and apply', async () => {
  const fixture = createFixture('async-recount');
  const patch = wrongCountPatch();

  const preview = await callAsync(fixture.state, {
    projectId: fixture.projectId,
    patch,
    dryRun: true,
  });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.applied, false);

  const applied = await callAsync(fixture.state, {
    projectId: fixture.projectId,
    patch,
  });
  assert.equal(applied.applied, true);
  assert.equal(readText(fixture.root, 'note.txt'), 'line1\nupdated\nline3\n');
});

test('native diff that is still invalid after recount fails safely with git diagnostics', () => {
  const fixture = createFixture('corrupt-native');
  const patch = [
    '--- a/note.txt',
    '+++ b/note.txt',
    '@@ -1 +1 @@',
    '-line-that-does-not-exist',
    '+updated',
    '',
  ].join('\n');

  assert.throws(
    () => applyLocalPatch(fixture.state, {
      projectId: fixture.projectId,
      patch,
      dryRun: true,
    }),
    (error: any) => {
      assert.equal(error?.payload?.code, 'PATCH_APPLY_FAILED');
      assert.match(JSON.stringify(error?.payload?.details || {}), /patch|apply|note\.txt/i);
      return true;
    },
  );
  assert.equal(readText(fixture.root, 'note.txt'), 'line1\nline2\nline3\n');
});

test('multi-file native unified diff still validates and applies', () => {
  const fixture = createFixture('multi-file', {
    'a.txt': 'alpha\n',
    'b.txt': 'beta\n',
  });
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-alpha',
    '+ALPHA',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '-beta',
    '+BETA',
    '',
  ].join('\n');

  const result = applyLocalPatch(fixture.state, {
    projectId: fixture.projectId,
    patch,
  });

  assert.deepEqual(result.changedFiles, ['a.txt', 'b.txt']);
  assert.equal(readText(fixture.root, 'a.txt'), 'ALPHA\n');
  assert.equal(readText(fixture.root, 'b.txt'), 'BETA\n');
});

test('path traversal and binary patch safety guards remain authoritative', () => {
  const fixture = createFixture('safety-guards');

  assert.throws(
    () => validatePatchPaths(fixture.root, [
      '--- a/../outside.txt',
      '+++ b/../outside.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n')),
    (error: any) => error?.payload?.code === 'PATCH_PATH_DENIED',
  );

  assert.throws(
    () => validatePatchPaths(fixture.root, [
      'diff --git a/image.bin b/image.bin',
      'GIT binary patch',
      'literal 0',
      '',
    ].join('\n')),
    (error: any) => error?.payload?.code === 'BINARY_PATCH_UNSUPPORTED',
  );
});
