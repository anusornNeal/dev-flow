import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-full-regression-escalation-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const {
  inspectProjectVerificationPresets,
  runProjectCommand,
} = await import('../../src/server/services/projectCommandService.js');
const { createProject: upsertProject } = await import('../../src/server/repositories/projectRepository.js');
const { evaluatePostIntegrationRequirement } = await import('../../src/server/services/taskWorkspaceFinalizationVerificationService.js');

let sequence = 0;

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

type FixtureOptions = {
  impactRules?: unknown[];
  includeBroadFallback?: boolean;
  desktopFails?: boolean;
  fullMode?: 'pass' | 'fail' | 'timeout';
};

function createFixture(label: string, options: FixtureOptions = {}) {
  const root = path.join(tempRoot, `${label}-${sequence++}`);
  const projectId = `project-full-proof-${sequence}`;
  const fullCounterPath = path.join(tempRoot, `${label}-${sequence}-full-counter.txt`);
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const moduleName of ['desktop-app', 'pdf', 'excel', 'pipeline']) {
    fs.mkdirSync(path.join(root, moduleName, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, moduleName, 'src', 'Placeholder.kt'), `// ${moduleName}\n`);
  }
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.mkdirSync(path.join(root, 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":desktop-app", ":pdf", ":excel", ":pipeline")\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2));

  fs.writeFileSync(path.join(root, 'scripts', 'pass.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(root, 'scripts', 'narrow-fail.mjs'), 'process.exit(7);\n');
  fs.writeFileSync(path.join(root, 'scripts', 'full-pass.mjs'), [
    "import fs from 'node:fs';",
    `const counterPath = ${JSON.stringify(fullCounterPath)};`,
    "const next = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(counterPath, String(next));",
    'process.exit(0);',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'full-fail.mjs'), 'process.exit(9);\n');
  fs.writeFileSync(path.join(root, 'scripts', 'full-timeout.mjs'), 'setInterval(() => {}, 1_000);\n');

  const fullMode = options.fullMode ?? 'pass';
  const fullScript = fullMode === 'fail' ? 'scripts/full-fail.mjs'
    : fullMode === 'timeout' ? 'scripts/full-timeout.mjs'
      : 'scripts/full-pass.mjs';
  const commands: Record<string, any> = {
    desktopCheck: {
      executable: 'node',
      args: [options.desktopFails ? '../scripts/narrow-fail.mjs' : '../scripts/pass.mjs'],
      cwd: 'desktop-app',
      category: 'test',
    },
    pdfCheck: { executable: 'node', args: ['../scripts/pass.mjs'], cwd: 'pdf', category: 'test' },
    excelCheck: { executable: 'node', args: ['../scripts/pass.mjs'], cwd: 'excel', category: 'test' },
    pipelineCheck: { executable: 'node', args: ['../scripts/pass.mjs'], cwd: 'pipeline', category: 'test' },
    verify: {
      executable: 'node',
      args: [fullScript],
      category: 'verification',
      reusePolicy: 'exact-revision',
      ...(fullMode === 'timeout' ? { timeoutMs: 50 } : {}),
    },
  };
  if (options.includeBroadFallback !== false) {
    commands.safeCheck = { executable: 'node', args: ['scripts/pass.mjs'], category: 'verification' };
  }
  fs.writeFileSync(path.join(root, '.devflow', 'commands.json'), JSON.stringify({ commands }, null, 2));
  if (options.impactRules) {
    fs.writeFileSync(path.join(root, '.devflow', 'verification-impact.json'), JSON.stringify({ rules: options.impactRules }, null, 2));
  }

  git(root, ['init']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);

  const project = { id: projectId, name: `Full proof ${label}`, repoUrl: `https://example.test/${label}`, localPath: root } as any;
  upsertProject(project);
  const state = { projectsCache: [project] } as any;
  return { root, projectId, state, fullCounterPath };
}

function inspect(fixture: ReturnType<typeof createFixture>, changedFiles: string[], requestedLane?: 'fast' | 'safe' | 'full') {
  return inspectProjectVerificationPresets(fixture.state, {
    projectId: fixture.projectId,
    changedFiles,
    ...(requestedLane ? { requestedLane } : {}),
  });
}

test('updater-only desktop change stays module-scoped without PDF or Excel regression work', () => {
  const fixture = createFixture('updater-only');
  const result = inspect(fixture, ['desktop-app/src/Updater.kt']);

  assert.equal(result.config.impactMapPresent, false);
  assert.deepEqual(result.plan?.commands, ['desktopCheck']);
  assert.equal(result.plan?.requiresFullRegression, false);
  assert.equal(result.plan?.coverageRequirement, 'targeted');
  assert.equal(result.plan?.commands.includes('pdfCheck'), false);
  assert.equal(result.plan?.commands.includes('excelCheck'), false);
  assert.equal(result.plan?.commands.includes('verify'), false);
  assert.deepEqual(result.plan?.fullRegression.reasonCodes, ['FULL_NOT_AUTHORIZED']);
});

test('missing and partial manual impact maps still produce bounded proportional coverage', () => {
  const noMap = createFixture('missing-map');
  const inferred = inspect(noMap, ['desktop-app/src/Updater.kt', 'pdf/src/PdfParser.kt']);
  assert.equal(inferred.plan?.impact.mode, 'inferred');
  assert.deepEqual(new Set(inferred.plan?.commands), new Set(['desktopCheck', 'pdfCheck']));
  assert.equal(inferred.plan?.requiresFullRegression, false);

  const partial = createFixture('partial-map', {
    impactRules: [{ id: 'desktop-explicit', patterns: ['desktop-app/**'], commands: ['desktopCheck'], lane: 'fast' }],
  });
  const hybrid = inspect(partial, ['desktop-app/src/Updater.kt', 'pdf/src/PdfParser.kt']);
  assert.equal(hybrid.plan?.impact.mode, 'hybrid');
  assert.deepEqual(hybrid.plan?.impact.configuredCoveredFiles, ['desktop-app/src/Updater.kt']);
  assert.deepEqual(hybrid.plan?.impact.inferredCoveredFiles, ['pdf/src/PdfParser.kt']);
  assert.deepEqual(new Set(hybrid.plan?.commands), new Set(['desktopCheck', 'pdfCheck']));
  assert.equal(hybrid.plan?.requiresFullRegression, false);
});

test('unknown impact widens conservatively to bounded broad evidence before FULL', () => {
  const fixture = createFixture('unknown-broad-fallback');
  const result = inspect(fixture, ['misc/Unknown.kt']);

  assert.equal(result.plan?.lane, 'safe');
  assert.deepEqual(result.plan?.commands, ['safeCheck']);
  assert.equal(result.plan?.coverageRequirement, 'broad');
  assert.equal(result.plan?.requiresFullRegression, false);
  assert.deepEqual(result.plan?.fullRegression.reasonCodes, ['FULL_NOT_AUTHORIZED']);
});

test('bounded shared contracts stay affected-only while global and unbounded changes require explicit FULL authority', () => {
  const bounded = createFixture('bounded-shared', {
    impactRules: [{
      id: 'known-shared-contract',
      patterns: ['shared/Contract.kt'],
      commands: ['desktopCheck', 'pdfCheck', 'pipelineCheck'],
      lane: 'fast',
      reason: 'Known shared contract has a bounded dependent set.',
    }],
  });
  const boundedResult = inspect(bounded, ['shared/Contract.kt']);
  assert.equal(boundedResult.plan?.requiresFullRegression, false);
  assert.equal(boundedResult.plan?.commands.includes('verify'), false);
  assert.deepEqual(new Set(boundedResult.plan?.commands), new Set(['desktopCheck', 'pdfCheck', 'pipelineCheck']));

  const global = createFixture('root-global');
  const globalResult = inspect(global, ['settings.gradle.kts']);
  assert.equal(globalResult.plan?.lane, 'full');
  assert.deepEqual(globalResult.plan?.commands, ['verify']);
  assert.equal(globalResult.plan?.requiresFullRegression, true);
  assert.equal(globalResult.plan?.fullRegression.authority, 'inferred-repository-wide');
  assert.deepEqual(globalResult.plan?.fullRegression.reasonCodes, ['FULL_INFERRED_REPOSITORY_WIDE']);

  const unbounded = createFixture('unbounded-shared', { includeBroadFallback: false });
  const unboundedResult = inspect(unbounded, ['shared/UnknownContract.kt']);
  assert.equal(unboundedResult.plan?.lane, 'full');
  assert.deepEqual(unboundedResult.plan?.commands, ['verify']);
  assert.equal(unboundedResult.plan?.requiresFullRegression, true);
  assert.equal(unboundedResult.plan?.fullRegression.authority, 'safe-runnable-coverage');
  assert.deepEqual(unboundedResult.plan?.fullRegression.reasonCodes, ['FULL_ONLY_SAFE_RUNNABLE_COVERAGE']);
});

test('explicit FULL and legacy configured lane FULL remain supported with concrete planner output', () => {
  const explicitFixture = createFixture('explicit-full');
  const explicit = inspect(explicitFixture, ['desktop-app/src/Updater.kt'], 'full');
  assert.equal(explicit.plan?.lane, 'full');
  assert.deepEqual(explicit.plan?.commands, ['verify']);
  assert.equal(explicit.plan?.fullRegression.authority, 'requested-lane');
  assert.deepEqual(explicit.plan?.fullRegression.reasonCodes, ['FULL_EXPLICIT_REQUEST']);

  const legacyFixture = createFixture('legacy-full', {
    impactRules: [{ id: 'legacy-full-rule', patterns: ['legacy/**'], commands: ['verify'], lane: 'full' }],
  });
  const legacy = inspect(legacyFixture, ['legacy/GlobalPolicy.kt']);
  assert.equal(legacy.plan?.lane, 'full');
  assert.deepEqual(legacy.plan?.commands, ['verify']);
  assert.equal(legacy.plan?.requiresFullRegression, true);
});

test('base advancement requests only newly missing integrated module coverage', () => {
  const fixture = createFixture('finalization-missing-only');
  const sourcePlan = inspect(fixture, ['desktop-app/src/Updater.kt']).plan!;
  const combinedPlan = inspect(fixture, ['desktop-app/src/Updater.kt', 'pdf/src/PdfParser.kt']).plan!;
  const requirement = evaluatePostIntegrationRequirement({
    baseRevision: 'workspace-base',
    baseHeadBefore: 'advanced-base',
    baseHeadAfter: 'integrated-head',
  } as any, [], sourcePlan, combinedPlan, {
    status: 'covered',
    policy: 'checks-passed',
    recordedAt: new Date().toISOString(),
    reusable: true,
    coveredCommands: ['desktopCheck'],
    staleCommands: [],
    staleDetails: [],
  } as any);

  assert.equal(requirement.required, true);
  assert.equal(requirement.requiredScope, 'targeted');
  assert.deepEqual(requirement.missingChecks.map((entry) => entry.command), ['pdfCheck']);
  assert.equal(requirement.missingChecks.some((entry) => entry.command === 'desktopCheck'), false);
  assert.equal(requirement.missingChecks.some((entry) => entry.command === 'verify'), false);
});

test('exact-revision FULL GREEN is reused without a second process launch', () => {
  const fixture = createFixture('full-reuse');
  const first = runProjectCommand(fixture.state, {
    projectId: fixture.projectId,
    command: 'verify',
    evidenceConsumerId: 'first',
  });
  const second = runProjectCommand(fixture.state, {
    projectId: fixture.projectId,
    command: 'verify',
    evidenceConsumerId: 'second',
  });

  assert.equal(first.ok, true);
  assert.equal(first.cache?.hit, false);
  assert.equal(first.processSpawns, 1);
  assert.equal(second.ok, true);
  assert.equal(second.cache?.hit, true);
  assert.equal(second.processSpawns, 0);
  assert.equal(second.cache?.evidenceId, first.cache?.evidenceId);
  assert.equal(fs.readFileSync(fixture.fullCounterPath, 'utf8'), '1');
});

test('failed and timed-out FULL checks do not auto-loop, and a failing narrow check is not bypassed by FULL', () => {
  const failedFull = createFixture('full-failure', { fullMode: 'fail' });
  const failed = runProjectCommand(failedFull.state, { projectId: failedFull.projectId, command: 'verify' });
  assert.equal(failed.ok, false);
  assert.equal(failed.processSpawns, 1);
  assert.equal(failed.infrastructureRecovery?.attempted, false);
  assert.equal(failed.cache?.hit, false);
  assert.equal(failed.cache?.evidenceId, undefined);

  const timedOutFull = createFixture('full-timeout', { fullMode: 'timeout' });
  const timedOut = runProjectCommand(timedOutFull.state, {
    projectId: timedOutFull.projectId,
    command: 'verify',
    infrastructureRetryPolicy: 'resource-safe-once',
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.processSpawns, 1);
  assert.equal(timedOut.infrastructureRecovery?.attempted, false);

  const narrowFailure = createFixture('narrow-failure', { desktopFails: true });
  const narrowPlan = inspect(narrowFailure, ['desktop-app/src/Updater.kt']);
  assert.deepEqual(narrowPlan.plan?.commands, ['desktopCheck']);
  assert.equal(narrowPlan.plan?.commands.includes('verify'), false);
  const narrow = runProjectCommand(narrowFailure.state, { projectId: narrowFailure.projectId, command: 'desktopCheck' });
  assert.equal(narrow.ok, false);
  assert.equal(narrow.processSpawns, 1);
  assert.equal(fs.existsSync(narrowFailure.fullCounterPath), false, 'FULL must not run as a fallback after a real narrow product failure');
});
