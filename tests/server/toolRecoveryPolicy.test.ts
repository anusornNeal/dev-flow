import test from 'node:test';
import assert from 'node:assert/strict';

async function loadPolicy() {
  try {
    return await import('../../src/server/services/toolRecoveryPolicy.js');
  } catch {
    return null;
  }
}

const taxonomyCases = [
  ['CONTEXT_STALE', 'automatic', 'refresh-context'],
  ['CACHE_STALE', 'automatic', 'refresh-context'],
  ['BATCH_BYTE_LIMIT', 'automatic', 'split-batch'],
  ['JOB_PENDING', 'automatic', 'wait-result'],
  ['SEARCH_BACKEND_UNAVAILABLE', 'automatic', 'fallback-search'],
  ['JOB_TIMED_OUT', 'automatic', 'narrow-scope-or-increase-timeout'],
  ['FILE_CHANGED_SINCE_READ', 'refresh-repreview', 'refresh-source-repreview'],
  ['CONTENT_CHANGED', 'refresh-repreview', 'refresh-source-repreview'],
  ['EDIT_REF_STALE', 'refresh-repreview', 'refresh-source-repreview'],
  ['EDIT_PLAN_STALE', 'refresh-repreview', 'refresh-source-repreview'],
  ['BASE_REVISION_CHANGED', 'refresh-repreview', 'refresh-base-repreview'],
  ['ANCHOR_MOVED', 'refresh-repreview', 'refresh-source-repreview'],
  ['AMBIGUOUS_MATCH', 'decision-required', 'request-decision'],
  ['PROJECT_AMBIGUOUS', 'decision-required', 'request-decision'],
  ['INTEGRATION_CONFLICT', 'decision-required', 'resolve-conflict'],
  ['UNSAFE_PATH', 'decision-required', 'stop-safety'],
  ['PATCH_PATH_DENIED', 'decision-required', 'stop-safety'],
  ['WORKSPACE_BASE_DIRTY', 'decision-required', 'inspect-dirty-tree'],
  ['WORKSPACE_SOURCE_DIRTY', 'decision-required', 'inspect-dirty-tree'],
  ['EDIT_PLAN_CONSUMED', 'decision-required', 'inspect-result'],
] as const;

test('recovery taxonomy maps targeted error classes to one deterministic category and strategy', async () => {
  const policy = await loadPolicy();
  assert.equal(typeof policy?.getToolRecoveryPolicy, 'function');
  for (const [code, category, strategy] of taxonomyCases) {
    const result = policy!.getToolRecoveryPolicy(code);
    assert.equal(result.code, code);
    assert.equal(result.category, category, code);
    assert.equal(result.strategy, strategy, code);
    assert.equal(result.retrySamePayload, false, code);
  }
});

test('decision-required and refresh-repreview policies can never auto-apply', async () => {
  const policy = await loadPolicy();
  for (const code of ['FILE_CHANGED_SINCE_READ', 'ANCHOR_MOVED', 'AMBIGUOUS_MATCH', 'INTEGRATION_CONFLICT', 'UNSAFE_PATH']) {
    const result = policy!.getToolRecoveryPolicy(code);
    assert.equal(result.autoApply, false, code);
  }
  assert.equal(policy!.getToolRecoveryPolicy('FILE_CHANGED_SINCE_READ').requiresFreshSource, true);
  assert.equal(policy!.getToolRecoveryPolicy('FILE_CHANGED_SINCE_READ').requiresFreshPreview, true);
});

test('unknown and validation failures terminate rather than guessing a recovery', async () => {
  const policy = await loadPolicy();
  for (const code of ['INVALID_ARGS', 'SEARCH_QUERY_INVALID', 'SOMETHING_NEW']) {
    const result = policy!.getToolRecoveryPolicy(code);
    assert.equal(result.category, 'terminal', code);
    assert.equal(result.strategy, 'stop', code);
    assert.equal(result.autoApply, false, code);
  }
});

test('failed job status without a structured code falls back to conservative terminal recovery', async () => {
  const policy = await loadPolicy();
  const failed = policy!.recoveryPolicyForJobStatus('failed');
  assert.equal(failed?.code, 'UNKNOWN_ERROR');
  assert.equal(failed?.category, 'terminal');
  assert.equal(failed?.strategy, 'stop');
  assert.equal(failed?.autoApply, false);

  const timedOut = policy!.recoveryPolicyForJobStatus('timed_out');
  assert.equal(timedOut?.code, 'JOB_TIMED_OUT');
  assert.equal(timedOut?.category, 'automatic');
  assert.equal(timedOut?.strategy, 'narrow-scope-or-increase-timeout');
});

test('recovery budget stops at max steps and detects same-payload strategy loops', async () => {
  const policy = await loadPolicy();
  assert.equal(typeof policy?.evaluateRecoveryAttempt, 'function');
  const first = policy!.evaluateRecoveryAttempt({
    code: 'BATCH_BYTE_LIMIT',
    payloadFingerprint: 'payload-a',
    history: [],
    maxSteps: 3,
  });
  assert.equal(first.decision, 'execute');
  assert.equal(first.strategy, 'split-batch');

  const loop = policy!.evaluateRecoveryAttempt({
    code: 'BATCH_BYTE_LIMIT',
    payloadFingerprint: 'payload-a',
    history: [{ code: 'BATCH_BYTE_LIMIT', strategy: 'split-batch', payloadFingerprint: 'payload-a' }],
    maxSteps: 3,
  });
  assert.equal(loop.decision, 'stop');
  assert.equal(loop.reason, 'loop-detected');

  const exhausted = policy!.evaluateRecoveryAttempt({
    code: 'CACHE_STALE',
    payloadFingerprint: 'payload-d',
    history: [
      { code: 'CACHE_STALE', strategy: 'refresh-context', payloadFingerprint: 'payload-a' },
      { code: 'BATCH_BYTE_LIMIT', strategy: 'split-batch', payloadFingerprint: 'payload-b' },
      { code: 'JOB_PENDING', strategy: 'wait-result', payloadFingerprint: 'payload-c' },
    ],
    maxSteps: 3,
  });
  assert.equal(exhausted.decision, 'stop');
  assert.equal(exhausted.reason, 'budget-exhausted');
});

test('refresh-repreview remains non-mutating even after source and preview refresh', async () => {
  const policy = await loadPolicy();
  const result = policy!.evaluateRecoveryAttempt({
    code: 'FILE_CHANGED_SINCE_READ',
    payloadFingerprint: 'payload-new',
    history: [],
    sourceRefreshed: true,
    previewRefreshed: true,
  });
  assert.equal(result.decision, 'stop');
  assert.equal(result.reason, 'fresh-preview-required-before-explicit-apply');
  assert.equal(result.autoApply, false);
});

test('API errors expose the same normalized recovery policy', async () => {
  const { createApiError, normalizeUnknownError } = await import('../../src/server/services/api.js');
  const stale = normalizeUnknownError(createApiError(409, 'FILE_CHANGED_SINCE_READ', 'changed')).error;
  assert.equal(stale.recovery?.category, 'refresh-repreview');
  assert.equal(stale.recovery?.strategy, 'refresh-source-repreview');
  assert.equal(stale.recovery?.autoApply, false);

  const safety = normalizeUnknownError(createApiError(403, 'UNSAFE_PATH', 'blocked')).error;
  assert.equal(safety.recovery?.category, 'decision-required');
  assert.equal(safety.recovery?.strategy, 'stop-safety');
  assert.equal(safety.recovery?.autoApply, false);
});
