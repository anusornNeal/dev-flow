import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-apply-verify-'));
process.env.DEVFLOW_DB_PATH = path.join(os.tmpdir(), `devflow-apply-verify-db-${path.basename(tempRoot)}.sqlite`);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');

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
  createProject({ id: 'project-apply-verify', name: 'Apply Verify', repoUrl: 'https://example.com/apply-verify', localPath: root });
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

test('applyAndVerifyAsync runs resource-safe targeted verification commands concurrently without caller isolation hints', async () => {
  const root = fixture('parallel');
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'target-a.mjs'), "await new Promise((resolve) => setTimeout(resolve, 800)); process.stdout.write('target a ok\\n');\n", 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'target-b.mjs'), "await new Promise((resolve) => setTimeout(resolve, 800)); process.stdout.write('target b ok\\n');\n", 'utf8');
  fs.writeFileSync(path.join(root, '.devflow', 'commands.yaml'), [
    'commands:',
    '  target-a:',
    '    executable: node',
    '    args:',
    '      - scripts/target-a.mjs',
    '    category: test',
    '  target-b:',
    '    executable: node',
    '    args:',
    '      - scripts/target-b.mjs',
    '    category: test',
    '',
  ].join('\n'), 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'parallel fixtures']);

  const startedAt = Date.now();
  const result = await applyAndVerifyAsync(stateFor(root), {
    projectId: 'project-apply-verify',
    files: [{ filePath: 'src/value.ts', edits: [{ type: 'replace', find: 'value = 1', replaceWith: 'value = 3' }] }],
    requestedCommands: ['target-a', 'target-b'],
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, true);
  assert.equal(result.parallelVerification, true);
  assert.equal(result.verification.length, 2);
  assert.equal(result.verification.every((entry: any) => entry.status === 'succeeded'), true);
  const summedVerificationMs = result.verification.reduce((sum: number, entry: any) => sum + Number(entry.durationMs || 0), 0);
  assert.equal(
    elapsedMs < summedVerificationMs * 0.8,
    true,
    `expected concurrent wall time ${elapsedMs}ms to be materially below summed verification time ${summedVerificationMs}ms`,
  );
  assert.equal(typeof result.verificationPerformance?.wallMs, 'number');
  assert.equal(result.verificationPerformance?.processSpawns, 2);
});

test('applyAndVerifyAsync fails cheap prerequisite before launching a later isolated expensive stage', async () => {
  const root = fixture('stage-fail-fast');
  const expensiveCounter = path.join(tempRoot, 'expensive-stage-counter.txt');
  fs.writeFileSync(path.join(root, 'scripts', 'typecheck.mjs'), "process.stderr.write('typecheck failed\\n'); process.exit(2);\n", 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'build.mjs'), [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(expensiveCounter)}, 'started', 'utf8');`,
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: {
      test: 'node scripts/test.mjs',
      typecheck: 'node scripts/typecheck.mjs',
      build: 'node scripts/build.mjs',
    },
  }, null, 2), 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'staged fail-fast fixtures']);

  const result = await applyAndVerifyAsync(stateFor(root), {
    projectId: 'project-apply-verify',
    files: [{ filePath: 'src/value.ts', edits: [{ type: 'replace', find: 'value = 1', replaceWith: 'value = 4' }] }],
    lane: 'safe',
    requestedCommands: ['typecheck', 'build'],
    resourceIsolatedCommands: ['build'],
    forceFresh: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.verification[0]?.command, 'typecheck');
  assert.equal(fs.existsSync(expensiveCounter), false, 'later expensive stage must not launch after prerequisite failure');
});

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
