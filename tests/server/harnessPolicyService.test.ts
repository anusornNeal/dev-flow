import test from 'node:test';
import assert from 'node:assert/strict';

const {
  HARNESS_POLICY_VERSION,
  evaluateHarnessPolicy,
  isHarnessPolicyCurrent,
} = await import('../../src/server/services/harnessPolicyService.js');

function safeRuntime(overrides: Record<string, unknown> = {}) {
  return {
    revision: 'runtime-r1',
    scopeRelationship: 'disjoint' as const,
    relatedWorkActive: false,
    restartRequested: false,
    managedWorkspace: true,
    ownershipProven: true,
    pathsSafe: true,
    workingTreeClean: true,
    commitOwned: true,
    integrationSafe: true,
    ...overrides,
  };
}

function baseInput(overrides: Record<string, any> = {}) {
  return {
    task: {
      revision: 'task-r1',
      risk: 'medium' as const,
      kind: 'bug-fix' as const,
      ...(overrides.task || {}),
    },
    user: {
      revision: 'user-r1',
      ...(overrides.user || {}),
    },
    project: {
      revision: 'project-r1',
      ...(overrides.project || {}),
    },
    rules: {
      revision: 'rules-r1',
      ...(overrides.rules || {}),
    },
    runtime: safeRuntime(overrides.runtime || {}),
    adaptive: {
      revision: 'adaptive-r1',
      ...(overrides.adaptive || {}),
    },
  };
}

test('policy identity and reason codes are deterministic for stable bounded inputs', () => {
  const input = baseInput();
  const first = evaluateHarnessPolicy(input);
  const second = evaluateHarnessPolicy(input);

  assert.equal(first.version, HARNESS_POLICY_VERSION);
  assert.deepEqual(first, second);
  assert.match(first.policyId, /^harness-policy\.v1:[a-f0-9]{24}$/);
  assert.match(first.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.match(first.revisionFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(isHarnessPolicyCurrent(first, input), true);
});

test('small low-risk UI change honors a current explicit soft verification waiver', () => {
  const policy = evaluateHarnessPolicy(baseInput({
    task: { risk: 'low', kind: 'small-ui' },
    user: { explicit: { verificationCoverage: 'none', planningEvidenceRequired: false, contextSearchBudgetClass: 'compact' } },
    project: { defaults: { verificationCoverage: 'broad', contextSearchBudgetClass: 'expanded' } },
    adaptive: { choices: { verificationCoverage: 'full', contextSearchBudgetClass: 'expanded' } },
  }));

  assert.deepEqual(policy.planningEvidence.value, { required: false });
  assert.equal(policy.planningEvidence.source, 'explicit-user');
  assert.deepEqual(policy.contextSearchBudget.value, { budgetClass: 'compact' });
  assert.equal(policy.contextSearchBudget.source, 'explicit-user');
  assert.deepEqual(policy.verification.value, {
    required: false,
    coverage: 'none',
    mechanics: 'delegated-to-verification-planner',
  });
  assert.equal(policy.verification.source, 'explicit-user');
  assert.ok(policy.verification.reasonCodes.includes('SMALL_UI_SOFT_VERIFICATION_WAIVER'));
  assert.ok(policy.verification.reasonCodes.includes('SOFT_DIRECTIVE_CONFLICT_RESOLVED'));
});

test('normal bug fix requires planning evidence, standard context and targeted verification intent', () => {
  const policy = evaluateHarnessPolicy(baseInput());

  assert.deepEqual(policy.planningEvidence.value, { required: true });
  assert.deepEqual(policy.contextSearchBudget.value, { budgetClass: 'standard' });
  assert.deepEqual(policy.verification.value, {
    required: true,
    coverage: 'targeted',
    mechanics: 'delegated-to-verification-planner',
  });
  assert.equal(policy.verification.reasonCodes.includes('VERIFICATION_MECHANICS_DELEGATED'), true);
});

test('cross-module and high-risk work enforce conservative minima over softer choices', () => {
  const cases = [
    { risk: 'medium' as const, kind: 'cross-module' as const },
    { risk: 'high' as const, kind: 'bug-fix' as const },
  ];

  for (const task of cases) {
    const policy = evaluateHarnessPolicy(baseInput({
      task,
      user: { explicit: { planningEvidenceRequired: false, contextSearchBudgetClass: 'compact', verificationCoverage: 'none' } },
      adaptive: { choices: { planningEvidenceRequired: false, contextSearchBudgetClass: 'compact', verificationCoverage: 'none' } },
    }));

    assert.deepEqual(policy.planningEvidence.value, { required: true });
    assert.equal(policy.planningEvidence.source, 'task-risk');
    assert.deepEqual(policy.contextSearchBudget.value, { budgetClass: 'expanded' });
    assert.equal(policy.contextSearchBudget.source, 'task-risk');
    assert.equal(policy.verification.value.coverage, 'broad');
    assert.equal(policy.verification.source, 'task-risk');
    assert.ok(policy.verification.reasonCodes.includes('TASK_RISK_MINIMUM_ENFORCED'));
  }
});

test('active sibling scope collision blocks parallel execution as a hard gate', () => {
  const policy = evaluateHarnessPolicy(baseInput({
    user: { explicit: { parallelAllowed: true } },
    runtime: { scopeRelationship: 'overlap' },
  }));

  assert.deepEqual(policy.parallel.value, { eligible: false });
  assert.equal(policy.parallel.authority, 'hard');
  assert.equal(policy.parallel.source, 'hard-invariant');
  assert.ok(policy.parallel.reasonCodes.includes('ACTIVE_SCOPE_COLLISION'));
});

test('restart is blocked while related work is active and allowed only when inactivity is known', () => {
  const blocked = evaluateHarnessPolicy(baseInput({
    runtime: { restartRequested: true, relatedWorkActive: true },
  }));
  assert.deepEqual(blocked.restart.value, { gate: 'blocked' });
  assert.equal(blocked.restart.authority, 'hard');
  assert.ok(blocked.restart.reasonCodes.includes('RELATED_WORK_ACTIVE'));

  const allowed = evaluateHarnessPolicy(baseInput({
    runtime: { restartRequested: true, relatedWorkActive: false },
  }));
  assert.deepEqual(allowed.restart.value, { gate: 'allowed' });
  assert.ok(allowed.restart.reasonCodes.includes('RELATED_WORK_INACTIVE'));
});

test('finalization exposes hard lifecycle requirements and eligibility from proven runtime facts', () => {
  const policy = evaluateHarnessPolicy(baseInput());

  assert.equal(policy.finalization.authority, 'hard');
  assert.equal(policy.finalization.value.eligible, true);
  assert.deepEqual(policy.finalization.value.missingFacts, []);
  assert.deepEqual(policy.finalization.value.requirements, {
    managedWorkspace: true,
    ownershipProven: true,
    pathsSafe: true,
    workingTreeClean: true,
    taskOwnedCommit: true,
    safeIntegration: true,
    freshPolicy: true,
  });
  assert.equal(policy.verification.authority, 'soft');
  assert.equal(policy.verification.value.required, true);
  assert.equal('verificationEvidenceRequired' in policy.finalization.value.requirements, false);
  assert.equal(policy.integrity.requireTaskOwnedCommit.value, true);
  assert.equal(policy.integrity.requireTaskOwnedCommit.authority, 'hard');
  assert.equal(policy.integrity.requireFreshPolicyForLifecycleAction.value, true);
});

test('unknown or ambiguous inputs fall back conservatively instead of guessing', () => {
  const policy = evaluateHarnessPolicy({
    task: { revision: 'task-r1' },
    project: { revision: 'project-r1' },
    rules: { revision: 'rules-r1' },
    runtime: { revision: 'runtime-r1', restartRequested: true },
  });

  assert.deepEqual(policy.planningEvidence.value, { required: true });
  assert.deepEqual(policy.contextSearchBudget.value, { budgetClass: 'expanded' });
  assert.equal(policy.verification.value.coverage, 'broad');
  assert.deepEqual(policy.parallel.value, { eligible: false });
  assert.deepEqual(policy.restart.value, { gate: 'blocked' });
  assert.equal(policy.finalization.value.eligible, false);
  assert.ok(policy.finalization.value.missingFacts.includes('managedWorkspace'));
  assert.ok(policy.verification.reasonCodes.includes('UNKNOWN_INPUT_CONSERVATIVE'));
});

test('conflicting soft directives resolve by explicit authority order and learned strategy stays lowest', () => {
  const policy = evaluateHarnessPolicy(baseInput({
    task: {
      risk: 'low',
      kind: 'small-ui',
      explicit: { contextSearchBudgetClass: 'standard' },
      defaults: { contextSearchBudgetClass: 'expanded' },
    },
    user: { explicit: { contextSearchBudgetClass: 'compact' } },
    project: { defaults: { contextSearchBudgetClass: 'expanded' } },
    adaptive: { choices: { contextSearchBudgetClass: 'expanded' } },
  }));

  assert.deepEqual(policy.contextSearchBudget.value, { budgetClass: 'compact' });
  assert.equal(policy.contextSearchBudget.source, 'explicit-user');
  assert.ok(policy.contextSearchBudget.reasonCodes.includes('SOFT_DIRECTIVE_CONFLICT_RESOLVED'));

  const adaptiveOnly = evaluateHarnessPolicy(baseInput({
    task: { risk: 'low', kind: 'small-ui' },
    adaptive: { choices: { contextSearchBudgetClass: 'standard' } },
  }));
  assert.deepEqual(adaptiveOnly.contextSearchBudget.value, { budgetClass: 'standard' });
  assert.equal(adaptiveOnly.contextSearchBudget.source, 'adaptive');
});

test('task, project, rule and runtime revision changes invalidate a previously issued policy', () => {
  const originalInput = baseInput();
  const policy = evaluateHarnessPolicy(originalInput);
  const mutations = [
    baseInput({ task: { revision: 'task-r2' } }),
    baseInput({ project: { revision: 'project-r2' } }),
    baseInput({ rules: { revision: 'rules-r2' } }),
    baseInput({ runtime: { revision: 'runtime-r2' } }),
  ];

  for (const changed of mutations) {
    const recomputed = evaluateHarnessPolicy(changed);
    assert.equal(isHarnessPolicyCurrent(policy, changed), false);
    assert.notEqual(policy.revisionFingerprint, recomputed.revisionFingerprint);
    assert.notEqual(policy.policyId, recomputed.policyId);
  }
});

test('verification policy emits intent only and leaves execution mechanics to the existing planner', () => {
  const policy = evaluateHarnessPolicy(baseInput());
  const verificationJson = JSON.stringify(policy.verification);

  assert.equal(policy.verification.value.mechanics, 'delegated-to-verification-planner');
  assert.doesNotMatch(verificationJson, /command|candidate|scheduler|resource|admission/i);
});

test('policy schema has no routing surface and hard invariants cannot be disabled by adaptive choices', () => {
  const policy = evaluateHarnessPolicy(baseInput({
    adaptive: {
      choices: {
        planningEvidenceRequired: false,
        contextSearchBudgetClass: 'compact',
        verificationCoverage: 'none',
        parallelAllowed: true,
      },
      model: 'ignored',
      provider: 'ignored',
    },
  }));

  const serialized = JSON.stringify(policy);
  assert.doesNotMatch(serialized, /model|provider|router/i);
  assert.equal(policy.integrity.requireManagedWorkspace.value, true);
  assert.equal(policy.integrity.requireWorkspaceOwnership.value, true);
  assert.equal(policy.integrity.requireRepoRelativePathSafety.value, true);
  assert.equal(policy.integrity.requireTaskOwnedCommit.value, true);
  assert.equal(policy.integrity.requireSafeFinalizationIntegration.value, true);
});
