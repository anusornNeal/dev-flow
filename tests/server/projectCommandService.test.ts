import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-command-result-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { runProjectCommand } = await import('../../src/server/services/projectCommandService.js');
const { createProject: upsertProject } = await import('../../src/server/repositories/projectRepository.js');

function createProject(name: string, scripts: Record<string, string>) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts }, null, 2));
  return root;
}

function stateFor(root: string): any {
  upsertProject({
    id: 'project-command',
    name: 'Command Fixture',
    repoUrl: 'https://example.com/command',
    localPath: root,
  });
  return {
    projectsCache: [
      { id: 'project-command', name: 'Command Fixture', repoUrl: 'https://example.com/command', localPath: root },
    ],
  };
}

test('runProjectCommand returns normalized success output', () => {
  const root = createProject('success', {
    typecheck: 'node scripts/pass.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), "process.stdout.write('ok\\n');\n");

  const result = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdoutEmpty, false);
  assert.equal(result.stderrEmpty, true);
  assert.equal(result.outputSummary.hasStdout, true);
  assert.match(result.stdout, /ok/);
});

test('runProjectCommand returns normalized failed output', () => {
  const root = createProject('failed', {
    lint: 'node scripts/fail.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'fail.mjs'), "process.stderr.write('bad\\n'); process.exit(7);\n");

  const result = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'lint' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.stderrEmpty, false);
  assert.equal(result.outputSummary.hasStderr, true);
  assert.match(result.stderr, /bad/);
});

test('runProjectCommand marks empty output explicitly', () => {
  const root = createProject('empty-output', {
    build: 'node scripts/empty.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'empty.mjs'), 'process.exit(0);\n');

  const result = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'build' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.stdoutEmpty, true);
  assert.equal(result.stderrEmpty, true);
  assert.equal(result.stdoutBytes, 0);
  assert.equal(result.stderrBytes, 0);
  assert.equal(result.outputSummary.hasStdout, false);
  assert.equal(result.outputSummary.hasStderr, false);
});

test('runProjectCommand returns timed_out status when the process exceeds timeout', () => {
  const root = createProject('timeout', {
    verify: 'node scripts/slow.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'slow.mjs'), 'setTimeout(() => process.exit(0), 2000);\n');

  const result = runProjectCommand(stateFor(root), {
    projectId: 'project-command',
    command: 'verify',
    timeoutMs: 50,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'timed_out');
  assert.equal(result.timedOut, true);
});

test('runProjectCommand returns structured output for test command', () => {
  const root = createProject('test-command', {
    test: 'node scripts/test.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'test.mjs'), "process.stdout.write('test ok\\n');\n");

  const result = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'test' });

  assert.equal(result.command, 'test');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputSummary.hasStdout, true);
  assert.match(result.stdout, /test ok/);
});

test('runProjectCommand validation failures remain structured ApiErrors', () => {
  const root = createProject('validation', {
    typecheck: 'node scripts/pass.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n');

  assert.throws(
    () => runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'unsafe' }),
    (error: any) => error?.payload?.code === 'COMMAND_NOT_ALLOWED',
  );
});
