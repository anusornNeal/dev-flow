import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-break-glass-db-'));
process.env.DEVFLOW_DB_PATH = path.join(dbRoot, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTask } = await import('../../src/server/repositories/taskRepository.js');
const { listExecutionSessionsForTask } = await import('../../src/server/repositories/executionSessionRepository.js');
const { claimTaskForSession } = await import('../../src/server/services/taskClaimService.js');
const {
  getExecutionOwnershipState,
  getExecutionSessionOwnershipEpoch,
  recordExecutionOwnedChanges,
  recordExecutionLifecycleTransition,
  recordExecutionSessionEvidence,
  getExecutionSessionState,
} = await import('../../src/server/services/executionSessionService.js');
const { integrateWorkspaceCommits } = await import('../../src/server/services/workspaceIntegrationService.js');
const { recordExecutionPendingOperationReference } = await import('../../src/server/services/executionCheckpointService.js');
const {
  getSessionWorkspaceMetadataForRecovery,
  resetSessionWorkspaceRuntimeForTests,
} = await import('../../src/server/services/sessionWorkspaceService.js');
const {
  executeBreakGlassLifecycle,
  getBreakGlassLifecycleOperation,
  __setBreakGlassFaultBoundaryForTests,
} = await import('../../src/server/services/breakGlassLifecycleService.js');

function git(root: string, args: string[], allowFailure = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

let sequence = 0;
function fixture(label: string) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `devflow-break-glass-runtime-${label}-`));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `devflow-break-glass-repo-${label}-`));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(root, 'owned.txt'), 'base-owned\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'base-unrelated\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['branch', '-M', 'develop']);

  const n = ++sequence;
  const project = { id: `project-break-glass-${label}-${n}`, name: `Break Glass ${label}`, repoUrl: `https://example.test/${label}`, localPath: root } as any;
  createProject(project);
  const task = {
    id: `task-break-glass-${label}-${n}`,
    displayId: `DVF-BG-${n}`,
    title: `Break glass ${label}`,
    description: 'break glass fixture',
    projectId: project.id,
    status: 'todo',
    priority: 'medium',
    branch: null,
    tags: [],
    targetFiles: ['owned.txt'],
    checklist: [{ id: 'done', text: 'implemented', completed: true }],
    verificationEvidence: [],
    logs: [],
    bugs: [],
    images: [],
    designImages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any;
  saveTask(task);
  const claimed = claimTaskForSession(task.id, { sessionId: `session-${label}-${n}`, ownerLabel: 'Original Worker', ownerKind: 'chat' });
  const workspace = getSessionWorkspaceMetadataForRecovery(claimed.workspace.workspaceId)!;
  const executions = listExecutionSessionsForTask(task.id).filter((entry: any) => entry.status === 'active');
  assert.equal(executions.length, 1);
  const execution = executions[0];
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  return { root, project, task, claimed, workspace, execution, state };
}

function mutateOwned(f: ReturnType<typeof fixture>, value = 'owned-wip\n') {
  fs.writeFileSync(path.join(f.workspace.root, 'owned.txt'), value);
  recordExecutionOwnedChanges(f.execution.id, ['owned.txt'], { repoRoot: f.workspace.root, source: 'break-glass-test' });
  return getExecutionOwnershipState(f.execution.id, { repoRoot: f.workspace.root });
}

function baseRequest(f: ReturnType<typeof fixture>, action: any, operationId: string) {
  return {
    operationId,
    action,
    reason: `operator recovery for ${action}`,
    actorLabel: 'Operator Test',
    projectId: f.project.id,
    taskId: f.task.id,
    workspaceId: f.workspace.workspaceId,
    executionSessionId: f.execution.id,
    ownershipEpochId: getExecutionSessionOwnershipEpoch(f.execution.id).ownershipEpochId,
  } as any;
}

test('emergency commit binds override to the exact owned fingerprint and preserves unrelated dirty files', () => {
  const f = fixture('commit');
  const ownership = mutateOwned(f);
  fs.writeFileSync(path.join(f.workspace.root, 'unrelated.txt'), 'other-worker-wip\n');

  const result = executeBreakGlassLifecycle(f.state, {
    ...baseRequest(f, 'commit-current-owned-diff', 'bg-commit-1'),
    expectedOwnedFingerprint: ownership.ownedFingerprint,
    message: 'fix: emergency owned diff',
  });

  assert.equal(result.operation.status, 'completed');
  assert.deepEqual((result.operation.result as any).committedFiles, ['owned.txt']);
  assert.deepEqual((result.operation.result as any).unrelatedChangesPreserved, ['unrelated.txt']);
  assert.equal(fs.readFileSync(path.join(f.workspace.root, 'unrelated.txt'), 'utf8'), 'other-worker-wip\n');
  assert.match(git(f.workspace.root, ['status', '--porcelain']), /unrelated\.txt/);
  assert.doesNotMatch(git(f.workspace.root, ['status', '--porcelain']), /owned\.txt/);
  assert.ok(result.operation.bypassedGates.includes('EXECUTION_VERIFICATION_NOT_FRESH'));

  fs.writeFileSync(path.join(f.workspace.root, 'owned.txt'), 'newer-owned-wip\n');
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, {
      ...baseRequest(f, 'commit-current-owned-diff', 'bg-commit-2'),
      expectedOwnedFingerprint: ownership.ownedFingerprint,
      message: 'fix: stale fingerprint must fail',
    }),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_OWNED_FINGERPRINT_MISMATCH',
  );
});

test('infra-blocked break-glass commit preserves verification debt instead of manufacturing fresh verification', () => {
  const f = fixture('infra-debt-commit');
  const ownership = mutateOwned(f, 'infra-debt-wip\n');
  recordExecutionLifecycleTransition(f.execution.id, {
    toStage: 'context-ready', reasonCode: 'infra-debt-context', evidence: { id: 'infra-debt-context', kind: 'context-bundle', status: 'completed' },
  });
  recordExecutionLifecycleTransition(f.execution.id, {
    toStage: 'implementing', reasonCode: 'infra-debt-implementing', evidence: { id: 'infra-debt-implementing', kind: 'owned-change', status: 'completed' },
  });
  recordExecutionLifecycleTransition(f.execution.id, {
    toStage: 'verifying', reasonCode: 'infra-debt-verifying', evidence: { id: 'infra-debt-verifying', kind: 'verification-result', status: 'completed' },
  });
  recordExecutionLifecycleTransition(f.execution.id, {
    toStage: 'verification-infra-blocked', reasonCode: 'infra-debt-failure', evidence: { id: 'infra-debt-failure-transition', kind: 'verification-result', status: 'completed' },
  });
  recordExecutionSessionEvidence(f.execution.id, [{
    evidenceId: 'infra-debt-failure', kind: 'verification-result', revisionIdentity: 'infra-debt-failure',
    metadata: { outcome: 'failed', terminal: true, failureClass: 'infrastructure', status: 'timed_out', timedOut: true },
  }]);

  const result = executeBreakGlassLifecycle(f.state, {
    ...baseRequest(f, 'commit-current-owned-diff', 'bg-infra-debt-commit-1'),
    expectedOwnedFingerprint: ownership.ownedFingerprint,
    message: 'fix: preserve infra verification debt',
  });
  assert.equal(result.operation.status, 'completed');
  const state = getExecutionSessionState(f.execution.id);
  const debt = state.evidence.find((entry: any) => entry.kind === 'verification-debt');
  assert.equal(debt?.metadata?.status, 'outstanding');
  assert.equal(debt?.metadata?.candidateId, 'break-glass:bg-infra-debt-commit-1');
  assert.equal(getExecutionOwnershipState(f.execution.id, { repoRoot: f.workspace.root }).verificationFresh, null);
  assert.equal((result.operation.result as any).verificationDebtPreserved, true);
});

test('release ownership preserves dirty managed workspace bytes and is idempotent on replay', () => {
  const f = fixture('release');
  mutateOwned(f, 'release-wip\n');
  const request = baseRequest(f, 'release-ownership-preserve-wip', 'bg-release-1');
  const first = executeBreakGlassLifecycle(f.state, request);
  assert.equal(first.operation.status, 'completed');
  assert.equal(getTask(f.task.id)?.claim, undefined);
  assert.equal(fs.existsSync(f.workspace.root), true);
  assert.equal(fs.readFileSync(path.join(f.workspace.root, 'owned.txt'), 'utf8'), 'release-wip\n');

  const second = executeBreakGlassLifecycle(f.state, request);
  assert.equal(second.replayed, true);
  assert.equal(second.operation.id, first.operation.id);
  assert.equal(fs.readFileSync(path.join(f.workspace.root, 'owned.txt'), 'utf8'), 'release-wip\n');
});

test('execution rotation preserves the exact WIP workspace and creates only one replacement epoch', () => {
  const f = fixture('rotate');
  mutateOwned(f, 'rotate-wip\n');
  const request = {
    ...baseRequest(f, 'rotate-execution-preserve-wip', 'bg-rotate-1'),
    replacementSessionId: 'replacement-session-rotate',
  };
  const first = executeBreakGlassLifecycle(f.state, request);
  assert.equal(first.operation.status, 'completed');
  const refreshed = getTask(f.task.id)!;
  assert.equal(refreshed.claim?.workspaceId, f.workspace.workspaceId);
  assert.notEqual(refreshed.claim?.ownershipEpochId, f.claimed.claim.ownershipEpochId);
  assert.equal(fs.readFileSync(path.join(f.workspace.root, 'owned.txt'), 'utf8'), 'rotate-wip\n');
  const active = listExecutionSessionsForTask(f.task.id).filter((entry: any) => entry.status === 'active');
  assert.equal(active.length, 1);
  assert.notEqual(active[0].id, f.execution.id);

  const replay = executeBreakGlassLifecycle(f.state, request);
  assert.equal(replay.replayed, true);
  assert.equal(listExecutionSessionsForTask(f.task.id).filter((entry: any) => entry.status === 'active').length, 1);
});

test('discard-wip rejects generic emergency intent without destructive acknowledgement and audits rejection', () => {
  const f = fixture('discard-reject');
  mutateOwned(f, 'must-survive\n');
  const request = baseRequest(f, 'discard-wip', 'bg-discard-reject-1');
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, request),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_DESTRUCTIVE_ACK_REQUIRED',
  );
  assert.equal(fs.existsSync(f.workspace.root), true);
  assert.equal(fs.readFileSync(path.join(f.workspace.root, 'owned.txt'), 'utf8'), 'must-survive\n');
  const audit = getBreakGlassLifecycleOperation('bg-discard-reject-1');
  assert.equal(audit.status, 'rejected');
  assert.equal((audit.failure as any)?.code, 'BREAK_GLASS_DESTRUCTIVE_ACK_REQUIRED');
});

test('explicit discard captures bounded dirty-file evidence then removes only the exact task workspace', () => {
  const f = fixture('discard');
  mutateOwned(f, 'discard-me\n');
  fs.writeFileSync(path.join(f.workspace.root, 'extra.tmp'), 'temporary bytes\n');
  const result = executeBreakGlassLifecycle(f.state, {
    ...baseRequest(f, 'discard-wip', 'bg-discard-1'),
    destructiveAck: true,
  });
  assert.equal(result.operation.status, 'completed');
  assert.equal(result.operation.wipDisposition, 'discarded-explicitly');
  assert.equal(fs.existsSync(f.workspace.root), false);
  assert.ok(Array.isArray((result.operation.evidence as any).discardIntent.dirtyFiles));
  assert.ok((result.operation.evidence as any).discardIntent.dirtyFiles.includes('owned.txt'));
  assert.ok((result.operation.evidence as any).discardIntent.dirtyFiles.includes('extra.tmp'));
});

test('supersede-execution requires explicit replacement identity and preserves historical audit evidence', () => {
  const f = fixture('supersede');
  mutateOwned(f, 'supersede-wip\n');
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, baseRequest(f, 'supersede-execution', 'bg-supersede-reject')),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_REPLACEMENT_REQUIRED',
  );
  const result = executeBreakGlassLifecycle(f.state, {
    ...baseRequest(f, 'supersede-execution', 'bg-supersede-1'),
    replacement: { taskId: 'DVF-REPLACEMENT-1' },
  });
  assert.equal(result.operation.status, 'completed');
  assert.equal((result.operation.result as any).supersededExecutionSessionId, f.execution.id);
  assert.equal(listExecutionSessionsForTask(f.task.id).filter((entry: any) => entry.status === 'active').length, 0);
  assert.equal(fs.readFileSync(path.join(f.workspace.root, 'owned.txt'), 'utf8'), 'supersede-wip\n');
});

test('finalize-as-integrated resumes normal finalization from exact Git evidence after task presentation drift', () => {
  const f = fixture('finalize-integrated');
  mutateOwned(f, 'integrated-wip\n');
  git(f.workspace.root, ['add', 'owned.txt']);
  git(f.workspace.root, ['commit', '-m', `[${f.task.displayId}] chore: implement already integrated recovery`]);
  const sourceHead = git(f.workspace.root, ['rev-parse', 'HEAD']);
  const transition = (stage: any, id: string, kind: string) => recordExecutionLifecycleTransition(f.execution.id, {
    toStage: stage,
    reasonCode: id,
    evidence: { id, kind, status: 'completed', operationId: `op-${id}` },
  });
  transition('context-ready', 'bg-context', 'context-bundle');
  transition('implementing', 'bg-owned', 'owned-change');
  transition('verifying', 'bg-verify', 'verification-candidate');
  transition('committed', 'bg-commit', 'git-commit');
  const integrated = integrateWorkspaceCommits(f.workspace.workspaceId, { task: getTask(f.task.id) });
  assert.equal(integrated.status, 'succeeded');
  const baseHead = git(f.root, ['rev-parse', 'HEAD']);
  const drifted = getTask(f.task.id)!;
  drifted.status = 'todo';
  drifted.updatedAt = new Date().toISOString();
  saveTask(drifted);

  const result = executeBreakGlassLifecycle(f.state, {
    ...baseRequest(f, 'finalize-as-integrated', 'bg-finalize-integrated-1'),
    expectedCommit: sourceHead,
    checks: [{ name: 'focused', command: 'focused-test', status: 'passed', scope: 'full', repoRevision: baseHead }],
  });
  assert.equal(result.operation.status, 'completed', JSON.stringify(result.operation));
  assert.equal(getTask(f.task.id)?.status, 'done');
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), baseHead);
  assert.equal((result.operation.evidence as any).expectedCommit, sourceHead);
});

test('pending durable operation blocks ownership release without discarding WIP', () => {
  const f = fixture('pending-operation');
  mutateOwned(f, 'pending-operation-wip\n');
  recordExecutionPendingOperationReference(f.execution.id, { operationId: 'durable-writer-1', evidenceId: 'evidence-1', kind: 'mutation', status: 'running' });
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, baseRequest(f, 'release-ownership-preserve-wip', 'bg-pending-release-1')),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_PENDING_OPERATION',
  );
  assert.equal(fs.readFileSync(path.join(f.workspace.root, 'owned.txt'), 'utf8'), 'pending-operation-wip\n');
  assert.equal(getTask(f.task.id)?.claim?.workspaceId, f.workspace.workspaceId);
});

test('same operation id rejects a changed nested replacement identity', () => {
  const f = fixture('replay-mismatch');
  const firstRequest = {
    ...baseRequest(f, 'supersede-execution', 'bg-replay-mismatch-1'),
    replacement: { commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  };
  const first = executeBreakGlassLifecycle(f.state, firstRequest);
  assert.equal(first.operation.status, 'completed');
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, { ...firstRequest, replacement: { commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_OPERATION_REPLAY_MISMATCH',
  );
});

test('response loss after emergency commit resumes from the exact committed HEAD without a second commit', () => {
  const f = fixture('commit-response-loss');
  const ownership = mutateOwned(f, 'commit-response-loss\n');
  const request = {
    ...baseRequest(f, 'commit-current-owned-diff', 'bg-commit-response-loss-1'),
    expectedOwnedFingerprint: ownership.ownedFingerprint,
    message: 'fix: response loss commit',
  };
  const headBefore = git(f.workspace.root, ['rev-parse', 'HEAD']);
  __setBreakGlassFaultBoundaryForTests('after-commit-side-effect');
  try {
    assert.throws(() => executeBreakGlassLifecycle(f.state, request), (error: any) => error?.code === 'BREAK_GLASS_FAULT_INJECTED');
  } finally {
    __setBreakGlassFaultBoundaryForTests(null);
  }
  const headAfter = git(f.workspace.root, ['rev-parse', 'HEAD']);
  assert.notEqual(headAfter, headBefore);
  assert.equal(getBreakGlassLifecycleOperation(request.operationId).status, 'active');
  const retried = executeBreakGlassLifecycle(f.state, request);
  assert.equal(retried.operation.status, 'completed');
  assert.equal((retried.operation.result as any).recoveredAfterResponseLoss, true);
  assert.equal(git(f.workspace.root, ['rev-parse', 'HEAD']), headAfter);
});

test('response loss after execution rotation reuses the replacement epoch instead of rotating twice', () => {
  const f = fixture('rotate-response-loss');
  mutateOwned(f, 'rotate-response-loss\n');
  const request = {
    ...baseRequest(f, 'rotate-execution-preserve-wip', 'bg-rotate-response-loss-1'),
    replacementSessionId: 'replacement-response-loss',
  };
  __setBreakGlassFaultBoundaryForTests('after-rotation-side-effect');
  try {
    assert.throws(() => executeBreakGlassLifecycle(f.state, request), (error: any) => error?.code === 'BREAK_GLASS_FAULT_INJECTED');
  } finally {
    __setBreakGlassFaultBoundaryForTests(null);
  }
  const epochAfterSideEffect = getTask(f.task.id)?.claim?.ownershipEpochId;
  const activeAfterSideEffect = listExecutionSessionsForTask(f.task.id).filter((entry: any) => entry.status === 'active');
  assert.equal(activeAfterSideEffect.length, 1);
  const retried = executeBreakGlassLifecycle(f.state, request);
  assert.equal(retried.operation.status, 'completed');
  assert.equal((retried.operation.result as any).recoveredAfterResponseLoss, true);
  assert.equal(getTask(f.task.id)?.claim?.ownershipEpochId, epochAfterSideEffect);
  assert.equal(listExecutionSessionsForTask(f.task.id).filter((entry: any) => entry.status === 'active').length, 1);
  assert.equal(fs.readFileSync(path.join(f.workspace.root, 'owned.txt'), 'utf8'), 'rotate-response-loss\n');
});

test('response loss after destructive cleanup resumes from pre-persisted discard evidence', () => {
  const f = fixture('discard-response-loss');
  mutateOwned(f, 'discard-response-loss\n');
  const request = { ...baseRequest(f, 'discard-wip', 'bg-discard-response-loss-1'), destructiveAck: true };
  __setBreakGlassFaultBoundaryForTests('after-discard-side-effect');
  try {
    assert.throws(() => executeBreakGlassLifecycle(f.state, request), (error: any) => error?.code === 'BREAK_GLASS_FAULT_INJECTED');
  } finally {
    __setBreakGlassFaultBoundaryForTests(null);
  }
  assert.equal(fs.existsSync(f.workspace.root), false);
  const interrupted = getBreakGlassLifecycleOperation(request.operationId);
  assert.equal(interrupted.status, 'active');
  assert.ok((interrupted.evidence as any).discardIntent.dirtyFiles.includes('owned.txt'));
  const retried = executeBreakGlassLifecycle(f.state, request);
  assert.equal(retried.operation.status, 'completed');
  assert.equal((retried.operation.result as any).cleanup.recoveredAfterResponseLoss, true);
  assert.equal(retried.operation.wipDisposition, 'discarded-explicitly');
});
