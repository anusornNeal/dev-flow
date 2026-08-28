import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { planVerification } = await import('../../src/server/services/verificationPlannerService.js');
const { loadProjectVerificationImpactRules } = await import('../../src/server/services/projectCommandConfigService.js');

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


test('configured impact rules select the smallest covered verification and explain omissions', () => {
  const plan = planVerification({
    changedFiles: ['src/server/services/exampleService.ts'],
    requestedCommands: ['typecheck', 'test', 'verify'],
    impactRules: [
      {
        id: 'service-unit',
        patterns: ['src/server/services/**'],
        commands: ['test'],
        reason: 'Service changes are covered by focused service tests.',
      },
    ],
  });

  assert.deepEqual(plan.commands, ['test']);
  assert.equal(plan.impact.mode, 'configured');
  assert.deepEqual(plan.impact.coveredFiles, ['src/server/services/exampleService.ts']);
  assert.deepEqual(plan.impact.unknownFiles, []);
  assert.deepEqual(plan.impact.matchedRuleIds, ['service-unit']);
  assert.ok(plan.impact.omittedCommands.some((entry: any) => entry.command === 'verify' && /not selected/i.test(entry.reason)));
});

test('unknown impact falls back conservatively instead of trusting partial mappings', () => {
  const plan = planVerification({
    changedFiles: ['src/server/services/exampleService.ts', 'scripts/unknown-tool.ts'],
    requestedCommands: ['typecheck', 'test', 'verify'],
    impactRules: [
      { id: 'service-unit', patterns: ['src/server/services/**'], commands: ['test'] },
    ],
  });

  assert.equal(plan.impact.mode, 'fallback');
  assert.deepEqual(plan.impact.unknownFiles, ['scripts/unknown-tool.ts']);
  assert.deepEqual(plan.commands, ['typecheck', 'test']);
  assert.ok(plan.reasons.some((reason: string) => /fallback/i.test(reason)));
});

test('repository verification impact mapping loads from declarative project config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-impact-config-'));
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.devflow', 'verification-impact.json'), JSON.stringify({
    rules: [
      {
        id: 'service-tests',
        patterns: ['src/services/**'],
        commands: ['test:service'],
        lane: 'fast',
        reason: 'Service module mapping from repository config.',
      },
    ],
  }));

  const rules = loadProjectVerificationImpactRules(root);
  assert.deepEqual(rules, [{
    id: 'service-tests',
    patterns: ['src/services/**'],
    commands: ['test:service'],
    lane: 'fast',
    reason: 'Service module mapping from repository config.',
  }]);
});

test('target-aware mapped coverage selects only the relevant focused check and exact target', () => {
  const plan = planVerification({
    changedFiles: ['src/server/services/taskClaimService.ts', 'tests/server/taskClaimService.test.ts'],
    resolvedCommands: [
      { command: 'test-focused', semanticKey: 'focused', scope: 'targeted', cost: 'low', resourceKey: 'focused', acceptsTargets: true },
      { command: 'test-command-service', semanticKey: 'command', scope: 'targeted', cost: 'low', resourceKey: 'command' },
      { command: 'test-zrok-bootstrap', semanticKey: 'zrok', scope: 'targeted', cost: 'low', resourceKey: 'zrok' },
    ],
    impactRules: [{
      id: 'task-claim',
      patterns: ['src/server/services/taskClaimService.ts', 'tests/server/taskClaimService.test.ts'],
      commands: ['test-focused'],
      targets: ['tests/server/taskClaimService.test.ts'],
    }],
  });

  assert.equal(plan.impact.mode, 'configured');
  assert.deepEqual(plan.commands, ['test-focused']);
  assert.deepEqual(plan.steps[0]?.targets, ['tests/server/taskClaimService.test.ts']);
  assert.deepEqual(plan.impact.selectedChecks, [{ command: 'test-focused', targets: ['tests/server/taskClaimService.test.ts'] }]);
  assert.deepEqual(plan.impact.omittedCommands.map((entry: any) => entry.command).sort(), ['test-command-service', 'test-zrok-bootstrap']);
});

test('catalog-only fallback never selects unrelated targeted presets without impact evidence', () => {
  const plan = planVerification({
    changedFiles: ['src/server/services/unmappedService.ts'],
    resolvedCommands: [
      { command: 'test-command-service', semanticKey: 'command', scope: 'targeted', cost: 'low', resourceKey: 'command' },
      { command: 'test-zrok-bootstrap', semanticKey: 'zrok', scope: 'targeted', cost: 'low', resourceKey: 'zrok' },
      { command: 'typecheck', semanticKey: 'typecheck', scope: 'broad', cost: 'medium', resourceKey: 'typescript' },
    ],
    impactRules: [{ id: 'other', patterns: ['src/other/**'], commands: ['test-command-service'] }],
  });

  assert.equal(plan.impact.mode, 'fallback');
  assert.deepEqual(plan.commands, ['typecheck']);
  assert.equal(plan.commands.includes('test-command-service'), false);
  assert.equal(plan.commands.includes('test-zrok-bootstrap'), false);
});

test('mapped coverage fails closed when a required command or target capability is unavailable', () => {
  const missing = planVerification({
    changedFiles: ['src/example.ts'],
    requestedCommands: ['test'],
    impactRules: [{ id: 'missing', patterns: ['src/example.ts'], commands: ['missing-preset'] }],
  });
  assert.equal(missing.impact.mode, 'fallback');
  assert.equal(missing.lane, 'safe');
  assert.equal(missing.impact.unavailableChecks[0]?.command, 'missing-preset');
  assert.deepEqual(missing.commands, []);

  const invalidTarget = planVerification({
    changedFiles: ['src/example.ts'],
    resolvedCommands: [
      { command: 'test-focused', semanticKey: 'focused', scope: 'targeted', cost: 'low', resourceKey: 'focused', acceptsTargets: false },
      { command: 'verify', semanticKey: 'full', scope: 'full', cost: 'high', resourceKey: 'repo' },
    ],
    impactRules: [{ id: 'targeted', patterns: ['src/example.ts'], checks: [{ command: 'test-focused', targets: ['tests/example.test.ts'] }] }],
  });
  assert.equal(invalidTarget.impact.mode, 'fallback');
  assert.equal(invalidTarget.lane, 'safe');
  assert.deepEqual(invalidTarget.commands, ['verify']);
  assert.match(invalidTarget.impact.unavailableChecks[0]?.reason || '', /accepts targets/i);
});

test('overlapping impact rules union required commands and focused targets deterministically', () => {
  const plan = planVerification({
    changedFiles: ['src/example.ts'],
    resolvedCommands: [
      { command: 'test-focused', semanticKey: 'focused', scope: 'targeted', cost: 'low', resourceKey: 'focused', acceptsTargets: true },
      { command: 'test-command-service', semanticKey: 'command', scope: 'targeted', cost: 'low', resourceKey: 'command' },
    ],
    impactRules: [
      { id: 'a', patterns: ['src/example.ts'], checks: [{ command: 'test-focused', targets: ['tests/a.test.ts'] }] },
      { id: 'b', patterns: ['src/example.ts'], checks: [{ command: 'test-focused', targets: ['tests/b.test.ts'] }], commands: ['test-command-service'] },
    ],
  });

  assert.equal(plan.impact.mode, 'configured');
  assert.deepEqual(plan.commands, ['test-focused', 'test-command-service']);
  assert.deepEqual(plan.steps.find((step: any) => step.command === 'test-focused')?.targets, ['tests/a.test.ts', 'tests/b.test.ts']);
});

test('SAFE impact escalation remains authoritative and cannot narrow to a targeted mapped check', () => {
  const plan = planVerification({
    changedFiles: ['src/example.ts'],
    resolvedCommands: [
      { command: 'test-command-service', semanticKey: 'command', scope: 'targeted', cost: 'low', resourceKey: 'command' },
      { command: 'verify', semanticKey: 'full', scope: 'full', cost: 'high', resourceKey: 'repo' },
    ],
    impactRules: [{ id: 'safe', patterns: ['src/example.ts'], commands: ['test-command-service'], lane: 'safe' }],
  });

  assert.equal(plan.impact.mode, 'configured');
  assert.equal(plan.lane, 'safe');
  assert.deepEqual(plan.commands, ['verify']);
  assert.equal(plan.requiresBroadVerify, true);
});

test('verification control-plane changes are high risk and cannot self-narrow', () => {
  const plan = planVerification({
    changedFiles: ['.devflow/verification-impact.json'],
    requestedLane: 'fast',
    resolvedCommands: [
      { command: 'test-command-service', semanticKey: 'command', scope: 'targeted', cost: 'low', resourceKey: 'command' },
      { command: 'verify', semanticKey: 'full', scope: 'full', cost: 'high', resourceKey: 'repo' },
    ],
    impactRules: [{ id: 'self', patterns: ['.devflow/verification-impact.json'], commands: ['test-command-service'] }],
  });

  assert.equal(plan.risk, 'high');
  assert.equal(plan.impact.mode, 'fallback');
  assert.equal(plan.lane, 'safe');
  assert.deepEqual(plan.commands, ['verify']);
});

test('impact config rejects duplicate rule ids and loads exact target-aware checks', () => {
  const duplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-impact-duplicate-'));
  fs.mkdirSync(path.join(duplicateRoot, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(duplicateRoot, '.devflow', 'verification-impact.json'), JSON.stringify({
    rules: [
      { id: 'same', patterns: ['src/a.ts'], commands: ['test:a'] },
      { id: 'same', patterns: ['src/b.ts'], commands: ['test:b'] },
    ],
  }));
  assert.throws(() => loadProjectVerificationImpactRules(duplicateRoot), /duplicated/i);

  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-impact-target-'));
  fs.mkdirSync(path.join(targetRoot, '.devflow'), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'tests', 'example.test.ts'), 'export {};\n');
  fs.writeFileSync(path.join(targetRoot, '.devflow', 'verification-impact.json'), JSON.stringify({
    rules: [
      {
        id: 'focused',
        patterns: ['src/example.ts'],
        checks: [{ command: 'test-focused', targets: ['tests/example.test.ts'] }],
      },
      {
        id: 'legacy-target-bridge',
        patterns: ['src/legacy.ts'],
        commands: ['test-focused'],
        targets: ['tests/example.test.ts'],
      },
    ],
  }));
  const targetRules = loadProjectVerificationImpactRules(targetRoot);
  assert.deepEqual(targetRules[0]?.checks, [
    { command: 'test-focused', targets: ['tests/example.test.ts'] },
  ]);
  assert.deepEqual(targetRules[1]?.targets, ['tests/example.test.ts']);
});

test('RED may defer only for low/medium risk with obvious proof under saturated resources', () => {
  const low = planVerification({
    changedFiles: ['README.md'],
    tdd: { testAuthored: true, redProof: 'obvious', resourcePressure: 'saturated' },
  });
  assert.equal(low.tdd.state, 'red-deferred');
  assert.equal(low.tdd.redDecision, 'deferred');
  assert.equal(low.tdd.redEvidence, 'deferred');
  assert.equal(low.tdd.canIntegrate, false);

  const medium = planVerification({
    changedFiles: ['src/service.ts'],
    tdd: { testAuthored: true, redProof: 'obvious', resourcePressure: 'saturated' },
  });
  assert.equal(medium.risk, 'medium');
  assert.equal(medium.tdd.state, 'red-deferred');
});

test('RED stays required when capacity is free, proof is non-obvious, risk is high, or strict TDD is enabled', () => {
  const free = planVerification({
    changedFiles: ['src/service.ts'],
    tdd: { testAuthored: true, redProof: 'obvious', resourcePressure: 'available' },
  });
  assert.equal(free.tdd.state, 'red-required');

  const nonObvious = planVerification({
    changedFiles: ['src/service.ts'],
    tdd: { testAuthored: true, redProof: 'non-obvious', resourcePressure: 'saturated' },
  });
  assert.equal(nonObvious.tdd.state, 'red-required');

  const high = planVerification({
    changedFiles: ['src/server/contracts/devflowContract.ts'],
    tdd: { testAuthored: true, redProof: 'obvious', resourcePressure: 'saturated' },
  });
  assert.equal(high.risk, 'high');
  assert.equal(high.tdd.state, 'red-required');

  const strict = planVerification({
    changedFiles: ['README.md'],
    tdd: { testAuthored: true, redProof: 'obvious', resourcePressure: 'saturated', strictTdd: true },
  });
  assert.equal(strict.tdd.state, 'red-required');
});

test('focused GREEN remains mandatory before integration even when RED was deferred', () => {
  const waitingForGreen = planVerification({
    changedFiles: ['src/service.ts'],
    tdd: { testAuthored: true, redProof: 'obvious', resourcePressure: 'saturated', greenPassed: false },
  });
  assert.equal(waitingForGreen.tdd.state, 'red-deferred');
  assert.equal(waitingForGreen.tdd.greenRequired, true);
  assert.equal(waitingForGreen.tdd.canIntegrate, false);

  const verified = planVerification({
    changedFiles: ['src/service.ts'],
    tdd: { testAuthored: true, redProof: 'obvious', resourcePressure: 'saturated', greenPassed: true },
  });
  assert.equal(verified.tdd.state, 'verified');
  assert.equal(verified.tdd.greenRequired, false);
  assert.equal(verified.tdd.canIntegrate, true);
});

test('TDD policy exposes authored-test and GREEN-required transition states', () => {
  const authored = planVerification({ changedFiles: ['src/service.ts'] });
  assert.equal(authored.tdd.state, 'authored-test');

  const greenRequired = planVerification({
    changedFiles: ['src/service.ts'],
    tdd: {
      testAuthored: true,
      redProof: 'non-obvious',
      resourcePressure: 'available',
      redExecuted: true,
      redFailedAsExpected: true,
    },
  });
  assert.equal(greenRequired.tdd.state, 'green-required');
  assert.equal(greenRequired.tdd.greenRequired, true);
  assert.equal(greenRequired.tdd.canIntegrate, false);
});

test('planner assigns stable required GREEN check identities to selected steps', () => {
  const plan = planVerification({
    changedFiles: ['src/service.ts'],
    requestedLane: 'safe',
    requestedCommands: ['typecheck', 'lint'],
    resolvedCommands: [
      { command: 'typecheck', semanticKey: 'tsc', scope: 'broad', cost: 'medium', resourceKey: 'typescript' },
      { command: 'lint', semanticKey: 'eslint', scope: 'targeted', cost: 'low', resourceKey: 'eslint' },
    ],
  });

  assert.deepEqual(plan.steps.map((step: any) => step.checkId).sort(), ['green:eslint', 'green:tsc']);
  assert.equal(new Set(plan.steps.map((step: any) => step.checkId)).size, plan.steps.length);
});
