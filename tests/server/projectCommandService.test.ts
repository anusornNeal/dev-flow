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
const projectCommandService = await import('../../src/server/services/projectCommandService.js');
const {
  runProjectCommand,
  runProjectCommandAsync,
  describeProjectCommand,
  describeProjectCommandResourceProfile,
  inspectProjectVerificationPresets,
  getProjectCommandExecutionIdentity,
  prepareProjectCommandVerificationCandidateAsync,
  buildProjectCommandInfrastructureRecovery,
  getProjectCommandDurableExecutionBudgetMs,
  resolveGradleRecoveryHeapPolicy,
  terminateCommandProcess,
} = projectCommandService;
const {
  clearReusableVerificationCandidatesForTests,
  getReusableVerificationCandidateDiagnostics,
  isVerificationCandidateCurrent,
  releaseReusableVerificationCandidateLeaseAsync,
  releaseVerificationCandidate,
  resolveVerificationCandidate,
} = await import('../../src/server/services/verificationCandidateService.js');
const { clearWorkspaceMetadataCache, getWorkspaceMetadataCacheStats } = await import('../../src/server/services/workspaceMetadataCacheService.js');
const { createProject: upsertProject } = await import('../../src/server/repositories/projectRepository.js');
const { getRepoCacheDiagnostics, invalidateRepoCacheDependencies } = await import('../../src/server/services/repoCacheInvalidationService.js');
const verificationResourceProfileService = await import('../../src/server/services/verificationResourceProfileService.js');
const { clearVerificationResourceProfilesForTests, getVerificationResourceProfileDiagnostics, recordVerificationResourceSample } = verificationResourceProfileService;

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

test('runProjectCommand retries proven infrastructure failure once with a revision-safe resource profile', () => {
  const marker = path.join(tempRoot, 'infra-retry-once-count.txt');
  const root = createConfigProject('infra-retry-once', [
    'commands:',
    '  infra-once:',
    '    executable: node',
    '    args:',
    '      - scripts/infra-once.mjs',
    '    category: test',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'infra-once.mjs'), [
    "import fs from 'node:fs';",
    `const marker = ${JSON.stringify(marker)};`,
    "const attempt = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(marker, String(attempt), 'utf8');",
    "if (process.env.DEVFLOW_VERIFICATION_RECOVERY !== 'resource-safe') { process.stderr.write('java.lang.OutOfMemoryError: Java heap space\\n'); process.exit(1); }",
    "process.stdout.write(JSON.stringify({ recovery: process.env.DEVFLOW_VERIFICATION_RECOVERY, attempt: process.env.DEVFLOW_VERIFICATION_RECOVERY_ATTEMPT }));",
  ].join('\n'), 'utf8');
  for (const args of [['init'], ['config', 'user.name', 'DevFlow Test'], ['config', 'user.email', 'devflow@example.test'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    const gitResult = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(gitResult.status, 0, gitResult.stderr || gitResult.stdout);
  }
  const configBefore = fs.readFileSync(path.join(root, '.devflow', 'commands.yaml'), 'utf8');
  const baseArgs = { projectId: 'project-command', command: 'infra-once', infrastructureRetryPolicy: 'resource-safe-once', cacheResult: false, forceFresh: true };
  const baseIdentity = getProjectCommandExecutionIdentity(stateFor(root), baseArgs)!;
  const recoveryIdentity = getProjectCommandExecutionIdentity(stateFor(root), { ...baseArgs, recoveryProfile: 'verification-infra-safe', retryAttempt: 1 })!;
  assert.equal(baseIdentity.repoRevision, recoveryIdentity.repoRevision);
  assert.notEqual(baseIdentity.key, recoveryIdentity.key, 'recovery profile must be represented in execution identity');
  const previousGradleOpts = process.env.GRADLE_OPTS;
  try {
    process.env.GRADLE_OPTS = '-Dorg.gradle.jvmargs=-Xmx2g';
    const heapIdentityA = getProjectCommandExecutionIdentity(stateFor(root), { ...baseArgs, recoveryProfile: 'verification-infra-safe', retryAttempt: 1 })!;
    process.env.GRADLE_OPTS = '-Dorg.gradle.jvmargs=-Xmx3g';
    const heapIdentityB = getProjectCommandExecutionIdentity(stateFor(root), { ...baseArgs, recoveryProfile: 'verification-infra-safe', retryAttempt: 1 })!;
    assert.notEqual(heapIdentityA.key, heapIdentityB.key, 'effective recovery heap inputs must participate in execution identity');
  } finally {
    if (previousGradleOpts === undefined) delete process.env.GRADLE_OPTS;
    else process.env.GRADLE_OPTS = previousGradleOpts;
  }

  const result = runProjectCommand(stateFor(root), baseArgs);

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), '2');
  assert.equal(result.infrastructureRecovery?.attempted, true);
  assert.equal(result.infrastructureRecovery?.retryCount, 1);
  assert.equal(result.infrastructureRecovery?.firstFailure?.failureClass, 'infrastructure');
  assert.equal(result.infrastructureRecovery?.profile?.kind, 'resource-safe');
  assert.match(result.stdout, /resource-safe/);
  assert.equal(fs.readFileSync(path.join(root, '.devflow', 'commands.yaml'), 'utf8'), configBefore, 'recovery must not mutate repository config');
});

test('Gradle recovery heap policy scales above 2 GB and preserves an existing larger safe Xmx', () => {
  const gib = 1024 ** 3;
  const low = resolveGradleRecoveryHeapPolicy(2 * gib, '');
  const medium = resolveGradleRecoveryHeapPolicy(8 * gib, '');
  const high = resolveGradleRecoveryHeapPolicy(32 * gib, '');
  const preserved = resolveGradleRecoveryHeapPolicy(32 * gib, '-Dorg.gradle.jvmargs=-Xmx6g');
  const unsafeLowMachine = resolveGradleRecoveryHeapPolicy(4 * gib, '-Dorg.gradle.jvmargs=-Xmx6g');

  assert.equal(low.heapMb, 1024);
  assert.equal(medium.heapMb, 2048);
  assert.equal(high.heapMb, 4096, 'high-memory machines must not be accidentally capped at 2 GB');
  assert.equal(preserved.heapMb, 6144);
  assert.equal(preserved.heapSource, 'existing-larger-safe');
  assert.equal(preserved.heapPolicyCeilingMb, 4096);
  assert.equal(unsafeLowMachine.heapMb, 1024, 'an existing Xmx above the machine safe bound is not blindly preserved');
  assert.equal(unsafeLowMachine.heapSource, 'machine-policy');
});

test('recovery profile audits adaptive verification timeout and Gradle worker/heap policy without changing repo state', () => {
  const root = createConfigProject('recovery-profile-audit', [
    'commands:',
    '  gradle-check:',
    '    executable: gradlew.bat',
    '    args:',
    '      - test',
    '    category: test',
    '',
  ].join('\n'));
  const recovery = buildProjectCommandInfrastructureRecovery(stateFor(root), {
    projectId: 'project-command',
    command: 'gradle-check',
    timeoutMs: 300_000,
    infrastructureRetryPolicy: 'resource-safe-once',
  });

  assert.ok(recovery);
  assert.equal(recovery!.profile.gradleTuned, true);
  assert.equal(recovery!.profile.maxWorkers, 1);
  assert.equal(recovery!.profile.requestedTimeoutMs, 375_000);
  assert.equal(recovery!.profile.timeoutMs, 375_000);
  assert.equal(recovery!.profile.timeoutCapped, false);
  assert.equal(typeof recovery!.profile.heapFloorMb, 'number');
  assert.equal(typeof recovery!.profile.heapPolicyCeilingMb, 'number');
  assert.equal(['machine-policy', 'existing-larger-safe'].includes(String(recovery!.profile.heapSource)), true);
});  

test('durable run_project_command budget includes the one allowed infrastructure recovery attempt', () => {
  const root = createProject('durable-execution-budget', {
    typecheck: 'node scripts/pass.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n');
  const state = stateFor(root);

  assert.equal(getProjectCommandDurableExecutionBudgetMs(state, {
    projectId: 'project-command', command: 'typecheck', timeoutMs: 100, infrastructureRetryPolicy: 'none',
  }), 100);
  assert.equal(getProjectCommandDurableExecutionBudgetMs(state, {
    projectId: 'project-command', command: 'typecheck', timeoutMs: 100, infrastructureRetryPolicy: 'resource-safe-once',
  }), 225);
  assert.equal(getProjectCommandDurableExecutionBudgetMs(state, {
    projectId: 'project-command', command: 'typecheck', timeoutMs: 300_000, infrastructureRetryPolicy: 'resource-safe-once',
  }), 675_000, 'verification recovery may expand above the legacy 300s cap while the durable budget covers both attempts');
});

test('adaptive verification timeout persists semantic history and treats timeout observations as censored lower bounds', () => {
  clearVerificationResourceProfilesForTests();
  const api = verificationResourceProfileService as any;
  assert.equal(typeof api.resolveVerificationTimeoutBudget, 'function');
  assert.equal(typeof api.resetVerificationResourceProfileMemoryForTests, 'function');

  const full = {
    repositoryKey: 'project:adaptive-timeout',
    semanticKey: 'full-test',
    machineKey: 'machine-a',
    cost: 'high' as const,
    verificationClass: 'heavy' as const,
    sharedResources: ['repo'],
  };
  const typecheck = {
    ...full,
    semanticKey: 'typecheck',
    cost: 'medium' as const,
    verificationClass: 'fast' as const,
    sharedResources: ['typescript'],
  };

  recordVerificationResourceSample(full, {
    status: 'timed_out',
    durationMs: 300_500,
    censoredLowerBoundMs: 300_000,
  });
  const escalated = api.resolveVerificationTimeoutBudget(full, {
    fallbackTimeoutMs: 120_000,
    ceilingMs: 900_000,
  });
  assert.equal(escalated.censoredSampleCount, 1);
  assert.ok(escalated.timeoutMs > 300_000, 'a timeout at 300s proves the next automatic budget must exceed 300s');

  const isolatedShort = api.resolveVerificationTimeoutBudget(typecheck, {
    fallbackTimeoutMs: 120_000,
    ceilingMs: 900_000,
  });
  assert.equal(isolatedShort.timeoutMs, 120_000, 'a long full-test observation must not inflate typecheck');

  for (const durationMs of [360_000, 380_000, 400_000]) {
    recordVerificationResourceSample(full, { status: 'succeeded', durationMs });
  }
  const learned = api.resolveVerificationTimeoutBudget(full, {
    fallbackTimeoutMs: 120_000,
    ceilingMs: 900_000,
  });
  assert.ok(learned.timeoutMs > 300_000);
  assert.equal(learned.source, 'learned');
  assert.equal(learned.ceilingMs, 900_000);
  assert.equal(learned.capped, false);
  const learnedDiagnostics = getVerificationResourceProfileDiagnostics();
  const learnedDiagnostic = learnedDiagnostics.profiles.find((profile: any) => profile.profileKey === learned.profileKey);
  assert.equal(learnedDiagnostic?.timeoutDecision?.source, 'learned');
  assert.equal(learnedDiagnostic?.timeoutDecision?.timeoutMs, learned.timeoutMs);

  const explicit = api.resolveVerificationTimeoutBudget(full, {
    fallbackTimeoutMs: 120_000,
    explicitTimeoutMs: 100_000,
    ceilingMs: 900_000,
  });
  assert.equal(explicit.timeoutMs, 100_000);
  assert.equal(explicit.source, 'explicit');

  api.resetVerificationResourceProfileMemoryForTests();
  const afterRestart = api.resolveVerificationTimeoutBudget(full, {
    fallbackTimeoutMs: 120_000,
    ceilingMs: 900_000,
  });
  assert.equal(afterRestart.sampleCount, 4, 'durable samples must rehydrate after in-memory state is reset');
  assert.ok(afterRestart.timeoutMs > 300_000);
  clearVerificationResourceProfilesForTests();
});

test('project command durable budget uses adaptive verification history above the legacy 300s cap without inflating unrelated commands', () => {
  clearVerificationResourceProfilesForTests();
  const root = createProject('adaptive-command-budget', {
    test: 'node scripts/full.mjs',
    typecheck: 'node scripts/typecheck.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'full.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(root, 'scripts', 'typecheck.mjs'), 'process.exit(0);\n');
  const state = stateFor(root);
  const fullProfile = describeProjectCommandResourceProfile(state, { projectId: 'project-command', command: 'test' });
  for (const durationMs of [330_000, 360_000, 390_000]) {
    recordVerificationResourceSample(fullProfile.resourceDescriptor, { status: 'succeeded', durationMs });
  }

  const adaptiveBudget = getProjectCommandDurableExecutionBudgetMs(state, {
    projectId: 'project-command', command: 'test', infrastructureRetryPolicy: 'none',
  });
  const shortBudget = getProjectCommandDurableExecutionBudgetMs(state, {
    projectId: 'project-command', command: 'typecheck', infrastructureRetryPolicy: 'none',
  });
  const explicitBudget = getProjectCommandDurableExecutionBudgetMs(state, {
    projectId: 'project-command', command: 'test', timeoutMs: 100_000, infrastructureRetryPolicy: 'none',
  });

  assert.ok(adaptiveBudget > 300_000, `expected adaptive full-test budget above 300s, got ${adaptiveBudget}`);
  assert.ok(adaptiveBudget <= 900_000);
  assert.equal(shortBudget, 120_000);
  assert.equal(explicitBudget, 100_000, 'explicit caller timeout remains authoritative within the safety ceiling');
  clearVerificationResourceProfilesForTests();
});

test('focused verification resource profiles bucket equivalent target shapes without path-cardinality explosion', () => {
  const root = createConfigProject('adaptive-target-buckets', [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    acceptsTargets: true',
    '    category: test',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n');
  for (const name of ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts']) {
    fs.writeFileSync(path.join(root, 'src', name), 'export {};\n');
  }
  const state = stateFor(root);
  const a = describeProjectCommandResourceProfile(state, { projectId: 'project-command', command: 'focused', targets: ['src/a.test.ts'] });
  const b = describeProjectCommandResourceProfile(state, { projectId: 'project-command', command: 'focused', targets: ['src/b.test.ts'] });
  const many = describeProjectCommandResourceProfile(state, {
    projectId: 'project-command', command: 'focused', targets: ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts', 'src/e.test.ts'],
  });

  assert.equal(a.resourceDescriptor.semanticKey, b.resourceDescriptor.semanticKey, 'same one-target TypeScript shape should share one resource profile');
  assert.notEqual(a.resourceDescriptor.semanticKey, many.resourceDescriptor.semanticKey, 'material target-count buckets should remain separate');
});

test('project command timeout records the selected kill budget as censored lower-bound evidence', () => {
  clearVerificationResourceProfilesForTests();
  const root = createConfigProject('adaptive-censored-command', [
    'commands:',
    '  slow-check:',
    '    executable: node',
    '    args:',
    '      - scripts/slow.mjs',
    '    category: test',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'slow.mjs'), 'setInterval(() => {}, 1000);\n');
  const state = stateFor(root);
  const described = describeProjectCommandResourceProfile(state, { projectId: 'project-command', command: 'slow-check' });
  const result = runProjectCommand(state, {
    projectId: 'project-command',
    command: 'slow-check',
    timeoutMs: 60,
    infrastructureRetryPolicy: 'none',
    forceFresh: true,
  });
  assert.equal(result.status, 'timed_out');
  const diagnostics = getVerificationResourceProfileDiagnostics();
  const profile = diagnostics.profiles.find((entry) => entry.profileKey === described.prediction.profileKey);
  assert.equal(profile?.censoredSampleCount, 1);
  assert.equal(profile?.maxCensoredLowerBoundMs, 60, 'process teardown latency must not be mistaken for completed runtime');
  clearVerificationResourceProfilesForTests();
});

test('runProjectCommand does not retry a bare timeout without infrastructure evidence', () => {
  const marker = path.join(tempRoot, 'bare-timeout-no-retry-count.txt');
  const root = createConfigProject('bare-timeout-no-retry', [
    'commands:',
    '  timeout-once:',
    '    executable: node',
    '    args:',
    '      - scripts/timeout-once.mjs',
    '    category: test',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'timeout-once.mjs'), [
    "import fs from 'node:fs';",
    `const marker = ${JSON.stringify(marker)};`,
    "const attempt = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(marker, String(attempt), 'utf8');",
    "setInterval(() => {}, 1_000);",
  ].join('\n'), 'utf8');

  const result = runProjectCommand(stateFor(root), {
    projectId: 'project-command',
    command: 'timeout-once',
    timeoutMs: 100,
    infrastructureRetryPolicy: 'resource-safe-once',
    cacheResult: false,
    forceFresh: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), '1', 'a bare timeout is not proof of retryable infrastructure failure');
  assert.equal(result.infrastructureRecovery?.attempted, false);
});

test('runProjectCommandAsync settles an ordinary timeout before the durable watchdog and reports termination evidence', async () => {
  const root = createProject('async-timeout-settlement', {
    test: 'node scripts/hang.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'hang.mjs'), 'setInterval(() => {}, 1_000);\n', 'utf8');
  const startedAt = Date.now();

  const result = await runProjectCommandAsync(
    stateFor(root),
    {
      projectId: 'project-command',
      command: 'test',
      timeoutMs: 50,
      infrastructureRetryPolicy: 'resource-safe-once',
      cacheResult: false,
      forceFresh: true,
    },
    { stdout: () => {}, stderr: () => {} },
    () => {},
  );

  assert.equal(result.status, 'timed_out');
  assert.equal(result.timedOut, true);
  assert.equal(result.infrastructureRecovery?.attempted, false);
  assert.equal(result.termination?.trigger, 'timeout');
  assert.equal(result.termination?.attempted, true);
  assert.ok(['process-close', 'termination-grace'].includes(String(result.termination?.settledBy)));
  assert.equal(Date.now() - startedAt < 5_000, true, 'ordinary command timeout must settle before the outer durable watchdog');
});

test('Windows command termination uses the exact process-tree terminator before root-signal fallback', () => {
  let fallbackKills = 0;
  const child = {
    pid: 123,
    kill: () => { fallbackKills += 1; return true; },
  };
  const treeCalls: number[] = [];
  const tree = terminateCommandProcess(child, {
    platform: 'win32',
    treeTerminator: (pid: number) => {
      treeCalls.push(pid);
      return { attempted: true, treeTermination: true, terminated: true };
    },
  });
  assert.deepEqual(treeCalls, [123]);
  assert.equal(tree.mode, 'process-tree');
  assert.equal(fallbackKills, 0);

  const fallback = terminateCommandProcess(child, {
    platform: 'win32',
    treeTerminator: () => ({ attempted: true, treeTermination: true, terminated: false, reason: 'terminator-failed' }),
  });
  assert.equal(fallback.mode, 'root-signal');
  assert.equal(fallbackKills, 1);

  const throwingFallback = terminateCommandProcess(child, {
    platform: 'win32',
    treeTerminator: () => { throw new Error('taskkill unavailable'); },
  });
  assert.equal(throwingFallback.mode, 'root-signal');
  assert.equal(throwingFallback.terminated, true);
  assert.match(String(throwingFallback.terminationError || ''), /taskkill unavailable/);
  assert.equal(fallbackKills, 2);
});

test('runProjectCommand never retries code failures and never retries infrastructure more than once', () => {
  const codeMarker = path.join(tempRoot, 'code-failure-count.txt');
  const codeRoot = createConfigProject('code-failure-no-retry', [
    'commands:',
    '  code-fail:',
    '    executable: node',
    '    args:',
    '      - scripts/code-fail.mjs',
    '    category: test',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(codeRoot, 'scripts', 'code-fail.mjs'), [
    "import fs from 'node:fs';",
    `const marker = ${JSON.stringify(codeMarker)};`,
    "const attempt = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(marker, String(attempt), 'utf8');",
    "process.stderr.write('AssertionError: expected true to equal false\\n'); process.exit(1);",
  ].join('\n'), 'utf8');
  const codeResult = runProjectCommand(stateFor(codeRoot), { projectId: 'project-command', command: 'code-fail', infrastructureRetryPolicy: 'resource-safe-once', cacheResult: false, forceFresh: true });
  assert.equal(codeResult.ok, false);
  assert.equal(fs.readFileSync(codeMarker, 'utf8'), '1');
  assert.equal(codeResult.infrastructureRecovery?.attempted, false);

  const oomMarker = path.join(tempRoot, 'repeated-oom-count.txt');
  const oomRoot = createConfigProject('repeated-oom', [
    'commands:',
    '  repeated-oom:',
    '    executable: node',
    '    args:',
    '      - scripts/repeated-oom.mjs',
    '    category: test',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(oomRoot, 'scripts', 'repeated-oom.mjs'), [
    "import fs from 'node:fs';",
    `const marker = ${JSON.stringify(oomMarker)};`,
    "const attempt = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(marker, String(attempt), 'utf8');",
    "process.stderr.write('java.lang.OutOfMemoryError: Java heap space\\n'); process.exit(1);",
  ].join('\n'), 'utf8');
  const oomResult = runProjectCommand(stateFor(oomRoot), { projectId: 'project-command', command: 'repeated-oom', infrastructureRetryPolicy: 'resource-safe-once', cacheResult: false, forceFresh: true });
  assert.equal(oomResult.ok, false);
  assert.equal(fs.readFileSync(oomMarker, 'utf8'), '2');
  assert.equal(oomResult.infrastructureRecovery?.attempted, true);
  assert.equal(oomResult.infrastructureRecovery?.retryCount, 1);
  assert.equal(oomResult.infrastructureRecovery?.finalStatus, 'failed');
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


test('bounded command capture retains only the response head while counting total bytes', () => {
  const createCapture = (projectCommandService as any).__createBoundedCommandOutputCaptureForTests;
  assert.equal(typeof createCapture, 'function');
  const capture = createCapture(64);
  for (let index = 0; index < 1000; index += 1) capture.append(Buffer.from('abcdefgh', 'utf8'));

  const snapshot = capture.snapshot();
  assert.equal(snapshot.bytes, 8000);
  assert.equal(snapshot.truncated, true);
  assert.equal(Buffer.byteLength(snapshot.value, 'utf8') <= 64, true);
});

test('runProjectCommandAsync reports full byte counts while returning bounded output', async () => {
  const root = createProject('async-bounded-output', {
    test: 'node scripts/async-output.mjs',
  });
  const emittedBytes = 256 * 1024;
  fs.writeFileSync(path.join(root, 'scripts', 'async-output.mjs'), `process.stdout.write('z'.repeat(${emittedBytes}));\n`);
  let streamedBytes = 0;

  const result = await runProjectCommandAsync(
    stateFor(root),
    { projectId: 'project-command', command: 'test', maxOutputBytes: 2048, forceFresh: true },
    {
      stdout: (data) => { streamedBytes += Buffer.byteLength(data, 'utf8'); },
      stderr: () => {},
    },
    () => {},
  );

  assert.equal(result.ok, true);
  assert.equal(result.stdoutBytes, emittedBytes);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(streamedBytes, emittedBytes);
  assert.equal(Buffer.byteLength(result.stdout, 'utf8') < 2200, true);
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

  clearVerificationResourceProfilesForTests();
  const first = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'test', cacheResult: true });
  const second = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'test', cacheResult: true });

  assert.equal(first.cache?.hit, false);
  assert.equal(second.cache?.hit, true);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  assert.equal(second.stdout, first.stdout);
  assert.equal(getVerificationResourceProfileDiagnostics().retainedSamples, 1, 'cache hit must not be recorded as a second execution sample');

  fs.writeFileSync(path.join(root, 'source.txt'), 'two\n', 'utf8');
  const third = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'test', cacheResult: true });
  assert.equal(third.cache?.hit, false);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
});

test('verification cache reuses scoped GREEN evidence across unrelated commits and invalidates relevant inputs', () => {
  const root = createProject('scoped-evidence-unrelated-commit', { test: 'node scripts/cached.mjs' });
  const counterPath = path.join(tempRoot, 'scoped-evidence-unrelated-commit-counter.txt');
  fs.writeFileSync(path.join(root, 'source.txt'), 'stable\n', 'utf8');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'one\n', 'utf8');
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

  const args = {
    projectId: 'project-command',
    command: 'test',
    cacheResult: true,
    affectedInputPaths: ['source.txt'],
    evidenceConsumerId: 'consumer-a',
  };
  const first = runProjectCommand(stateFor(root), args);
  assert.equal(first.cache?.hit, false);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'two\n', 'utf8');
  git(['add', 'unrelated.txt']);
  git(['commit', '-m', 'unrelated']);
  const second = runProjectCommand(stateFor(root), { ...args, evidenceConsumerId: 'consumer-b' });
  assert.equal(second.cache?.hit, true);
  assert.equal(second.processSpawns, 0);
  assert.equal(second.cache?.evidenceId, first.cache?.evidenceId);
  assert.deepEqual(second.cache?.consumers?.sort(), ['consumer-a', 'consumer-b']);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

  fs.writeFileSync(path.join(root, 'source.txt'), 'changed\n', 'utf8');
  const third = runProjectCommand(stateFor(root), args);
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

test('runProjectCommand executes exact benchmark package scripts through the safe package-manager path', () => {
  const root = createProject('benchmark-package-safe', {
    'benchmark:adaptive-source-disclosure': 'node scripts/benchmark.mjs',
    'admin:unsafe': 'node scripts/admin.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'benchmark.mjs'), "process.stdout.write('benchmark ok\\n');\n");
  fs.writeFileSync(path.join(root, 'scripts', 'admin.mjs'), "process.stdout.write('unsafe\\n');\n");
  const state = stateFor(root);
  const args = { projectId: 'project-command', command: 'benchmark:adaptive-source-disclosure' };
  const descriptor = describeProjectCommand(state, args);
  const result = runProjectCommand(state, args);

  assert.equal(descriptor.source, 'package-json');
  assert.equal(descriptor.access, 'verify');
  assert.equal(descriptor.scope, 'broad');
  assert.equal(result.ok, true);
  assert.equal(result.command, 'benchmark:adaptive-source-disclosure');
  assert.match(result.stdout, /benchmark ok/);
});

test('benchmark package fallback stays narrow and returns actionable command guidance', () => {
  const root = createProject('benchmark-policy-guidance', {
    'benchmark:adaptive-source-disclosure': 'node scripts/pass.mjs',
    'admin:unsafe': 'node scripts/pass.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n');
  const state = stateFor(root);

  assert.throws(
    () => runProjectCommand(state, { projectId: 'project-command', command: 'admin:unsafe' }),
    (error: any) => {
      assert.equal(error?.payload?.code, 'COMMAND_NOT_ALLOWED');
      assert.equal(error?.payload?.details?.availableCommands?.includes('admin:unsafe'), false);
      assert.ok(error?.payload?.details?.availableCommands?.includes('benchmark:adaptive-source-disclosure'));
      assert.equal(typeof error?.payload?.details?.nextAction, 'string');
      return true;
    },
  );
  assert.throws(
    () => runProjectCommand(state, { projectId: 'project-command', command: 'benchmark:adaptive-source-disclosur' }),
    (error: any) => {
      assert.equal(error?.payload?.code, 'COMMAND_NOT_CONFIGURED');
      assert.equal(error?.payload?.details?.nearestValidCommands?.[0], 'benchmark:adaptive-source-disclosure');
      assert.equal(typeof error?.payload?.details?.nextAction, 'string');
      return true;
    },
  );
  for (const command of ['benchmark:ok && whoami', './benchmark:ok', 'npm run benchmark:ok', '../benchmark:ok']) {
    assert.throws(
      () => runProjectCommand(state, { projectId: 'project-command', command }),
      (error: any) => error?.payload?.code === 'COMMAND_NOT_ALLOWED' && typeof error?.payload?.details?.nextAction === 'string',
      command,
    );
  }
});

test('repository-config preset wins over benchmark package fallback with the same name', () => {
  const root = createProject('benchmark-config-precedence', {
    'benchmark:adaptive-source-disclosure': 'node scripts/package.mjs',
  });
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.devflow', 'commands.json'), JSON.stringify({
    commands: {
      'benchmark:adaptive-source-disclosure': {
        executable: 'node',
        args: ['scripts/config.mjs'],
        category: 'test',
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'scripts', 'package.mjs'), "process.stdout.write('package\\n');\n");
  fs.writeFileSync(path.join(root, 'scripts', 'config.mjs'), "process.stdout.write('config\\n');\n");
  const state = stateFor(root);
  const args = { projectId: 'project-command', command: 'benchmark:adaptive-source-disclosure' };
  const descriptor = describeProjectCommand(state, args);
  const result = runProjectCommand(state, args);

  assert.equal(descriptor.source, 'repository-config');
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), 'config');
});

test('benchmark package scripts retain timeout and output bounds', () => {
  const root = createProject('benchmark-bounds', {
    'benchmark:slow': 'node scripts/slow.mjs',
    'benchmark:noisy': 'node scripts/noisy.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'slow.mjs'), 'setTimeout(() => process.exit(0), 2000);\n');
  fs.writeFileSync(path.join(root, 'scripts', 'noisy.mjs'), "process.stdout.write('x'.repeat(4096));\n");
  const state = stateFor(root);
  const timeoutResult = runProjectCommand(state, { projectId: 'project-command', command: 'benchmark:slow', timeoutMs: 25 });
  const outputResult = runProjectCommand(state, { projectId: 'project-command', command: 'benchmark:noisy', maxOutputBytes: 128 });

  assert.equal(timeoutResult.status, 'timed_out');
  assert.equal(timeoutResult.timedOut, true);
  assert.equal(outputResult.ok, true);
  assert.equal(outputResult.stdoutTruncated, true);
  assert.ok(outputResult.stdoutBytes >= 4096);
  assert.ok(Buffer.byteLength(outputResult.stdout, 'utf8') < outputResult.stdoutBytes);
});

test('benchmark package scripts retain verification candidate and cache identity behavior', async () => {
  const root = createProject('benchmark-cache-candidate', {
    'benchmark:cache': 'node scripts/counter.mjs',
  });
  const counterPath = path.join(tempRoot, 'benchmark-cache-counter.txt');
  fs.writeFileSync(path.join(root, 'scripts', 'counter.mjs'), [
    "import fs from 'node:fs';",
    `const counterPath = ${JSON.stringify(counterPath)};`,
    "const next = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(counterPath, String(next), 'utf8');",
    "process.stdout.write(String(next));",
  ].join('\n'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  };
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  git(['add', '.']);
  git(['commit', '-m', 'benchmark fixture']);
  const state = stateFor(root);
  const args = { projectId: 'project-command', command: 'benchmark:cache', cacheResult: true };
  const identity = getProjectCommandExecutionIdentity(state, args);
  assert.ok(identity);
  assert.equal(identity?.command, 'benchmark:cache');
  const candidate = await prepareProjectCommandVerificationCandidateAsync(state, args, { expectedExecutionKey: identity!.key });
  assert.ok(candidate);
  assert.equal(isVerificationCandidateCurrent(root, candidate!, candidate?.executionIdentity.commandConfigFingerprint), true);

  const first = runProjectCommand(state, args);
  const second = runProjectCommand(state, args);

  assert.equal(first.cache?.hit, false);
  assert.equal(second.cache?.hit, true);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  assert.equal(first.resourceProfile?.sharedResources.length, describeProjectCommand(state, args).sharedResources.length);
  releaseVerificationCandidate(candidate!.candidateId);
});

test('verification candidate reuse amortizes sequential checks and restores the immutable snapshot', async () => {
  await clearReusableVerificationCandidatesForTests();
  const root = createProject('candidate-reuse', {
    typecheck: 'node scripts/pass.mjs',
  });
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(root, 'value.txt'), 'source\n');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  };
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  git(['add', '.']);
  git(['commit', '-m', 'candidate reuse fixture']);

  const state = stateFor(root);
  const args = { projectId: 'project-command', command: 'typecheck', cacheResult: false, forceFresh: true };
  const identity = getProjectCommandExecutionIdentity(state, args)!;
  const candidateIds = new Set<string>();
  const reuseFlags: boolean[] = [];

  try {
    for (let index = 0; index < 5; index += 1) {
      const candidate: any = await prepareProjectCommandVerificationCandidateAsync(state, args, {
        expectedExecutionKey: identity.key,
        reuseKey: 'candidate-reuse-generation-1',
      });
      assert.ok(candidate);
      candidateIds.add(candidate.candidateId);
      reuseFlags.push(candidate.reuseLease?.reused === true);
      const resolved = resolveVerificationCandidate(candidate.candidateId);
      if (index === 0) {
        fs.writeFileSync(path.join(resolved.root, 'value.txt'), 'contaminated\n');
        fs.writeFileSync(path.join(resolved.root, 'generated.tmp'), 'remove me\n');
      }
      if (index === 1) {
        assert.equal(fs.readFileSync(path.join(resolved.root, 'value.txt'), 'utf8').trim(), 'source');
        assert.equal(fs.existsSync(path.join(resolved.root, 'generated.tmp')), false);
      }
      assert.equal(await releaseReusableVerificationCandidateLeaseAsync(candidate.reuseLease.leaseId), true);
      if (index === 0) {
        assert.equal(await releaseReusableVerificationCandidateLeaseAsync(candidate.reuseLease.leaseId), true, 'duplicate release must be idempotent without destroying the idle pooled candidate');
      }
    }

    const diagnostics = getReusableVerificationCandidateDiagnostics();
    assert.equal(candidateIds.size, 1, 'five compatible sequential checks should need only one candidate/worktree');
    assert.deepEqual(reuseFlags, [false, true, true, true, true]);
    assert.equal(diagnostics.creations, 1);
    assert.equal(diagnostics.hits, 4);
    assert.equal(1 - diagnostics.creations / 5 >= 0.6, true, 'candidate/worktree creation count should fall by at least 60%');
  } finally {
    await clearReusableVerificationCandidatesForTests();
  }
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

test('repository-defined verification preset carries declarative shared resources into its descriptor', () => {
  const root = createConfigProject('json-shared-resources', JSON.stringify({
    commands: {
      'test:integration': {
        executable: 'node',
        args: ['scripts/pass.mjs'],
        category: 'test',
        sharedResources: ['global:port:5432', 'database'],
      },
    },
  }, null, 2), 'json');
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n');

  const descriptor = describeProjectCommand(stateFor(root), { projectId: 'project-command', command: 'test:integration' });
  assert.equal(descriptor.access, 'verify');
  assert.deepEqual(descriptor.sharedResources, ['global:port:5432', 'database']);
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

test('repository command execution identity changes when ignored command config policy changes', () => {
  clearWorkspaceMetadataCache();
  const root = createConfigProject('repository-config-identity', [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    category: test',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n', 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), '.devflow/\n', 'utf8');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  };
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  git(['add', 'scripts/pass.mjs', '.gitignore']);
  git(['commit', '-m', 'initial']);
  const state = stateFor(root);
  const first = getProjectCommandExecutionIdentity(state, { projectId: 'project-command', command: 'focused' });
  assert.ok(first);

  fs.writeFileSync(path.join(root, '.devflow', 'commands.yaml'), [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    category: build',
    '',
  ].join('\n'), 'utf8');
  clearWorkspaceMetadataCache();
  const second = getProjectCommandExecutionIdentity(state, { projectId: 'project-command', command: 'focused' });
  assert.ok(second);
  assert.notEqual(second!.key, first!.key, 'raw repository command config changes must invalidate command execution/cache identity');
});

test('ignored repository command config change does not reuse stale cached verification output', () => {
  clearWorkspaceMetadataCache();
  const root = createConfigProject('repository-config-cache', [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/one.mjs',
    '    category: test',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'one.mjs'), "process.stdout.write('one');\n", 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'two.mjs'), "process.stdout.write('two');\n", 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), '.devflow/\n', 'utf8');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  };
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  git(['add', 'scripts/one.mjs', 'scripts/two.mjs', '.gitignore']);
  git(['commit', '-m', 'initial']);
  const state = stateFor(root);

  const first = runProjectCommand(state, { projectId: 'project-command', command: 'focused', cacheResult: true });
  assert.equal(first.ok, true);
  assert.equal(first.stdout, 'one');
  assert.equal(first.cache?.hit, false);

  fs.writeFileSync(path.join(root, '.devflow', 'commands.yaml'), [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/two.mjs',
    '    category: test',
    '',
  ].join('\n'), 'utf8');
  clearWorkspaceMetadataCache();

  const second = runProjectCommand(state, { projectId: 'project-command', command: 'focused', cacheResult: true });
  assert.equal(second.ok, true);
  assert.equal(second.stdout, 'two');
  assert.equal(second.cache?.hit, false, 'changed ignored config must produce a new cache identity');
  assert.notEqual(second.cache?.key, first.cache?.key);
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

test('verification evidence reuses across consumers when only unrelated inputs change', () => {
  const root = createProject('scoped-evidence-reuse', { typecheck: 'node scripts/static.mjs' });
  const counterPath = path.join(tempRoot, 'scoped-evidence-reuse-counter.txt');
  fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), 'one\n', 'utf8');
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

  const baseArgs = { projectId: 'project-command', command: 'typecheck', affectedInputPaths: ['source.ts'] };
  const first = runProjectCommand(stateFor(root), { ...baseArgs, evidenceConsumerId: 'session-a' });
  fs.writeFileSync(path.join(root, 'README.md'), 'two\n', 'utf8');
  const second = runProjectCommand(stateFor(root), { ...baseArgs, evidenceConsumerId: 'session-b' });

  assert.equal(first.cache?.hit, false);
  assert.equal(second.cache?.hit, true);
  assert.equal(second.processSpawns, 0);
  assert.ok(second.cache?.evidenceId);
  assert.equal(second.cache?.sourceConsumerId, 'session-a');
  assert.deepEqual(second.cache?.consumers, ['session-a', 'session-b']);

  fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 2;\n', 'utf8');
  const third = runProjectCommand(stateFor(root), { ...baseArgs, evidenceConsumerId: 'session-c' });
  assert.equal(third.cache?.hit, false);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
});

test('verification evidence invalidates when dependency identity changes inside a scoped reuse', () => {
  const root = createProject('dependency-evidence-invalidation', { typecheck: 'node scripts/static.mjs' });
  const counterPath = path.join(tempRoot, 'dependency-evidence-invalidation-counter.txt');
  fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n', 'utf8');
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

  const args = { projectId: 'project-command', command: 'typecheck', affectedInputPaths: ['source.ts'] };
  const first = runProjectCommand(stateFor(root), args);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"x":{}}}\n', 'utf8');
  const second = runProjectCommand(stateFor(root), args);

  assert.equal(first.cache?.hit, false);
  assert.equal(second.cache?.hit, false);
  assert.equal(second.processSpawns, 1);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
});

test('project command execution returns machine-specific predicted and actual resource telemetry', () => {
  clearVerificationResourceProfilesForTests();
  const root = createProject('resource-profile-sync', { typecheck: 'node scripts/resource.mjs' });
  fs.writeFileSync(path.join(root, 'scripts', 'resource.mjs'), "let sum = 0; for (let i = 0; i < 100000; i += 1) sum += i; process.stdout.write(String(sum));\n", 'utf8');

  const state = stateFor(root);
  const result = runProjectCommand(state, { projectId: 'project-command', command: 'typecheck', forceFresh: true });

  assert.equal(result.ok, true);
  assert.ok(result.resourceProfile?.profileKey);
  assert.ok(result.resourceProfile?.machineKey);
  assert.deepEqual(result.resourceProfile?.sharedResources, describeProjectCommand(state, { projectId: 'project-command', command: 'typecheck' }).sharedResources);
  assert.equal(typeof result.resourceProfile?.prediction.expected.durationMs, 'number');
  assert.equal(typeof result.resourceProfile?.actual.durationMs, 'number');
  assert.equal(typeof result.resourceProfile?.actual.systemCpuRatio, 'number');
  assert.equal(typeof result.resourceProfile?.actual.memoryPressureRatio, 'number');
  assert.equal(result.resourceProfile?.actual.processTreeSampleCount, 0);
  assert.equal(JSON.stringify(result.resourceProfile).includes(root), false);
  assert.equal(getVerificationResourceProfileDiagnostics().retainedSamples, 1);
});

test('short async project commands avoid process-tree polling overhead', async () => {
  clearVerificationResourceProfilesForTests();
  const root = createProject('resource-profile-short-async', { test: 'node scripts/short.mjs' });
  fs.writeFileSync(path.join(root, 'scripts', 'short.mjs'), "await new Promise((resolve) => setTimeout(resolve, 50));\n", 'utf8');
  let cancel = () => {};

  const result = await runProjectCommandAsync(
    stateFor(root),
    { projectId: 'project-command', command: 'test', forceFresh: true },
    { stdout: () => {}, stderr: () => {} },
    (fn) => { cancel = fn; },
  );

  assert.equal(result.ok, true);
  assert.equal(result.resourceProfile?.actual.processTreeSampleCount, 0);
  assert.equal(result.resourceProfile?.actual.processTreeAccounting, false);
  assert.equal(typeof cancel, 'function');
});

test('long async project commands take bounded live process samples without requiring them for success', async () => {
  clearVerificationResourceProfilesForTests();
  const root = createProject('resource-profile-long-async', { test: 'node scripts/long.mjs' });
  fs.writeFileSync(path.join(root, 'scripts', 'long.mjs'), "await new Promise((resolve) => setTimeout(resolve, 1400));\n", 'utf8');

  const result = await runProjectCommandAsync(
    stateFor(root),
    { projectId: 'project-command', command: 'test', forceFresh: true },
    { stdout: () => {}, stderr: () => {} },
    () => {},
  );

  assert.equal(result.ok, true);
  assert.equal((result.resourceProfile?.actual.processTreeSampleAttempts || 0) >= 1, true);
  assert.equal((result.resourceProfile?.actual.processTreeSampleCount || 0) <= result.resourceProfile!.actual.processTreeSampleAttempts, true);
  assert.equal(typeof result.resourceProfile?.actual.durationMs, 'number');
  assert.equal(getVerificationResourceProfileDiagnostics().retainedSamples, 1);
});

test('repository focused preset accepts validated target files and separates command identity', () => {
  const root = createConfigProject('focused-targets', [
    'commands:',
    '  test-focused:',
    '    executable: node',
    '    args:',
    '      - scripts/argv.mjs',
    '    acceptsTargets: true',
    '    category: test',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'argv.mjs'), "process.stdout.write(process.argv.slice(2).join('|'));\n", 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'a.test.ts'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'b.test.ts'), 'b\n', 'utf8');
  const git = (args: string[]) => {
    const command = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(command.status, 0, command.stderr || command.stdout || `git ${args.join(' ')} failed`);
  };
  git(['init']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.com']);
  git(['add', '.']);
  git(['commit', '-m', 'focused target fixture']);
  const state = stateFor(root);

  const aArgs = { projectId: 'project-command', command: 'test-focused', targets: ['tests/a.test.ts'] };
  const bArgs = { projectId: 'project-command', command: 'test-focused', targets: ['tests/b.test.ts'] };
  const aDescriptor = describeProjectCommand(state, aArgs);
  const bDescriptor = describeProjectCommand(state, bArgs);
  const aIdentity = getProjectCommandExecutionIdentity(state, aArgs);
  const bIdentity = getProjectCommandExecutionIdentity(state, bArgs);
  const result = runProjectCommand(state, aArgs);

  assert.deepEqual(aDescriptor.args.slice(-1), ['tests/a.test.ts']);
  assert.notEqual(aDescriptor.semanticKey, bDescriptor.semanticKey);
  assert.ok(aIdentity && bIdentity);
  assert.notEqual(aIdentity!.key, bIdentity!.key);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'tests/a.test.ts');
});

test('focused targets require explicit preset opt-in and reject unsafe target paths', () => {
  const root = createConfigProject('focused-target-validation', [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    acceptsTargets: true',
    '    category: test',
    '  ordinary:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    category: test',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n', 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'ok.test.ts'), 'ok\n', 'utf8');
  const state = stateFor(root);

  assert.throws(
    () => describeProjectCommand(state, { projectId: 'project-command', command: 'ordinary', targets: ['tests/ok.test.ts'] }),
    (error: any) => error?.payload?.code === 'COMMAND_TARGETS_NOT_ALLOWED',
  );
  for (const targets of [
    [],
    ['../outside.test.ts'],
    [path.resolve(root, 'tests/ok.test.ts')],
    ['tests/missing.test.ts'],
    [''],
    [123 as any],
    Array.from({ length: 21 }, (_, index) => `tests/${index}.test.ts`),
    [`tests/${'a'.repeat(490)}.test.ts`],
  ]) {
    assert.throws(
      () => describeProjectCommand(state, { projectId: 'project-command', command: 'focused', targets }),
      (error: any) => String(error?.payload?.code || '').startsWith('COMMAND_TARGET'),
      JSON.stringify(targets),
    );
  }
});

test('focused targets reject symlink escapes before process spawn', (t) => {
  const root = createConfigProject('focused-target-symlink', [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    acceptsTargets: true',
    '    category: test',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n', 'utf8');
  const outside = path.join(tempRoot, 'focused-target-outside.test.ts');
  fs.writeFileSync(outside, 'outside\n', 'utf8');
  const link = path.join(root, 'escape.test.ts');
  try {
    fs.symlinkSync(outside, link, 'file');
  } catch {
    t.skip('symlink creation is unavailable in this environment');
    return;
  }

  assert.throws(
    () => describeProjectCommand(stateFor(root), { projectId: 'project-command', command: 'focused', targets: ['escape.test.ts'] }),
    (error: any) => String(error?.payload?.code || '').startsWith('COMMAND_TARGET'),
  );
});

test('repository npm and npx presets use platform-safe package-manager invocation', () => {
  for (const executable of ['npm', 'npx'] as const) {
    const root = createConfigProject(`repo-${executable}-safe`, [
      'commands:',
      '  safe:',
      `    executable: ${executable}`,
      '    args:',
      '      - --version',
      '    category: test',
      '',
    ].join('\n'));
    const state = stateFor(root);
    const descriptor = describeProjectCommand(state, { projectId: 'project-command', command: 'safe' });
    const result = runProjectCommand(state, { projectId: 'project-command', command: 'safe', cacheResult: false });
    if (process.platform === 'win32') {
      assert.equal(descriptor.executable, process.execPath);
      assert.match(descriptor.args[0] || '', new RegExp(`${executable}-cli\\.js$`, 'i'));
    } else {
      assert.equal(descriptor.executable, executable);
    }
    assert.equal(result.ok, true, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr, /ENOENT/i);
  }
});

test('repository reuse policy shares safe GREEN evidence across physical worktrees and fails closed otherwise', () => {
  const counterPath = path.join(tempRoot, 'cross-worktree-reuse-counter.txt');
  const config = [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/cached.mjs',
    '    acceptsTargets: true',
    '    category: test',
    '    reusePolicy: effective-input',
    '  exact:',
    '    executable: node',
    '    args:',
    '      - scripts/cached.mjs',
    '    acceptsTargets: true',
    '    category: test',
    '    reusePolicy: exact-revision',
    '  external:',
    '    executable: node',
    '    args:',
    '      - scripts/cached.mjs',
    '    acceptsTargets: true',
    '    category: test',
    '    reusePolicy: disabled',
    '',
  ].join('\n');
  const setup = (name: string, commitMessage: string) => {
    const root = createConfigProject(name, config);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 1;\n', 'utf8');
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
    git(['commit', '-m', commitMessage]);
    return root;
  };

  const rootA = setup('cross-worktree-a', 'candidate a');
  const rootB = setup('cross-worktree-b', 'candidate b');
  const before = getRepoCacheDiagnostics({ domains: ['verification-results'] }).domains[0] as any;

  const first = runProjectCommand(stateFor(rootA), {
    projectId: 'project-command', command: 'focused', targets: ['src/value.ts'], evidenceConsumerId: 'workspace-a',
  });
  const reused = runProjectCommand(stateFor(rootB), {
    projectId: 'project-command', command: 'focused', targets: ['src/value.ts'], evidenceConsumerId: 'workspace-b',
  });
  assert.equal(first.cache?.hit, false);
  assert.equal(reused.cache?.hit, true);
  assert.equal(reused.processSpawns, 0);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  assert.deepEqual(reused.cache?.consumers?.sort(), ['workspace-a', 'workspace-b']);

  const exactA = runProjectCommand(stateFor(rootA), { projectId: 'project-command', command: 'exact', targets: ['src/value.ts'] });
  const exactB = runProjectCommand(stateFor(rootB), { projectId: 'project-command', command: 'exact', targets: ['src/value.ts'] });
  assert.equal(exactA.cache?.hit, false);
  assert.equal(exactB.cache?.hit, false, 'exact-revision policy must not reuse across distinct candidate revisions');
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '3');

  const externalA = runProjectCommand(stateFor(rootA), { projectId: 'project-command', command: 'external', targets: ['src/value.ts'], cacheResult: true });
  const externalB = runProjectCommand(stateFor(rootA), { projectId: 'project-command', command: 'external', targets: ['src/value.ts'], cacheResult: true });
  assert.equal(externalA.processSpawns, 1);
  assert.equal(externalB.processSpawns, 1);
  assert.equal(externalA.cache, undefined);
  assert.equal(externalB.cache, undefined);

  const forced = runProjectCommand(stateFor(rootB), {
    projectId: 'project-command', command: 'focused', targets: ['src/value.ts'], forceFresh: true,
  });
  assert.equal(forced.cache?.hit, false);
  assert.equal(forced.processSpawns, 1);

  upsertProject({ id: 'project-other', name: 'Other Project', repoUrl: 'https://example.com/other', localPath: rootB });
  const isolated = runProjectCommand({
    projectsCache: [{ id: 'project-other', name: 'Other Project', repoUrl: 'https://example.com/other', localPath: rootB }],
  } as any, { projectId: 'project-other', command: 'focused', targets: ['src/value.ts'] });
  assert.equal(isolated.cache?.hit, false, 'identical content must not leak evidence across project authority boundaries');

  const after = getRepoCacheDiagnostics({ domains: ['verification-results'] }).domains[0] as any;
  const reasons = Object.fromEntries((after.reasons || []).map((entry: any) => [entry.reason, entry.count]));
  const beforeReasons = Object.fromEntries((before.reasons || []).map((entry: any) => [entry.reason, entry.count]));
  assert.ok(after.hits >= before.hits + 1);
  assert.ok(after.bypasses >= before.bypasses + 3);
  assert.ok((reasons.EXPLICIT_FORCE_FRESH || 0) >= (beforeReasons.EXPLICIT_FORCE_FRESH || 0) + 1);
  assert.ok((reasons.CACHE_DISABLED_BY_POLICY || 0) >= (beforeReasons.CACHE_DISABLED_BY_POLICY || 0) + 2);
  assert.ok(after.avoidedProcessExecutions >= before.avoidedProcessExecutions + 1);
  assert.ok(after.avoidedWallClockMs >= before.avoidedWallClockMs);
});

test('invalid repository verification reuse policy fails closed', () => {
  const root = createConfigProject('invalid-reuse-policy', [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/pass.mjs',
    '    category: test',
    '    reusePolicy: unsafe-global',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n', 'utf8');
  assert.throws(
    () => describeProjectCommand(stateFor(root), { projectId: 'project-command', command: 'focused' }),
    (error: any) => error?.payload?.code === 'COMMAND_CONFIG_INVALID_REUSE_POLICY',
  );
});

test('low-confidence or retried PASS is not promoted to reusable evidence by default', () => {
  const root = createProject('low-confidence-evidence', { typecheck: 'node scripts/low-confidence-static.mjs' });
  const counterPath = path.join(tempRoot, 'low-confidence-evidence-counter.txt');
  fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'low-confidence-static.mjs'), [
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

  const baseArgs = { projectId: 'project-command', command: 'typecheck', affectedInputPaths: ['source.ts'] };
  const first = runProjectCommand(stateFor(root), { ...baseArgs, verificationConfidence: 'low', retryAttempt: 1 });
  const second = runProjectCommand(stateFor(root), baseArgs);

  assert.equal(first.cache?.hit, false);
  assert.equal(first.cache?.reusable, false);
  assert.equal(second.cache?.hit, false);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
});

test('verification inspection lists only runnable package and repository presets without executing them', () => {
  const root = createProject('inspect-presets', {
    typecheck: 'node scripts/typecheck.mjs',
    'benchmark:verification': 'node scripts/benchmark.mjs',
    'admin:unsafe': 'node scripts/admin.mjs',
  });
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.devflow', 'commands.yaml'), [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/focused.mjs',
    '    category: test',
    '    acceptsTargets: true',
    '',
  ].join('\n'));

  const inspection = inspectProjectVerificationPresets(stateFor(root), { projectId: 'project-command' });
  const names = inspection.presets.map((preset: any) => preset.command);
  assert.equal(inspection.readOnly, true);
  assert.equal(inspection.processSpawns, 0);
  assert.deepEqual(names, ['benchmark:verification', 'focused', 'typecheck']);
  assert.equal(names.includes('admin:unsafe'), false);
  assert.equal(inspection.presets.find((preset: any) => preset.command === 'typecheck')?.source, 'package-json');
  const focused = inspection.presets.find((preset: any) => preset.command === 'focused');
  assert.equal(focused?.source, 'repository-config');
  assert.equal(focused?.acceptsTargets, true);
  assert.equal(focused?.configPath, '.devflow/commands.yaml');
  assert.equal(inspection.config.commandConfigPresent, true);
});

test('verification inspection discovers valid JSON repository presets with target metadata', () => {
  const root = createConfigProject('inspect-json-preset', JSON.stringify({
    commands: {
      focusedJson: {
        executable: 'node',
        args: ['--version'],
        category: 'test',
        acceptsTargets: true,
      },
    },
  }, null, 2), 'json');
  const inspection = inspectProjectVerificationPresets(stateFor(root), { projectId: 'project-command' });
  const preset = inspection.presets.find((entry: any) => entry.command === 'focusedJson');
  assert.equal(preset?.source, 'repository-config');
  assert.equal(preset?.configPath, '.devflow/commands.json');
  assert.equal(preset?.acceptsTargets, true);
  assert.equal(preset?.scope, 'targeted');
  assert.equal(preset?.cost, 'low');
});

test('verification inspection reuses repository impact rules and the existing planner for changed files', () => {
  const root = createProject('inspect-impact-plan', {
    typecheck: 'node scripts/typecheck.mjs',
    test: 'node scripts/test.mjs',
    verify: 'node scripts/verify.mjs',
  });
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.devflow', 'verification-impact.json'), JSON.stringify({ rules: [{
    id: 'service-tests', patterns: ['src/server/services/**'], commands: ['test'], lane: 'fast', reason: 'Focused service tests cover this path.',
  }] }));
  const inspection = inspectProjectVerificationPresets(stateFor(root), {
    projectId: 'project-command', changedFiles: ['src/server/services/exampleService.ts'],
  });
  assert.equal(inspection.plan?.impact.mode, 'configured');
  assert.deepEqual(inspection.plan?.impact.matchedRuleIds, ['service-tests']);
  assert.deepEqual(inspection.plan?.commands, ['test']);
  assert.ok(inspection.plan?.impact.omittedCommands.some((entry: any) => entry.command === 'verify'));
});

test('verification inspection suggests reusable config for npm without a targeted preset and performs no write', () => {
  const root = createProject('inspect-npm-no-target', { typecheck: 'node scripts/typecheck.mjs' });
  const inspection = inspectProjectVerificationPresets(stateFor(root), {
    projectId: 'project-command',
    changedFiles: ['src/app.ts'],
  });
  assert.ok(inspection.buildEvidence.some((entry: any) => entry.kind === 'package-json'));
  assert.equal(inspection.guidance.shouldSuggestPresetGeneration, true);
  assert.equal(inspection.guidance.autoGenerationAllowed, false);
  assert.equal(inspection.guidance.temporaryScriptFallbackAllowed, false);
  assert.equal(fs.existsSync(path.join(root, '.devflow', 'commands.yaml')), false);
});

test('verification inspection degrades conservatively for Gradle evidence with no known runnable preset', () => {
  const root = path.join(tempRoot, 'inspect-gradle-only');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'rootProject.name = "fixture"\n');
  fs.writeFileSync(path.join(root, 'build.gradle.kts'), 'plugins {}\n');
  const inspection = inspectProjectVerificationPresets(stateFor(root), {
    projectId: 'project-command', changedFiles: ['src/main/kotlin/App.kt'],
  });
  assert.deepEqual(inspection.presets, []);
  assert.ok(inspection.buildEvidence.some((entry: any) => entry.kind === 'gradle'));
  assert.equal(inspection.guidance.shouldSuggestPresetGeneration, true);
  assert.equal(inspection.guidance.autoGenerationAllowed, false);
  assert.equal(inspection.guidance.temporaryScriptFallbackAllowed, false);
  assert.equal(fs.existsSync(path.join(root, '.devflow', 'commands.yaml')), false);
});

test('verification inspection cache identity reacts to config, build metadata, and repository lineage', () => {
  const root = createProject('inspect-cache-identity', { typecheck: 'node scripts/typecheck.mjs' });
  const initial = inspectProjectVerificationPresets(stateFor(root), { projectId: 'project-command' });
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.devflow', 'verification-impact.json'), JSON.stringify({
    rules: [{ id: 'source-check', patterns: ['src/**'], commands: ['typecheck'] }],
  }));
  const afterConfig = inspectProjectVerificationPresets(stateFor(root), { projectId: 'project-command' });
  assert.notEqual(afterConfig.cacheIdentity.commandConfigFingerprint, initial.cacheIdentity.commandConfigFingerprint);

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { typecheck: 'node scripts/typecheck.mjs', lint: 'node scripts/lint.mjs' },
  }, null, 2));
  const afterBuildMetadata = inspectProjectVerificationPresets(stateFor(root), { projectId: 'project-command' });
  assert.notEqual(afterBuildMetadata.cacheIdentity.buildMetadataFingerprint, afterConfig.cacheIdentity.buildMetadataFingerprint);

  const lineageBefore = afterBuildMetadata.cacheIdentity.lineageToken;
  invalidateRepoCacheDependencies({ root, reason: 'verification-inspection-test', dependencies: ['repo-content'] });
  const afterLineage = inspectProjectVerificationPresets(stateFor(root), { projectId: 'project-command' });
  assert.notEqual(afterLineage.cacheIdentity.lineageToken, lineageBefore);
});

test('verification inspection preserves structured command-config ambiguity and parse errors', () => {
  const ambiguousRoot = createConfigProject('inspect-ambiguous', 'commands:\n  safe:\n    executable: node\n    args:\n      - --version\n');
  fs.writeFileSync(path.join(ambiguousRoot, '.devflow', 'commands.json'), JSON.stringify({ commands: {} }));
  assert.throws(() => inspectProjectVerificationPresets(stateFor(ambiguousRoot), { projectId: 'project-command' }), (error: any) => error?.payload?.code === 'COMMAND_CONFIG_AMBIGUOUS');
  const invalidRoot = createConfigProject('inspect-invalid', '{ invalid json', 'json');
  assert.throws(() => inspectProjectVerificationPresets(stateFor(invalidRoot), { projectId: 'project-command' }), (error: any) => error?.payload?.code === 'INVALID_COMMAND_CONFIG');
});

test('verification inspection reports bounded advisory preset quality from existing resource telemetry', () => {
  clearVerificationResourceProfilesForTests();
  const root = createProject('inspect-quality', { test: 'node scripts/test.mjs' });
  const state = stateFor(root);
  const profile = describeProjectCommandResourceProfile(state, { projectId: 'project-command', command: 'test' });
  const noneInspection = inspectProjectVerificationPresets(state, { projectId: 'project-command' });
  const noneQuality = noneInspection.presets.find((preset: any) => preset.command === 'test')?.quality;
  assert.equal(noneQuality?.confidence, 'none');
  assert.equal(noneQuality?.status, 'insufficient-data');

  recordVerificationResourceSample(profile.resourceDescriptor, { status: 'succeeded', durationMs: 20000 });
  const lowInspection = inspectProjectVerificationPresets(state, { projectId: 'project-command' });
  const lowQuality = lowInspection.presets.find((preset: any) => preset.command === 'test')?.quality;
  assert.equal(lowQuality?.confidence, 'low');
  assert.equal(lowQuality?.status, 'insufficient-data');

  for (let index = 1; index < 3; index += 1) recordVerificationResourceSample(profile.resourceDescriptor, { status: 'succeeded', durationMs: 20000 + index * 1000 });
  recordVerificationResourceSample(profile.resourceDescriptor, { status: 'failed', durationMs: 12000 });
  recordVerificationResourceSample(profile.resourceDescriptor, { status: 'timed_out', durationMs: 30000 });
  const inspection = inspectProjectVerificationPresets(state, { projectId: 'project-command' });
  const quality = inspection.presets.find((preset: any) => preset.command === 'test')?.quality;
  assert.equal(quality?.confidence, 'medium');
  assert.equal(quality?.sampleCount, 5);
  assert.equal(quality?.successfulSampleCount, 3);
  assert.equal(quality?.failedSampleCount, 2);
  assert.equal(quality?.failureRate, 0.4);
  assert.equal(quality?.status, 'review');
  clearVerificationResourceProfilesForTests();
});
