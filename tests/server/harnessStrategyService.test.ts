import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  createHarnessTaskFingerprint,
  recommendHarnessStrategy,
  type HarnessStrategyChoices,
  type HarnessStrategyEvidence,
  type HarnessStrategyTaskInput,
} from '../../src/server/services/harnessStrategyService.js';
import {
  loadHarnessScenarios,
  runHarnessBenchmark,
  runHarnessEval,
} from '../../scripts/benchmark-chatgpt-harness.js';

const FIXTURES_DIR = path.resolve('tests/fixtures/harness-evals');

const smallTask: HarnessStrategyTaskInput = {
  risk: 'low',
  kind: 'small-ui',
  targetFileCount: 1,
  sharedContract: false,
  reproductionAvailable: false,
  explicitVerificationWaiver: false,
  hardSafetyAffected: false,
};

const efficientChoices: HarnessStrategyChoices = {
  contextProfile: 'snippets',
  contextSearchBudgetClass: 'compact',
  searchReadBudget: 3,
  planningEvidenceRequired: false,
  verificationCoverage: 'targeted',
};

const conservativeChoices: HarnessStrategyChoices = {
  contextProfile: 'callers-tests',
  contextSearchBudgetClass: 'expanded',
  searchReadBudget: 8,
  planningEvidenceRequired: true,
  verificationCoverage: 'broad',
};

function evidence(
  overrides: Partial<HarnessStrategyEvidence> = {},
  task: HarnessStrategyTaskInput = smallTask,
): HarnessStrategyEvidence {
  return {
    evidenceId: 'cal-efficient-1',
    evidenceWindow: 'window-2026-08-a',
    source: 'calibration',
    scope: 'task-class',
    taskFingerprint: createHarnessTaskFingerprint(task).fingerprint,
    strategyVersion: 'candidate-v2',
    choices: efficientChoices,
    sampleCount: 8,
    oraclePassRate: 1,
    firstPassSuccessRate: 1,
    repairRate: 0,
    retryRate: 0,
    verificationFailureRate: 0,
    averageContextBytes: 1_200,
    averageToolCallCount: 4,
    ...overrides,
  };
}

function globalHoldout(overrides: Partial<HarnessStrategyEvidence> = {}): HarnessStrategyEvidence {
  return evidence({
    evidenceId: 'holdout-candidate-v2',
    evidenceWindow: 'holdout-v1',
    source: 'holdout',
    scope: 'global',
    taskFingerprint: undefined,
    sampleCount: 12,
    regression: 'unchanged',
    ...overrides,
  });
}

function strongInput(overrides: Record<string, any> = {}) {
  return {
    task: smallTask,
    evidence: [evidence(), globalHoldout()],
    rollout: {
      mode: 'bounded-auto' as const,
      minSamples: 6,
      minConfidence: 0.8,
      decisionSequence: 10,
      ...overrides.rollout,
    },
    ...overrides,
  };
}

test('task fingerprint is deterministic, bounded and ignores raw unrecognized content', () => {
  const first = createHarnessTaskFingerprint({
    ...smallTask,
    ...( { repoText: 'SECRET raw repository text', provider: 'do-not-store' } as any),
  });
  const second = createHarnessTaskFingerprint({ ...smallTask });

  assert.deepEqual(first, second);
  assert.match(first.fingerprint, /^harness-task-fingerprint\.v1:[a-f0-9]{32}$/);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes('SECRET raw repository text'), false);
  assert.equal(serialized.includes('do-not-store'), false);
});

test('cold start returns stable deterministic defaults in shadow mode', () => {
  const first = recommendHarnessStrategy({ task: smallTask });
  const second = recommendHarnessStrategy({ task: smallTask });

  assert.deepEqual(first, second);
  assert.equal(first.status, 'fallback');
  assert.equal(first.strategyVersion, 'deterministic-default.v1');
  assert.equal(first.rollout.mode, 'shadow');
  assert.equal(first.rollout.autoApplyEligible, false);
  assert.ok(first.reasonCodes.includes('COLD_START_FALLBACK'));
  assert.ok(first.reasonCodes.includes('DETERMINISTIC_FALLBACK'));
});

test('strong exact-class evidence recommends the best bounded strategy deterministically', () => {
  const slower = evidence({
    evidenceId: 'cal-conservative-1',
    strategyVersion: 'candidate-conservative-v1',
    choices: conservativeChoices,
    sampleCount: 8,
    firstPassSuccessRate: 0.75,
    repairRate: 0.2,
    averageContextBytes: 8_000,
    averageToolCallCount: 9,
  });
  const slowerHoldout = globalHoldout({
    evidenceId: 'holdout-conservative-v1',
    strategyVersion: 'candidate-conservative-v1',
    choices: conservativeChoices,
  });
  const input = strongInput({ evidence: [evidence(), globalHoldout(), slower, slowerHoldout] });

  const first = recommendHarnessStrategy(input);
  const second = recommendHarnessStrategy(input);

  assert.deepEqual(first, second);
  assert.equal(first.status, 'recommended');
  assert.equal(first.strategyVersion, 'candidate-v2');
  assert.deepEqual(first.recommendation, efficientChoices);
  assert.ok(first.confidence >= 0.8);
  assert.ok(first.scoreMargin > 0);
  assert.equal(first.evidence.holdoutValidated, true);
  assert.equal(first.rollout.autoApplyEligible, true);
});

test('sparse evidence falls back instead of overfitting', () => {
  const decision = recommendHarnessStrategy(strongInput({
    evidence: [evidence({ sampleCount: 2 }), globalHoldout()],
  }));

  assert.equal(decision.status, 'fallback');
  assert.equal(decision.rollout.autoApplyEligible, false);
  assert.ok(decision.reasonCodes.includes('INSUFFICIENT_EVIDENCE'));
});

test('conflicting near-equal strategies fall back to deterministic defaults', () => {
  const alternativeChoices: HarnessStrategyChoices = {
    ...efficientChoices,
    searchReadBudget: 4,
  };
  const decision = recommendHarnessStrategy(strongInput({
    evidence: [
      evidence(),
      globalHoldout(),
      evidence({ evidenceId: 'cal-alt', strategyVersion: 'candidate-alt', choices: alternativeChoices }),
      globalHoldout({ evidenceId: 'holdout-alt', strategyVersion: 'candidate-alt', choices: alternativeChoices }),
    ],
  }));

  assert.equal(decision.status, 'fallback');
  assert.ok(decision.reasonCodes.includes('CONFLICTING_EVIDENCE'));
});

test('explicit user or task policy constraints override adaptive recommendations and block auto apply', () => {
  const decision = recommendHarnessStrategy(strongInput({
    policy: {
      planningEvidence: { value: { required: true }, source: 'explicit-user', authority: 'soft' },
      contextSearchBudget: { value: { budgetClass: 'expanded' }, source: 'explicit-task', authority: 'advisory' },
      verification: { value: { required: true, coverage: 'broad' }, source: 'explicit-user', authority: 'soft' },
    },
  }));

  assert.equal(decision.status, 'recommended');
  assert.equal(decision.recommendation.planningEvidenceRequired, true);
  assert.equal(decision.recommendation.contextSearchBudgetClass, 'expanded');
  assert.equal(decision.recommendation.verificationCoverage, 'broad');
  assert.equal(decision.rollout.autoApplyEligible, false);
  assert.ok(decision.reasonCodes.includes('POLICY_CONSTRAINT_APPLIED'));
  assert.ok(decision.reasonCodes.includes('AUTO_APPLY_BLOCKED_BY_POLICY_CONSTRAINT'));
});

test('hard-policy or hard-safety conflict always fails closed', () => {
  const decision = recommendHarnessStrategy(strongInput({
    policy: { hardSafetyBlocked: true },
  }));

  assert.equal(decision.status, 'fallback');
  assert.equal(decision.rollout.autoApplyEligible, false);
  assert.ok(decision.reasonCodes.includes('HARD_POLICY_BLOCK'));
});

test('shadow is the default even with strong validated evidence', () => {
  const decision = recommendHarnessStrategy({
    task: smallTask,
    evidence: [evidence(), globalHoldout()],
  });

  assert.equal(decision.status, 'recommended');
  assert.equal(decision.rollout.mode, 'shadow');
  assert.equal(decision.rollout.autoApplyEligible, false);
  assert.ok(decision.reasonCodes.includes('SHADOW_MODE'));
});

test('bounded auto apply requires holdout evidence and confidence threshold', () => {
  const withoutHoldout = recommendHarnessStrategy(strongInput({ evidence: [evidence()] }));
  const withHoldout = recommendHarnessStrategy(strongInput());

  assert.equal(withoutHoldout.status, 'recommended');
  assert.equal(withoutHoldout.rollout.autoApplyEligible, false);
  assert.ok(withoutHoldout.reasonCodes.includes('HOLDOUT_EVIDENCE_REQUIRED_FOR_AUTO_APPLY'));
  assert.equal(withHoldout.rollout.autoApplyEligible, true);
  assert.ok(withHoldout.reasonCodes.includes('BOUNDED_AUTO_APPLY_ELIGIBLE'));
});

test('anti-flapping cooldown blocks switching strategies during the configured cooldown window', () => {
  const decision = recommendHarnessStrategy(strongInput({
    rollout: {
      mode: 'bounded-auto',
      minSamples: 6,
      minConfidence: 0.8,
      cooldownDecisions: 3,
      decisionSequence: 10,
      previous: {
        strategyId: 'harness-strategy.v1:previous-strategy',
        lastChangedDecisionSequence: 9,
      },
    },
  }));

  assert.equal(decision.status, 'recommended');
  assert.equal(decision.rollout.autoApplyEligible, false);
  assert.ok(decision.reasonCodes.includes('ANTI_FLAP_COOLDOWN'));
});

test('distribution shift from a different normalized task class falls back', () => {
  const otherTask: HarnessStrategyTaskInput = {
    risk: 'high',
    kind: 'cross-module',
    targetFileCount: 7,
    sharedContract: true,
  };
  const decision = recommendHarnessStrategy({
    task: smallTask,
    evidence: [evidence({}, otherTask)],
  });

  assert.equal(decision.status, 'fallback');
  assert.ok(decision.reasonCodes.includes('DISTRIBUTION_SHIFT_FALLBACK'));
});

test('holdout regression rejects a candidate and reverts to deterministic baseline', () => {
  const decision = recommendHarnessStrategy(strongInput({
    evidence: [evidence(), globalHoldout({ regression: 'regression' })],
  }));

  assert.equal(decision.status, 'fallback');
  assert.equal(decision.strategyVersion, 'deterministic-default.v1');
  assert.ok(decision.reasonCodes.includes('HOLDOUT_REGRESSION_REJECTED'));
});

test('context governor output bounds adaptive disclosure and read/search budget', () => {
  const decision = recommendHarnessStrategy(strongInput({
    evidence: [evidence({ choices: conservativeChoices, strategyVersion: 'bounded-context-v1' }), globalHoldout({ choices: conservativeChoices, strategyVersion: 'bounded-context-v1' })],
    contextGovernor: {
      planIdentity: 'context-plan-v1',
      disclosureLevel: 'snippets',
      maxContextBytes: 12_000,
      maxSearchReadBudget: 4,
    },
  }));

  assert.equal(decision.recommendation.contextProfile, 'snippets');
  assert.equal(decision.recommendation.searchReadBudget, 4);
  assert.ok(decision.reasonCodes.includes('CONTEXT_GOVERNOR_DISCLOSURE_BOUND_APPLIED'));
  assert.ok(decision.reasonCodes.includes('CONTEXT_GOVERNOR_SEARCH_READ_BOUND_APPLIED'));
});

test('DVF-0562 fixture metrics can drive a holdout-gated strategy recommendation', () => {
  const scenarios = loadHarnessScenarios(FIXTURES_DIR);
  const calibrationScenario = scenarios.find((scenario) => scenario.id === 'cal-small-scoped');
  assert.ok(calibrationScenario);
  const calibration = runHarnessEval({
    scenarios: [calibrationScenario],
    strategyName: 'candidate',
    repoFingerprint: 'repo-fixture-v1',
    environmentFingerprint: 'environment-fixture-v1',
  });
  const benchmark = runHarnessBenchmark({
    fixturesDir: FIXTURES_DIR,
    baselineStrategy: 'baseline',
    candidateStrategy: 'candidate',
    repoFingerprint: 'repo-fixture-v1',
    environmentFingerprint: 'environment-fixture-v1',
  });
  const metric = calibration.scenarios[0]!.metrics;
  const holdout = benchmark.corpora.find((entry) => entry.corpus === 'holdout');
  assert.ok(holdout);
  const holdoutCandidateScenarios = benchmark.raw.candidate.scenarios.filter((scenario) => scenario.corpus === 'holdout');
  const holdoutOracleRate = holdoutCandidateScenarios.filter((scenario) => scenario.metrics.oraclePassed).length / holdoutCandidateScenarios.length;

  const decision = recommendHarnessStrategy({
    task: smallTask,
    evidence: [
      evidence({
        evidenceId: 'dvf-0562-cal-small-scoped',
        evidenceWindow: calibration.corpusIdentity,
        strategyVersion: calibration.scenarios[0]!.strategyVersion,
        sampleCount: 6,
        oraclePassRate: metric.oraclePassed ? 1 : 0,
        firstPassSuccessRate: metric.firstPassSuccess ? 1 : 0,
        repairRate: metric.repairCount / 6,
        retryRate: metric.retryCount / 6,
        verificationFailureRate: metric.verificationFailures / 6,
        averageContextBytes: metric.contextBytes,
        averageToolCallCount: metric.toolCallCount,
      }),
      globalHoldout({
        evidenceId: 'dvf-0562-holdout',
        evidenceWindow: benchmark.corpusIdentity,
        strategyVersion: calibration.scenarios[0]!.strategyVersion,
        oraclePassRate: holdoutOracleRate,
        regression: holdout.classification,
      }),
    ],
    rollout: { mode: 'bounded-auto', minSamples: 6, minConfidence: 0.75 },
  });

  assert.equal(holdout.classification === 'regression', false);
  assert.equal(decision.status, 'recommended');
  assert.equal(decision.evidence.holdoutValidated, true);
  assert.equal(decision.rollout.autoApplyEligible, true);
});

test('strategy output contains no model, provider or agent routing field', () => {
  const decision = recommendHarnessStrategy(strongInput());
  const serialized = JSON.stringify(decision).toLowerCase();

  assert.equal(serialized.includes('"model"'), false);
  assert.equal(serialized.includes('"provider"'), false);
  assert.equal(serialized.includes('"agent"'), false);
  assert.deepEqual(Object.keys(decision.adaptivePolicyChoices).sort(), [
    'contextSearchBudgetClass',
    'planningEvidenceRequired',
    'verificationCoverage',
  ]);
});
