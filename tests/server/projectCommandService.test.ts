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

function createConfigProject(name: string, config: string, extension: 'yaml' | 'json' = 'yaml') {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.devflow', `commands.${extension}`), config);
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

test('runProjectCommand executes a repository-defined YAML preset without package.json', () => {
  const root = createConfigProject('yaml-custom', [
    'commands:',
    '  validate-skill:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), "process.stdout.write('custom ok\\n');\n");

  const result = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'validate-skill' });

  assert.equal(result.command, 'validate-skill');
  assert.equal(result.ok, true);
  assert.match(result.stdout, /custom ok/);
});

test('runProjectCommand executes a repository-defined JSON preset', () => {
  const root = createConfigProject('json-custom', JSON.stringify({
    commands: {
      'validate-json': {
        executable: 'node',
        args: ['scripts/pass.mjs'],
      },
    },
  }, null, 2), 'json');
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), "process.stdout.write('json ok\\n');\n");

  const result = runProjectCommand(stateFor(root), { projectId: 'project-command', preset: 'validate-json' });

  assert.equal(result.ok, true);
  assert.match(result.stdout, /json ok/);
});

test('runProjectCommand rejects unsafe shell-control tokens before spawn', () => {
  const root = createConfigProject('unsafe-arg', [
    'commands:',
    '  unsafe:',
    '    executable: node',
    '    args:',
    '      - -e',
    '      - "process.stdout.write(\'bad\') && process.exit(0)"',
    '',
  ].join('\n'));

  assert.throws(
    () => runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'unsafe' }),
    (error: any) => error?.payload?.code === 'COMMAND_CONFIG_UNSAFE_ARG',
  );
});

test('runProjectCommand rejects configured cwd outside the repository', () => {
  const root = createConfigProject('unsafe-cwd', [
    'commands:',
    '  validate:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    cwd: ../outside',
    '',
  ].join('\n'));

  assert.throws(
    () => runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'validate' }),
    (error: any) => error?.payload?.code === 'COMMAND_CONFIG_CWD_DENIED',
  );
});

test('runProjectCommand rejects mutation and deployment preset categories', () => {
  const root = createConfigProject('unsafe-category', [
    'commands:',
    '  deploy:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    category: deploy',
    '',
  ].join('\n'));

  assert.throws(
    () => runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'deploy' }),
    (error: any) => error?.payload?.code === 'COMMAND_CONFIG_CATEGORY_DENIED',
  );
});

test('runProjectCommand applies configured timeout and output caps', () => {
  const timeoutRoot = createConfigProject('config-timeout', [
    'commands:',
    '  slow:',
    '    executable: node',
    '    args:',
    '      - scripts/slow.mjs',
    '    timeoutMs: 25',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(timeoutRoot, 'scripts', 'slow.mjs'), 'setTimeout(() => process.exit(0), 2000);\n');
  const timeoutResult = runProjectCommand(stateFor(timeoutRoot), { projectId: 'project-command', command: 'slow' });
  assert.equal(timeoutResult.status, 'timed_out');

  const outputRoot = createConfigProject('config-output', [
    'commands:',
    '  noisy:',
    '    executable: node',
    '    args:',
    '      - scripts/noisy.mjs',
    '    maxOutputBytes: 5',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(outputRoot, 'scripts', 'noisy.mjs'), "process.stdout.write('1234567890');\n");
  const outputResult = runProjectCommand(stateFor(outputRoot), { projectId: 'project-command', command: 'noisy' });
  assert.equal(outputResult.stdoutTruncated, true);
  assert.equal(outputResult.stdoutBytes, 10);
});
