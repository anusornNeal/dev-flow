import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __classifyPostIntegrationCommandResultForTests,
  __evaluatePostIntegrationRequirementForTests,
  __postIntegrationRequirementsAttemptedForTests,
  __verificationImpactRuleCommandsForTests,
} from '../../src/server/services/taskWorkspaceFinalizationService.js';

function plan(checks: Array<{ command: string; targets?: string[] }>) {
  return {
    risk: 'high',
    lane: 'safe',
    commands: checks.map((check) => check.command),
    steps: checks.map((check, index) => ({
      checkId: `check-${index}`,
      command: check.command,
      ...(check.targets ? { targets: check.targets } : {}),
      scope: check.targets ? 'targeted' : 'full',
      cost: check.targets ? 'low' : 'high',
      resourceKey: check.command,
      stage: index,
      reason: 'fixture',
    })),
    requiresBroadVerify: true,
    reasons: ['high-risk fixture'],
    impact: {
      mode: 'configured',
      coveredFiles: [],
      unknownFiles: [],
      matchedRuleIds: [],
      selectedCommands: checks.map((check) => check.command),
      selectedChecks: checks,
      unavailableChecks: [],
      omittedCommands: [],
    },
    tdd: {
      state: 'verified',
      redDecision: 'required',
      redEvidence: 'executed',
      greenRequired: true,
      canIntegrate: true,
      reasons: [],
    },
  } as any;
}

const integration = {
  baseHeadBefore: 'base',
  baseRevision: 'base',
  baseHeadAfter: 'integrated-head',
} as any;

test('checks-only impact rules contribute commands without requiring a rule-level commands array', () => {
  assert.deepEqual(__verificationImpactRuleCommandsForTests({
    id: 'checks-only',
    patterns: ['src/**'],
    checks: [
      { command: 'test-focused', targets: ['tests/server/example.test.ts'] },
      { command: 'typecheck' },
      { command: 'typecheck' },
    ],
  } as any), ['test-focused', 'typecheck']);
  assert.deepEqual(__verificationImpactRuleCommandsForTests({
    id: 'legacy-empty',
    patterns: ['src/**'],
  } as any), []);
});

test('failed exact-revision verification remains an unsatisfied requirement with truthful debt', () => {
  const checks = [{ command: 'test' }];
  const requirement = __evaluatePostIntegrationRequirementForTests({
    integration,
    checks: [{
      name: 'full suite',
      command: 'test',
      status: 'failed',
      scope: 'full',
      repoRevision: 'integrated-head',
      failureKind: 'timeout',
      summary: 'Timed out after 120 seconds.',
    }],
    sourcePlan: plan(checks),
    combinedPlan: plan(checks),
  });

  assert.equal(requirement.required, true);
  assert.deepEqual(requirement.missingChecks, checks);
  assert.deepEqual(requirement.missingCommands, ['test']);
  assert.match(requirement.reason, /still non-passing: test/);
});

test('terminal failed or not-run exact-revision attempts preserve debt without retrying forever', () => {
  const required = [{ command: 'test' }];
  const requirement = __evaluatePostIntegrationRequirementForTests({
    integration,
    checks: [],
    sourcePlan: plan(required),
    combinedPlan: plan(required),
  });

  assert.equal(__postIntegrationRequirementsAttemptedForTests({
    requirement,
    checks: [{ command: 'test', status: 'failed', scope: 'full', repoRevision: 'integrated-head', failureKind: 'timeout' }],
  }), true);
  assert.equal(__postIntegrationRequirementsAttemptedForTests({
    requirement,
    checks: [{ command: 'test', status: 'not-run', scope: 'broad', repoRevision: 'integrated-head', failureKind: 'workspace-setup' }],
  }), true);
  assert.equal(__postIntegrationRequirementsAttemptedForTests({
    requirement,
    checks: [{ command: 'test', status: 'failed', scope: 'full', repoRevision: 'stale-head', failureKind: 'command-failed' }],
  }), false);
});

test('target-aware requirement only clears after the exact command+targets identity passes', () => {
  const focused = [{ command: 'test-focused', targets: ['tests/server/example.test.ts'] }];
  const wrongTargets = __evaluatePostIntegrationRequirementForTests({
    integration,
    checks: [{
      command: 'test-focused',
      targets: ['tests/server/other.test.ts'],
      status: 'failed',
      scope: 'broad',
      repoRevision: 'integrated-head',
      failureKind: 'command-failed',
    }],
    sourcePlan: plan(focused),
    combinedPlan: plan(focused),
  });
  assert.equal(wrongTargets.required, true);
  assert.deepEqual(wrongTargets.missingChecks, focused);

  const failedExactTargets = __evaluatePostIntegrationRequirementForTests({
    integration,
    checks: [{
      command: 'test-focused',
      targets: ['./tests/server/example.test.ts'],
      status: 'failed',
      scope: 'broad',
      repoRevision: 'integrated-head',
      failureKind: 'command-failed',
    }],
    sourcePlan: plan(focused),
    combinedPlan: plan(focused),
  });
  assert.equal(failedExactTargets.required, true);
  assert.deepEqual(failedExactTargets.missingChecks, focused);

  const passedExactTargets = __evaluatePostIntegrationRequirementForTests({
    integration,
    checks: [{
      command: 'test-focused',
      targets: ['./tests/server/example.test.ts'],
      status: 'passed',
      scope: 'broad',
      repoRevision: 'integrated-head',
    }],
    sourcePlan: plan(focused),
    combinedPlan: plan(focused),
  });
  assert.equal(passedExactTargets.required, false);
  assert.deepEqual(passedExactTargets.missingChecks, []);
});

test('automatic verification classifies timeout separately from ordinary command failure', () => {
  assert.equal(__classifyPostIntegrationCommandResultForTests({ ok: false, status: 'timed_out', timedOut: true, exitCode: 1 }), 'timeout');
  assert.equal(__classifyPostIntegrationCommandResultForTests({ ok: false, status: 'failed', timedOut: false, exitCode: 2 }), 'command-failed');
  assert.equal(__classifyPostIntegrationCommandResultForTests({ ok: true, status: 'succeeded', timedOut: false, exitCode: 0 }), null);
});
