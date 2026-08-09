import test from 'node:test';
import assert from 'node:assert/strict';

async function loadEngine() {
  try {
    return await import('../../src/server/services/toolRecoveryEngine.js');
  } catch {
    return null;
  }
}

function codedError(code: string, message = code) {
  return Object.assign(new Error(message), { code });
}

test('BATCH_BYTE_LIMIT splits bounded work without replaying the oversized payload', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine?.executeWithToolRecovery, 'function');
  const attempts: any[] = [];
  const result: any = await engine!.executeWithToolRecovery({
    initialPayload: { items: ['a', 'b', 'c', 'd'], secret: 'do-not-leak' },
    attempt: async (payload: any) => {
      attempts.push(payload.items.slice());
      if (payload.items.length > 2) throw codedError('BATCH_BYTE_LIMIT');
      return payload.items.join('');
    },
    adapters: {
      splitBatch: async (payload: any) => ({
        chunks: [
          { ...payload, items: payload.items.slice(0, 2) },
          { ...payload, items: payload.items.slice(2) },
        ],
        combine: (values: any[]) => values.join('|'),
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.value, 'ab|cd');
  assert.deepEqual(attempts, [['a', 'b', 'c', 'd'], ['a', 'b'], ['c', 'd']]);
  assert.equal(result.recovery.steps[0].strategy, 'split-batch');
  assert.equal(result.recovery.manualRecoveryCallsAvoided, 1);
  assert.equal(result.recovery.externalAgentCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak/);
});

test('CONTEXT_HANDLE_STALE refreshes context and retries with changed evidence only', async () => {
  const engine = await loadEngine();
  const attempts: string[] = [];
  const result: any = await engine!.executeWithToolRecovery({
    initialPayload: { contextHandle: 'ctx-old' },
    attempt: async (payload: any) => {
      attempts.push(payload.contextHandle);
      if (payload.contextHandle === 'ctx-old') throw codedError('CONTEXT_HANDLE_STALE');
      return { status: 'not_modified', contextHandle: payload.contextHandle };
    },
    adapters: {
      refreshContext: async () => ({ contextHandle: 'ctx-new' }),
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(attempts, ['ctx-old', 'ctx-new']);
  assert.equal(result.recovery.steps[0].strategy, 'refresh-context');
});

test('recovery adapter guard errors return structured decision-required output instead of throwing', async () => {
  const engine = await loadEngine();
  const result: any = await engine!.executeWithToolRecovery({
    initialPayload: { contextHandle: 'ctx-old', secret: 'must-not-leak' },
    attempt: async () => { throw codedError('CONTEXT_HANDLE_STALE'); },
    adapters: {
      refreshContext: async () => { throw codedError('UNSAFE_PATH', 'blocked private path'); },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSAFE_PATH');
  assert.equal(result.error.category, 'decision-required');
  assert.equal(result.recovery.outcome, 'decision-required');
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|blocked private path/);
});

test('JOB_PENDING resolves through one bounded wait without polling/retrying the original tool', async () => {
  const engine = await loadEngine();
  let attempts = 0;
  let waits = 0;
  const result: any = await engine!.executeWithToolRecovery({
    initialPayload: { jobId: 'job-1' },
    attempt: async () => {
      attempts += 1;
      throw codedError('JOB_PENDING');
    },
    adapters: {
      waitResult: async (_payload: any, _error: any, options: any) => {
        waits += 1;
        assert.ok(options.waitMs > 0 && options.waitMs <= 30_000);
        return { complete: true };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { complete: true });
  assert.equal(attempts, 1);
  assert.equal(waits, 1);
  assert.equal(result.recovery.steps[0].strategy, 'wait-result');
});

test('JOB_PENDING bounded wait stops cleanly when the existing job is still not ready', async () => {
  const engine = await loadEngine();
  let waits = 0;
  const result: any = await engine!.executeWithToolRecovery({
    initialPayload: { jobId: 'job-still-running' },
    attempt: async () => { throw codedError('JOB_PENDING'); },
    adapters: {
      waitResult: async () => {
        waits += 1;
        return { ready: false };
      },
    },
    waitMs: 100,
  });
  assert.equal(result.ok, false);
  assert.equal(result.recovery.outcome, 'wait-timeout');
  assert.equal(result.recovery.internalAttempts, 1);
  assert.equal(waits, 1);
});

test('validated search backend failure switches strategy, unrelated errors do not', async () => {
  const engine = await loadEngine();
  let fallbackCalls = 0;
  const recovered: any = await engine!.executeWithToolRecovery({
    initialPayload: { backend: 'ripgrep', query: 'foo' },
    attempt: async (payload: any) => {
      if (payload.backend === 'ripgrep') throw codedError('RIPGREP_UNAVAILABLE');
      return ['fallback-result'];
    },
    adapters: {
      fallbackSearch: async (payload: any) => {
        fallbackCalls += 1;
        return { ...payload, backend: 'bundled' };
      },
    },
  });
  assert.equal(recovered.ok, true);
  assert.equal(fallbackCalls, 1);
  assert.equal(recovered.recovery.steps[0].strategy, 'fallback-search');

  const blocked: any = await engine!.executeWithToolRecovery({
    initialPayload: { backend: 'ripgrep', query: 'foo' },
    attempt: async () => { throw codedError('AMBIGUOUS_MATCH'); },
    adapters: {
      fallbackSearch: async (payload: any) => {
        fallbackCalls += 1;
        return { ...payload, backend: 'bundled' };
      },
    },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.recovery.outcome, 'decision-required');
  assert.equal(fallbackCalls, 1);
});

test('FILE_CHANGED and ANCHOR_MOVED re-preview changed source but never auto-apply', async () => {
  const engine = await loadEngine();
  for (const code of ['FILE_CHANGED_SINCE_READ', 'ANCHOR_MOVED']) {
    let attempts = 0;
    let previewCalls = 0;
    const result: any = await engine!.executeWithToolRecovery({
      initialPayload: { editPlanId: 'plan-old' },
      attempt: async () => {
        attempts += 1;
        throw codedError(code);
      },
      adapters: {
        refreshPreview: async () => {
          previewCalls += 1;
          return { editPlanId: 'plan-fresh', preview: `fresh-preview-${code}`, materiallyChanged: true };
        },
      },
    });
    assert.equal(result.ok, false, code);
    assert.equal(result.recovery.outcome, 'preview-ready', code);
    assert.equal(result.recovery.requiresExplicitApply, true, code);
    assert.equal(result.recovery.preview.preview, `fresh-preview-${code}`, code);
    assert.equal(attempts, 1, code);
    assert.equal(previewCalls, 1, code);
  }
});

test('same strategy+payload loop and recovery budget terminate deterministically', async () => {
  const engine = await loadEngine();
  const loop: any = await engine!.executeWithToolRecovery({
    initialPayload: { contextHandle: 'same' },
    attempt: async () => { throw codedError('CONTEXT_HANDLE_STALE'); },
    adapters: { refreshContext: async (payload: any) => payload },
    maxSteps: 3,
  });
  assert.equal(loop.ok, false);
  assert.equal(loop.recovery.outcome, 'loop-detected');
  assert.ok(loop.recovery.steps.length <= 2);

  let generation = 0;
  const exhausted: any = await engine!.executeWithToolRecovery({
    initialPayload: { contextHandle: 'ctx-0' },
    attempt: async () => { throw codedError('CONTEXT_HANDLE_STALE'); },
    adapters: { refreshContext: async () => ({ contextHandle: `ctx-${++generation}` }) },
    maxSteps: 2,
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.recovery.outcome, 'budget-exhausted');
  assert.equal(exhausted.recovery.steps.length, 2);
});

test('engine reports compact automatic-recovery call reduction evidence', async () => {
  const engine = await loadEngine();
  const result: any = await engine!.executeWithToolRecovery({
    initialPayload: { contextHandle: 'old', prompt: 'must-not-appear' },
    attempt: async (payload: any) => {
      if (payload.contextHandle === 'old') throw codedError('CONTEXT_HANDLE_STALE');
      return 'ok';
    },
    adapters: { refreshContext: async () => ({ contextHandle: 'new', prompt: 'must-not-appear' }) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recovery.externalAgentCalls, 0);
  assert.equal(result.recovery.internalAttempts, 2);
  assert.equal(result.recovery.manualRecoveryCallsAvoided, 1);
  assert.doesNotMatch(JSON.stringify(result.recovery), /must-not-appear|prompt|contextHandle/);
});
