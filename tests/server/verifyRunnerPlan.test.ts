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
  'project atlas cache',
  'project atlas agent update',
  'project atlas api',
  'project atlas domains',
  'project atlas exports',
  'project atlas impact',
  'project atlas prompt templates',
  'project atlas scanner',
  'project atlas view model',
  'project atlas graph edge visibility',
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

test('FULL verify plan preserves every baseline verification step exactly once', () => {
  assert.deepEqual(VERIFICATION_STEPS.map((step) => step.label), BASELINE_LABELS);
  assert.equal(new Set(VERIFICATION_STEPS.map((step) => step.label)).size, BASELINE_LABELS.length);
});

test('FULL verify plan keeps lint first and bounds parallel-safe work', () => {
  assert.equal(VERIFICATION_STEPS[0]?.label, 'lint');
  assert.equal(VERIFICATION_STEPS[0]?.stage, 0);
  assert.equal(VERIFICATION_STEPS[0]?.parallelSafe, false);
  assert.equal(FULL_VERIFY_PARALLELISM > 1 && FULL_VERIFY_PARALLELISM <= 4, true);
  assert.equal(VERIFICATION_STEPS.some((step) => step.parallelSafe === true), true);
});

test('shared-resource and integration gates remain serial', () => {
  const serialLabels = new Set([
    'devflow restart route',
    'devflow restart contract',
    'devflow restart state',
    'devflow contract',
    'devflow tool profiles',
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
  ]);
  for (const step of VERIFICATION_STEPS) {
    if (serialLabels.has(step.label)) assert.equal(step.parallelSafe, false, `${step.label} must remain serial`);
  }
});

test('Stage 1 parallelizes only proven-isolated claim, skill, and UI checks behind serial runtime gates', () => {
  const stageOne = VERIFICATION_STEPS.filter((step) => step.stage === 1);
  const approvedParallel = [
    'task claim service',
    'task claim routes',
    'task claim contract',
    'board loop skill registry',
    'board loop skill content',
    'task claim card ui',
  ];
  const protectedSerial = [
    'devflow restart route',
    'devflow restart contract',
    'devflow restart state',
    'devflow contract',
    'devflow tool profiles',
  ];

  for (const label of approvedParallel) {
    assert.equal(stageOne.find((step) => step.label === label)?.parallelSafe, true, `${label} should be parallel-safe`);
  }
  for (const label of protectedSerial) {
    assert.equal(stageOne.find((step) => step.label === label)?.parallelSafe, false, `${label} must stay serial`);
  }

  const segments = buildVerificationStageSegments(stageOne);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.parallel, false);
  assert.deepEqual(segments[0]?.steps.map((step) => step.label), protectedSerial);
  assert.equal(segments[1]?.parallel, true);
  assert.deepEqual(segments[1]?.steps.map((step) => step.label), approvedParallel);
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

test('FULL verify runner consumes the staged plan without a serial spawnSync loop', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'verify.ts'), 'utf8');
  assert.match(source, /VERIFICATION_STEPS/);
  assert.match(source, /FULL_VERIFY_PARALLELISM/);
  assert.doesNotMatch(source, /spawnSync/);
});
