import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-project-resolution-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const {
  createProject,
  findProjectIdentityConflicts,
  normalizeProjectLocalPathIdentity,
  normalizeProjectNameAlias,
  normalizeProjectRepoIdentity,
} = await import('../../src/server/repositories/projectRepository.js');
const { findProjectByIdentifier } = await import('../../src/server/services/taskService.js');

const state: any = { countersCache: {} };

createProject({
  id: 'project-main',
  name: 'dev flow',
  repoUrl: 'https://github.com/Acme/dev-flow.git',
  localPath: 'C:\\Work\\Dev-Flow',
  createdAt: '2026-01-01T00:00:00.000Z',
});
createProject({
  id: 'project-legacy-alias',
  name: 'dev-flow',
  repoUrl: 'git@github.com:acme/dev-flow.git',
  localPath: 'c:/work/dev-flow/',
  createdAt: '2026-02-01T00:00:00.000Z',
});
createProject({
  id: 'project-other',
  name: 'Other App',
  repoUrl: 'https://github.com/acme/other-app',
  localPath: 'C:\\Work\\Other-App',
  createdAt: '2026-01-02T00:00:00.000Z',
});
createProject({
  id: 'project-alpha-a',
  name: 'Alpha App',
  repoUrl: 'https://github.com/acme/alpha-a',
  localPath: 'C:\\Work\\Alpha-A',
  createdAt: '2026-01-03T00:00:00.000Z',
});
createProject({
  id: 'project-alpha-b',
  name: 'alpha-app',
  repoUrl: 'https://github.com/acme/alpha-b',
  localPath: 'C:\\Work\\Alpha-B',
  createdAt: '2026-01-04T00:00:00.000Z',
});

test('canonical project normalizers handle safe aliases', () => {
  assert.equal(normalizeProjectNameAlias(' DevFlow '), 'devflow');
  assert.equal(normalizeProjectNameAlias('dev-flow'), 'devflow');
  assert.equal(normalizeProjectNameAlias('dev flow'), 'devflow');
  assert.equal(normalizeProjectRepoIdentity('https://github.com/Acme/dev-flow.git/'), 'github.com/acme/dev-flow');
  assert.equal(normalizeProjectRepoIdentity('git@github.com:acme/dev-flow.git'), 'github.com/acme/dev-flow');
  assert.equal(normalizeProjectLocalPathIdentity('C:\\Work\\Dev-Flow'), normalizeProjectLocalPathIdentity('c:/work/dev-flow/'));
});

test('exact projectId is authoritative over aliases', () => {
  const project = findProjectByIdentifier(state, { projectId: 'project-other', projectName: 'DevFlow' });
  assert.equal(project?.id, 'project-other');
  const missing = findProjectByIdentifier(state, { projectId: 'project-missing', projectName: 'DevFlow' });
  assert.equal(missing, null);
});

test('safe case/space/hyphen aliases collapse legacy same-repo duplicates deterministically', () => {
  const byName = findProjectByIdentifier(state, { projectName: 'DevFlow' });
  const byRepo = findProjectByIdentifier(state, { repoUrl: 'https://github.com/acme/dev-flow/' });
  const byPath = findProjectByIdentifier(state, { localPath: 'c:/WORK/dev-flow' });
  assert.equal(byName?.id, 'project-main');
  assert.equal(byRepo?.id, 'project-main');
  assert.equal(byPath?.id, 'project-main');
  assert.equal(findProjectByIdentifier(state, { projectId: 'project-legacy-alias' })?.id, 'project-legacy-alias');
});

test('ambiguous display aliases across different repositories return structured candidates', () => {
  assert.throws(
    () => findProjectByIdentifier(state, { projectName: 'AlphaApp' }),
    (error: any) => {
      assert.equal(error?.status, 409);
      assert.equal(error?.payload?.code, 'PROJECT_AMBIGUOUS');
      const ids = (error?.payload?.details?.candidates || []).map((candidate: any) => candidate.id).sort();
      assert.deepEqual(ids, ['project-alpha-a', 'project-alpha-b']);
      return true;
    },
  );
});

test('repository conflict helper detects same canonical repo or local path without rewriting ids', () => {
  const repoConflicts = findProjectIdentityConflicts({
    id: 'project-new',
    name: 'Anything',
    repoUrl: 'https://github.com/acme/dev-flow',
    localPath: 'D:\\Elsewhere\\dev-flow',
  });
  assert.deepEqual(repoConflicts.map((project: any) => project.id).sort(), ['project-legacy-alias', 'project-main']);

  const pathConflicts = findProjectIdentityConflicts({
    id: 'project-new',
    name: 'Anything',
    repoUrl: 'https://github.com/acme/unrelated',
    localPath: 'C:/work/dev-flow/',
  });
  assert.deepEqual(pathConflicts.map((project: any) => project.id).sort(), ['project-legacy-alias', 'project-main']);
});

test('canonical resolution stays cheap across common alias forms', () => {
  const identifiers = [
    { projectName: 'DevFlow' },
    { projectName: 'dev-flow' },
    { repo: 'git@github.com:acme/dev-flow.git' },
    { localPath: 'c:/work/dev-flow' },
    { projectId: 'project-main' },
  ];
  const startedAt = performance.now();
  for (let index = 0; index < 500; index += 1) {
    const resolved = findProjectByIdentifier(state, identifiers[index % identifiers.length]);
    assert.ok(resolved);
  }
  const elapsedMs = performance.now() - startedAt;
  console.log(`[project-resolution] 500 canonical lookups: ${elapsedMs.toFixed(2)}ms`);
});

// SQLite keeps a process-level connection open on Windows; OS temp cleanup owns tempDir.
