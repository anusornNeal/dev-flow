import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-project-command-candidate-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.sqlite');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const {
  describeProjectCommand,
  prepareProjectCommandVerificationCandidate,
  runProjectCommandAsync,
} = await import('../../src/server/services/projectCommandService.js');
const { releaseVerificationCandidate } = await import('../../src/server/services/verificationCandidateService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

function fixture(name: string) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'candidate-a\n', 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'read.mjs'), [
    "import fs from 'node:fs';",
    "process.stdout.write(fs.readFileSync('src/value.txt', 'utf8').trim());",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: {
      test: 'node scripts/read.mjs',
      build: 'node scripts/read.mjs',
    },
  }, null, 2), 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  git(root, ['config', 'user.email', 'devflow@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  createProject({ id: `project-${name}`, name, repoUrl: `https://example.com/${name}`, localPath: root });
  return { root, projectId: `project-${name}` };
}

function stateFor(root: string, projectId: string): any {
  return { projectsCache: [{ id: projectId, name: projectId, repoUrl: `https://example.com/${projectId}`, localPath: root }] };
}

const logger = { stdout: () => {}, stderr: () => {} };

test('async project verification runs against candidate A after live workspace advances to B', async () => {
  const { root, projectId } = fixture('immutable');
  const state = stateFor(root, projectId);
  const args = { projectId, command: 'test', cacheResult: true, forceFresh: false };
  const candidate = prepareProjectCommandVerificationCandidate(state, args);
  assert.ok(candidate);
  assert.doesNotMatch(JSON.stringify(candidate), /verification-candidates|[A-Z]:\\|\/tmp\//i);

  fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'candidate-b\n', 'utf8');

  const first = await runProjectCommandAsync(
    state,
    { ...args, __verificationCandidate: candidate },
    logger,
    () => {},
  );

  assert.equal(first.ok, true);
  assert.equal(first.stdout.trim(), 'candidate-a');
  assert.equal(first.cache?.hit, false);
  assert.equal(first.verificationCandidate?.candidateId, candidate?.candidateId);
  assert.equal(first.verificationCandidate?.repoRevision, candidate?.repoRevision);
  assert.equal(first.verificationCandidate?.executionKey, candidate?.executionIdentity.key);
  assert.equal(first.verificationCandidate?.current, false);
  assert.doesNotMatch(JSON.stringify(first.verificationCandidate), /verification-candidates|[A-Z]:\\|\/tmp\//i);

  const second = await runProjectCommandAsync(
    state,
    { ...args, __verificationCandidate: candidate },
    logger,
    () => {},
  );
  assert.equal(second.ok, true);
  assert.equal(second.stdout.trim(), 'candidate-a');
  assert.equal(second.cache?.hit, true);
  assert.equal(second.verificationCandidate?.executionKey, candidate?.executionIdentity.key);

  releaseVerificationCandidate(candidate!.candidateId);
});

test('package-script verification candidate stays current when only ignored repository command config changes', async () => {
  const { root, projectId } = fixture('package-currentness');
  fs.appendFileSync(path.join(root, '.gitignore'), '.devflow/\n', 'utf8');
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '-m', 'ignore devflow config']);
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  const configPath = path.join(root, '.devflow', 'commands.yaml');
  fs.writeFileSync(configPath, [
    'commands:',
    '  unrelated:',
    '    executable: node',
    '    args:',
    '      - scripts/read.mjs',
    '    category: test',
    '',
  ].join('\n'), 'utf8');

  const state = stateFor(root, projectId);
  const args = { projectId, command: 'test', cacheResult: false, forceFresh: true };
  const candidate = prepareProjectCommandVerificationCandidate(state, args);
  assert.ok(candidate);
  try {
    fs.appendFileSync(configPath, '# unrelated config change\n', 'utf8');
    const result = await runProjectCommandAsync(state, { ...args, __verificationCandidate: candidate }, logger, () => {});
    assert.equal(result.ok, true);
    assert.equal(result.stdout.trim(), 'candidate-a');
    assert.equal(result.verificationCandidate?.current, true, 'package-script candidate currentness must ignore unrelated repository command config changes');
  } finally {
    releaseVerificationCandidate(candidate!.candidateId);
  }
});

for (const extension of ['yaml', 'json'] as const) {
  test(`ignored commands.${extension} preset resolves and executes from immutable candidate`, async () => {
    const { root, projectId } = fixture(`ignored-config-${extension}`);
    fs.appendFileSync(path.join(root, '.gitignore'), '.devflow/\n', 'utf8');
    git(root, ['add', '.gitignore']);
    git(root, ['commit', '-m', 'ignore devflow config']);
    fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
    const configPath = path.join(root, '.devflow', `commands.${extension}`);
    const originalConfig = extension === 'yaml'
      ? [
          'commands:',
          '  snapshot-read:',
          '    executable: node',
          '    args:',
          '      - scripts/read.mjs',
          '    category: test',
          '',
        ].join('\n')
      : JSON.stringify({ commands: { 'snapshot-read': { executable: 'node', args: ['scripts/read.mjs'], category: 'test' } } }, null, 2);
    fs.writeFileSync(configPath, originalConfig, 'utf8');

    const state = stateFor(root, projectId);
    const args = { projectId, command: 'snapshot-read', cacheResult: true, forceFresh: false };
    const sourceDescriptor = describeProjectCommand(state, args);
    assert.equal(sourceDescriptor.source, 'repository-config');

    const candidate = prepareProjectCommandVerificationCandidate(state, args);
    assert.ok(candidate);
    assert.match(candidate!.commandConfigFingerprint || '', /^[a-f0-9]{64}$/);
    try {
      fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'candidate-b\n', 'utf8');
      const changedConfig = extension === 'yaml'
        ? [
            'commands:',
            '  snapshot-read:',
            '    executable: node',
            '    args:',
            '      - scripts/missing.mjs',
            '    category: test',
            '',
          ].join('\n')
        : JSON.stringify({ commands: { 'snapshot-read': { executable: 'node', args: ['scripts/missing.mjs'], category: 'test' } } }, null, 2);
      fs.writeFileSync(configPath, changedConfig, 'utf8');

      const result = await runProjectCommandAsync(
        state,
        { ...args, __verificationCandidate: candidate },
        logger,
        () => {},
      );
      assert.equal(result.ok, true, result.stderr || result.stdout);
      assert.equal(result.stdout.trim(), 'candidate-a');
      assert.equal(result.verificationCandidate?.candidateId, candidate!.candidateId);
      assert.equal(result.verificationCandidate?.current, false);
    } finally {
      releaseVerificationCandidate(candidate!.candidateId);
    }
  });
}

test('verification candidate can use ignored installed dependencies from the source environment', async () => {
  const { root, projectId } = fixture('ignored-dependency');
  fs.writeFileSync(path.join(root, 'scripts', 'read.mjs'), [
    "import { value } from 'candidate-dep';",
    "process.stdout.write(value);",
    '',
  ].join('\n'), 'utf8');
  git(root, ['add', 'scripts/read.mjs']);
  git(root, ['commit', '-m', 'use installed dependency']);

  const dependencyRoot = path.join(root, 'node_modules', 'candidate-dep');
  fs.mkdirSync(dependencyRoot, { recursive: true });
  fs.writeFileSync(path.join(dependencyRoot, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }), 'utf8');
  fs.writeFileSync(path.join(dependencyRoot, 'index.js'), "export const value = 'dependency-ok';\n", 'utf8');

  const state = stateFor(root, projectId);
  const args = { projectId, command: 'test', cacheResult: false, forceFresh: true };
  const candidate = prepareProjectCommandVerificationCandidate(state, args);
  assert.ok(candidate);
  try {
    const result = await runProjectCommandAsync(
      state,
      { ...args, __verificationCandidate: candidate },
      logger,
      () => {},
    );
    assert.equal(result.ok, true, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), 'dependency-ok');
  } finally {
    releaseVerificationCandidate(candidate!.candidateId);
  }
  assert.equal(fs.existsSync(path.join(dependencyRoot, 'index.js')), true, 'candidate cleanup must not remove source dependencies');
});

test('focused verification candidate identity is target-specific and rejects target substitution', async () => {
  const { root, projectId } = fixture('focused-target-candidate');
  fs.appendFileSync(path.join(root, '.gitignore'), '.devflow/\n', 'utf8');
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'target-read.mjs'), [
    "import fs from 'node:fs';",
    "process.stdout.write(fs.readFileSync(process.argv[2], 'utf8').trim());",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'a.txt'), 'target-a\n', 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'b.txt'), 'target-b\n', 'utf8');
  git(root, ['add', '.gitignore', 'scripts/target-read.mjs', 'tests/a.txt', 'tests/b.txt']);
  git(root, ['commit', '-m', 'add focused target fixtures']);
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.devflow', 'commands.yaml'), [
    'commands:',
    '  test-focused:',
    '    executable: node',
    '    args:',
    '      - scripts/target-read.mjs',
    '    acceptsTargets: true',
    '    category: test',
    '',
  ].join('\n'), 'utf8');

  const state = stateFor(root, projectId);
  const argsA = { projectId, command: 'test-focused', targets: ['tests/a.txt'], cacheResult: false, forceFresh: true };
  const argsB = { ...argsA, targets: ['tests/b.txt'] };
  const candidateA = prepareProjectCommandVerificationCandidate(state, argsA);
  const candidateB = prepareProjectCommandVerificationCandidate(state, argsB);
  assert.ok(candidateA && candidateB);
  assert.notEqual(candidateA!.executionIdentity.key, candidateB!.executionIdentity.key);
  try {
    const result = await runProjectCommandAsync(state, { ...argsA, __verificationCandidate: candidateA }, logger, () => {});
    assert.equal(result.ok, true, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), 'target-a');
    await assert.rejects(
      runProjectCommandAsync(state, { ...argsB, __verificationCandidate: candidateA }, logger, () => {}),
      (error: any) => error?.payload?.code === 'VERIFICATION_CANDIDATE_IDENTITY_MISMATCH',
    );
  } finally {
    releaseVerificationCandidate(candidateA!.candidateId);
    releaseVerificationCandidate(candidateB!.candidateId);
  }
});

test('write-access project command does not create a verification candidate', () => {
  const { root, projectId } = fixture('write-access');
  const candidate = prepareProjectCommandVerificationCandidate(stateFor(root, projectId), {
    projectId,
    command: 'build',
  });
  assert.equal(candidate, null);
});
