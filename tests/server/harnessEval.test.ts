import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  compareHarnessRuns,
  loadHarnessScenarios,
  runHarnessBenchmark,
  runHarnessEval,
  type HarnessScenario,
} from '../../scripts/benchmark-chatgpt-harness.js';

const FIXTURES_DIR = path.resolve('tests/fixtures/harness-evals');
const REPO_FINGERPRINT = 'repo-fixture-v1';
const ENVIRONMENT_FINGERPRINT = 'environment-fixture-v1';

function loadScenarios() {
  return loadHarnessScenarios(FIXTURES_DIR);
}

function run(strategyName: string, scenarios = loadScenarios()) {
  return runHarnessEval({
    scenarios,
    strategyName,
    repoFingerprint: REPO_FINGERPRINT,
    environmentFingerprint: ENVIRONMENT_FINGERPRINT,
  });
}

test('golden harness corpus is versioned and covers calibration plus required holdout behaviors', () => {
  const scenarios = loadScenarios();
  assert.equal(scenarios.length, 7);
  assert.ok(scenarios.every((scenario) => scenario.schemaVersion === 1));
  assert.deepEqual([...new Set(scenarios.map((scenario) => scenario.corpus))].sort(), ['calibration', 'holdout']);
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id).sort(),
    [
      'cal-small-scoped',
      'cal-soft-verification-override',
      'cal-verify-repair',
      'holdout-cross-module',
      'holdout-hard-safety-blocker',
      'holdout-interruption-resume',
      'holdout-stale-context-refresh',
    ],
  );
  for (const scenario of scenarios) {
    assert.ok(scenario.strategies.baseline, `${scenario.id} should have a baseline trajectory`);
    assert.ok(scenario.strategies.candidate, `${scenario.id} should have a candidate trajectory`);
    assert.ok(scenario.oracle.expectedLifecycleStages?.length, `${scenario.id} should define lifecycle expectations`);
    assert.ok(scenario.oracle.expectedPolicyDecision, `${scenario.id} should define policy expectations`);
    assert.ok(scenario.oracle.expectedContextDecision, `${scenario.id} should define context expectations`);
  }
});

test('offline replay is deterministic for the same fixture and strategy version', () => {
  const scenarios = loadScenarios();
  const first = run('baseline', scenarios);
  const second = run('baseline', scenarios);
  assert.deepEqual(second, first);
  assert.equal(first.aggregate.scenarioCount, 7);
  assert.equal(first.aggregate.oraclePassCount, 7);
  assert.equal(first.aggregate.oraclePassRate, 1);
  assert.deepEqual(first.aggregate.strategyVersions, ['baseline-v1']);
  assert.deepEqual(first.aggregate.policyVersions, ['policy-v1']);
  assert.equal(first.repoFingerprint, REPO_FINGERPRINT);
  assert.equal(first.environmentFingerprint, ENVIRONMENT_FINGERPRINT);
});

test('runner collects only harness-owned deterministic metrics and leaves model tokens optional', () => {
  const baseline = run('baseline');
  const repair = baseline.scenarios.find((scenario) => scenario.scenarioId === 'cal-verify-repair');
  const resume = baseline.scenarios.find((scenario) => scenario.scenarioId === 'holdout-interruption-resume');
  const small = baseline.scenarios.find((scenario) => scenario.scenarioId === 'cal-small-scoped');
  assert.ok(repair && resume && small);

  assert.equal(repair.metrics.repairCount, 1);
  assert.equal(repair.metrics.verificationFailures, 1);
  assert.equal(repair.metrics.firstPassSuccess, false);
  assert.equal(resume.metrics.retryCount, 1);
  assert.ok(small.metrics.toolCallCount > 0);
  assert.ok(small.metrics.contextBytes > 0);
  assert.equal(small.metrics.modelTokenCount, undefined);
  assert.equal(baseline.aggregate.modelTokenCount, undefined);
});

test('baseline-vs-candidate comparison separates calibration and holdout and preserves raw evidence', () => {
  const result = runHarnessBenchmark({
    fixturesDir: FIXTURES_DIR,
    baselineStrategy: 'baseline',
    candidateStrategy: 'candidate',
    repoFingerprint: REPO_FINGERPRINT,
    environmentFingerprint: ENVIRONMENT_FINGERPRINT,
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.benchmark, 'devflow-chatgpt-harness-golden-comparison');
  assert.equal(result.classification, 'improvement');
  assert.equal(result.corpora.length, 2);
  const calibration = result.corpora.find((entry) => entry.corpus === 'calibration');
  const holdout = result.corpora.find((entry) => entry.corpus === 'holdout');
  assert.ok(calibration && holdout);
  assert.equal(calibration.scenarioIds.length, 3);
  assert.equal(holdout.scenarioIds.length, 4);
  assert.equal(holdout.metrics.contextBytes.classification, 'improvement');
  assert.notEqual(holdout.classification, 'regression');
  assert.equal(result.raw.baseline.scenarios.length, 7);
  assert.equal(result.raw.candidate.scenarios.length, 7);
  assert.ok(result.raw.baseline.scenarios.every((scenario) => scenario.trajectory.length > 0));
  assert.ok(result.raw.candidate.scenarios.every((scenario) => scenario.policyVersion === 'policy-v2'));
  assert.equal(result.raw.candidate.repoFingerprint, REPO_FINGERPRINT);
  assert.equal(result.raw.candidate.environmentFingerprint, ENVIRONMENT_FINGERPRINT);
});

test('recorded wall-clock observations never decide deterministic correctness or regression', () => {
  const scenarios = structuredClone(loadScenarios()) as HarnessScenario[];
  const noisy = scenarios.find((scenario) => scenario.id === 'holdout-cross-module')!;
  for (const event of noisy.strategies.candidate.events) {
    event.observedWallClockMs = (event.observedWallClockMs ?? 0) + 10_000;
  }

  const baseline = runHarnessEval({
    scenarios,
    strategyName: 'baseline',
    repoFingerprint: REPO_FINGERPRINT,
    environmentFingerprint: ENVIRONMENT_FINGERPRINT,
  });
  const candidate = runHarnessEval({
    scenarios,
    strategyName: 'candidate',
    repoFingerprint: REPO_FINGERPRINT,
    environmentFingerprint: ENVIRONMENT_FINGERPRINT,
  });
  const comparison = compareHarnessRuns(baseline, candidate);
  const result = candidate.scenarios.find((scenario) => scenario.scenarioId === 'holdout-cross-module')!;

  assert.equal(result.metrics.oraclePassed, true);
  assert.ok(result.metrics.observedWallClockMs >= 10_000);
  assert.equal('observedWallClockMs' in comparison.corpora[0].metrics, false);
  assert.notEqual(comparison.classification, 'regression');
});

test('hard safety blocker is a successful oracle outcome when the strategy fails closed', () => {
  const candidate = run('candidate');
  const blocker = candidate.scenarios.find((scenario) => scenario.scenarioId === 'holdout-hard-safety-blocker');
  assert.ok(blocker);
  assert.equal(blocker.terminalOutcome, 'blocked');
  assert.equal(blocker.metrics.oraclePassed, true);
  assert.deepEqual(blocker.lifecycleStages, ['context-ready', 'blocked']);
  assert.equal(blocker.policyDecision.hardSafetyBlocker, true);
});
