import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildVerificationResourceProfileKey,
  clearVerificationResourceProfilesForTests,
  getVerificationResourceProfileDiagnostics,
  predictVerificationResourceCost,
  recordVerificationResourceSample,
} = await import('../../src/server/services/verificationResourceProfileService.js');

function descriptor(overrides: Record<string, any> = {}) {
  return {
    repositoryKey: 'project:alpha',
    semanticKey: 'semantic:typecheck',
    machineKey: 'machine-a',
    cost: 'medium' as const,
    verificationClass: 'fast' as const,
    sharedResources: ['typescript'],
    ...overrides,
  };
}

test.beforeEach(() => {
  clearVerificationResourceProfilesForTests();
});

test('verification resource profile identity separates repository, semantic command and machine', () => {
  const base = descriptor();
  const baseKey = buildVerificationResourceProfileKey(base);
  assert.equal(baseKey, buildVerificationResourceProfileKey({ ...base }));
  assert.notEqual(baseKey, buildVerificationResourceProfileKey({ ...base, repositoryKey: 'project:beta' }));
  assert.notEqual(baseKey, buildVerificationResourceProfileKey({ ...base, semanticKey: 'semantic:test' }));
  assert.notEqual(baseKey, buildVerificationResourceProfileKey({ ...base, machineKey: 'machine-b' }));
  assert.equal(baseKey.includes('alpha'), false);
  assert.equal(baseKey.includes('typecheck'), false);
});

test('cold-start prediction is conservative and preserves declared shared resources', () => {
  const light = predictVerificationResourceCost(descriptor({ cost: 'low', verificationClass: 'fast', sharedResources: ['command:abc'] }));
  const heavy = predictVerificationResourceCost(descriptor({ cost: 'high', verificationClass: 'heavy', sharedResources: ['repo'] }));

  assert.equal(light.sampleCount, 0);
  assert.equal(light.confidence, 'none');
  assert.deepEqual(light.sharedResources, ['command:abc']);
  assert.equal(heavy.expected.cpuRatio > light.expected.cpuRatio, true);
  assert.equal(heavy.expected.memoryBytes > light.expected.memoryBytes, true);
  assert.equal(heavy.expected.durationMs > light.expected.durationMs, true);
  assert.equal(heavy.upperBound.durationMs >= heavy.expected.durationMs, true);
});

test('successful recent samples learn a stable recency-weighted profile after enough evidence', () => {
  const target = descriptor();
  const cold = predictVerificationResourceCost(target);
  for (const [index, durationMs] of [30_000, 24_000, 18_000, 12_000].entries()) {
    const before = predictVerificationResourceCost(target);
    recordVerificationResourceSample(target, {
      status: 'succeeded',
      durationMs,
      cpuRatio: 0.35 + index * 0.05,
      memoryBytes: (350 + index * 25) * 1024 ** 2,
      processCount: 2 + Math.floor(index / 2),
      systemCpuRatio: 0.45,
      memoryPressureRatio: 0.6,
      treeAccounting: true,
      predicted: before,
      recordedAt: 1_000 + index,
    });
  }

  const learned = predictVerificationResourceCost(target);
  assert.equal(learned.sampleCount, 4);
  assert.equal(learned.successfulSampleCount, 4);
  assert.equal(learned.confidence, 'medium');
  assert.equal(learned.expected.durationMs < cold.expected.durationMs, true);
  assert.equal(learned.expected.durationMs >= 12_000, true);
  assert.equal(learned.expected.durationMs <= 30_000, true);
  assert.equal(learned.upperBound.durationMs >= learned.expected.durationMs, true);
});

test('failed and timed-out samples remain visible without corrupting learned successful cost', () => {
  const target = descriptor({ cost: 'low' });
  for (let index = 0; index < 3; index += 1) {
    recordVerificationResourceSample(target, {
      status: 'succeeded', durationMs: 4_000 + index * 100, cpuRatio: 0.2, memoryBytes: 128 * 1024 ** 2, processCount: 1, recordedAt: index + 1,
    });
  }
  const before = predictVerificationResourceCost(target);
  recordVerificationResourceSample(target, {
    status: 'failed', durationMs: 240_000, cpuRatio: 1, memoryBytes: 8 * 1024 ** 3, processCount: 50, recordedAt: 10,
  });
  recordVerificationResourceSample(target, {
    status: 'timed_out', durationMs: 300_000, cpuRatio: 1, memoryBytes: 16 * 1024 ** 3, processCount: 100, recordedAt: 11,
  });
  const after = predictVerificationResourceCost(target);
  const diagnostics = getVerificationResourceProfileDiagnostics();

  assert.equal(after.expected.durationMs, before.expected.durationMs);
  assert.equal(after.successfulSampleCount, 3);
  assert.equal(after.sampleCount, 5);
  assert.equal(diagnostics.failedSamples, 2);
});

test('one successful outlier is clipped so sparse history cannot make future admission unsafe', () => {
  const target = descriptor({ cost: 'low' });
  for (const [index, durationMs] of [5_000, 5_200, 4_800, 300_000].entries()) {
    recordVerificationResourceSample(target, {
      status: 'succeeded',
      durationMs,
      cpuRatio: index === 3 ? 1 : 0.2,
      memoryBytes: (index === 3 ? 8_000 : 180) * 1024 ** 2,
      processCount: index === 3 ? 50 : 2,
      recordedAt: index + 1,
    });
  }
  const learned = predictVerificationResourceCost(target);

  assert.equal(learned.expected.durationMs < 20_000, true);
  assert.equal(learned.expected.memoryBytes < 1024 ** 3, true);
  assert.equal(learned.expected.processCount < 10, true);
  assert.equal(learned.upperBound.durationMs < 60_000, true);
});

test('machine histories remain independent and per-profile retention is bounded', () => {
  const machineA = descriptor({ machineKey: 'machine-a' });
  const machineB = descriptor({ machineKey: 'machine-b' });
  for (let index = 0; index < 40; index += 1) {
    recordVerificationResourceSample(machineA, {
      status: 'succeeded', durationMs: 5_000 + index, cpuRatio: 0.2, memoryBytes: 128 * 1024 ** 2, processCount: 1, recordedAt: index + 1,
    });
  }
  for (let index = 0; index < 3; index += 1) {
    recordVerificationResourceSample(machineB, {
      status: 'succeeded', durationMs: 40_000, cpuRatio: 0.7, memoryBytes: 900 * 1024 ** 2, processCount: 5, recordedAt: 100 + index,
    });
  }

  const a = predictVerificationResourceCost(machineA);
  const b = predictVerificationResourceCost(machineB);
  assert.equal(a.sampleCount <= 24, true);
  assert.equal(a.expected.durationMs < b.expected.durationMs, true);
  assert.equal(getVerificationResourceProfileDiagnostics().profiles.length, 2);
});

test('prediction diagnostics compare predicted and actual demand', () => {
  const target = descriptor();
  const predicted = predictVerificationResourceCost(target);
  recordVerificationResourceSample(target, {
    status: 'succeeded',
    durationMs: predicted.expected.durationMs / 2,
    cpuRatio: predicted.expected.cpuRatio / 2,
    memoryBytes: predicted.expected.memoryBytes / 2,
    processCount: Math.max(1, Math.round(predicted.expected.processCount / 2)),
    predicted,
    recordedAt: 1,
  });

  const diagnostics = getVerificationResourceProfileDiagnostics();
  assert.equal(diagnostics.predictionComparisons, 1);
  assert.equal(diagnostics.meanAbsoluteRelativeError.duration > 0, true);
  assert.equal(diagnostics.meanAbsoluteRelativeError.cpu > 0, true);
  assert.equal(diagnostics.meanAbsoluteRelativeError.memory > 0, true);
});
