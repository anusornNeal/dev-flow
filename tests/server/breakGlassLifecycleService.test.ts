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
  return { root, runtimeRoot, project, task, claimed, workspace, execution, state };
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

function loseWorkspaceAuthority(f: ReturnType<typeof fixture>, options: { releaseClaim?: boolean } = {}) {
  if (options.releaseClaim !== false) {
    const task = getTask(f.task.id)!;
    task.claim = undefined;
    task.updatedAt = new Date().toISOString();
    saveTask(task);
  }
  fs.rmSync(path.join(f.runtimeRoot, 'workspaces', 'registry', `${f.workspace.workspaceId}.json`), { force: true });
  fs.rmSync(f.workspace.root, { recursive: true, force: true });
  resetSessionWorkspaceRuntimeForTests();
  assert.equal(getSessionWorkspaceMetadataForRecovery(f.workspace.workspaceId), null);
}

type DetachedFailureMode = 'none' | 'infrastructure' | 'code';

function prepareDetachedIntegrated(
  label: string,
  options: { failureMode?: DetachedFailureMode; includeOutOfScope?: boolean } = {},
) {
  const f = fixture(label);
  mutateOwned(f, `detached-${label}\n`);
  if (options.includeOutOfScope) {
    fs.writeFileSync(path.join(f.workspace.root, 'unrelated.txt'), `leaked-${label}\n`);
    git(f.workspace.root, ['add', 'owned.txt', 'unrelated.txt']);
  } else {
    git(f.workspace.root, ['add', 'owned.txt']);
  }
  git(f.workspace.root, ['commit', '-m', `[${f.task.displayId}] chore: detached ${label}`]);
  const sourceHead = git(f.workspace.root, ['rev-parse', 'HEAD']);
  const transition = (stage: any, id: string, kind: string) => recordExecutionLifecycleTransition(f.execution.id, {
    toStage: stage,
    reasonCode: id,
    evidence: { id, kind, status: 'completed', operationId: `op-${id}` },
  });
  transition('context-ready', `${label}-context`, 'context-bundle');
  transition('implementing', `${label}-implementing`, 'owned-change');
  transition('verifying', `${label}-verifying`, 'verification-candidate');
  const failureMode = options.failureMode || 'none';
  if (failureMode === 'infrastructure') {
    transition('verification-infra-blocked', `${label}-infra-blocked`, 'verification-result');
    recordExecutionSessionEvidence(f.execution.id, [{
      evidenceId: `${label}-infra-failure`,
      kind: 'verification-result',
      revisionIdentity: `${label}-infra-failure`,
      metadata: { outcome: 'failed', terminal: true, failureClass: 'infrastructure', status: 'timed_out', timedOut: true },
    }]);
  } else if (failureMode === 'code') {
    recordExecutionSessionEvidence(f.execution.id, [{
      evidenceId: `${label}-code-failure`,
      kind: 'verification-result',
      revisionIdentity: `${label}-code-failure`,
      metadata: { outcome: 'failed', terminal: true, failureClass: 'code', status: 'failed' },
    }]);
    transition('repairing', `${label}-repairing`, 'repair');
  } else {
    transition('committed', `${label}-committed`, 'git-commit');
  }
  const integrated = integrateWorkspaceCommits(f.workspace.workspaceId, { task: getTask(f.task.id) });
  assert.equal(integrated.status, 'succeeded');
  const baseHead = git(f.root, ['rev-parse', 'HEAD']);
  fs.rmSync(f.workspace.root, { recursive: true, force: true });
  assert.equal(fs.existsSync(f.workspace.root), false);
  return { ...f, sourceHead, baseHead, integrated };
}

function detachedRequest(f: ReturnType<typeof prepareDetachedIntegrated>, operationId: string) {
  return {
    ...baseRequest(f, 'reconcile-integrated-detached', operationId),
    expectedCommit: f.sourceHead,
    checks: [{ name: 'detached-green', command: 'detached-green', status: 'passed', scope: 'full', repoRevision: f.baseHead }],
  } as any;
}

test('detached integrated recovery terminalizes exact already-integrated work without recreating or cleaning the lost workspace', () => {
  const f = prepareDetachedIntegrated('detached-success');
  const result = executeBreakGlassLifecycle(f.state, detachedRequest(f, 'bg-detached-success-1'));

  assert.equal(result.operation.status, 'completed', JSON.stringify(result.operation));
  assert.equal(getTask(f.task.id)?.status, 'done');
  assert.equal(getTask(f.task.id)?.claim, undefined);
  const execution = getExecutionSessionState(f.execution.id).session;
  assert.equal(execution.status, 'completed');
  assert.equal(execution.lifecycle.stage, 'finalized');
  assert.equal(fs.existsSync(f.workspace.root), false);
  assert.equal((result.operation.result as any).integratedRevision, f.baseHead);
  assert.equal((result.operation.result as any).verificationDebtSettled, true);
});

test('detached integrated recovery treats repository Git policy as authoritative over SQLite fallback', () => {
  const f = prepareDetachedIntegrated('detached-repo-policy');
  const devflowDir = path.join(f.root, '.devflow');
  fs.mkdirSync(devflowDir, { recursive: true });
  fs.writeFileSync(path.join(devflowDir, 'project.json'), JSON.stringify({
    version: 1,
    gitWorkflowPolicy: {
      integrationStrategy: 'rebase-ff',
      commitMessageTemplate: 'repo::{ticket}::{type}::{title}',
      mergeMessageTemplate: 'Repo merge {ticket}',
    },
  }, null, 2), 'utf8');
  git(f.root, ['add', '-f', '.devflow/project.json']);
  git(f.root, ['commit', '-m', 'add repo policy']);

  assert.throws(
    () => executeBreakGlassLifecycle(f.state, detachedRequest(f, 'bg-detached-repo-policy-1')),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_DETACHED_COMMIT_TASK_MISMATCH',
  );
});

test('detached integrated recovery is forbidden while the managed workspace root is still live', () => {
  const f = fixture('detached-live-reject');
  const expectedCommit = git(f.root, ['rev-parse', 'HEAD']);
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, {
      ...baseRequest(f, 'reconcile-integrated-detached', 'bg-detached-live-reject-1'),
      expectedCommit,
      checks: [{ name: 'green', command: 'green', status: 'passed', scope: 'full', repoRevision: expectedCommit }],
    }),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_DETACHED_WORKSPACE_STILL_LIVE',
  );
  assert.equal(fs.existsSync(f.workspace.root), true);
});

test('detached integrated recovery blocks integrated changes outside authoritative task-owned scope', () => {
  const f = prepareDetachedIntegrated('detached-scope-reject', { includeOutOfScope: true });
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, detachedRequest(f, 'bg-detached-scope-reject-1')),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_DETACHED_DIFF_OUT_OF_SCOPE',
  );
  assert.equal(getTask(f.task.id)?.status, 'in-progress');
  assert.equal(getExecutionSessionState(f.execution.id).session.status, 'active');
});

test('detached integrated recovery creates infrastructure verification debt, settles it with revision-bound GREEN, and finalizes once', () => {
  const f = prepareDetachedIntegrated('detached-infra-debt', { failureMode: 'infrastructure' });
  const request = detachedRequest(f, 'bg-detached-infra-debt-1');
  const result = executeBreakGlassLifecycle(f.state, request);
  assert.equal(result.operation.status, 'completed', JSON.stringify(result.operation));
  const state = getExecutionSessionState(f.execution.id);
  const debts = state.evidence.filter((entry: any) => entry.kind === 'verification-debt');
  const settlements = state.evidence.filter((entry: any) => entry.kind === 'verification-debt-settlement' && entry.metadata?.status === 'settled');
  assert.equal(debts.length, 1);
  assert.equal(debts[0].metadata?.failureClass, 'infrastructure');
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].metadata?.debtEvidenceId, debts[0].id);
  assert.equal(state.session.status, 'completed');
  assert.equal(state.session.lifecycle.stage, 'finalized');
  assert.equal(getTask(f.task.id)?.status, 'done');
});

test('detached integrated recovery refuses to reclassify a prior code verification failure as infrastructure', () => {
  const f = prepareDetachedIntegrated('detached-code-reject', { failureMode: 'code' });
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, detachedRequest(f, 'bg-detached-code-reject-1')),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_DETACHED_CODE_FAILURE_REPAIR_REQUIRED',
  );
  assert.equal(getTask(f.task.id)?.status, 'in-progress');
  assert.equal(getExecutionSessionState(f.execution.id).session.status, 'active');
});

test('detached integrated recovery blocks unresolved durable operations before lifecycle convergence', () => {
  const f = prepareDetachedIntegrated('detached-pending-reject');
  recordExecutionPendingOperationReference(f.execution.id, {
    operationId: 'detached-pending-writer',
    evidenceId: 'detached-pending-evidence',
    kind: 'mutation',
    status: 'running',
  });
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, detachedRequest(f, 'bg-detached-pending-reject-1')),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_PENDING_OPERATION',
  );
  assert.equal(getTask(f.task.id)?.status, 'in-progress');
});

test('detached integrated recovery resumes after response loss without duplicate finalization effects', () => {
  const f = prepareDetachedIntegrated('detached-response-loss');
  const request = detachedRequest(f, 'bg-detached-response-loss-1');
  __setBreakGlassFaultBoundaryForTests('after-detached-finalization-side-effect');
  try {
    assert.throws(
      () => executeBreakGlassLifecycle(f.state, request),
      (error: any) => error?.code === 'BREAK_GLASS_FAULT_INJECTED',
    );
  } finally {
    __setBreakGlassFaultBoundaryForTests(null);
  }
  assert.equal(getBreakGlassLifecycleOperation(request.operationId).status, 'active');
  assert.equal(getTask(f.task.id)?.status, 'done');
  const logCountAfterSideEffect = (getTask(f.task.id)?.logs || []).filter((entry: any) => /Finalized managed workspace/.test(entry.message)).length;
  assert.equal(logCountAfterSideEffect, 1);

  const replay = executeBreakGlassLifecycle(f.state, request);
  assert.equal(replay.operation.status, 'completed');
  assert.equal(getTask(f.task.id)?.status, 'done');
  assert.equal((getTask(f.task.id)?.logs || []).filter((entry: any) => /Finalized managed workspace/.test(entry.message)).length, 1);
  assert.equal(getExecutionSessionState(f.execution.id).session.status, 'completed');
  assert.equal(fs.existsSync(f.workspace.root), false);
});

test('workflow-only commit, release, and rotate actions are rejected before emergency audit creation', () => {
  const f = fixture('workflow-only-actions');
  for (const action of ['commit-current-owned-diff', 'release-ownership-preserve-wip', 'rotate-execution-preserve-wip']) {
    const operationId = `bg-workflow-only-${action}`;
    assert.throws(
      () => executeBreakGlassLifecycle(f.state, baseRequest(f, action, operationId)),
      (error: any) => error?.payload?.code === 'BREAK_GLASS_ACTION_INVALID',
    );
    assert.throws(
      () => getBreakGlassLifecycleOperation(operationId),
      (error: any) => error?.payload?.code === 'BREAK_GLASS_OPERATION_NOT_FOUND',
      'unsupported workflow action must not create emergency audit state',
    );
  }
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

test('supersede-execution can retire one exact stale execution after its workspace metadata is gone', () => {
  const f = fixture('supersede-missing-workspace');
  loseWorkspaceAuthority(f);

  const request = {
    ...baseRequest(f, 'supersede-execution', 'bg-supersede-missing-workspace-1'),
    workspaceId: undefined,
    noReplacement: true,
  };
  const result = executeBreakGlassLifecycle(f.state, request);

  assert.equal(result.operation.status, 'completed');
  assert.equal((result.operation.result as any).supersededExecutionSessionId, f.execution.id);
  assert.equal(listExecutionSessionsForTask(f.task.id).filter((entry: any) => entry.status === 'active').length, 0);
  assert.equal((result.operation.evidence as any).missingWorkspaceSupersession?.executionSessionId, f.execution.id);
  assert.equal((result.operation.evidence as any).missingWorkspaceSupersession?.workspaceMetadataAvailable, false);
});

test('supersede-execution accepts a missing historical workspace id only when the exact execution recorded the same id', () => {
  const f = fixture('supersede-missing-workspace-id');
  loseWorkspaceAuthority(f);

  const result = executeBreakGlassLifecycle(f.state, {
    ...baseRequest(f, 'supersede-execution', 'bg-supersede-missing-workspace-id-1'),
    noReplacement: true,
  });
  assert.equal(result.operation.status, 'completed');
  assert.equal((result.operation.evidence as any).missingWorkspaceSupersession?.recordedWorkspaceId, f.workspace.workspaceId);

  const mismatch = fixture('supersede-missing-workspace-mismatch');
  loseWorkspaceAuthority(mismatch);
  assert.throws(
    () => executeBreakGlassLifecycle(mismatch.state, {
      ...baseRequest(mismatch, 'supersede-execution', 'bg-supersede-missing-workspace-mismatch-1'),
      workspaceId: 'ws_wrong_historical_id',
      noReplacement: true,
    }),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_EXECUTION_IDENTITY_MISMATCH',
  );

  const foreign = fixture('supersede-missing-foreign-execution');
  loseWorkspaceAuthority(foreign);
  assert.throws(
    () => executeBreakGlassLifecycle(mismatch.state, {
      ...baseRequest(mismatch, 'supersede-execution', 'bg-supersede-missing-foreign-execution-1'),
      workspaceId: undefined,
      executionSessionId: foreign.execution.id,
      ownershipEpochId: getExecutionSessionOwnershipEpoch(foreign.execution.id).ownershipEpochId,
      noReplacement: true,
    }),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_EXECUTION_IDENTITY_MISMATCH',
  );
});

test('missing-workspace supersession refuses a still-live claim and unresolved durable operation', () => {
  const live = fixture('supersede-missing-live-claim');
  loseWorkspaceAuthority(live, { releaseClaim: false });
  assert.throws(
    () => executeBreakGlassLifecycle(live.state, {
      ...baseRequest(live, 'supersede-execution', 'bg-supersede-missing-live-claim-1'),
      workspaceId: undefined,
      noReplacement: true,
    }),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_HARD_SAFETY_BLOCKED',
  );
  assert.equal(getExecutionSessionState(live.execution.id).session.status, 'active');

  const pending = fixture('supersede-missing-pending');
  loseWorkspaceAuthority(pending);
  recordExecutionPendingOperationReference(pending.execution.id, {
    operationId: 'missing-workspace-pending-op',
    evidenceId: 'missing-workspace-pending-evidence',
    kind: 'mutation',
    status: 'running',
  });
  assert.throws(
    () => executeBreakGlassLifecycle(pending.state, {
      ...baseRequest(pending, 'supersede-execution', 'bg-supersede-missing-pending-1'),
      workspaceId: undefined,
      noReplacement: true,
    }),
    (error: any) => error?.payload?.code === 'BREAK_GLASS_PENDING_OPERATION',
  );
  assert.equal(getExecutionSessionState(pending.execution.id).session.status, 'active');
});

test('missing workspace remains a hard requirement for unrelated break-glass actions', () => {
  const f = fixture('missing-workspace-other-action');
  loseWorkspaceAuthority(f);
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, {
      ...baseRequest(f, 'finalize-as-integrated', 'bg-missing-workspace-finalize-1'),
      workspaceId: undefined,
      expectedCommit: git(f.root, ['rev-parse', 'HEAD']),
    }),
    (error: any) => error?.payload?.code === 'WORKSPACE_ID_REQUIRED',
  );
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

test('integrated emergency recovery delegates verification to normal finalization without workflow bypass', () => {
  const f = fixture('owner-finalize-no-green');
  mutateOwned(f, 'owner-finalize-no-green\n');
  git(f.workspace.root, ['add', 'owned.txt']);
  git(f.workspace.root, ['commit', '-m', `[${f.task.displayId}] chore: owner finalization candidate`]);
  const sourceHead = git(f.workspace.root, ['rev-parse', 'HEAD']);
  recordExecutionLifecycleTransition(f.execution.id, {
    toStage: 'context-ready',
    reasonCode: 'owner-finalize-context',
    evidence: { id: 'owner-finalize-context', kind: 'context-bundle', status: 'completed' },
  });
  recordExecutionLifecycleTransition(f.execution.id, {
    toStage: 'implementing',
    reasonCode: 'owner-finalize-implementing',
    evidence: { id: 'owner-finalize-implementing', kind: 'owned-change', status: 'completed' },
  });
  const integrated = integrateWorkspaceCommits(f.workspace.workspaceId, { task: getTask(f.task.id) });
  assert.equal(integrated.status, 'succeeded');
  const baseHead = git(f.root, ['rev-parse', 'HEAD']);

  const result = executeBreakGlassLifecycle(f.state, {
    ...baseRequest(f, 'finalize-as-integrated', 'bg-owner-finalize-no-green-1'),
    expectedCommit: sourceHead,
    checks: [{ name: 'normal-finalization-green', command: 'normal-finalization-green', status: 'passed', scope: 'full', repoRevision: baseHead }],
  });

  assert.equal(result.operation.status, 'completed', JSON.stringify(result.operation));
  assert.equal(getTask(f.task.id)?.status, 'done');
  const executionState = getExecutionSessionState(f.execution.id);
  assert.equal(executionState.session.status, 'completed');
  assert.equal(executionState.session.lifecycle.stage, 'finalized');
  assert.equal(
    executionState.evidence.some((entry: any) => entry.kind === 'verification-binding' && entry.metadata?.policy === 'operator-break-glass'),
    false,
  );
  assert.equal(result.operation.bypassedGates.includes('VERIFICATION_EVIDENCE_MISSING'), false);
  assert.equal(result.operation.bypassedGates.includes('POST_INTEGRATION_VERIFICATION_REQUIRED'), false);
});

test('pending durable operation blocks destructive execution supersession without discarding WIP', () => {
  const f = fixture('pending-operation');
  mutateOwned(f, 'pending-operation-wip\n');
  recordExecutionPendingOperationReference(f.execution.id, { operationId: 'durable-writer-1', evidenceId: 'evidence-1', kind: 'mutation', status: 'running' });
  assert.throws(
    () => executeBreakGlassLifecycle(f.state, {
      ...baseRequest(f, 'supersede-execution', 'bg-pending-supersede-1'),
      replacement: { commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    }),
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
