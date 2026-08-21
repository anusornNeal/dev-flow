import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleGuardrailAssessment } from '../../src/server/services/lifecycleGuardrailModel.js';import { isLifecycleOperationAllowed } from '../../src/server/services/lifecycleGuardrailModel.js';

test('canonical guardrail assessment keeps safety, debt, warnings, and reconciliation separate', () => {
  const assessment = createLifecycleGuardrailAssessment({
    hardBlockers: [
      { code: 'FOREIGN_OWNERSHIP', category: 'ownership', message: 'Foreign ownership cannot be mutated.' },
      { code: 'FOREIGN_OWNERSHIP', category: 'ownership', message: 'Duplicate should collapse.' },
    ],
    debts: [
      { code: 'VERIFICATION_FAILED', category: 'verification', message: 'Focused verification failed.', details: { status: 'failed' } },
      { code: 'VERIFICATION_FAILED', category: 'verification', message: 'Duplicate debt should collapse.' },
    ],
    warnings: [
      { code: 'LIFECYCLE_STAGE_STALE', category: 'metadata', message: 'Lifecycle stage is stale.' },
    ],
    reconciliations: [
      { code: 'DIRECT_STAGE_RECONCILIATION', message: 'Observed Git state reconciled lifecycle metadata.', from: 'created', to: 'committed' },
    ],
  });

  assert.equal(assessment.allowed, false);
  assert.deepEqual(assessment.hardBlockers.map((entry) => entry.code), ['FOREIGN_OWNERSHIP']);
  assert.deepEqual(assessment.debts.map((entry) => entry.code), ['VERIFICATION_FAILED']);
  assert.deepEqual(assessment.warnings.map((entry) => entry.code), ['LIFECYCLE_STAGE_STALE']);
  assert.deepEqual(assessment.reconciliations.map((entry) => entry.code), ['DIRECT_STAGE_RECONCILIATION']);
  assert.deepEqual(assessment.debts[0].details, { status: 'failed' });
});

test('quality debt never changes mechanical allowed state without a hard blocker', () => {test('hard blockers can be scoped to the unsafe operation instead of becoming global lifecycle gates', () => {
  const assessment = createLifecycleGuardrailAssessment({
    hardBlockers: [
      { code: 'COMMIT_FOREIGN_CHANGE', category: 'ownership', message: 'Commit scope contains foreign changes.', appliesTo: ['commit'] },
    ],
  });

  assert.equal(isLifecycleOperationAllowed(assessment, 'commit'), false);
  assert.equal(isLifecycleOperationAllowed(assessment, 'review'), true);
});


  const assessment = createLifecycleGuardrailAssessment({
    debts: [
      { code: 'VERIFICATION_NOT_RUN', category: 'verification', message: 'Verification was not run.' },
      { code: 'CHECKLIST_INCOMPLETE', category: 'checklist', message: 'Checklist is incomplete.' },
    ],
  });

  assert.equal(assessment.allowed, true);
  assert.equal(assessment.hardBlockers.length, 0);
  assert.equal(assessment.debts.length, 2);
});
