import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-path-mutation-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject: upsertProject } = await import('../../src/server/repositories/projectRepository.js');
const {
  applyPathMutations,
  deleteLocalPath,
  moveLocalPath,
} = await import('../../src/server/services/localPathMutationService.js');
const { getFileRevision } = await import('../../src/server/services/localFileService.js');
const { applyLocalPatch } = await import('../../src/server/services/localPatchService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function createFixture(name: string) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-b', 'develop']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  upsertProject({
    id: `project-${name}`,
    name: `Project ${name}`,
    repoUrl: `https://example.com/${name}`,
    localPath: root,
  });
  const state = {
    projectsCache: [{ id: `project-${name}`, name: `Project ${name}`, repoUrl: `https://example.com/${name}`, localPath: root }],
  } as any;
  return { root, state, projectId: `project-${name}` };
}

function commitAll(root: string, message = 'fixture') {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

test('deleteLocalPath dry-run returns a deterministic plan without writing', () => {
  const fixture = createFixture('delete-preview');
  fs.writeFileSync(path.join(fixture.root, 'remove.txt'), 'remove me\n');

  const result = deleteLocalPath(fixture.state, {
    projectId: fixture.projectId,
    paths: ['remove.txt'],
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.applied, false);
  assert.equal(result.operationCount, 1);
  assert.deepEqual(result.affectedPaths, ['remove.txt']);
  assert.deepEqual(result.gitPreview, [{ status: 'deleted', path: 'remove.txt' }]);
  assert.equal(fs.existsSync(path.join(fixture.root, 'remove.txt')), true);
});

test('deleteLocalPath applies a guarded file deletion and invalidates caches', () => {
  const fixture = createFixture('delete-file');
  const filePath = path.join(fixture.root, 'remove.txt');
  fs.writeFileSync(filePath, 'remove me\n');
  commitAll(fixture.root);
  const revision = getFileRevision(filePath);

  const result = deleteLocalPath(fixture.state, {
    projectId: fixture.projectId,
    paths: ['remove.txt'],
    expectedRevisions: { 'remove.txt': revision.token },
  });

  assert.equal(result.applied, true);
  assert.equal(result.rolledBack, false);
  assert.ok(result.cacheInvalidation);
  assert.equal(fs.existsSync(filePath), false);
  assert.match(git(fixture.root, ['status', '--short']), /^D\s+remove\.txt$/m);
});

test('deleteLocalPath deletes a nested directory tree', () => {
  const fixture = createFixture('delete-directory');
  fs.mkdirSync(path.join(fixture.root, 'nested', 'child'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'nested', 'child', 'value.txt'), 'value\n');

  deleteLocalPath(fixture.state, {
    projectId: fixture.projectId,
    paths: ['nested'],
  });

  assert.equal(fs.existsSync(path.join(fixture.root, 'nested')), false);
});

test('revision mismatch blocks deletion before mutation', () => {
  const fixture = createFixture('stale-revision');
  const filePath = path.join(fixture.root, 'remove.txt');
  fs.writeFileSync(filePath, 'first\n');
  const revision = getFileRevision(filePath);
  fs.writeFileSync(filePath, 'changed\n');

  assert.throws(
    () => deleteLocalPath(fixture.state, {
      projectId: fixture.projectId,
      paths: ['remove.txt'],
      expectedRevisions: { 'remove.txt': revision.token },
    }),
    (error: any) => error?.payload?.code === 'FILE_CHANGED_SINCE_READ',
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'changed\n');
});

test('moveLocalPath previews and applies a rename without overwrite', () => {
  const fixture = createFixture('move-file');
  fs.mkdirSync(path.join(fixture.root, 'target'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'source.txt'), 'source\n');

  const preview = moveLocalPath(fixture.state, {
    projectId: fixture.projectId,
    moves: [{ from: 'source.txt', to: 'target/renamed.txt' }],
    dryRun: true,
  });
  assert.deepEqual(preview.gitPreview, [{ status: 'renamed', from: 'source.txt', to: 'target/renamed.txt' }]);
  assert.equal(fs.existsSync(path.join(fixture.root, 'source.txt')), true);

  const applied = moveLocalPath(fixture.state, {
    projectId: fixture.projectId,
    moves: [{ from: 'source.txt', to: 'target/renamed.txt' }],
  });
  assert.equal(applied.applied, true);
  assert.equal(fs.existsSync(path.join(fixture.root, 'source.txt')), false);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'target', 'renamed.txt'), 'utf8'), 'source\n');
});

test('moveLocalPath moves a directory tree without changing its contents', () => {
  const fixture = createFixture('move-directory');
  fs.mkdirSync(path.join(fixture.root, 'source-dir', 'child'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'source-dir', 'child', 'value.txt'), 'value\n');

  const result = moveLocalPath(fixture.state, {
    projectId: fixture.projectId,
    moves: [{ from: 'source-dir', to: 'renamed-dir' }],
  });

  assert.equal(result.applied, true);
  assert.equal(fs.existsSync(path.join(fixture.root, 'source-dir')), false);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'renamed-dir', 'child', 'value.txt'), 'utf8'), 'value\n');
});

test('applyLocalPatch delegates structured operations to the guarded mutation transaction', () => {
  const fixture = createFixture('structured-patch');
  fs.writeFileSync(path.join(fixture.root, 'old.txt'), 'old\n');

  const preview = applyLocalPatch(fixture.state, {
    projectId: fixture.projectId,
    operations: [{ type: 'move', from: 'old.txt', to: 'new.txt' }],
    dryRun: true,
  });
  assert.equal(preview.dryRun, true);
  assert.equal(fs.existsSync(path.join(fixture.root, 'old.txt')), true);

  const applied = applyLocalPatch(fixture.state, {
    projectId: fixture.projectId,
    operations: [{ type: 'move', from: 'old.txt', to: 'new.txt' }],
  });
  assert.equal(applied.applied, true);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'new.txt'), 'utf8'), 'old\n');
});

test('moveLocalPath rejects destination collisions and protected paths', () => {
  const fixture = createFixture('move-guards');
  fs.writeFileSync(path.join(fixture.root, 'source.txt'), 'source\n');
  fs.writeFileSync(path.join(fixture.root, 'exists.txt'), 'exists\n');
  fs.mkdirSync(path.join(fixture.root, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.devflow', 'control.json'), '{}');

  assert.throws(
    () => moveLocalPath(fixture.state, {
      projectId: fixture.projectId,
      moves: [{ from: 'source.txt', to: 'exists.txt' }],
    }),
    (error: any) => error?.payload?.code === 'MOVE_DESTINATION_EXISTS',
  );
  assert.throws(
    () => deleteLocalPath(fixture.state, {
      projectId: fixture.projectId,
      paths: ['.devflow/control.json'],
    }),
    (error: any) => error?.payload?.code === 'PROTECTED_PATH',
  );
  assert.throws(
    () => deleteLocalPath(fixture.state, {
      projectId: fixture.projectId,
      paths: ['.git/config'],
    }),
    (error: any) => error?.payload?.code === 'PROTECTED_PATH',
  );
});

test('exact DevFlow command config files can be migrated while other DevFlow paths stay protected', () => {
  const fixture = createFixture('command-config-migration');
  fs.mkdirSync(path.join(fixture.root, '.devflow', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.devflow', 'commands.yaml'), 'commands:\n');
  fs.writeFileSync(path.join(fixture.root, '.devflow', 'commands.json'), '{"commands":{}}\n');
  fs.writeFileSync(path.join(fixture.root, '.devflow', 'nested', 'commands.yaml'), 'commands:\n');

  const moved = moveLocalPath(fixture.state, {
    projectId: fixture.projectId,
    moves: [{ from: '.devflow/commands.json', to: 'commands.json.backup' }],
  });
  assert.equal(moved.applied, true);
  assert.equal(fs.existsSync(path.join(fixture.root, '.devflow', 'commands.json')), false);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'commands.json.backup'), 'utf8'), '{"commands":{}}\n');

  const deleted = deleteLocalPath(fixture.state, {
    projectId: fixture.projectId,
    paths: ['.devflow/commands.yaml'],
  });
  assert.equal(deleted.applied, true);
  assert.equal(fs.existsSync(path.join(fixture.root, '.devflow', 'commands.yaml')), false);

  assert.throws(
    () => deleteLocalPath(fixture.state, {
      projectId: fixture.projectId,
      paths: ['.devflow/nested/commands.yaml'],
    }),
    (error: any) => error?.payload?.code === 'PROTECTED_PATH',
  );
});

test('applyPathMutations rolls back completed operations when ownership persistence fails', () => {
  const fixture = createFixture('ownership-rollback');
  fs.writeFileSync(path.join(fixture.root, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(fixture.root, 'b.txt'), 'b\n');

  assert.throws(
    () => applyPathMutations(fixture.state, {
      projectId: fixture.projectId,
      __recordOwnedChanges: () => { throw new Error('synthetic ownership failure'); },
      operations: [
        { type: 'move', from: 'a.txt', to: 'a-renamed.txt' },
        { type: 'delete', path: 'b.txt' },
      ],
    }),
    (error: any) => error?.payload?.code === 'PATH_MUTATION_OWNERSHIP_FAILED',
  );

  assert.equal(fs.readFileSync(path.join(fixture.root, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(path.join(fixture.root, 'b.txt'), 'utf8'), 'b\n');
  assert.equal(fs.existsSync(path.join(fixture.root, 'a-renamed.txt')), false);
});

test('applyPathMutations rolls back completed moves when a later filesystem operation fails', () => {
  const fixture = createFixture('rollback');
  fs.writeFileSync(path.join(fixture.root, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(fixture.root, 'b.txt'), 'b\n');

  let renameCalls = 0;
  const io = {
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    statSync: fs.statSync,
    realpathSync: fs.realpathSync,
    mkdirSync: fs.mkdirSync,
    rmSync: fs.rmSync,
    renameSync(from: fs.PathLike, to: fs.PathLike) {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error('simulated second-operation failure');
      fs.renameSync(from, to);
    },
  };

  assert.throws(
    () => applyPathMutations(fixture.state, {
      projectId: fixture.projectId,
      operations: [
        { type: 'move', from: 'a.txt', to: 'a-renamed.txt' },
        { type: 'move', from: 'b.txt', to: 'b-renamed.txt' },
      ],
    }, io),
    (error: any) => error?.payload?.code === 'PATH_MUTATION_FAILED',
  );

  assert.equal(fs.readFileSync(path.join(fixture.root, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(path.join(fixture.root, 'b.txt'), 'utf8'), 'b\n');
  assert.equal(fs.existsSync(path.join(fixture.root, 'a-renamed.txt')), false);
  assert.equal(fs.existsSync(path.join(fixture.root, 'b-renamed.txt')), false);
});
