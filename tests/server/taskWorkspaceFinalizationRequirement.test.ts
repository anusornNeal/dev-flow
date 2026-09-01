import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __classifyPostIntegrationCommandResultForTests,
  __evaluatePostIntegrationRequirementForTests,
  __postIntegrationRequirementsAttemptedForTests,
  __verificationImpactRuleCommandsForTests,
} from '../../src/server/services/taskWorkspaceFinalizationService.js';import { __buildPostIntegrationVerificationRequestsForTests } from '../../src/server/services/taskWorkspaceHappyPathTailService.js';


function plan(
  checks: Array<{ command: string; targets?: string[] }>,
  coverageRequirement: 'targeted' | 'broad' | 'full' = 'broad',
  risk: 'low' | 'medium' | 'high' = 'high',
) {
  const requiresFullRegression = coverageRequirement === 'full';
  return {
    risk,
    lane: requiresFullRegression ? 'full' : coverageRequirement === 'broad' ? 'safe' : 'fast',
    commands: checks.map((check) => check.command),
    steps: checks.map((check, index) => ({
      checkId: `check-${index}`,
      command: check.command,
      ...(check.targets ? { targets: check.targets } : {}),
      scope: check.targets ? 'targeted' : coverageRequirement,
      cost: check.targets ? 'low' : coverageRequirement === 'full' ? 'high' : 'medium',
      resourceKey: check.command,
      stage: index,
      reason: 'fixture',
    })),
    requiresBroadVerify: coverageRequirement !== 'targeted',
    requiresFullRegression,
    coverageRequirement,
    fullRegression: {
      required: requiresFullRegression,
      authority: requiresFullRegression ? 'requested-lane' : 'none',
      reasonCodes: requiresFullRegression ? ['FULL_EXPLICIT_REQUEST'] : ['FULL_NOT_AUTHORIZED'],
      reasons: [],
    },
    reasons: [`${risk}-risk fixture`],
    impact: {
      mode: 'configured',
      coveredFiles: [],
      configuredCoveredFiles: [],
      inferredCoveredFiles: [],
      unknownFiles: [],
      matchedRuleIds: [],
      matchedConfiguredRuleIds: [],
      matchedInferredRuleIds: [],
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
  assert.deepEqual(requirement.missingChecks, [{ command: 'test', requiredScope: 'broad' }]);
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
  assert.deepEqual(wrongTargets.missingChecks, [{ command: 'test-focused', targets: ['tests/server/example.test.ts'], requiredScope: 'targeted' }]);

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
  assert.deepEqual(failedExactTargets.missingChecks, [{ command: 'test-focused', targets: ['tests/server/example.test.ts'], requiredScope: 'targeted' }]);

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

test('unrelated base advancement reuses authoritative command coverage with an explicit reason code', () => {
  const checks = [{ command: 'typecheck' }, { command: 'lint' }];
  const advancedIntegration = { ...integration, baseHeadBefore: 'advanced-base', baseRevision: 'workspace-base' } as any;
  const requirement = __evaluatePostIntegrationRequirementForTests({
    integration: advancedIntegration,
    checks: [],
    sourcePlan: plan(checks),
    combinedPlan: plan(checks),
    coverage: {
      status: 'covered', policy: 'checks-passed', recordedAt: new Date().toISOString(), reusable: true,
      coveredCommands: ['typecheck', 'lint'], staleCommands: [], staleDetails: [],
    },
  });
  assert.equal(requirement.required, false);
  assert.deepEqual(requirement.missingChecks, []);
  assert.ok(requirement.reasonCodes.includes('REUSED_EQUIVALENT_COVERAGE'));
  assert.ok(requirement.reasonCodes.includes('BASE_ADVANCED_OUTSIDE_VERIFIED_INPUTS'));
});

test('post-integration coverage strength keeps broad and full evidence distinct', () => {
  const required = [{ command: 'test-command-service' }];
  const broadPlan = plan(required, 'broad');
  const fullPlan = plan(required, 'full');

  const broadSatisfied = __evaluatePostIntegrationRequirementForTests({
    integration,
    checks: [{ command: 'test-command-service', status: 'passed', scope: 'broad', repoRevision: 'integrated-head' }],
    sourcePlan: broadPlan,
    combinedPlan: broadPlan,
  });
  assert.equal(broadSatisfied.required, false);
  assert.equal(broadSatisfied.requiredScope, 'broad');

  const broadDoesNotSatisfyFull = __evaluatePostIntegrationRequirementForTests({
    integration,
    checks: [{ command: 'test-command-service', status: 'passed', scope: 'broad', repoRevision: 'integrated-head' }],
    sourcePlan: fullPlan,
    combinedPlan: fullPlan,
  });
  assert.equal(broadDoesNotSatisfyFull.required, true);
  assert.equal(broadDoesNotSatisfyFull.requiredScope, 'full');
  assert.deepEqual(broadDoesNotSatisfyFull.missingChecks.map((check: any) => ({ command: check.command, requiredScope: check.requiredScope })), [
    { command: 'test-command-service', requiredScope: 'full' },
  ]);

  const fullSatisfied = __evaluatePostIntegrationRequirementForTests({
    integration,
    checks: [{ command: 'test-command-service', status: 'passed', scope: 'full', repoRevision: 'integrated-head' }],
    sourcePlan: fullPlan,
    combinedPlan: fullPlan,
  });
  assert.equal(fullSatisfied.required, false);
  assert.equal(fullSatisfied.requiredScope, 'full');
});

test('base advancement requests only the newly missing affected check at its exact scope', () => {
  const sourcePlan = plan([{ command: 'test-desktop', targets: ['tests/desktop.test.ts'] }], 'targeted', 'medium');
  const combinedPlan = plan([
    { command: 'test-desktop', targets: ['tests/desktop.test.ts'] },
    { command: 'test-pdf', targets: ['tests/pdf.test.ts'] },
  ], 'targeted', 'medium');
  const advancedIntegration = { ...integration, baseHeadBefore: 'advanced-base', baseRevision: 'workspace-base' } as any;
  const requirement = __evaluatePostIntegrationRequirementForTests({
    integration: advancedIntegration,
    checks: [],
    sourcePlan,
    combinedPlan,
    coverage: {
      status: 'covered', policy: 'checks-passed', recordedAt: new Date().toISOString(), reusable: true,
      coveredCommands: ['test-desktop'], staleCommands: [], staleDetails: [],
    },
  });

  assert.equal(requirement.required, true);
  assert.equal(requirement.requiredScope, 'targeted');
  assert.deepEqual(requirement.missingChecks.map((check: any) => ({
    command: check.command, targets: check.targets, requiredScope: check.requiredScope,
  })), [{ command: 'test-pdf', targets: ['tests/pdf.test.ts'], requiredScope: 'targeted' }]);
});

test('unchanged integrated impact does not widen valid targeted source evidence during finalization', () => {
  const targetedPlan = plan([{ command: 'test-focused', targets: ['tests/example.test.ts'] }], 'targeted', 'medium');
  const requirement = __evaluatePostIntegrationRequirementForTests({
    integration,
    checks: [{
      command: 'test-focused', targets: ['tests/example.test.ts'], status: 'passed', scope: 'targeted', repoRevision: 'source-head',
    }],
    sourcePlan: targetedPlan,
    combinedPlan: targetedPlan,
    coverage: {
      status: 'covered', policy: 'checks-passed', recordedAt: new Date().toISOString(), reusable: true,
      coveredCommands: ['test-focused'], staleCommands: [], staleDetails: [],
    },
  });

  assert.equal(requirement.required, false);
  assert.equal(requirement.requiredScope, 'targeted');
  assert.equal(requirement.reasonCodes.includes('RERUN_BROAD_EVIDENCE_REQUIRED'), false);
});

test('partial reusable coverage reruns only the missing command and explains the invalidation', () => {test('happy-path tail sends only finalizer-missing checks with their exact coverage strength', () => {
  const requests = __buildPostIntegrationVerificationRequestsForTests({
    projectId: 'project-finalize',
    postIntegration: {
      repoRevision: 'integrated-head',
      requiredScope: 'broad',
      requiredChecks: [
        { command: 'test-focused', targets: ['tests/focused.test.ts'], requiredScope: 'targeted' },
        { command: 'typecheck', requiredScope: 'broad' },
      ],
      missingChecks: [{ command: 'typecheck', requiredScope: 'broad' }],
    },
  });

  assert.deepEqual(requests, [{
    projectId: 'project-finalize',
    command: 'typecheck',
    repoRevision: 'integrated-head',
    requiredScope: 'broad',
  }]);
});

test('happy-path tail preserves explicit FULL authority instead of collapsing it into broad', () => {
  const requests = __buildPostIntegrationVerificationRequestsForTests({
    projectId: 'project-finalize',
    postIntegration: {
      repoRevision: 'integrated-head',
      requiredScope: 'full',
      requiredChecks: [{ command: 'verify', requiredScope: 'full' }],
      missingChecks: [{ command: 'verify', requiredScope: 'full' }],
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.requiredScope, 'full');
  assert.equal(requests[0]?.command, 'verify');
});


  const checks = [{ command: 'typecheck' }, { command: 'lint' }];
  const advancedIntegration = { ...integration, baseHeadBefore: 'advanced-base', baseRevision: 'workspace-base' } as any;
  const requirement = __evaluatePostIntegrationRequirementForTests({
    integration: advancedIntegration,
    checks: [],
    sourcePlan: plan(checks),
    combinedPlan: plan(checks),
    coverage: {
      status: 'stale', policy: 'checks-passed', recordedAt: new Date().toISOString(), reusable: false,
      coveredCommands: ['typecheck'], staleCommands: ['lint'],
      staleDetails: [{ command: 'lint', changedFields: ['dependencyFingerprint'] }],
    },
  });
  assert.equal(requirement.required, true);
  assert.deepEqual(requirement.missingChecks, [{ command: 'lint', requiredScope: 'broad' }]);
  assert.deepEqual(requirement.missingCommands, ['lint']);
  assert.ok(requirement.reasonCodes.includes('RERUN_COVERAGE_IDENTITY_CHANGED'));
});

