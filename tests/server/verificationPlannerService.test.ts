import test from 'node:test';
import assert from 'node:assert/strict';

const { planVerification } = await import('../../src/server/services/verificationPlannerService.js');

test('low-risk isolated UI change selects FAST lane with targeted checks', () => {
  const plan = planVerification({
    changedFiles: ['src/components/Toolbar.tsx'],
    requestedCommands: ['typecheck', 'test', 'build'],
  });

  assert.equal(plan.lane, 'fast');
  assert.equal(plan.risk, 'medium');
  assert.deepEqual(plan.commands, ['typecheck', 'test']);
  assert.equal(plan.requiresBroadVerify, false);
});

test('build/config changes automatically escalate to SAFE and broad verification', () => {
  const plan = planVerification({
    changedFiles: ['package.json', 'src/server/contracts/devflowContract.ts'],
    requestedCommands: ['typecheck', 'test', 'build', 'verify'],
  });

  assert.equal(plan.lane, 'safe');
  assert.equal(plan.risk, 'high');
  assert.equal(plan.requiresBroadVerify, true);
  assert.ok(plan.commands.includes('verify'));
  assert.ok(plan.reasons.length > 0);
});

test('explicit SAFE override is honored and FAST override cannot bypass high-risk escalation', () => {
  const safe = planVerification({ changedFiles: ['README.md'], requestedLane: 'safe', requestedCommands: ['typecheck', 'test'] });
  assert.equal(safe.lane, 'safe');

  const forcedFast = planVerification({ changedFiles: ['build.gradle.kts'], requestedLane: 'fast', requestedCommands: ['typecheck', 'test', 'verify'] });
  assert.equal(forcedFast.lane, 'safe');
  assert.ok(forcedFast.reasons.some((reason: string) => reason.includes('escalated')));
});

test('independent parallel groups are opt-in only', () => {
  const serial = planVerification({ changedFiles: ['src/service.ts'], requestedCommands: ['typecheck', 'test', 'lint'] });
  assert.equal(serial.steps.every((step: any) => step.parallelGroup === undefined), true);

  const parallel = planVerification({
    changedFiles: ['src/service.ts'],
    requestedCommands: ['typecheck', 'test', 'lint'],
    resourceIsolatedCommands: ['typecheck', 'lint'],
  });
  assert.equal(parallel.steps.filter((step: any) => step.parallelGroup === 'isolated').length, 2);
});

test('FAST planner deduplicates equivalent command semantics and excludes FULL verification aliases', () => {
  const plan = planVerification({
    changedFiles: ['src/components/Toolbar.tsx'],
    resolvedCommands: [
      { command: 'typecheck', semanticKey: 'same-tsc', scope: 'broad', cost: 'medium', resourceKey: 'typescript' },
      { command: 'lint', semanticKey: 'same-tsc', scope: 'broad', cost: 'medium', resourceKey: 'typescript' },
      { command: 'test', semanticKey: 'full-verify', scope: 'full', cost: 'high', resourceKey: 'repo' },
    ],
  });

  assert.equal(plan.lane, 'fast');
  assert.deepEqual(plan.commands, ['typecheck']);
  assert.equal(plan.steps.some((step: any) => step.command === 'test'), false);
});

test('explicit FULL lane selects one FULL descriptor and marks broad verification required', () => {
  const plan = planVerification({
    changedFiles: ['src/server/service.ts'],
    requestedLane: 'full',
    resolvedCommands: [
      { command: 'typecheck', semanticKey: 'tsc', scope: 'broad', cost: 'medium', resourceKey: 'typescript' },
      { command: 'verify', semanticKey: 'full-verify', scope: 'full', cost: 'high', resourceKey: 'repo' },
    ],
  });

  assert.equal(plan.lane, 'full');
  assert.deepEqual(plan.commands, ['verify']);
  assert.equal(plan.requiresBroadVerify, true);
  assert.equal(plan.steps[0]?.verificationClass, 'heavy');
  assert.deepEqual(plan.steps[0]?.sharedResources, ['repo']);
});

test('planner propagates fast verification resource metadata without changing selection', () => {
  const plan = planVerification({
    changedFiles: ['src/components/Toolbar.tsx'],
    resolvedCommands: [
      {
        command: 'typecheck',
        semanticKey: 'tsc',
        scope: 'broad',
        cost: 'medium',
        resourceKey: 'typescript',
        verificationClass: 'fast',
        sharedResources: ['typescript'],
      },
      {
        command: 'verify',
        semanticKey: 'full-verify',
        scope: 'full',
        cost: 'high',
        resourceKey: 'repo',
        verificationClass: 'heavy',
        sharedResources: ['repo'],
      },
    ],
  });

  assert.deepEqual(plan.commands, ['typecheck']);
  assert.equal(plan.steps[0]?.verificationClass, 'fast');
  assert.deepEqual(plan.steps[0]?.sharedResources, ['typescript']);
});
