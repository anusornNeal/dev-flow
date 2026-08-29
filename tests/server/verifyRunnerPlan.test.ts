import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildVerificationStageSegments, FULL_VERIFY_PARALLELISM, VERIFICATION_STEPS } from '../../scripts/verifyPlan.js';

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
  'task workspace finalization',
  'mcp fetch errors',
  'mcp streamable http',
  'runtime identity diagnostics',
  'mcp tool job queue',
  'mcp tool job recovery',
  'mcp scheduler policy',
  'project resolution',
  'mcp transport benchmark gate',
  'session workspace service',
  'steno session isolation',
  'workspace integration service',
  'agent runs',
  'figma integration',
  'gateway safety',
  'start all launcher',
  'absolute paths',
  'prompt templates',
  'orchestration',
  'sqlite persistence',
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
});

test('shared-resource and integration gates remain serial', () => {
  const serialLabels = new Set([
    ...RUNTIME_GATE_LABELS,
    'mcp transport benchmark gate',
    'session workspace service',
    'steno session isolation',
    'workspace integration service',
    'start all launcher',
    'doctor',
  ]);
  for (const step of VERIFICATION_STEPS) {
    if (serialLabels.has(step.label)) assert.equal(step.parallelSafe, false, `${step.label} must remain serial`);
  }
});

test('Stage 1 contains only serial runtime gates before independent verification work', () => {
  const stageOne = VERIFICATION_STEPS.filter((step) => step.stage === 1);
  assert.deepEqual(stageOne.map((step) => step.label), RUNTIME_GATE_LABELS);
  assert.equal(stageOne.every((step) => step.parallelSafe === false), true);
  const segments = buildVerificationStageSegments(stageOne);
  assert.deepEqual(segments.map((segment) => ({
    parallel: segment.parallel,
    labels: segment.steps.map((step) => step.label),
  })), [{ parallel: false, labels: [...RUNTIME_GATE_LABELS] }]);
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
  for (const label of ['task commit plan', 'task manual move recovery', 'task workspace finalization']) {
    const step = VERIFICATION_STEPS.find((entry) => entry.label === label);
    assert.ok(step, `${label} should remain in FULL verification`);
    assert.equal(step?.stage, 2);
    assert.equal(step?.parallelSafe, true);
  }
});

test('mixed FULL verify stages batch parallel-safe work without crossing serial barriers', () => {
  const stageTwo = VERIFICATION_STEPS.filter((step) => step.stage === 2);
  const segments = buildVerificationStageSegments(stageTwo);

  assert.equal(stageTwo.some((step) => step.parallelSafe), true);
  assert.equal(stageTwo.some((step) => !step.parallelSafe), true);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.parallel, true);
  assert.equal(segments[0]?.steps.every((step) => step.parallelSafe), true);
  assert.equal(segments[1]?.parallel, false);
  assert.deepEqual(segments[1]?.steps.map((step) => step.label), [
    'mcp transport benchmark gate',
    'session workspace service',
    'steno session isolation',
    'workspace integration service',
  ]);
});

test('Stage 3 overlaps isolated verification scripts around explicit supervisor and doctor barriers', () => {
  const stageThree = VERIFICATION_STEPS.filter((step) => step.stage === 3);
  const segments = buildVerificationStageSegments(stageThree);
  assert.deepEqual(segments.map((segment) => ({
    parallel: segment.parallel,
    labels: segment.steps.map((step) => step.label),
  })), [
    { parallel: true, labels: ['agent runs', 'figma integration', 'gateway safety'] },
    { parallel: false, labels: ['start all launcher'] },
    { parallel: true, labels: ['absolute paths', 'prompt templates', 'orchestration', 'sqlite persistence'] },
    { parallel: false, labels: ['doctor'] },
  ]);
});

test('FULL verify runner consumes the staged plan and enforces durable-budget headroom', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'verify.ts'), 'utf8');
  assert.match(source, /VERIFICATION_STEPS/);
  assert.match(source, /FULL_VERIFY_PARALLELISM/);
  assert.match(source, /FULL_VERIFY_DURABLE_BUDGET_MS = 300_000/);
  assert.match(source, /FULL_VERIFY_HEADROOM_MS = 30_000/);
  assert.match(source, /elapsedMs > FULL_VERIFY_SOFT_LIMIT_MS/);
  assert.match(source, /Verification completed successfully in/);
  assert.doesNotMatch(source, /spawnSync/);
});
