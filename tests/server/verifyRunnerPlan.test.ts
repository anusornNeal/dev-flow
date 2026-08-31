import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildVerificationStageSegments, findRunnableVerificationStepIndex, FULL_VERIFY_PARALLELISM, VERIFICATION_STEPS, verificationStepWeight } from '../../scripts/verifyPlan.js';

const BASELINE_LABELS = [
  'lint',
  'devflow restart route',
  'devflow restart contract',
  'devflow restart state',
  'devflow contract',
  'devflow tool profiles',
  'task claim service',
  'task claim routes',
  'task claim contract',
  'board loop skill registry',
  'board loop skill content',
  'task claim card ui',
  'board refresh and atlas ui retirement',
  'ui preview library repository service',
  'ui preview library routes',
  'ui preview frozen evidence attach',
  'ui preview library client ui',
  'project atlas cache',
  'project atlas agent update',
  'project atlas api',
  'project atlas domains',
  'project atlas exports',
  'project atlas impact',
  'project atlas prompt templates',
  'project atlas scanner',
  'project atlas view model',
  'task detail bug visibility',
  'project command service',
  'git workflow service',
  'local path mutation service',
  'task git workflow service',
  'task commit plan',
  'task manual move recovery',
  'task workspace finalization foundation',
  'task workspace finalization coverage',
  'task workspace finalization durable recovery',
  'task workspace finalization autonomous tail',
  'task workspace finalization edge',
  'mcp fetch errors',
  'mcp streamable http',
  'runtime identity diagnostics',
  'mcp tool job queue',
  'mcp tool job recovery',
  'mcp scheduler policy',
  'project resolution',
  'session workspace service',
  'steno session isolation',
  'workspace integration service',
  'agent runs',
  'figma integration',
  'gateway safety',
  'absolute paths',
  'prompt templates',
  'orchestration',
  'sqlite persistence',
  'mcp transport benchmark gate',
  'start all launcher',
  'doctor',
] as const;

const CLAIM_AND_SKILL_LABELS = [
  'task claim service',
  'task claim routes',
  'task claim contract',
  'board loop skill registry',
  'board loop skill content',
  'task claim card ui',
] as const;

const RUNTIME_GATE_LABELS = [
  'devflow restart route',
  'devflow restart contract',
  'devflow restart state',
  'devflow contract',
  'devflow tool profiles',
] as const;

test('FULL verify plan preserves every baseline verification step exactly once', () => {
  assert.deepEqual(VERIFICATION_STEPS.map((step) => step.label), BASELINE_LABELS);
  assert.equal(new Set(VERIFICATION_STEPS.map((step) => step.label)).size, BASELINE_LABELS.length);
});

test('FULL verify plan keeps lint first and uses the measured bounded worker pool', () => {
  assert.equal(VERIFICATION_STEPS[0]?.label, 'lint');
  assert.equal(VERIFICATION_STEPS[0]?.stage, 0);
  assert.equal(VERIFICATION_STEPS[0]?.parallelSafe, false);
  assert.equal(FULL_VERIFY_PARALLELISM, 6);
  assert.equal(VERIFICATION_STEPS.some((step) => step.parallelSafe === true), true);
  const weighted = VERIFICATION_STEPS.filter((step) => (step.parallelWeight ?? 1) > 1);
  assert.deepEqual(weighted.map((step) => ({ label: step.label, weight: step.parallelWeight })), [
    { label: 'task claim service', weight: 2 },
    { label: 'project command service', weight: 3 },
    { label: 'task workspace finalization foundation', weight: 3 },
    { label: 'task workspace finalization coverage', weight: 3 },
    { label: 'task workspace finalization durable recovery', weight: 3 },
    { label: 'task workspace finalization autonomous tail', weight: 3 },
    { label: 'task workspace finalization edge', weight: 3 },
  ]);
  assert.equal(weighted.every((step) => (step.parallelWeight ?? 1) <= FULL_VERIFY_PARALLELISM), true);
});

test('shared-resource and integration gates remain serial', () => {
  const serialLabels = new Set([
    'mcp transport benchmark gate',
    'start all launcher',
    'doctor',
  ]);
  for (const step of VERIFICATION_STEPS) {
    if (serialLabels.has(step.label)) assert.equal(step.parallelSafe, false, `${step.label} must remain serial`);
  }
});

test('Stage 1 overlaps process-isolated runtime contract fixtures', () => {
  const stageOne = VERIFICATION_STEPS.filter((step) => step.stage === 1);
  assert.deepEqual(stageOne.map((step) => step.label), RUNTIME_GATE_LABELS);
  assert.equal(stageOne.every((step) => step.parallelSafe === true), true);
  const segments = buildVerificationStageSegments(stageOne);
  assert.deepEqual(segments.map((segment) => ({
    parallel: segment.parallel,
    labels: segment.steps.map((step) => step.label),
  })), [{ parallel: true, labels: [...RUNTIME_GATE_LABELS] }]);
});

test('claim, skill, and UI checks overlap the wider isolated Stage 2 pool after runtime gates', () => {
  const stageTwo = VERIFICATION_STEPS.filter((step) => step.stage === 2);
  for (const label of CLAIM_AND_SKILL_LABELS) {
    const step = stageTwo.find((entry) => entry.label === label);
    assert.ok(step, `${label} should move into Stage 2`);
    assert.equal(step?.parallelSafe, true, `${label} should remain parallel-safe`);
  }

  const firstSerialIndex = stageTwo.findIndex((step) => !step.parallelSafe);
  assert.equal(firstSerialIndex > CLAIM_AND_SKILL_LABELS.length, true);
  assert.deepEqual(stageTwo.slice(0, CLAIM_AND_SKILL_LABELS.length).map((step) => step.label), CLAIM_AND_SKILL_LABELS);
});

test('DVF-0477 workflow-integrity regressions stay in the FULL verify plan', () => {
  for (const label of ['task commit plan', 'task manual move recovery', 'task workspace finalization foundation', 'task workspace finalization coverage', 'task workspace finalization durable recovery', 'task workspace finalization autonomous tail', 'task workspace finalization edge']) {
    const step = VERIFICATION_STEPS.find((entry) => entry.label === label);
    assert.ok(step, `${label} should remain in FULL verification`);
    assert.equal(step?.stage, 2);
    assert.equal(step?.parallelSafe, true);
  }
});

test('split pathological suites preserve every current top-level test exactly once', () => {
  const splitSuites = [
    { path: 'tests/server/taskWorkspaceFinalizationService.test.ts', labels: ['task workspace finalization foundation', 'task workspace finalization coverage', 'task workspace finalization durable recovery', 'task workspace finalization autonomous tail', 'task workspace finalization edge'] },
  ];

  for (const suite of splitSuites) {
    const source = fs.readFileSync(path.join(process.cwd(), suite.path), 'utf8');
    const testNames = [...source.matchAll(/^test\('([^']+)'/gm)].map((match) => match[1]);
    assert.ok(testNames.length > 0, `${suite.path} should expose top-level test names`);
    const patterns = suite.labels.map((label) => {
      const step = VERIFICATION_STEPS.find((entry) => entry.label === label);
      assert.ok(step, `${label} should exist`);
      const patternArg = step!.args.find((arg) => arg.startsWith('--test-name-pattern='));
      assert.ok(patternArg, `${label} should use an explicit test-name pattern`);
      return new RegExp(patternArg!.slice('--test-name-pattern='.length));
    });
    for (const testName of testNames) {
      assert.equal(patterns.filter((pattern) => pattern.test(testName)).length, 1, `${suite.path}: ${testName}`);
    }
  }
});

test('transport benchmark overlaps independent async waits while preserving result order', async () => {
  const benchmarkModule = await import('../../scripts/benchmark-mcp-transport.js') as any;
  const runner = benchmarkModule.runAsyncBenchmarkWorkloads;
  assert.equal(typeof runner, 'function');
  const startedAt = Date.now();
  const results = await runner([40, 160], async (durationMs: number) => {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    return { structuredContent: { completedAfterMs: durationMs } };
  });
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(results.map((entry: any) => entry.durationMs), [40, 160]);
  assert.ok(results.every((entry: any) => entry.completedWithoutFollowUp));
  assert.ok(results.every((entry: any) => entry.completionMode === 'request-stream'));
  assert.ok(elapsedMs < 195, `independent waits should overlap; elapsed=${elapsedMs}ms`);
});

test('transport benchmark overlaps isolated protocol async phases while preserving protocol identity', async () => {
  const benchmarkModule = await import('../../scripts/benchmark-mcp-transport.js') as any;
  const runner = benchmarkModule.runConcurrentAsyncProtocolPhases;
  assert.equal(typeof runner, 'function');
  const startedAt = Date.now();
  const result = await runner(
    async () => { await new Promise((resolve) => setTimeout(resolve, 160)); return ['streamable']; },
    async () => { await new Promise((resolve) => setTimeout(resolve, 160)); return ['sse']; },
  );
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(result, { streamableHttp: ['streamable'], legacySse: ['sse'] });
  assert.ok(elapsedMs < 210, `isolated protocol phases should overlap; elapsed=${elapsedMs}ms`);
});

test('scheduler prioritizes the longest measured runnable step without bypassing capacity or resource guards', () => {
  const steps = [
    { label: 'short', command: 'node', args: [], stage: 2, parallelSafe: true, expectedDurationMs: 20_000 },
    { label: 'long', command: 'node', args: [], stage: 2, parallelSafe: true, expectedDurationMs: 80_000 },
    { label: 'blocked-longest', command: 'node', args: [], stage: 2, parallelSafe: true, expectedDurationMs: 120_000, exclusiveResources: ['git-authority'] },
  ];
  assert.equal(findRunnableVerificationStepIndex(steps, 6, new Set(['git-authority'])), 1);
  assert.equal(findRunnableVerificationStepIndex([steps[0], { ...steps[0], label: 'short-tie' }], 6), 0, 'equal estimates preserve plan order');
});

test('weighted scheduler backfills a lighter later step when the next heavy step does not fit', () => {
  const steps = [
    { label: 'heavy', command: 'node', args: [], stage: 2, parallelSafe: true, parallelWeight: 3 },
    { label: 'light', command: 'node', args: [], stage: 2, parallelSafe: true, parallelWeight: 1 },
    { label: 'medium', command: 'node', args: [], stage: 2, parallelSafe: true, parallelWeight: 2 },
  ];
  assert.equal(verificationStepWeight(steps[0]), 3);
  assert.equal(findRunnableVerificationStepIndex(steps, 2), 1);
  assert.equal(findRunnableVerificationStepIndex([steps[0]], 2), -1);
});

test('resource-aware scheduler backfills around active exclusive resources', () => {
  const steps = [
    { label: 'claim', command: 'node', args: [], stage: 2, parallelSafe: true, exclusiveResources: ['git-authority'] },
    { label: 'independent', command: 'node', args: [], stage: 2, parallelSafe: true },
  ];
  assert.equal(findRunnableVerificationStepIndex(steps, 6, new Set(['git-authority'])), 1);
  assert.equal(findRunnableVerificationStepIndex([steps[0]], 6, new Set(['git-authority'])), -1);

  const resourceSteps = VERIFICATION_STEPS
    .filter((step) => (step.exclusiveResources?.length ?? 0) > 0)
    .map((step) => ({ label: step.label, resources: step.exclusiveResources }));
  assert.deepEqual(resourceSteps, [
    { label: 'task claim service', resources: ['git-authority', 'io-heavy'] },
    { label: 'project command service', resources: ['command-runtime'] },
    { label: 'task git workflow service', resources: ['git-authority'] },
    { label: 'task commit plan', resources: ['git-authority'] },
    { label: 'task workspace finalization durable recovery', resources: ['io-heavy'] },
    { label: 'task workspace finalization autonomous tail', resources: ['io-heavy'] },
    { label: 'mcp tool job queue', resources: ['command-runtime'] },
    { label: 'workspace integration service', resources: ['io-heavy'] },
  ]);
});

test('mixed FULL verify stages batch parallel-safe work without crossing serial barriers', () => {
  const stageTwo = VERIFICATION_STEPS.filter((step) => step.stage === 2);
  const segments = buildVerificationStageSegments(stageTwo);

  assert.equal(stageTwo.some((step) => step.parallelSafe), true);
  assert.equal(stageTwo.some((step) => !step.parallelSafe), true);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.parallel, true);
  assert.equal(segments[0]?.steps.every((step) => step.parallelSafe), true);
  assert.deepEqual(segments[0]?.steps.slice(-10).map((step) => step.label), [
    'session workspace service',
    'steno session isolation',
    'workspace integration service',
    'agent runs',
    'figma integration',
    'gateway safety',
    'absolute paths',
    'prompt templates',
    'orchestration',
    'sqlite persistence',
  ]);
  assert.deepEqual(segments[1]?.steps.map((step) => step.label), ['mcp transport benchmark gate']);
  assert.equal(segments[1]?.parallel, false);
});

test('every npm verification step references an existing package script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  for (const step of VERIFICATION_STEPS.filter((entry) => entry.command === 'npm' && entry.args[0] === 'run')) {
    const scriptName = step.args[1];
    assert.equal(typeof pkg.scripts?.[scriptName], 'string', `${step.label} references missing npm script ${scriptName}`);
  }
});

test('gateway verification reuses one tsx node:test bootstrap while preserving serial DB isolation', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['test:gateway'],
    'tsx --test --test-concurrency=1 tests/server/jiraAuthoringBundle.test.ts tests/server/compositeAuthoringService.test.ts tests/server/lockAndIdempotency.test.ts tests/server/adversarialLockAndIdempotency.test.ts',
  );
});

test('isolated late checks backfill Stage 2 while supervisor and doctor stay serial', () => {
  const promotedLabels = ['agent runs', 'figma integration', 'gateway safety', 'absolute paths', 'prompt templates', 'orchestration', 'sqlite persistence'];
  for (const label of promotedLabels) {
    const step = VERIFICATION_STEPS.find((entry) => entry.label === label);
    assert.equal(step?.stage, 2, `${label} should backfill Stage 2`);
    assert.equal(step?.parallelSafe, true, `${label} should remain isolated`);
  }
  const stageThree = VERIFICATION_STEPS.filter((step) => step.stage === 3);
  assert.deepEqual(stageThree.map((step) => ({ label: step.label, parallelSafe: step.parallelSafe })), [
    { label: 'start all launcher', parallelSafe: false },
    { label: 'doctor', parallelSafe: false },
  ]);
});

test('self-managed sqlite verification does not inherit the runner DB override', () => {
  const sqliteStep = VERIFICATION_STEPS.find((step) => step.label === 'sqlite persistence');
  assert.equal(sqliteStep?.databasePathMode, 'self-managed');
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'verify.ts'), 'utf8');
  assert.match(source, /databasePathMode === 'self-managed'/);
  assert.match(source, /delete env\.DEVFLOW_DB_PATH/);
});

test('FULL verify runner consumes the staged plan and enforces durable-budget headroom', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'verify.ts'), 'utf8');
  assert.match(source, /VERIFICATION_STEPS/);
  assert.match(source, /FULL_VERIFY_PARALLELISM/);
  assert.match(source, /FULL_VERIFY_DURABLE_BUDGET_MS = 300_000/);
  assert.match(source, /FULL_VERIFY_HEADROOM_MS = 30_000/);
  assert.match(source, /elapsedMs > FULL_VERIFY_SOFT_LIMIT_MS/);
  assert.match(source, /node_modules.*tsx.*dist.*cli\.mjs/);
  assert.match(source, /console\.error\(`\[verify\] Active groups after/);
  assert.match(source, /slowest groups/);
  assert.match(source, /verificationStepWeight/);
  assert.match(source, /findRunnableVerificationStepIndex/);
  assert.match(source, /executeAllMigrations/);
  const sharedDbAssignment = source.indexOf("process.env.DEVFLOW_DB_PATH = path.join(tempDbDir, 'devflow.db');");
  const sharedDbBootstrap = source.indexOf('executeAllMigrations();');
  assert.ok(sharedDbAssignment >= 0 && sharedDbBootstrap > sharedDbAssignment, 'shared temp verification DB must be selected before schema bootstrap');
  assert.match(source, /Verification completed successfully in/);
  assert.match(source, /maxRetries: 10/);
  assert.match(source, /Temporary verification cleanup failed/);
  assert.doesNotMatch(source, /spawnSync/);
});
