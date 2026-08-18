import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REPRESENTATIVE_SOURCE_DISCLOSURE_FIXTURES,
  runAdaptiveSourceDisclosureBenchmark,
} from '../../scripts/benchmark-adaptive-source-disclosure.js';

test('adaptive source disclosure benchmark emits stable machine-readable metrics and representative baselines', () => {
  const result = runAdaptiveSourceDisclosureBenchmark({ thresholds: [250, 350, 400, 500] });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.benchmark, 'devflow-adaptive-source-disclosure');
  assert.equal(result.fixtureIdentity, 'representative-source-disclosure-v1');
  assert.deepEqual(result.config, {
    legacyWindowLines: 60,
    thresholds: [250, 350, 400, 500],
  });
  assert.equal(result.fixtures.length, 2);

  const threshold250 = result.comparisons.find((comparison) => comparison.thresholdLines === 250);
  assert.ok(threshold250, '250-line comparison should be present');

  const onboarding = threshold250.scenarios.find((scenario) => scenario.fixtureId === 'onboarding');
  const jobDetail = threshold250.scenarios.find((scenario) => scenario.fixtureId === 'job-detail');
  assert.ok(onboarding, 'onboarding fixture should be present');
  assert.ok(jobDetail, 'job-detail fixture should be present');

  assert.equal(onboarding.fileCount, 11);
  assert.equal(onboarding.lineCount, 1_707);
  assert.equal(onboarding.legacy.logicalContentReadBoundaries, 34);
  assert.equal(onboarding.adaptive.logicalContentReadBoundaries, 12);
  assert.equal(jobDetail.legacy.logicalContentReadBoundaries, 27);
  assert.equal(jobDetail.adaptive.logicalContentReadBoundaries, 12);

  for (const comparison of result.comparisons) {
    assert.equal(typeof comparison.thresholdLines, 'number');
    assert.ok(comparison.aggregate.gate.passed, JSON.stringify(comparison.aggregate.gate));
    assert.ok(comparison.aggregate.gate.boundaryReductionRate >= 0.5);
    assert.ok(comparison.aggregate.gate.totalPayloadBytesRatio <= 1.2);
    assert.ok(comparison.aggregate.gate.sourceBytesRatio <= 1.2);
    assert.equal(comparison.aggregate.gate.evidenceCoverageEquivalent, true);
    assert.equal(comparison.aggregate.gate.truncationDidNotRegress, true);

    for (const scenario of comparison.scenarios) {
      for (const metrics of [scenario.legacy, scenario.adaptive]) {
        assert.equal(metrics.filesCovered, scenario.fileCount);
        assert.equal(metrics.linesCovered, scenario.lineCount);
        assert.equal(metrics.evidenceLinesCovered, scenario.lineCount);
        assert.equal(metrics.evidenceCoverageRate, 1);
        assert.ok(metrics.sourceBytesReturned > 0);
        assert.ok(metrics.totalPayloadBytes >= metrics.sourceBytesReturned);
        assert.ok(metrics.truncationCount >= 0);
        assert.ok(metrics.truncationRate >= 0 && metrics.truncationRate <= 1);
        assert.ok(metrics.repeatedReadCount >= 0);
        assert.ok(metrics.elapsedLocalToolMs >= 0);
        assert.ok(
          metrics.observedEndToEndWallClockMs === null || metrics.observedEndToEndWallClockMs >= 0,
          'observed wall-clock is a reporting hook, not a gate',
        );
      }
    }
  }

  assert.equal(result.passed, true);
});

test('threshold candidates reuse the same fixtures and wider disclosure does not increase read boundaries', () => {
  const fixtureSnapshot = JSON.stringify(REPRESENTATIVE_SOURCE_DISCLOSURE_FIXTURES);
  const result = runAdaptiveSourceDisclosureBenchmark({ thresholds: [250, 350, 400, 500] });

  assert.equal(JSON.stringify(REPRESENTATIVE_SOURCE_DISCLOSURE_FIXTURES), fixtureSnapshot);
  assert.deepEqual(result.config.thresholds, [250, 350, 400, 500]);

  const adaptiveBoundaries = result.comparisons.map(
    (comparison) => comparison.aggregate.adaptive.logicalContentReadBoundaries,
  );
  for (let index = 1; index < adaptiveBoundaries.length; index += 1) {
    assert.ok(
      adaptiveBoundaries[index] <= adaptiveBoundaries[index - 1],
      `threshold ${result.comparisons[index].thresholdLines} should not add read boundaries`,
    );
  }
});

test('observed end-to-end wall-clock values are reportable but never CI gate inputs', () => {
  const result = runAdaptiveSourceDisclosureBenchmark({
    thresholds: [250],
    observedWallClockMs: {
      onboarding: { legacy: 1, adaptive: 999_999_999 },
      'job-detail': { legacy: 1, adaptive: 999_999_999 },
    },
  });

  const comparison = result.comparisons[0];
  assert.equal(comparison.aggregate.adaptive.observedEndToEndWallClockMs, 1_999_999_998);
  assert.equal(comparison.aggregate.legacy.observedEndToEndWallClockMs, 2);
  assert.equal(comparison.aggregate.gate.passed, true);
  assert.equal(result.passed, true);
});
