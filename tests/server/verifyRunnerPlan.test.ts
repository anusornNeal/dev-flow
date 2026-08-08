import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FULL_VERIFY_PARALLELISM, VERIFICATION_STEPS } from '../../scripts/verifyPlan.js';

const BASELINE_LABELS = [
  'lint',
  'devflow restart route',
  'devflow restart contract',
  'devflow restart state',
  'devflow contract',
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
  'mcp fetch errors',
  'mcp tool job queue',
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

test('FULL verify runner consumes the staged plan without a serial spawnSync loop', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'verify.ts'), 'utf8');
  assert.match(source, /VERIFICATION_STEPS/);
  assert.match(source, /FULL_VERIFY_PARALLELISM/);
  assert.doesNotMatch(source, /spawnSync/);
});
