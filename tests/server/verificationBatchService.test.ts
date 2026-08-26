import test from 'node:test';
import assert from 'node:assert/strict';

const batchModule = await import('../../src/server/services/verificationBatchService.js');
const { createVerificationBatch, MAX_VERIFICATION_BATCH_CHECKS } = batchModule;

const CANDIDATE = {
  candidateId: 'vc_aaaaaaaaaaaaaaaaaaaaaaaa',
  repoRevision: 'abc123:tree-a',
  executionKey: 'exec-key-a',
};

function resultFor(checkId: string, status: 'passed' | 'failed' | 'stale' | 'blocked', overrides: Partial<typeof CANDIDATE> = {}) {
  return {
    checkId,
    status,
    candidate: { ...CANDIDATE, ...overrides },
  };
}

test('freezes candidate identity and tracks required checks as a bounded set', () => {
  const sourceIdentity = { ...CANDIDATE };
  const batch = createVerificationBatch(sourceIdentity);
  sourceIdentity.repoRevision = 'mutated-after-create';

  batch.registerRequiredCheck('typecheck');
  batch.registerRequiredCheck('typecheck');
  batch.registerRequiredCheck('unit');

  const snapshot = batch.snapshot();
  assert.deepEqual(snapshot.candidate, CANDIDATE);
  assert.deepEqual(snapshot.requiredChecks, ['typecheck', 'unit']);
  assert.deepEqual(snapshot.pending, ['typecheck', 'unit']);
  assert.equal(snapshot.canComplete, false);
  assert.throws(() => {
    (snapshot.candidate as any).executionKey = 'mutated';
  }, TypeError);

  const bounded = createVerificationBatch(CANDIDATE);
  for (let index = 0; index < MAX_VERIFICATION_BATCH_CHECKS; index += 1) {
    bounded.registerRequiredCheck(`check-${index}`);
  }
  assert.throws(() => bounded.registerRequiredCheck('one-too-many'), /too many|required/i);
});

test('completes only when every required check passes for the frozen candidate', () => {
  const batch = createVerificationBatch(CANDIDATE, ['typecheck', 'unit', 'integration']);

  assert.deepEqual(batch.snapshot().pending, ['typecheck', 'unit', 'integration']);
  batch.recordResult(resultFor('typecheck', 'passed'));
  let snapshot = batch.snapshot();
  assert.deepEqual(snapshot.passed, ['typecheck']);
  assert.deepEqual(snapshot.pending, ['unit', 'integration']);
  assert.equal(snapshot.canComplete, false);

  batch.recordResult(resultFor('unit', 'passed'));
  batch.recordResult(resultFor('integration', 'passed'));
  snapshot = batch.snapshot();
  assert.deepEqual(snapshot.pending, []);
  assert.deepEqual(snapshot.passed, ['typecheck', 'unit', 'integration']);
  assert.deepEqual(snapshot.failed, []);
  assert.deepEqual(snapshot.stale, []);
  assert.equal(snapshot.canComplete, true);
});

test('failed, stale, or blocked terminal results block completion', () => {
  const failed = createVerificationBatch(CANDIDATE, ['unit', 'integration']);
  failed.recordResult(resultFor('unit', 'passed'));
  failed.recordResult(resultFor('integration', 'failed'));
  assert.deepEqual(failed.snapshot().failed, ['integration']);
  assert.equal(failed.snapshot().canComplete, false);

  const stale = createVerificationBatch(CANDIDATE, ['unit']);
  stale.recordResult(resultFor('unit', 'stale'));
  assert.deepEqual(stale.snapshot().stale, ['unit']);
  assert.equal(stale.snapshot().canComplete, false);

  const blocked = createVerificationBatch(CANDIDATE, ['unit', 'integration']);
  blocked.recordResult(resultFor('unit', 'blocked'));
  blocked.recordResult(resultFor('integration', 'passed'));
  assert.deepEqual(blocked.snapshot().blocked, ['unit']);
  assert.deepEqual(blocked.snapshot().passed, ['integration']);
  assert.deepEqual(blocked.snapshot().pending, []);
  assert.equal(blocked.snapshot().canComplete, false);
});

test('rejects cross-candidate, cross-revision, and cross-execution evidence', () => {
  const batch = createVerificationBatch(CANDIDATE, ['unit']);

  assert.throws(
    () => batch.recordResult(resultFor('unit', 'passed', { candidateId: 'vc_bbbbbbbbbbbbbbbbbbbbbbbb' })),
    /candidate/i,
  );
  assert.throws(
    () => batch.recordResult(resultFor('unit', 'passed', { repoRevision: 'other-revision' })),
    /candidate|revision/i,
  );
  assert.throws(
    () => batch.recordResult(resultFor('unit', 'passed', { executionKey: 'other-execution' })),
    /candidate|execution/i,
  );

  assert.deepEqual(batch.snapshot().pending, ['unit']);
  assert.equal(batch.snapshot().canComplete, false);
});

test('accepts results only for registered checks and only once per terminal check', () => {
  const batch = createVerificationBatch(CANDIDATE, ['unit']);
  assert.throws(() => batch.recordResult(resultFor('unknown', 'passed')), /required|registered/i);

  batch.recordResult(resultFor('unit', 'passed'));
  assert.throws(() => batch.recordResult(resultFor('unit', 'failed')), /already.*terminal|already.*result/i);
  assert.equal(batch.snapshot().canComplete, true);
});
