import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-command-result-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { runProjectCommand, describeProjectCommand } = await import('../../src/server/services/projectCommandService.js');
const { clearWorkspaceMetadataCache, getWorkspaceMetadataCacheStats } = await import('../../src/server/services/workspaceMetadataCacheService.js');
const { createProject: upsertProject } = await import('../../src/server/repositories/projectRepository.js');
const { invalidateRepoCacheDependencies } = await import('../../src/server/services/repoCacheInvalidationService.js');

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

test('runProjectCommand reuses cached package metadata between unchanged calls', () => {
  clearWorkspaceMetadataCache();
  const root = createProject('metadata-cache', {
    typecheck: 'node scripts/pass.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n');

  runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });
  const afterFirst = getWorkspaceMetadataCacheStats();
  runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });
  const afterSecond = getWorkspaceMetadataCacheStats();

  assert.equal(afterFirst.misses >= 1, true);
  assert.equal(afterSecond.hits > afterFirst.hits, true);
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

test('runProjectCommand compact mode caps payload and exposes process/startup metrics', () => {
  const root = createProject('compact-output', {
    test: 'node scripts/output.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'output.mjs'), "process.stdout.write('x'.repeat(5000));\n");

  const result = runProjectCommand(stateFor(root), {
    projectId: 'project-command',
    command: 'test',
    responseMode: 'compact',
  });

  assert.equal(result.ok, true);
  assert.equal(result.responseMode, 'compact');
  assert.equal(result.stdoutTruncated, true);
  assert.equal(Buffer.byteLength(result.stdout, 'utf8') < 3000, true);
  assert.equal(result.processSpawns, 1);
  assert.equal(typeof result.performance?.resolutionMs, 'number');
  assert.equal(typeof result.performance?.cacheLookupMs, 'number');
  assert.equal(typeof result.performance?.executionMs, 'number');
  assert.equal(typeof result.performance?.resultNormalizationMs, 'number');
  assert.equal(typeof result.performance?.totalMs, 'number');
  assert.equal((result.performance?.totalMs || 0) >= (result.performance?.executionMs || 0), true);
});

test('runProjectCommand reuses an explicitly cached successful result only for the same repo revision', () => {
  const root = createProject('cached-result', {
    test: 'node scripts/cached.mjs',
  });
  const counterPath = path.join(tempRoot, 'cached-result-counter.txt');
  fs.writeFileSync(path.join(root, 'source.txt'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'cached.mjs'), [
    "import fs from 'node:fs';",
    `const counterPath = ${JSON.stringify(counterPath)};`,
    "const next = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(counterPath, String(next), 'utf8');",
    "process.stdout.write(`run:${next}\\n`);",
  ].join('\n'), 'utf8');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  };
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  git(['add', '.']);
  git(['commit', '-m', 'initial']);

  const first = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'test', cacheResult: true });
  const second = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'test', cacheResult: true });

  assert.equal(first.cache?.hit, false);
  assert.equal(second.cache?.hit, true);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  assert.equal(second.stdout, first.stdout);

  fs.writeFileSync(path.join(root, 'source.txt'), 'two\n', 'utf8');
  const third = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'test', cacheResult: true });
  assert.equal(third.cache?.hit, false);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
});

test('verification cache lineage invalidates only the affected repository when project rules change', () => {
  const createCachedRepo = (name: string) => {
    const root = createProject(name, { test: 'node scripts/cached.mjs' });
    const counterPath = path.join(tempRoot, `${name}-counter.txt`);
    fs.writeFileSync(path.join(root, 'source.txt'), 'same\n', 'utf8');
    fs.writeFileSync(path.join(root, 'scripts', 'cached.mjs'), [
      "import fs from 'node:fs';",
      `const counterPath = ${JSON.stringify(counterPath)};`,
      "const next = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(counterPath, String(next), 'utf8');",
      "process.stdout.write(`run:${next}\\n`);",
    ].join('\n'), 'utf8');
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
      assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    };
    git(['init']);
    git(['config', 'user.name', 'DevFlow Test']);
    git(['config', 'user.email', 'devflow@example.com']);
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    return { root, counterPath };
  };

  const firstRepo = createCachedRepo('lineage-a');
  const secondRepo = createCachedRepo('lineage-b');
  const run = (root: string) => runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'test', cacheResult: true });

  assert.equal(run(firstRepo.root).cache?.hit, false);
  assert.equal(run(firstRepo.root).cache?.hit, true);
  assert.equal(run(secondRepo.root).cache?.hit, false);
  assert.equal(run(secondRepo.root).cache?.hit, true);

  invalidateRepoCacheDependencies({
    root: firstRepo.root,
    reason: 'project-rules-updated',
    dependencies: ['project-rules'],
  });

  assert.equal(run(firstRepo.root).cache?.hit, false);
  assert.equal(run(secondRepo.root).cache?.hit, true);
  assert.equal(fs.readFileSync(firstRepo.counterPath, 'utf8'), '2');
  assert.equal(fs.readFileSync(secondRepo.counterPath, 'utf8'), '1');
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

test('describeProjectCommand gives equivalent package scripts one semantic key and recognizes FULL aliases', () => {
  const root = createProject('descriptor-semantics', {
    typecheck: 'tsc --noEmit',
    lint: 'tsc --noEmit',
    verify: 'tsx scripts/verify.ts',
    test: 'tsx scripts/verify.ts',
  });
  const state = stateFor(root);

  const typecheck = describeProjectCommand(state, { projectId: 'project-command', command: 'typecheck' });
  const lint = describeProjectCommand(state, { projectId: 'project-command', command: 'lint' });
  const testCommand = describeProjectCommand(state, { projectId: 'project-command', command: 'test' });

  assert.equal(typecheck.semanticKey, lint.semanticKey);
  assert.equal(typecheck.scope, 'broad');
  assert.equal(testCommand.scope, 'full');
  assert.equal(typecheck.verificationClass, 'fast');
  assert.deepEqual(typecheck.sharedResources, ['typescript']);
  assert.equal(lint.verificationClass, 'fast');
  assert.deepEqual(lint.sharedResources, ['typescript']);
  assert.equal(testCommand.verificationClass, 'heavy');
  assert.deepEqual(testCommand.sharedResources, ['repo']);
});

test('describeProjectCommand classifies verification access conservatively', () => {
  const packageRoot = createProject('descriptor-access-package', {
    typecheck: 'tsc --noEmit',
    build: 'vite build',
  });
  const packageState = stateFor(packageRoot);

  assert.equal(describeProjectCommand(packageState, { projectId: 'project-command', command: 'typecheck' }).access, 'verify');
  assert.equal(describeProjectCommand(packageState, { projectId: 'project-command', command: 'build' }).access, 'write');

  const configRoot = createConfigProject('descriptor-access-config', [
    'commands:',
    '  focused-test:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    category: test',
    '  mutate:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    category: build',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(configRoot, 'scripts', 'pass.mjs'), 'process.exit(0);\n');
  const configState = stateFor(configRoot);

  assert.equal(describeProjectCommand(configState, { projectId: 'project-command', command: 'focused-test' }).access, 'verify');
  assert.equal(describeProjectCommand(configState, { projectId: 'project-command', command: 'mutate' }).access, 'write');
});

test('runProjectCommand automatically reuses deterministic static verification and forceFresh bypasses evidence', () => {
  const root = createProject('auto-static-cache', {
    typecheck: 'node scripts/static.mjs',
  });
  const counterPath = path.join(tempRoot, 'auto-static-cache-counter.txt');
  fs.writeFileSync(path.join(root, 'source.txt'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'static.mjs'), [
    "import fs from 'node:fs';",
    `const counterPath = ${JSON.stringify(counterPath)};`,
    "const next = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(counterPath, String(next), 'utf8');",
  ].join('\n'), 'utf8');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  };
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  git(['add', '.']);
  git(['commit', '-m', 'initial']);

  const first = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });
  const second = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });
  const fresh = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck', forceFresh: true });

  assert.equal(first.cache?.hit, false);
  assert.equal(second.cache?.hit, true);
  assert.equal(second.processSpawns, 0);
  assert.equal(fresh.cache?.hit, false);
  assert.equal(fresh.processSpawns, 1);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
});

test('equivalent static package aliases reuse one semantic verification result', () => {
  const root = createProject('semantic-cache-alias', {
    typecheck: 'node scripts/shared.mjs',
    lint: 'node scripts/shared.mjs',
  });
  const counterPath = path.join(tempRoot, 'semantic-cache-alias-counter.txt');
  fs.writeFileSync(path.join(root, 'source.txt'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'shared.mjs'), [
    "import fs from 'node:fs';",
    `const counterPath = ${JSON.stringify(counterPath)};`,
    "const next = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(counterPath, String(next), 'utf8');",
  ].join('\n'), 'utf8');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  };
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  git(['add', '.']);
  git(['commit', '-m', 'initial']);

  const first = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });
  const second = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'lint' });

  assert.equal(first.cache?.hit, false);
  assert.equal(second.cache?.hit, true);
  assert.equal(second.processSpawns, 0);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
});

test('automatic static verification cache invalidates when NODE_OPTIONS changes', () => {
  const root = createProject('cache-node-options', {
    typecheck: 'node scripts/static.mjs',
  });
  const counterPath = path.join(tempRoot, 'cache-node-options-counter.txt');
  fs.writeFileSync(path.join(root, 'source.txt'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'static.mjs'), [
    "import fs from 'node:fs';",
    `const counterPath = ${JSON.stringify(counterPath)};`,
    "const next = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(counterPath, String(next), 'utf8');",
  ].join('\n'), 'utf8');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  };
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  git(['add', '.']);
  git(['commit', '-m', 'initial']);

  const previousNodeOptions = process.env.NODE_OPTIONS;
  try {
    delete process.env.NODE_OPTIONS;
    const first = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });
    process.env.NODE_OPTIONS = '--no-warnings';
    const second = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });

    assert.equal(first.cache?.hit, false);
    assert.equal(second.cache?.hit, false);
    assert.equal(second.processSpawns, 1);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  }
});
