import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createVerificationBatch } from '../../src/server/services/verificationBatchService.js';
import { evaluateLifecycleTaskSlo } from '../../src/server/services/performanceSloService.js';

const repoRoot = process.cwd();

type CoverageScenario = {
  id: string;
  file: string;
  requiredSnippets: string[];
};

const coverageManifest: CoverageScenario[] = [
  {
    id: 'normal-flow',
    file: 'tests/server/taskWorkspaceFinalizationService.test.ts',
    requiredSnippets: [
      "test('committed workspace finalizes into local develop and removes clean worktree/branch'",
    ],
  },
  {
    id: 'BSA-0126-stale-execution-reclaim',
    file: 'tests/server/taskClaimService.test.ts',
    requiredSnippets: [
      "test('released task preserves WIP workspace but rotates ownership epoch and execution identity'",
      "test('claim reconciles one pre-fix orphan execution and preserves dirty workspace bytes'",
      "test('claim blocks a pre-fix orphan with unresolved durable operation'",
    ],
  },
  {
    id: 'DVF-0634-sequential-verification',
    file: 'tests/server/mcpToolJobExecutionOwnership.test.ts',
    requiredSnippets: [
      "test('task-bound sequential MCP verification stays pending after the first check and becomes authoritative only after the final check'",
      "test('active verification supersession keeps old operation pending until old worker exits and never clears replacement'",
    ],
  },
  {
    id: 'durable-writer-restart-and-cancel',
    file: 'tests/server/mcpToolJobExecutionOwnership.test.ts',
    requiredSnippets: [
      "test('running refresh is idempotent and active cancellation stays pending until worker exit'",
      "test('success failure and timeout terminal states reconcile only their durable pending operation'",
    ],
  },
  {
    id: 'startup-authority-without-legacy-agent-marker',
    file: 'tests/server/bootstrap.test.ts',
    requiredSnippets: [
      "test('startup sanitation preserves authoritative lifecycle ownership and orchestration parents'",
    ],
  },
  {
    id: 'DVF-0637-finalization-response-loss',
    file: 'tests/server/taskWorkspaceFinalizationService.test.ts',
    requiredSnippets: [
      "test('durable finalization operation resumes the same identity across injected phase failures without duplicate completion effects'",
      "test('task presentation drift after integration does not revoke a frozen finalization operation'",
      "test('cleanup failure is resumable after task evidence and lifecycle are durable'",
      "test('finalization blocks pre-integration evidence when sibling changes escalate combined-state verification'",
    ],
  },
  {
    id: 'read-only-health-and-ambiguity',
    file: 'tests/server/workflowHealthService.test.ts',
    requiredSnippets: [
      "test('task health is read-only across repeated orphan diagnostics'",
      "workspace-ambiguous-health",
    ],
  },
  {
    id: 'audited-break-glass',
    file: 'tests/server/breakGlassLifecycleService.test.ts',
    requiredSnippets: [
      "test('emergency commit binds override to the exact owned fingerprint and preserves unrelated dirty files'",
      "test('finalize-as-integrated resumes normal finalization from exact Git evidence after task presentation drift'",
      "test('response loss after emergency commit resumes from the exact committed HEAD without a second commit'",
      "test('response loss after execution rotation reuses the replacement epoch instead of rotating twice'",
      "test('response loss after destructive cleanup resumes from pre-persisted discard evidence'",
    ],
  },
  {
    id: 'recovery-handoff-exact-continuation',
    file: 'tests/server/workflowRecoveryHandoff.test.ts',
    requiredSnippets: [
      "test('recovery handoff surfaces an unresolved audited break-glass operation as the exact continuation boundary'",
    ],
  },
  {
    id: 'legacy-agent-completion-consistency',
    file: 'scripts/verify-orchestration.ts',
    requiredSnippets: [
      '[verify] Testing failed completion leaves the card retryable...',
      "Object.prototype.hasOwnProperty.call(state._testTasks[0], 'claim')",
    ],
  },
];

function sourceFor(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('DVF-0642 final gate keeps every permanent lifecycle incident/recovery scenario executable', () => {
  for (const scenario of coverageManifest) {
    const source = sourceFor(scenario.file);
    for (const snippet of scenario.requiredSnippets) {
      assert.ok(
        source.includes(snippet),
        `${scenario.id} lost required executable coverage in ${scenario.file}: ${snippet}`,
      );
    }
  }
  assert.equal(new Set(coverageManifest.map((entry) => entry.id)).size, coverageManifest.length);
});

test('DVF-0634 replay: verification authority belongs to one exact frozen candidate and only a complete all-green batch', () => {
  const candidate = {
    candidateId: 'candidate-final-gate',
    repoRevision: 'deadbeef:owned-fingerprint',
    executionKey: 'execution-final-gate',
  };
  const batch = createVerificationBatch(candidate, ['focused', 'typecheck']);

  const afterFocused = batch.recordResult({ checkId: 'focused', status: 'passed', candidate });
  assert.equal(afterFocused.canComplete, false);
  assert.deepEqual(afterFocused.pending, ['typecheck']);
  assert.deepEqual(afterFocused.passed, ['focused']);

  const complete = batch.recordResult({ checkId: 'typecheck', status: 'passed', candidate });
  assert.equal(complete.canComplete, true);
  assert.deepEqual(complete.pending, []);
  assert.deepEqual(complete.failed, []);
  assert.deepEqual(complete.stale, []);

  const failed = createVerificationBatch(candidate, ['focused', 'typecheck']);
  failed.recordResult({ checkId: 'focused', status: 'passed', candidate });
  const failedSnapshot = failed.recordResult({ checkId: 'typecheck', status: 'failed', candidate });
  assert.equal(failedSnapshot.canComplete, false);
  assert.deepEqual(failedSnapshot.failed, ['typecheck']);

  const stale = createVerificationBatch(candidate, ['focused']);
  const staleSnapshot = stale.recordResult({ checkId: 'focused', status: 'stale', candidate });
  assert.equal(staleSnapshot.canComplete, false);
  assert.deepEqual(staleSnapshot.stale, ['focused']);

  assert.throws(
    () => createVerificationBatch(candidate, ['focused']).recordResult({
      checkId: 'focused',
      status: 'passed',
      candidate: { ...candidate, repoRevision: 'different-revision' },
    }),
    /does not match the frozen batch candidate/,
  );
});

test('lifecycle task SLOs are structural/count-based and never fail solely because one machine is slow', () => {
  const healthy = evaluateLifecycleTaskSlo({
    taskId: 'DVF-E2E-HEALTHY',
    outcome: 'succeeded',
    path: 'normal',
    phaseDurationsMs: {
      claimToFirstMutation: 120_000,
      mutationToVerificationComplete: 240_000,
      verificationToCommit: 180_000,
      commitToIntegration: 60_000,
      integrationToLogicalFinalize: 300_000,
      cleanup: 90_000,
    },
    ownershipRotationsAfterInitialClaim: 0,
    reclaims: 0,
    automaticReconciliations: 0,
    emergencyOperations: 0,
    finalizationAttempts: 1,
    finalizationRetries: 0,
    cleanupPendingCount: 0,
    authoritativeTerminalOutcomes: 1,
    currentAuthorityCount: 0,
    duplicateSideEffects: 0,
    unauthorizedWipLossCount: 0,
    unrecoverableSoftStateCount: 0,
    unresolvedWriterCount: 0,
    visibleWriterBlockerCount: 0,
  });
  assert.equal(healthy.status, 'within_slo');
  assert.deepEqual(healthy.violations, []);
  assert.equal(healthy.phaseDurationsMs.integrationToLogicalFinalize, 300_000);

  const regressed = evaluateLifecycleTaskSlo({
    ...healthy.metrics,
    taskId: 'DVF-E2E-REGRESSED',
    path: 'normal',
    ownershipRotationsAfterInitialClaim: 2,
    emergencyOperations: 1,
    authoritativeTerminalOutcomes: 2,
    currentAuthorityCount: 2,
    duplicateSideEffects: 1,
    unauthorizedWipLossCount: 1,
    unrecoverableSoftStateCount: 1,
    unresolvedWriterCount: 2,
    visibleWriterBlockerCount: 1,
  });
  assert.equal(regressed.status, 'regressed');
  const codes = new Set(regressed.violations.map((entry) => entry.code));
  for (const code of [
    'NORMAL_PATH_OWNERSHIP_CHURN',
    'NORMAL_PATH_EMERGENCY_USED',
    'TERMINAL_OUTCOME_NOT_EXACTLY_ONCE',
    'MULTIPLE_CURRENT_AUTHORITIES',
    'DUPLICATE_DURABLE_SIDE_EFFECT',
    'UNAUTHORIZED_WIP_LOSS',
    'UNRECOVERABLE_SOFT_STATE',
    'UNRESOLVED_WRITER_NOT_FULLY_BLOCKED',
  ]) assert.ok(codes.has(code), `missing structural lifecycle SLO violation ${code}`);
});
