// DVF-0685 regression coverage for frozen reusable verification identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildVerificationCoverageIdentity, createVerificationBatch } from '../../src/server/services/verificationBatchService.js';
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
      "test('verification batch replacement waits for live durable members and late old results stay non-authoritative'",
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
      "test('finalization records combined-state verification escalation as debt without blocking safe completion'",
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
      "test('workflow-only commit, release, and rotate actions are rejected before emergency audit creation'",
      "test('finalize-as-integrated resumes normal finalization from exact Git evidence after task presentation drift'",
      "test('integrated emergency recovery delegates verification debt to normal finalization without workflow bypass'",
      "test('supersede-execution requires explicit replacement identity and preserves historical audit evidence'",
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
    id: 'DVF-0717-runtime-restart-authority-and-source-equivalence',
    file: 'tests/server/runtimeIdentityDiagnostics.test.ts',
    requiredSnippets: [
      "test('clean commit mismatch with the same Git tree is content-equivalent and requires no restart'",
      "test('restart safety ignores safe-orphan changedFiles, but blocks live durable and live ownership authority'",
      "MULTIPLE_ACTIVE_EXECUTIONS",
      "LIVE_DURABLE_OPERATION",
      "LIVE_AUTHORITATIVE_WORK",
    ],
  },
  // Permanent gate: bounded migration and the long-lived soak must stay executable together.
  {
    id: 'DVF-0720-zero-orphan-migration-soak',
    file: 'tests/server/emergencyOrphanCleanupService.test.ts',
    requiredSnippets: [
      "test('canonical cleanup preserves claimless dirty managed workspace WIP'",
      "test('bounded migration scans past skipped rows so later safe orphans can converge'",
      "test('long-lived deterministic cleanup soak converges 200 cycles without safe-orphan accumulation'",
      "test('apply is transactional: injected failure rolls back cancellation and audit evidence'",
    ],
  },
  {
    id: 'DVF-0719-recovery-tool-surface-parity',
    file: 'tests/server/devflowContractModules.test.ts',
    requiredSnippets: [
      "test('closure-critical recovery capabilities are callable end-to-end in the coding profile'",
      "test('capability catalog reports closure recovery readiness from the active advertised tool surface'",
    ],
  },
  {
    id: 'DVF-0722-truncation-only-health-debt',
    file: 'tests/server/workflowHealthService.test.ts',
    requiredSnippets: [
      "test('project-scoped health treats truncation-only idle aggregate as debt instead of a hard blocker'",
    ],
  },
  {
    id: 'DVF-0719-recovery-capability-health-drift',
    file: 'tests/server/workflowHealthService.test.ts',
    requiredSnippets: [
      "test('workflow health reports closure recovery capability drift from the active advertised surface'",
    ],
  },
  {
    id: 'DVF-0660-cleanup-authority-and-race',
    file: 'tests/server/sessionWorkspaceService.test.ts',
    requiredSnippets: [
      "test('normal cleanup rejects an active durable claim even after in-memory workspace refs are reset'",
      "test('normal cleanup rejects active execution ownership without a task claim'",
      "test('unresolved durable operation blocks cleanup even after its execution is no longer active'",
      "test('cleanup rechecks lifecycle authority immediately before deletion and fails closed on an interleaved claim'",
    ],
  },
  {
    id: 'DVF-0660-patch-equivalent-live-authority',
    file: 'tests/server/workspaceRecoveryService.test.ts',
    requiredSnippets: [
      "test('inspection recognizes clean recreated patch as patch-equivalent'",
      "test('finalize superseded workspace refuses patch-equivalent cleanup while a live execution still owns the workspace'",
    ],
  },
  {
    id: 'DVF-0661-task-deletion-actionable-wip',
    file: 'tests/server/taskLifecycleDispositionRoutes.test.ts',
    requiredSnippets: [
      "test('recursive delete fails closed before deleting any task when one descendant still owns lifecycle state'",
      "test('claimless exact dirty workspace blocks task deletion and preserves task plus workspace bytes'",
      "test('claimless exact workspace with unique commit blocks task deletion'",
    ],
  },
  {
    id: 'DVF-0661-project-deletion-atomic-guard',
    file: 'tests/server/projectLifecycleDeletionRoutes.test.ts',
    requiredSnippets: [
      "test('project deletion rejects active claim/execution without removing project or tasks'",
      "test('project deletion rejects a durable pending operation even after claim and execution authority drift'",
      "test('project deletion rejects claimless actionable workspace and preserves workspace bytes'",
      "test('project deletion rejects historical execution/workspace whose task row is already missing'",
    ],
  },
  {
    id: 'DVF-0662-health-missing-workspace-authority',
    file: 'tests/server/workflowHealthService.test.ts',
    requiredSnippets: [
      "test('task-scoped health fails closed when matching claim and execution point at missing workspace metadata'",
      "test('task-scoped health distinguishes metadata-present workspace root or Git identity failure'",
      "test('workspace-scoped health fails closed for a missing workspace id'",
    ],
  },
  {
    id: 'DVF-0663-stale-registry-recovery-ordering',
    file: 'tests/server/workflowRecoveryHandoff.test.ts',
    requiredSnippets: [
      "test('stale workspace authority outranks old succeeded and unrelated running jobs'",
    ],
  },
  {
    id: 'DVF-0664-detached-integrated-convergence',
    file: 'tests/server/breakGlassLifecycleService.test.ts',
    requiredSnippets: [
      "test('detached integrated recovery terminalizes exact already-integrated work without recreating or cleaning the lost workspace'",
      "test('detached integrated recovery blocks integrated changes outside authoritative task-owned scope'",
      "test('detached integrated recovery creates infrastructure verification debt, settles it with revision-bound GREEN, and finalizes once'",
      "test('detached integrated recovery blocks unresolved durable operations before lifecycle convergence'",
      "test('detached integrated recovery resumes after response loss without duplicate finalization effects'",
    ],
  },
  {
    id: 'DVF-0665-infra-blocked-composite-verification',
    file: 'tests/server/mcpToolJobRunnerRegistry.test.ts',
    requiredSnippets: [
      "test('direct run_project_command retries proven infrastructure failure through a recovery capacity lease'",
      "test('apply_and_verify async runner treats verification-infra-blocked as recoverable debt instead of mutation authority'",
    ],
  },
  {
    id: 'DVF-0666-process-tree-and-timeout',
    file: 'tests/server/projectCommandService.test.ts',
    requiredSnippets: [
      "test('Windows command termination uses the exact process-tree terminator before root-signal fallback'",
      "test('runProjectCommand returns timed_out status when the process exceeds timeout'",
      "test('long async project commands take bounded live process samples without requiring them for success'",
    ],
  },
  {
    id: 'DVF-0666-partial-resource-accounting',
    file: 'tests/server/verificationResourceProfileService.test.ts',
    requiredSnippets: [
      "test('partial process-tree memory stays auditable but cannot teach a falsely tiny admission memory profile'",
      "test('failed and timed-out samples remain visible without corrupting learned successful cost'",
    ],
  },
  {
    id: 'DVF-0668-runtime-source-freshness',
    file: 'tests/server/runtimeIdentityDiagnostics.test.ts',
    requiredSnippets: [
      "test('dirty runtime source is ambiguous and does not claim a deployed revision'",
      "test('restart safety ignores safe-orphan changedFiles, but blocks live durable and live ownership authority'",
    ],
  },
  {
    id: 'DVF-0668-runtime-source-health-surface',
    file: 'tests/server/workflowHealthService.test.ts',
    requiredSnippets: [
      "test('workflow health surfaces stale loaded source even while runtime supervisor is otherwise healthy'",
    ],
  },
  {
    id: 'DVF-0650-late-page-health',
    file: 'tests/server/workflowHealthService.test.ts',
    requiredSnippets: [
      "test('project-scoped health resolves late claimed executions while surfacing missing workspace authority'",
      "test('project-scoped health keeps real orphan drift without fabricating a late-page claim mismatch'",
    ],
  },
  {
    id: 'DVF-0649-safe-orphan-cleanup',
    file: 'tests/server/emergencyOrphanCleanupService.test.ts',
    requiredSnippets: [
      "test('dry-run classifies safe and fail-closed orphan cases without mutation'",
      "test('apply cancels only safe orphan executions, preserves task state, and records deterministic audit evidence'",
      "test('same apply operation id replays its frozen result and never sweeps the next bounded batch'",
      "test('apply is transactional: injected failure rolls back cancellation and audit evidence'",
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

const requiredConvergenceScenarioIds = [
  'DVF-0660-cleanup-authority-and-race',
  'DVF-0660-patch-equivalent-live-authority',
  'DVF-0661-task-deletion-actionable-wip',
  'DVF-0661-project-deletion-atomic-guard',
  'DVF-0662-health-missing-workspace-authority',
  'DVF-0663-stale-registry-recovery-ordering',
  'DVF-0664-detached-integrated-convergence',
  'DVF-0665-infra-blocked-composite-verification',
  'DVF-0666-process-tree-and-timeout',
  'DVF-0666-partial-resource-accounting',
  'DVF-0668-runtime-source-freshness',
  'DVF-0650-late-page-health',
  'DVF-0649-safe-orphan-cleanup',
] as const;

test('DVF-0667 convergence gate requires every newly audited lifecycle producer and recovery class', () => {
  const manifestIds = new Set(coverageManifest.map((entry) => entry.id));
  for (const scenarioId of requiredConvergenceScenarioIds) {
    assert.ok(manifestIds.has(scenarioId), `missing required convergence scenario ${scenarioId}`);
  }
});

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

test('verification batch preserves reusable coverage identity on its frozen candidate', () => {
  const coverage = buildVerificationCoverageIdentity({
    command: 'test-focused',
    semanticKey: 'semantic:test-focused',
    affectedInputFingerprint: 'scoped:owned',
    affectedInputPaths: ['src/owned.ts'],
    dependencyFingerprint: 'dependency',
    environmentFingerprint: 'environment',
  });
  assert.ok(coverage);
  const batch = createVerificationBatch({
    candidateId: 'coverage-candidate',
    repoRevision: 'repo:coverage',
    executionKey: 'execution:coverage',
    coverage: coverage!,
  }, ['focused']);

  assert.equal(batch.snapshot().candidate.coverage?.key, coverage!.key);
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
