import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-execution-session-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 1;\n', 'utf8');
fs.writeFileSync(path.join(repoRoot, 'src', 'B.ts'), 'export const B = 1;\n', 'utf8');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const sessions = await import('../../src/server/services/executionSessionService.js');
const reconciliation = await import('../../src/server/services/executionLifecycleReconciliationService.js');
const repository = await import('../../src/server/repositories/executionSessionRepository.js');
const serverEvents = await import('../../src/server/services/serverEventService.js') as any;

test('persists logical execution-session identity without storing the local repo path', () => {
  const created = sessions.createExecutionSession({
    projectId: 'project-session',
    taskId: 'task-session',
    workspaceId: 'ws_opaque-session-1',
    branch: 'feature/session',
    repoRoot,
  });

  assert.match(created.id, /^exec-/);
  assert.equal(created.status, 'active');
  assert.equal(created.workspaceId, 'ws_opaque-session-1');
  assert.ok(created.repoRevision);
  assert.ok(created.baseRevision);
  assert.equal('repoRoot' in created, false);
  assert.equal(JSON.stringify(created).includes(repoRoot), false);

  const reloaded = repository.getExecutionSessionById(created.id);
  assert.equal(reloaded?.id, created.id);
  assert.equal(reloaded?.workspaceId, 'ws_opaque-session-1');
  assert.equal(JSON.stringify(reloaded).includes(repoRoot), false);
});

test('ownership epoch evidence is durable, idempotent, and cannot be rebound to another epoch', () => {
  const created = sessions.createExecutionSession({
    projectId: 'project-session',
    taskId: 'task-epoch',
    workspaceId: 'ws_epoch',
    repoRoot,
    ownershipEpochId: 'claim-epoch-11111111-1111-4111-8111-111111111111',
  });

  const first = sessions.getExecutionSessionOwnershipEpoch(created.id);
  assert.equal(first.ownershipEpochId, 'claim-epoch-11111111-1111-4111-8111-111111111111');
  assert.equal(first.evidence?.kind, 'ownership-epoch');
  assert.equal(first.evidence?.revisionIdentity, first.ownershipEpochId);
  const retry = sessions.bindExecutionSessionOwnershipEpoch(created.id, first.ownershipEpochId!);
  assert.equal(retry.ownershipEpochId, first.ownershipEpochId);
  assert.equal(repository.listExecutionSessionEvidence(created.id).filter((entry) => entry.kind === 'ownership-epoch').length, 1);

  assert.throws(
    () => sessions.bindExecutionSessionOwnershipEpoch(created.id, 'claim-epoch-22222222-2222-4222-8222-222222222222'),
    (error: any) => error?.code === 'EXECUTION_OWNERSHIP_EPOCH_CONFLICT',
  );
  sessions.cancelExecutionSession(created.id);
  assert.equal(sessions.getExecutionSessionOwnershipEpoch(created.id).ownershipEpochId, first.ownershipEpochId);
});

test('survives a fresh Node process and resolves the same logical session from SQLite', () => {
  const created = sessions.createExecutionSession({
    projectId: 'project-session',
    taskId: 'task-restart',
    workspaceId: 'ws_restart',
    repoRoot,
  });
  sessions.updateExecutionSessionProgress(created.id, {
    contextHandle: 'ctx-restart',
    changedFiles: ['src/B.ts'],
    verification: [{ name: 'restart-fixture', status: 'passed' }],
  });

  const script = `
    const repo = await import('./src/server/repositories/executionSessionRepository.js');
    const session = repo.getExecutionSessionById(${JSON.stringify(created.id)});
    process.stdout.write(JSON.stringify(session));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, DEVFLOW_DB_PATH: process.env.DEVFLOW_DB_PATH! },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const reloaded = JSON.parse(child.stdout);
  assert.equal(reloaded.id, created.id);
  assert.equal(reloaded.workspaceId, 'ws_restart');
  assert.equal(reloaded.contextHandle, 'ctx-restart');
  assert.equal(reloaded.lifecycle.stage, 'created');
  assert.deepEqual(reloaded.changedFiles, ['src/B.ts']);
  assert.equal(JSON.stringify(reloaded).includes(repoRoot), false);
});

test('rejects raw filesystem paths as workspace identity', () => {
  assert.throws(() => sessions.createExecutionSession({
    projectId: 'project-session',
    workspaceId: 'C:\\Users\\someone\\repo',
    repoRoot,
  }), /workspace identity/i);
});

test('resume selectively invalidates changed file evidence while reusing unchanged evidence', () => {
  const created = sessions.createExecutionSession({
    projectId: 'project-session',
    taskId: 'task-evidence',
    workspaceId: 'ws_evidence',
    branch: 'feature/evidence',
    repoRoot,
  });
  sessions.recordExecutionSessionEvidence(created.id, [
    { kind: 'file', path: 'src/A.ts' },
    { kind: 'file', path: 'src/B.ts' },
  ], { repoRoot });

  const before = repository.listExecutionSessionEvidence(created.id).filter((entry) => entry.kind === 'file');
  assert.equal(before.length, 2);
  assert.ok(before.every((entry) => entry.stale === false));
  const beforeB = before.find((entry) => entry.path === 'src/B.ts');

  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  const resumed = sessions.resumeExecutionSession(created.id, { repoRoot, workspaceId: 'ws_evidence' });

  assert.equal(resumed.resumable, true);
  assert.equal(resumed.staleEvidence.length, 1);
  assert.equal(resumed.staleEvidence[0].path, 'src/A.ts');
  const reusableFiles = resumed.reusableEvidence.filter((entry) => entry.kind === 'file');
  assert.equal(reusableFiles.length, 1);
  assert.equal(reusableFiles[0].path, 'src/B.ts');
  assert.equal(reusableFiles[0].revisionIdentity, beforeB?.revisionIdentity);

  const after = repository.listExecutionSessionEvidence(created.id);
  assert.equal(after.find((entry) => entry.path === 'src/A.ts')?.stale, true);
  assert.equal(after.find((entry) => entry.path === 'src/B.ts')?.stale, false);
});

test('records changed files, verification state, and context handle for active sessions', () => {
  const created = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_progress', repoRoot });
  const updated = sessions.updateExecutionSessionProgress(created.id, {
    contextHandle: 'ctx-123',
    changedFiles: ['src/A.ts'],
    verification: [{ name: 'focused', status: 'passed' }],
  });

  assert.equal(updated.contextHandle, 'ctx-123');
  assert.deepEqual(updated.changedFiles, ['src/A.ts']);
  assert.deepEqual(updated.verification, [{ name: 'focused', status: 'passed' }]);
});

test('tracks observable lifecycle stages independently from terminal session status', () => {
  const created = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_lifecycle', repoRoot });
  assert.equal(created.status, 'active');
  assert.equal(created.lifecycle.stage, 'created');
  assert.equal(created.lifecycle.legacyCompatibility, false);

  const advance = (toStage: any, id: string, kind: string, reasonCode: string) => sessions.recordExecutionLifecycleTransition(created.id, {
    toStage,
    reasonCode,
    evidence: { id, kind, status: 'completed', operationId: `op-${id}` },
  });
  advance('context-ready', 'context-1', 'context-bundle', 'context-ready');
  advance('plan-recorded', 'plan-1', 'plan-evidence', 'plan-recorded');
  advance('implementing', 'mutation-1', 'owned-change', 'mutation-applied');
  advance('verifying', 'verify-1', 'verification-candidate', 'verification-started');
  advance('repairing', 'repair-1', 'verification-result', 'verification-failed');
  advance('verifying', 'verify-2', 'verification-candidate', 'verification-retry');
  advance('committed', 'commit-1', 'git-commit', 'commit-created');
  advance('finalized', 'finalize-1', 'workspace-finalization', 'workspace-finalized');

  const active = repository.getExecutionSessionById(created.id)!;
  assert.equal(active.status, 'active');
  assert.equal(active.lifecycle.stage, 'finalized');
  assert.equal(active.lifecycle.lastTransition?.reasonCode, 'workspace-finalized');
  assert.equal(active.lifecycle.lastTransition?.sequence, 9);
  sessions.completeExecutionSession(created.id);
  assert.equal(repository.getExecutionSessionById(created.id)?.status, 'completed');
  assert.equal(repository.getExecutionSessionById(created.id)?.lifecycle.stage, 'finalized');
});

test('publishes compact execution invalidations for lifecycle, checkpoint, and terminal changes', () => {
  serverEvents.__resetServerEventsForTests();
  const received: any[] = [];
  const subscription = serverEvents.subscribeServerEvents((event: any) => received.push(event));
  const created = sessions.createExecutionSession({ projectId: 'project-events', workspaceId: 'ws_events', repoRoot });

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    ...received[0],
    type: 'execution.changed',
    projectId: 'project-events',
    entityId: created.id,
    status: 'created',
    reason: 'session-created',
  });

  const transition = {
    toStage: 'context-ready' as const,
    reasonCode: 'context-ready',
    evidence: { id: 'context-event-1', kind: 'context-bundle', status: 'completed' as const, operationId: 'op-context-event-1' },
  };
  sessions.recordExecutionLifecycleTransition(created.id, transition);
  const afterTransition = received.at(-1);
  assert.equal(afterTransition.type, 'execution.changed');
  assert.equal(afterTransition.status, 'context-ready');
  assert.equal(afterTransition.reason, 'context-ready');
  const eventCountAfterTransition = received.length;
  sessions.recordExecutionLifecycleTransition(created.id, transition);
  assert.equal(received.length, eventCountAfterTransition, 'idempotent lifecycle retries must not publish duplicate invalidations');

  assert.throws(() => sessions.recordExecutionLifecycleTransition(created.id, {
    toStage: 'implementing',
    reasonCode: 'mutation-pending',
    evidence: { id: 'mutation-event-1', kind: 'owned-change', status: 'accepted', operationId: 'op-mutation-event-1' },
  }), (error: any) => error?.code === 'EXECUTION_LIFECYCLE_EVIDENCE_NOT_TERMINAL');
  const pending = received.at(-1);
  assert.equal(pending.type, 'execution.changed');
  assert.equal(pending.status, 'context-ready');
  assert.equal(pending.reason, 'pending-operation-accepted');

  sessions.cancelExecutionSession(created.id);
  const terminal = received.at(-1);
  assert.equal(terminal.type, 'execution.changed');
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.reason, 'session-cancelled');
  assert.equal(JSON.stringify(received).includes(repoRoot), false);
  assert.equal(JSON.stringify(received).includes('ws_events'), false);
  subscription.unsubscribe();
});

test('direct lifecycle reconciliation records observed state without synthetic intermediate transitions', () => {
  const created = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_lifecycle_direct', repoRoot });
  const transitionsBefore = repository.listExecutionSessionEvidence(created.id).filter((entry) => entry.kind === 'lifecycle-transition').length;
  const input = {
    toStage: 'committed' as const,
    reasonCode: 'git-commit-observed',
    evidence: { id: 'direct-commit-1', kind: 'git-commit', status: 'completed' as const, operationId: 'op-direct-commit-1' },
  };
  const first = reconciliation.reconcileExecutionLifecycleStage(created.id, input);
  const retry = reconciliation.reconcileExecutionLifecycleStage(created.id, input);

  assert.equal(first.changed, true);
  assert.equal(first.idempotent, false);
  assert.equal(retry.changed, false);
  assert.equal(retry.idempotent, true);
  assert.equal(repository.getExecutionSessionById(created.id)?.lifecycle.stage, 'committed');
  const transitions = repository.listExecutionSessionEvidence(created.id).filter((entry) => entry.kind === 'lifecycle-transition');
  assert.equal(transitions.length, transitionsBefore + 1);
  const direct = transitions.find((entry) => entry.metadata?.directReconciliation === true);
  assert.ok(direct);
  assert.equal(direct.metadata?.fromStage, 'created');
  assert.equal(direct.metadata?.toStage, 'committed');
  assert.equal(direct.metadata?.skippedStageValidation, true);
  assert.equal(transitions.some((entry) => ['context-ready', 'implementing', 'verifying'].includes(String(entry.metadata?.toStage))), false);

  assert.throws(() => reconciliation.reconcileExecutionLifecycleStage(created.id, {
    ...input,
    toStage: 'finalized',
    reasonCode: 'conflicting-observation',
  }), (error: any) => error?.code === 'EXECUTION_LIFECYCLE_IDEMPOTENCY_CONFLICT');
});

test('lifecycle retries are idempotent and invalid or in-flight transitions fail closed', () => {
  const created = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_lifecycle_guard', repoRoot });
  const transition = {
    toStage: 'context-ready' as const,
    reasonCode: 'context-ready',
    evidence: { id: 'context-guard-1', kind: 'context-bundle', status: 'completed' as const, operationId: 'op-context-guard-1' },
  };
  const first = sessions.recordExecutionLifecycleTransition(created.id, transition);
  const retry = sessions.recordExecutionLifecycleTransition(created.id, transition);
  assert.equal(first.changed, true);
  assert.equal(retry.changed, false);
  assert.equal(retry.idempotent, true);
  assert.equal(repository.listExecutionSessionEvidence(created.id).filter((entry) => entry.kind === 'lifecycle-transition').length, 2);

  assert.throws(() => sessions.recordExecutionLifecycleTransition(created.id, {
    toStage: 'implementing', reasonCode: 'different-reconciliation', evidence: { ...transition.evidence, status: 'completed' },
  }), (error: any) => error?.code === 'EXECUTION_LIFECYCLE_IDEMPOTENCY_CONFLICT');
  assert.throws(() => sessions.recordExecutionLifecycleTransition(created.id, {
    toStage: 'verifying', reasonCode: 'skip-implementation', evidence: { id: 'verify-skip-1', kind: 'verification-candidate', status: 'completed' },
  }), (error: any) => error?.code === 'EXECUTION_LIFECYCLE_TRANSITION_BLOCKED');
  assert.throws(() => sessions.recordExecutionLifecycleTransition(created.id, {
    toStage: 'implementing', reasonCode: 'mutation-accepted', evidence: { id: 'mutation-accepted-1', kind: 'async-mutation', status: 'accepted' },
  }), (error: any) => error?.code === 'EXECUTION_LIFECYCLE_EVIDENCE_NOT_TERMINAL');
  assert.throws(() => sessions.recordExecutionLifecycleTransition(created.id, {
    toStage: 'compatibility', reasonCode: 'invalid-runtime-sentinel', evidence: { id: 'compatibility-target-1', kind: 'untyped-runtime-input', status: 'completed' },
  } as any), (error: any) => error?.code === 'EXECUTION_LIFECYCLE_STAGE_REQUIRED');
  assert.equal(repository.getExecutionSessionById(created.id)?.lifecycle.stage, 'context-ready');
});

test('resume preserves lifecycle state and legacy sessions remain conservative until explicit initialization', () => {
  const created = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_lifecycle_resume', repoRoot });
  sessions.recordExecutionLifecycleTransition(created.id, {
    toStage: 'context-ready', reasonCode: 'context-ready', evidence: { id: 'context-resume-1', kind: 'context-bundle', status: 'completed' },
  });
  const resumed = sessions.resumeExecutionSession(created.id, { repoRoot, workspaceId: 'ws_lifecycle_resume' });
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.session.lifecycle.stage, 'context-ready');

  const legacyId = `exec-legacy-${Date.now()}`;
  const now = new Date().toISOString();
  repository.createExecutionSessionRecord({
    id: legacyId, projectId: 'project-session', taskId: null, workspaceId: 'ws_legacy_lifecycle', branch: 'legacy',
    baseRevision: null, repoRevision: null, status: 'active', contextHandle: null, changedFiles: [], verification: [],
    createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), endedAt: null,
  });
  const legacy = repository.getExecutionSessionById(legacyId)!;
  assert.equal(legacy.lifecycle.stage, 'compatibility');
  assert.equal(legacy.lifecycle.legacyCompatibility, true);
  const legacyResumed = sessions.resumeExecutionSession(legacyId, { workspaceId: 'ws_legacy_lifecycle' });
  assert.equal(legacyResumed.session.lifecycle.stage, 'compatibility');
  sessions.recordExecutionLifecycleTransition(legacyId, {
    toStage: 'created', reasonCode: 'legacy-explicit-initialization', evidence: { id: 'legacy-init-1', kind: 'compatibility-initialization', status: 'completed' },
  });
  assert.equal(repository.getExecutionSessionById(legacyId)?.lifecycle.stage, 'created');
});

test('completed, cancelled, and expired sessions cannot mutate as active sessions', () => {
  const completed = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_completed', repoRoot });
  sessions.completeExecutionSession(completed.id, { changedFiles: ['src/A.ts'] });
  assert.equal(repository.getExecutionSessionById(completed.id)?.status, 'completed');
  assert.equal(repository.getExecutionSessionById(completed.id)?.lifecycle.stage, 'created');
  assert.throws(() => sessions.recordExecutionLifecycleTransition(completed.id, {
    toStage: 'context-ready', reasonCode: 'late-context', evidence: { id: 'late-context-completed', kind: 'context-bundle', status: 'completed' },
  }), (error: any) => error?.code === 'EXECUTION_SESSION_TERMINAL');
  assert.throws(() => sessions.updateExecutionSessionProgress(completed.id, { contextHandle: 'ctx-nope' }), /terminal/i);
  assert.throws(() => sessions.recordExecutionSessionEvidence(completed.id, [{ kind: 'file', path: 'src/A.ts' }], { repoRoot }), /terminal/i);
  assert.equal(sessions.resumeExecutionSession(completed.id, { repoRoot }).resumable, false);

  const cancelled = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_cancelled', repoRoot });
  sessions.cancelExecutionSession(cancelled.id);
  assert.equal(repository.getExecutionSessionById(cancelled.id)?.status, 'cancelled');
  assert.equal(repository.getExecutionSessionById(cancelled.id)?.lifecycle.stage, 'created');

  const expired = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_expired', repoRoot, ttlMs: 1 });
  const resumedExpired = sessions.resumeExecutionSession(expired.id, { repoRoot, now: new Date(Date.now() + 10_000) });
  assert.equal(resumedExpired.resumable, false);
  assert.equal(repository.getExecutionSessionById(expired.id)?.status, 'expired');
  assert.equal(repository.getExecutionSessionById(expired.id)?.lifecycle.stage, 'created');
});

test('blocked verification batch member remains visible debt while independent checks continue', () => {
  const created = sessions.createExecutionSession({
    projectId: 'project-session',
    workspaceId: 'ws_blocked_batch',
    repoRoot,
    ownershipEpochId: 'claim-epoch-33333333-3333-4333-8333-333333333333',
  });
  const captured = sessions.captureExecutionVerificationProvenance(created.id, { repoRoot });
  const requiredChecks = ['unit', 'integration'];
  const first = sessions.recordExecutionVerificationBatchResult(created.id, {
    repoRoot,
    batchId: 'blocked-batch',
    requiredChecks,
    checkId: 'unit',
    status: 'blocked',
    captured,
    memberCandidate: {
      candidateId: 'candidate-blocked-unit',
      repoRevision: captured.repoRevision,
      executionKey: 'execution-blocked-unit',
    },
  });
  assert.equal(first.state.status, 'pending');
  assert.deepEqual(first.state.blocked, ['unit']);
  assert.deepEqual(first.state.pending, ['integration']);
  assert.equal(first.state.canComplete, false);
  assert.deepEqual(sessions.getExecutionVerificationBatchLiveOperations(created.id, 'blocked-batch'), []);

  const second = sessions.recordExecutionVerificationBatchResult(created.id, {
    repoRoot,
    batchId: 'blocked-batch',
    requiredChecks,
    checkId: 'integration',
    status: 'passed',
    captured,
    memberCandidate: {
      candidateId: 'candidate-blocked-integration',
      repoRevision: captured.repoRevision,
      executionKey: 'execution-blocked-integration',
    },
  });
  assert.equal(second.state.status, 'blocked');
  assert.deepEqual(second.state.blocked, ['unit']);
  assert.deepEqual(second.state.passed, ['integration']);
  assert.deepEqual(second.state.pending, []);
  assert.equal(second.state.canComplete, false);
  assert.deepEqual(sessions.getExecutionVerificationBatchLiveOperations(created.id, 'blocked-batch'), []);
});

test.after(() => {
  try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
});
