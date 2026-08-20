import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-harness-policy-enforcement-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { claimTaskForSession, releaseTaskClaim } = await import('../../src/server/services/taskClaimService.js');
const { cleanupSessionWorkspace, resetSessionWorkspaceRuntimeForTests } = await import('../../src/server/services/sessionWorkspaceService.js');
const executionSessions = await import('../../src/server/services/executionSessionService.js');
const { getHarnessExecutionEffects, preflightHarnessExecutionGuard, recordHarnessExecutionOutcome } = await import('../../src/server/services/harnessExecutionGuardService.js');
const { getBuiltinToolJobRecoveryPolicy } = await import('../../src/server/services/mcpToolJobRunnerRegistry.js');
const { finalizeTaskWorkspace } = await import('../../src/server/services/taskWorkspaceFinalizationService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

function createRepo(name = 'repo') {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'value.txt'), 'before\n', 'utf8');
  git(root, ['init', '-b', 'develop']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return root;
}

function lifecycleEvidenceCount(sessionId: string) {
  return executionSessions.getExecutionSessionState(sessionId).evidence.filter((entry: any) => entry.kind === 'lifecycle-transition').length;
}

test('lightweight reads bypass the lifecycle guard', () => {
  const decision = preflightHarnessExecutionGuard({} as any, 'search_local_files', {});
  assert.equal(decision.guarded, false);
  assert.equal(decision.allowed, true);
  assert.equal(decision.reasonCode, 'LIGHTWEIGHT_UNGUARDED');
  assert.equal(decision.policy, null);
});

test('execution guard composes policy, ownership, lifecycle, retry identity, and restart safety', () => {
  resetSessionWorkspaceRuntimeForTests();
  const repoRoot = createRepo();
  const project = { id: 'project-harness-enforcement', name: 'Harness Enforcement', repoUrl: 'https://example.com/harness-enforcement', localPath: repoRoot };
  createProject(project);
  const now = new Date().toISOString();
  const task = {
    id: 'task-harness-enforcement', displayId: 'DVF-HARNESS-0001', title: 'Small UI harness enforcement fixture',
    description: 'Exercise the server-side harness guard against a real claimed workspace.', projectId: project.id,
    status: 'todo', priority: 'low', category: 'frontend', tags: ['ui'], targetFiles: ['value.txt'],
    checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: now,
  } as any;
  saveTask(task);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, { sessionId: 'harness-enforcement-session', ownerKind: 'chat', ownerLabel: 'Harness test' });
  const workspaceId = claimed.claim.workspaceId;

  try {
    const session = executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)!;
    assert.equal(session.lifecycle.stage, 'created');

    const generic = preflightHarnessExecutionGuard(state, 'write_local_file', { projectId: project.id, filePath: 'value.txt' });
    assert.equal(generic.allowed, true);
    assert.equal(generic.guarded, false);
    assert.equal(generic.reasonCode, 'GENERIC_NON_EXECUTION_UNGUARDED');

    const unbound = preflightHarnessExecutionGuard(state, 'write_local_file', { projectId: project.id, taskId: task.id, filePath: 'value.txt' });
    assert.equal(unbound.allowed, false);
    assert.equal(unbound.reasonCode, 'MANAGED_WORKSPACE_REQUIRED');

    const tooEarly = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'value.txt' });
    assert.equal(tooEarly.allowed, false);
    assert.equal(tooEarly.reasonCode, 'EXECUTION_LIFECYCLE_STAGE_BLOCKED');

    const unclaimedContext = executionSessions.recordTaskExecutionContextReady({ projectId: project.id }, {
      contextHandle: 'ctx-unclaimed',
      repoRevision: session.repoRevision,
    });
    assert.equal(unclaimedContext, null);
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'created');

    executionSessions.recordTaskExecutionContextReady({ workspaceId }, {
      contextHandle: 'ctx-harness-1',
      repoRevision: session.repoRevision,
      contextPlanIdentity: 'plan-harness-1',
    });

    const tooEarlyComposite = preflightHarnessExecutionGuard(state, 'apply_and_verify', {
      workspaceId,
      files: [{ filePath: 'value.txt', edits: [{ type: 'replace', find: 'before', replaceWith: 'after' }] }],
      requestedCommands: ['test-focused'],
      harnessOperationId: 'context-ready-composite',
    });
    assert.equal(tooEarlyComposite.allowed, false, 'composite must fail before edit when verification effect is illegal');
    assert.equal(tooEarlyComposite.action, 'verification');
    assert.equal(tooEarlyComposite.reasonCode, 'EXECUTION_LIFECYCLE_STAGE_BLOCKED');

    const safe = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'value.txt', harnessOperationId: 'mutation-1' });
    assert.equal(safe.allowed, true);
    assert.equal(safe.guarded, true);
    assert.equal(safe.action, 'mutation');
    assert.equal(safe.execution?.stage, 'context-ready');
    assert.match(safe.policy?.inputFingerprint || '', /^[a-f0-9]{64}$/);

    const unsafe = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'C:/outside/value.txt' });
    assert.equal(unsafe.allowed, false);
    assert.equal(unsafe.reasonCode, 'REPO_RELATIVE_PATH_SAFETY_REQUIRED');

    const oldFingerprint = safe.policy!.inputFingerprint;
    executionSessions.recordExecutionLifecycleTransition(session.id, {
      toStage: 'plan-recorded', reasonCode: 'plan-recorded', evidence: { id: 'plan-harness-1', kind: 'plan-evidence', status: 'completed' },
    });
    const stale = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'value.txt', harnessPolicyFingerprint: oldFingerprint });
    assert.equal(stale.allowed, false);
    assert.equal(stale.reasonCode, 'HARNESS_POLICY_STALE');

    const failedDecision = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'value.txt', harnessOperationId: 'mutation-failed' });
    recordHarnessExecutionOutcome(failedDecision, { ok: false, status: 'failed' });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'plan-recorded');

    const previewDecision = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'value.txt', harnessOperationId: 'mutation-preview' });
    recordHarnessExecutionOutcome(previewDecision, { ok: true, dryRun: true, changed: true });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'plan-recorded');

    const noOpDecision = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'value.txt', harnessOperationId: 'mutation-noop' });
    recordHarnessExecutionOutcome(noOpDecision, { ok: true, changed: false });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'plan-recorded');

    const mutationDecision = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'value.txt', harnessOperationId: 'mutation-success' });
    const beforeDuplicate = lifecycleEvidenceCount(session.id);
    recordHarnessExecutionOutcome(mutationDecision, { ok: true, changed: true });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'implementing');
    const afterFirst = lifecycleEvidenceCount(session.id);
    assert.equal(afterFirst, beforeDuplicate + 1);
    recordHarnessExecutionOutcome(mutationDecision, { ok: true, changed: true });
    assert.equal(lifecycleEvidenceCount(session.id), afterFirst);

    const verificationArgs = { workspaceId, command: 'test-focused', targets: ['tests/server/example.test.ts'] };
    const redVerificationArgs = {
      ...verificationArgs,
      __verificationCandidate: { candidateId: 'candidate-red', repoRevision: 'revision-a', executionKey: 'red-key' },
    };
    const verifyDecision = preflightHarnessExecutionGuard(state, 'run_project_command', redVerificationArgs);
    recordHarnessExecutionOutcome(verifyDecision, { status: 'failed', ok: false });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'repairing');

    const recoveryFailure = preflightHarnessExecutionGuard(state, 'run_project_command', redVerificationArgs);
    assert.equal(recoveryFailure.operationId, verifyDecision.operationId);
    const lifecycleBeforeRecoveryFailure = lifecycleEvidenceCount(session.id);
    recordHarnessExecutionOutcome(recoveryFailure, { status: 'failed', ok: false, exitCode: 1 });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'repairing');
    assert.equal(lifecycleEvidenceCount(session.id), lifecycleBeforeRecoveryFailure);
    assert.equal(executionSessions.getExecutionSessionState(session.id).evidence.filter((entry: any) => entry.id === `harness:${verifyDecision.operationId}:verification-failure`).length, 1);
    recordHarnessExecutionOutcome(recoveryFailure, { status: 'failed', ok: false, exitCode: 1 });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'repairing');
    assert.equal(lifecycleEvidenceCount(session.id), lifecycleBeforeRecoveryFailure);
    assert.equal(executionSessions.getExecutionSessionState(session.id).evidence.filter((entry: any) => entry.id === `harness:${verifyDecision.operationId}:verification-failure`).length, 1);

    const softOverride = preflightHarnessExecutionGuard(state, 'write_local_file', {
      workspaceId, filePath: 'value.txt',
      harnessPolicyOverride: { verificationCoverage: 'none', planningEvidenceRequired: false, contextSearchBudgetClass: 'compact' },
    });
    assert.equal(softOverride.allowed, true);
    assert.deepEqual(softOverride.policy?.verification.value, { required: false, coverage: 'none', mechanics: 'delegated-to-verification-planner' });
    assert.equal(softOverride.policy?.verification.source, 'explicit-user');

    const genericCommit = preflightHarnessExecutionGuard(state, 'commit_git_changes', { workspaceId, message: 'should be blocked' });
    assert.equal(genericCommit.allowed, false);
    assert.equal(genericCommit.reasonCode, 'TASK_OWNED_COMMIT_REQUIRED');

    const tooEarlyOwnedCommit = preflightHarnessExecutionGuard(state, 'commit_task_owned_changes', { workspaceId, taskId: task.id, message: 'too early' });
    assert.equal(tooEarlyOwnedCommit.allowed, false);
    assert.equal(tooEarlyOwnedCommit.reasonCode, 'EXECUTION_LIFECYCLE_STAGE_BLOCKED');

    const greenVerificationArgs = {
      ...verificationArgs,
      __verificationCandidate: { candidateId: 'candidate-green', repoRevision: 'revision-b', executionKey: 'green-key' },
    };
    const verifySuccess = preflightHarnessExecutionGuard(state, 'run_project_command', greenVerificationArgs);
    assert.notEqual(verifySuccess.operationId, verifyDecision.operationId);
    const lifecycleBeforeRecoverySuccess = lifecycleEvidenceCount(session.id);
    executionSessions.recordExecutionVerificationEvidence(session.id, [{ name: 'test-focused', status: 'passed' }], { repoRoot });
    recordHarnessExecutionOutcome(verifySuccess, { status: 'passed', ok: true, exitCode: 0 });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verifying');
    assert.equal(lifecycleEvidenceCount(session.id), lifecycleBeforeRecoverySuccess + 1);
    const verifySuccessReplay = preflightHarnessExecutionGuard(state, 'run_project_command', greenVerificationArgs);
    assert.equal(verifySuccessReplay.operationId, verifySuccess.operationId);
    recordHarnessExecutionOutcome(verifySuccessReplay, { status: 'passed', ok: true, exitCode: 0 });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verifying');
    assert.equal(lifecycleEvidenceCount(session.id), lifecycleBeforeRecoverySuccess + 1);

    const postGreenDiagnostic = preflightHarnessExecutionGuard(state, 'run_project_command', {
      workspaceId,
      command: 'typecheck',
      harnessOperationId: 'diagnostic-after-green',
      __verificationCandidate: { candidateId: 'candidate-diagnostic-after-green', repoRevision: 'revision-b', executionKey: 'diagnostic-after-green-key' },
    });
    assert.equal(postGreenDiagnostic.allowed, true, 'a safe diagnostic verification must remain admissible after lifecycle reaches verifying');
    assert.equal(postGreenDiagnostic.action, 'verification');

    const dryCommit = preflightHarnessExecutionGuard(state, 'commit_task_owned_changes', { workspaceId, taskId: task.id, message: 'preview', harnessOperationId: 'commit-preview' });
    assert.equal(dryCommit.allowed, true);
    assert.equal(dryCommit.allowed, true);
    recordHarnessExecutionOutcome(dryCommit, { dryRun: true, commitHash: null, hash: null });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verifying');

    const realCommit = preflightHarnessExecutionGuard(state, 'commit_task_owned_changes', { workspaceId, taskId: task.id, message: 'commit', harnessOperationId: 'commit-success' });
    recordHarnessExecutionOutcome(realCommit, { dryRun: false, commitHash: 'a'.repeat(40), hash: 'a'.repeat(40) });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'committed');

    const finalization = preflightHarnessExecutionGuard(state, 'finalize_task_workspace', { workspaceId, taskId: task.id });
    assert.equal(finalization.allowed, true);
    assert.equal(finalization.execution?.stage, 'committed');

    saveTask({
      id: 'task-related-active', displayId: 'DVF-HARNESS-0002', title: 'Related active work', description: 'Blocks restart.',
      projectId: project.id, status: 'in-progress', priority: 'high', category: 'backend', tags: [], targetFiles: ['other.txt'],
      checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: new Date().toISOString(),
    } as any);
    const restart = preflightHarnessExecutionGuard(state, 'restart_devflow', { projectId: project.id });
    assert.equal(restart.allowed, true);
    assert.equal(restart.action, 'restart');
    assert.equal(restart.restartBlockers, undefined);

    const liveTask = {
      id: 'task-related-live', displayId: 'DVF-HARNESS-0004', title: 'Related live execution', description: 'Blocks restart only while execution is live.',
      projectId: project.id, status: 'todo', priority: 'high', category: 'backend', tags: [], targetFiles: ['live.txt'],
      checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: new Date().toISOString(),
    } as any;
    saveTask(liveTask);
    const liveClaim = claimTaskForSession(liveTask.id, { sessionId: 'harness-related-live-session', ownerKind: 'chat', ownerLabel: 'Harness live test' });
    const liveWorkspaceId = liveClaim.claim.workspaceId;
    const liveSession = executionSessions.getActiveTaskExecutionSessionForWorkspace(liveWorkspaceId)!;

    const createdRestart = preflightHarnessExecutionGuard(state, 'restart_devflow', { projectId: project.id });
    assert.equal(createdRestart.allowed, true);
    executionSessions.recordExecutionLifecycleTransition(liveSession.id, {
      toStage: 'context-ready', reasonCode: 'live-context', evidence: { id: 'live-context', kind: 'context-bundle', status: 'completed' },
    });
    executionSessions.recordExecutionLifecycleTransition(liveSession.id, {
      toStage: 'implementing', reasonCode: 'live-mutation', evidence: { id: 'live-mutation', kind: 'owned-change', status: 'completed' },
    });

    const blockedRestart = preflightHarnessExecutionGuard(state, 'restart_devflow', { projectId: project.id });
    assert.equal(blockedRestart.allowed, false);
    assert.equal(blockedRestart.reasonCode, 'RELATED_WORK_ACTIVE');
    assert.equal(blockedRestart.restartBlockers?.length, 1);
    assert.equal(blockedRestart.restartBlockers?.[0]?.category, 'execution-session');
    assert.equal(blockedRestart.restartBlockers?.[0]?.taskId, liveTask.id);
    assert.equal(blockedRestart.restartBlockers?.[0]?.stage, 'implementing');
    assert.match(blockedRestart.guidance[0] || '', /execution-session:implementing/);
    executionSessions.completeExecutionSession(liveSession.id);
    saveTask({ ...liveTask, status: 'done', claim: undefined, updatedAt: new Date().toISOString() } as any);
    cleanupSessionWorkspace(liveWorkspaceId);

    assert.equal(getBuiltinToolJobRecoveryPolicy('apply_patch'), 'interrupted');
    assert.equal(getBuiltinToolJobRecoveryPolicy('apply_prepared_edit'), 'interrupted');
    assert.equal(getBuiltinToolJobRecoveryPolicy('search_local_files'), 'retryable');
  } finally {
    releaseTaskClaim(task.id, { sessionId: 'harness-enforcement-session', nextStatus: 'todo' });
    cleanupSessionWorkspace(workspaceId);
  }
});

test('verification OOM preserves execution for verification-only recovery', () => {
  resetSessionWorkspaceRuntimeForTests();
  const repoRoot = createRepo('verification-oom-repo');
  const project = { id: 'project-verification-oom', name: 'Verification OOM', repoUrl: 'https://example.com/verification-oom', localPath: repoRoot };
  createProject(project);
  const now = new Date().toISOString();
  const task = {
    id: 'task-verification-oom', displayId: 'DVF-HARNESS-OOM', title: 'Verification OOM fixture',
    description: 'Keep ownership after infrastructure verification failure.', projectId: project.id,
    status: 'todo', priority: 'high', category: 'backend', tags: [], targetFiles: ['value.txt'],
    checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: now,
  } as any;
  saveTask(task);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, { sessionId: 'verification-oom-session', ownerKind: 'chat', ownerLabel: 'OOM test' });
  const workspaceId = claimed.claim.workspaceId;
  try {
    const binding = executionSessions.getTaskExecutionMutationBinding({ workspaceId })!;
    executionSessions.recordTaskExecutionContextReady({ workspaceId }, { contextHandle: 'ctx-verification-oom', repoRevision: binding.session.repoRevision, contextPlanIdentity: 'plan-verification-oom' });
    executionSessions.recordExecutionLifecycleTransition(binding.session.id, { toStage: 'implementing', reasonCode: 'oom-fixture-mutation', evidence: { id: 'oom-fixture-mutation', kind: 'owned-change', status: 'completed' } });
    const verification = preflightHarnessExecutionGuard(state, 'run_project_command', { workspaceId, command: 'test-focused', harnessOperationId: 'verification-oom' });
    assert.equal(verification.allowed, true);
    recordHarnessExecutionOutcome(verification, { ok: false, status: 'timed_out', timedOut: true, signal: 'SIGTERM', stderr: 'java.lang.OutOfMemoryError: Java heap space' });
    const current = executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)!;
    assert.equal(current.lifecycle.stage, 'verification-infra-blocked');
    const failureEvidence = executionSessions.getExecutionSessionState(current.id).evidence.find((entry: any) => entry.kind === 'verification-result');
    assert.equal(failureEvidence?.metadata?.failureClass, 'infrastructure');
    const mutation = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'value.txt' });
    assert.equal(mutation.allowed, false);
    const recovery = preflightHarnessExecutionGuard(state, 'run_project_command', { workspaceId, command: 'test-focused', harnessOperationId: 'verification-oom-recovery' });
    assert.equal(recovery.allowed, true);
    assert.equal(recovery.execution?.stage, 'verification-infra-blocked');
    const compositeArgs = {
      workspaceId,
      files: [{ filePath: 'value.txt', edits: [{ type: 'replace', find: 'before', replaceWith: 'after' }] }],
      requestedCommands: ['test-focused'],
      harnessOperationId: 'verification-oom-composite',
    };
    assert.deepEqual(getHarnessExecutionEffects('apply_and_verify', compositeArgs), ['mutation', 'verification']);
    assert.deepEqual(getHarnessExecutionEffects('apply_and_verify', { workspaceId, requestedCommands: ['test-focused'] }), ['mutation', 'verification'], 'missing edit args must not implicitly downgrade the composite to verify-only');
    assert.deepEqual(getHarnessExecutionEffects('apply_prepared_edit', { editPlanId: 'plan-1' }), ['mutation']);
    assert.deepEqual(getHarnessExecutionEffects('apply_prepared_edit_plan', { editPlanId: 'plan-1' }), ['mutation']);
    const blockedComposite = preflightHarnessExecutionGuard(state, 'apply_and_verify', compositeArgs);
    assert.equal(blockedComposite.allowed, false);
    assert.equal(blockedComposite.action, 'mutation');
    assert.equal(blockedComposite.reasonCode, 'EXECUTION_LIFECYCLE_STAGE_BLOCKED');
    const commit = preflightHarnessExecutionGuard(state, 'commit_task_owned_changes', { workspaceId, taskId: task.id, message: 'blocked' });
    assert.equal(commit.allowed, false);
    const finalization = preflightHarnessExecutionGuard(state, 'finalize_task_workspace', { workspaceId, taskId: task.id });
    assert.equal(finalization.allowed, false);

    recordHarnessExecutionOutcome(recovery, { ok: false, status: 'failed', exitCode: 1, stderr: 'assertion failed' });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'repairing');
    const repairingComposite = preflightHarnessExecutionGuard(state, 'apply_and_verify', {
      ...compositeArgs,
      harnessOperationId: 'repairing-composite-infra-failure',
    });
    assert.equal(repairingComposite.allowed, true);
    assert.deepEqual(repairingComposite.effects, ['mutation', 'verification']);
    const lifecycleBeforeCompositeFailure = lifecycleEvidenceCount(binding.session.id);
    recordHarnessExecutionOutcome(repairingComposite, {
      ok: false,
      status: 'verification_failed',
      edit: { ok: true, changed: true },
      verification: [{ ok: false, status: 'timed_out', timedOut: true, stderr: 'java.lang.OutOfMemoryError: Java heap space' }],
    });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verification-infra-blocked');
    assert.equal(lifecycleEvidenceCount(binding.session.id), lifecycleBeforeCompositeFailure + 1, 'composite mutation must be observed before one infra-block transition without duplicate lifecycle records');
  } finally {
    releaseTaskClaim(task.id, { sessionId: 'verification-oom-session', nextStatus: 'todo' });
    cleanupSessionWorkspace(workspaceId);
  }
});

test('verification debt commit gates finalization until authoritative recovery verification settles the debt', () => {
  resetSessionWorkspaceRuntimeForTests();
  const repoRoot = createRepo('verification-debt-guard-repo');
  const project = { id: 'project-verification-debt-guard', name: 'Verification Debt Guard', repoUrl: 'https://example.com/verification-debt-guard', localPath: repoRoot };
  createProject(project);
  const now = new Date().toISOString();
  const task = {
    id: 'task-verification-debt-guard', displayId: 'DVF-HARNESS-DEBT', title: 'Verification debt guard fixture',
    description: 'Keep finalization blocked until authoritative recovery verification settles debt.', projectId: project.id,
    status: 'todo', priority: 'high', category: 'backend', tags: [], targetFiles: ['value.txt'],
    checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: now,
  } as any;
  saveTask(task);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, { sessionId: 'verification-debt-guard-session', ownerKind: 'chat', ownerLabel: 'Debt guard' });
  const workspaceId = claimed.claim.workspaceId;
  try {
    const binding = executionSessions.getTaskExecutionMutationBinding({ workspaceId })!;
    executionSessions.recordTaskExecutionContextReady({ workspaceId }, {
      contextHandle: 'ctx-verification-debt', repoRevision: binding.session.repoRevision, contextPlanIdentity: 'plan-verification-debt',
    });
    executionSessions.recordExecutionLifecycleTransition(binding.session.id, {
      toStage: 'implementing', reasonCode: 'debt-fixture-mutation',
      evidence: { id: 'debt-fixture-mutation', kind: 'owned-change', status: 'completed' },
    });
    fs.writeFileSync(path.join(binding.workspace.root, 'value.txt'), 'after\n', 'utf8');
    executionSessions.recordExecutionOwnedChanges(binding.session.id, ['value.txt'], { repoRoot: binding.workspace.root, source: 'debt-fixture' });
    const failedVerification = preflightHarnessExecutionGuard(state, 'run_project_command', { workspaceId, command: 'test-focused', harnessOperationId: 'debt-infra-failure' });
    recordHarnessExecutionOutcome(failedVerification, { ok: false, status: 'timed_out', timedOut: true, stderr: 'Java heap space' });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verification-infra-blocked');

    const ordinaryCommit = preflightHarnessExecutionGuard(state, 'commit_task_owned_changes', { workspaceId, taskId: task.id, message: 'ordinary' });
    assert.equal(ordinaryCommit.allowed, false);
    const debtCommit = preflightHarnessExecutionGuard(state, 'commit_task_owned_changes', {
      workspaceId, taskId: task.id, message: 'debt', preserveVerificationDebt: true, emergency: true,
      reason: 'runner exhausted heap', actorLabel: 'Operator Test', harnessOperationId: 'debt-commit',
    });
    assert.equal(debtCommit.allowed, true);
    executionSessions.recordExecutionSessionEvidence(binding.session.id, [{
      evidenceId: 'verification-debt:fixture', kind: 'verification-debt', revisionIdentity: 'fixture-commit',
      metadata: { status: 'outstanding', commitHash: 'fixture-commit', failureClass: 'infrastructure', failureEvidenceId: 'harness:debt-infra-failure:verification-failure' },
    }]);
    recordHarnessExecutionOutcome(debtCommit, {
      ok: true, status: 'succeeded', commitHash: 'fixture-commit', verificationDebtPreserved: true,
      verificationDebt: { evidenceId: 'verification-debt:fixture', status: 'outstanding' },
    });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'committed');

    const blockedFinalization = preflightHarnessExecutionGuard(state, 'finalize_task_workspace', { workspaceId, taskId: task.id });
    assert.equal(blockedFinalization.allowed, false);
    assert.equal(blockedFinalization.reasonCode, 'EXECUTION_VERIFICATION_DEBT_OUTSTANDING');
    const recovery = preflightHarnessExecutionGuard(state, 'run_project_command', { workspaceId, command: 'test-focused', harnessOperationId: 'debt-recovery-green' });
    assert.equal(recovery.allowed, true);
    executionSessions.recordExecutionVerificationEvidence(binding.session.id, [{ name: 'recovery', status: 'passed' }], { repoRoot: binding.workspace.root });
    recordHarnessExecutionOutcome(recovery, { ok: true, status: 'succeeded', exitCode: 0 });
    const settlement = executionSessions.getExecutionSessionState(binding.session.id).evidence.find((entry: any) => entry.kind === 'verification-debt-settlement');
    assert.equal(settlement?.metadata?.debtEvidenceId, 'verification-debt:fixture');
    assert.equal(settlement?.metadata?.status, 'settled');

    const allowedFinalization = preflightHarnessExecutionGuard(state, 'finalize_task_workspace', { workspaceId, taskId: task.id });
    assert.equal(allowedFinalization.allowed, true);
    const redundantVerification = preflightHarnessExecutionGuard(state, 'run_project_command', { workspaceId, command: 'test-focused', harnessOperationId: 'debt-recovery-redundant' });
    assert.equal(redundantVerification.allowed, false);
  } finally {
    const cleanupBinding = executionSessions.getTaskExecutionMutationBinding({ workspaceId });
    if (cleanupBinding) git(cleanupBinding.workspace.root, ['checkout', '--', 'value.txt']);
    releaseTaskClaim(task.id, { sessionId: 'verification-debt-guard-session', nextStatus: 'todo' });
    cleanupSessionWorkspace(workspaceId);
  }
});

test('incomplete sequential verification batch fences mutation but admits the remaining verification member', () => {
  resetSessionWorkspaceRuntimeForTests();
  const repoRoot = createRepo('sequential-batch-guard-repo');
  const project = { id: 'project-sequential-batch-guard', name: 'Sequential Batch Guard', repoUrl: 'https://example.com/sequential-batch-guard', localPath: repoRoot };
  createProject(project);
  const now = new Date().toISOString();
  const task = {
    id: 'task-sequential-batch-guard', displayId: 'DVF-HARNESS-BATCH', title: 'Sequential verification batch guard fixture',
    description: 'Keep batch continuation admissible while mutation and commit stay fenced.', projectId: project.id,
    status: 'todo', priority: 'high', category: 'backend', tags: [], targetFiles: ['value.txt'],
    checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: now,
  } as any;
  saveTask(task);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, { sessionId: 'sequential-batch-guard-session', ownerKind: 'chat', ownerLabel: 'Batch guard' });
  const workspaceId = claimed.claim.workspaceId;

  try {
    const binding = executionSessions.getTaskExecutionMutationBinding({ workspaceId })!;
    executionSessions.recordTaskExecutionContextReady({ workspaceId }, {
      contextHandle: 'ctx-sequential-batch',
      repoRevision: binding.session.repoRevision,
      contextPlanIdentity: 'plan-sequential-batch',
    });
    executionSessions.recordExecutionLifecycleTransition(binding.session.id, {
      toStage: 'implementing', reasonCode: 'batch-fixture-mutation',
      evidence: { id: 'batch-fixture-mutation', kind: 'owned-change', status: 'completed' },
    });
    fs.writeFileSync(path.join(binding.workspace.root, 'value.txt'), 'after\n', 'utf8');
    executionSessions.recordExecutionOwnedChanges(binding.session.id, ['value.txt'], { repoRoot: binding.workspace.root, source: 'batch-fixture' });
    const captured = executionSessions.captureExecutionVerificationProvenance(binding.session.id, { repoRoot: binding.workspace.root });
    const requiredChecks = ['focused', 'typecheck'];
    const first = executionSessions.recordExecutionVerificationBatchResult(binding.session.id, {
      repoRoot: binding.workspace.root,
      batchId: 'guard-batch-1', requiredChecks, checkId: 'focused', status: 'passed', captured,
      memberCandidate: { candidateId: 'vc-guard-focused', repoRevision: captured.repoRevision, executionKey: 'cmd-guard-focused' },
    });
    assert.equal(first.state.status, 'pending');
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'implementing');

    const mutation = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'value.txt' });
    assert.equal(mutation.allowed, false);
    assert.equal(mutation.reasonCode, 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE');

    const continuation = preflightHarnessExecutionGuard(state, 'run_project_command', {
      workspaceId,
      command: 'typecheck',
      verificationBatch: { id: 'guard-batch-1', requiredChecks, checkId: 'typecheck' },
    });
    assert.equal(continuation.allowed, true);
    assert.equal(continuation.action, 'verification');

    const second = executionSessions.recordExecutionVerificationBatchResult(binding.session.id, {
      repoRoot: binding.workspace.root,
      batchId: 'guard-batch-1', requiredChecks, checkId: 'typecheck', status: 'passed', captured,
      memberCandidate: { candidateId: 'vc-guard-typecheck', repoRevision: captured.repoRevision, executionKey: 'cmd-guard-typecheck' },
    });
    assert.equal(second.authoritative, true);
    recordHarnessExecutionOutcome(continuation, { ok: true, status: 'succeeded', exitCode: 0 });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verifying');
  } finally {
    const workspace = executionSessions.getTaskExecutionMutationBinding({ workspaceId })?.workspace;
    if (workspace) git(workspace.root, ['checkout', '--', 'value.txt']);
    releaseTaskClaim(task.id, { sessionId: 'sequential-batch-guard-session', nextStatus: 'todo' });
    cleanupSessionWorkspace(workspaceId);
  }
});

test('failed declared batch cannot be masked by diagnostic GREEN before explicit recovery batch', () => {
  resetSessionWorkspaceRuntimeForTests();
  const repoRoot = createRepo('failed-batch-diagnostic-green-repo');
  const project = { id: 'project-failed-batch-diagnostic-green', name: 'Failed Batch Diagnostic Green', repoUrl: 'https://example.com/failed-batch-diagnostic-green', localPath: repoRoot };
  createProject(project);
  const now = new Date().toISOString();
  const task = {
    id: 'task-failed-batch-diagnostic-green', displayId: 'DVF-HARNESS-RECOVERY-BATCH', title: 'Failed batch recovery fixture',
    description: 'Diagnostic GREEN must not mask failed declared verification authority.', projectId: project.id,
    status: 'todo', priority: 'high', category: 'backend', tags: [], targetFiles: ['value.txt'],
    checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: now,
  } as any;
  saveTask(task);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, { sessionId: 'failed-batch-diagnostic-green-session', ownerKind: 'chat', ownerLabel: 'Failed batch recovery' });
  const workspaceId = claimed.claim.workspaceId;

  try {
    const binding = executionSessions.getTaskExecutionMutationBinding({ workspaceId })!;
    executionSessions.recordTaskExecutionContextReady({ workspaceId }, {
      contextHandle: 'ctx-failed-batch-recovery', repoRevision: binding.session.repoRevision, contextPlanIdentity: 'plan-failed-batch-recovery',
    });
    executionSessions.recordExecutionLifecycleTransition(binding.session.id, {
      toStage: 'implementing', reasonCode: 'failed-batch-fixture-mutation',
      evidence: { id: 'failed-batch-fixture-mutation', kind: 'owned-change', status: 'completed' },
    });
    fs.writeFileSync(path.join(binding.workspace.root, 'value.txt'), 'after\n', 'utf8');
    executionSessions.recordExecutionOwnedChanges(binding.session.id, ['value.txt'], { repoRoot: binding.workspace.root, source: 'failed-batch-fixture' });
    const failedRevision = executionSessions.captureExecutionVerificationProvenance(binding.session.id, { repoRoot: binding.workspace.root });
    const requiredChecks = ['focused'];
    const failedArgs = {
      workspaceId, command: 'test-focused', harnessOperationId: 'failed-declared-batch',
      verificationBatch: { id: 'declared-batch-failed', requiredChecks, checkId: 'focused' },
    };
    const failedDecision = preflightHarnessExecutionGuard(state, 'run_project_command', failedArgs);
    assert.equal(failedDecision.allowed, true);
    const failedResult = {
      ok: false, status: 'failed', exitCode: 1, stderr: 'assertion failed',
      verificationCandidate: { candidateId: 'vc-declared-failed', repoRevision: failedRevision.repoRevision, executionKey: 'cmd-declared-failed', current: true },
    };
    const failedBinding = executionSessions.recordTaskExecutionVerificationResult(failedArgs, failedResult, failedRevision);
    assert.equal(failedBinding.authoritative, false);
    assert.equal(failedBinding.reasonCode, 'EXECUTION_VERIFICATION_BATCH_FAILED');
    recordHarnessExecutionOutcome(failedDecision, failedResult);
    assert.equal(executionSessions.getExecutionVerificationBatchState(binding.session.id)?.status, 'failed');
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'repairing');

    fs.writeFileSync(path.join(binding.workspace.root, 'value.txt'), 'repaired\n', 'utf8');
    executionSessions.recordExecutionOwnedChanges(binding.session.id, ['value.txt'], { repoRoot: binding.workspace.root, source: 'failed-batch-repair-fixture' });
    const repairedRevision = executionSessions.captureExecutionVerificationProvenance(binding.session.id, { repoRoot: binding.workspace.root });
    assert.notEqual(repairedRevision.ownedFingerprint, failedRevision.ownedFingerprint);

    const diagnosticArgs = { workspaceId, command: 'typecheck', harnessOperationId: 'diagnostic-green-after-failed-batch' };
    const diagnosticDecision = preflightHarnessExecutionGuard(state, 'run_project_command', diagnosticArgs);
    assert.equal(diagnosticDecision.allowed, true);
    const diagnosticResult = {
      ok: true, status: 'succeeded', exitCode: 0,
      verificationCandidate: { candidateId: 'vc-diagnostic-green', repoRevision: repairedRevision.repoRevision, executionKey: 'cmd-diagnostic-green', current: true },
    };
    const diagnosticBinding = executionSessions.recordTaskExecutionVerificationResult(diagnosticArgs, diagnosticResult, repairedRevision);
    assert.equal(diagnosticBinding.authoritative, false);
    assert.equal(diagnosticBinding.reasonCode, 'EXECUTION_VERIFICATION_RECOVERY_BATCH_REQUIRED');
    assert.equal(diagnosticBinding.verificationFresh, null);
    recordHarnessExecutionOutcome(diagnosticDecision, diagnosticResult);
    assert.equal(executionSessions.getExecutionVerificationBatchState(binding.session.id)?.status, 'failed');
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'repairing');

    const recoveryArgs = {
      workspaceId, command: 'test-focused', harnessOperationId: 'fresh-recovery-batch',
      verificationBatch: { id: 'declared-batch-recovery', requiredChecks, checkId: 'focused' },
    };
    const recoveryDecision = preflightHarnessExecutionGuard(state, 'run_project_command', recoveryArgs);
    assert.equal(recoveryDecision.allowed, true);
    const recoveryResult = {
      ok: true, status: 'succeeded', exitCode: 0,
      verificationCandidate: { candidateId: 'vc-declared-recovery', repoRevision: repairedRevision.repoRevision, executionKey: 'cmd-declared-recovery', current: true },
    };
    const recoveryBinding = executionSessions.recordTaskExecutionVerificationResult(recoveryArgs, recoveryResult, repairedRevision);
    assert.equal(recoveryBinding.authoritative, true);
    assert.equal(recoveryBinding.verificationFresh, true);
    assert.equal(executionSessions.getExecutionVerificationBatchState(binding.session.id)?.status, 'complete');
    recordHarnessExecutionOutcome(recoveryDecision, recoveryResult);
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verifying');
  } finally {
    const workspace = executionSessions.getTaskExecutionMutationBinding({ workspaceId })?.workspace;
    if (workspace) git(workspace.root, ['checkout', '--', 'value.txt']);
    releaseTaskClaim(task.id, { sessionId: 'failed-batch-diagnostic-green-session', nextStatus: 'todo' });
    cleanupSessionWorkspace(workspaceId);
  }
});

test('authoritative finalization persists finalized lifecycle before the execution session becomes terminal', () => {
  resetSessionWorkspaceRuntimeForTests();
  const repoRoot = createRepo('finalization-repo');
  const project = { id: 'project-harness-finalization', name: 'Harness Finalization', repoUrl: 'https://example.com/harness-finalization', localPath: repoRoot };
  createProject(project);
  const now = new Date().toISOString();
  const task = {
    id: 'task-harness-finalization', displayId: 'DVF-HARNESS-0003', title: 'Finalization lifecycle fixture',
    description: 'Ensure successful workspace finalization remains observable after cleanup.', projectId: project.id,
    status: 'todo', priority: 'low', category: 'frontend', tags: ['ui'], targetFiles: ['value.txt'],
    checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: now,
  } as any;
  saveTask(task);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, { sessionId: 'harness-finalization-session', ownerKind: 'chat', ownerLabel: 'Harness finalization test' });
  const workspaceId = claimed.claim.workspaceId;
  const binding = executionSessions.getTaskExecutionMutationBinding({ workspaceId })!;
  fs.writeFileSync(path.join(binding.workspace.root, 'value.txt'), 'after\n', 'utf8');
  git(binding.workspace.root, ['add', 'value.txt']);
  git(binding.workspace.root, ['commit', '-m', `[${task.displayId}] chore: implement task`]);
  const session = executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)!;
  const advance = (toStage: any, id: string, kind: string, reasonCode: string) => executionSessions.recordExecutionLifecycleTransition(session.id, {
    toStage,
    reasonCode,
    evidence: { id, kind, status: 'completed', operationId: `op-${id}` },
  });
  advance('context-ready', 'final-context', 'context-bundle', 'context-ready');
  advance('implementing', 'final-mutation', 'owned-change', 'mutation-applied');
  advance('verifying', 'final-verify', 'verification-candidate', 'verification-started');
  advance('committed', 'final-commit', 'git-commit', 'commit-created');

  const result = finalizeTaskWorkspace(state, {
    taskId: task.id,
    workspaceId,
    checks: [{ command: 'focused', status: 'passed', scope: 'targeted' }],
  });
  assert.equal(result.status, 'completed');
  const completed = executionSessions.getExecutionSessionState(session.id).session;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.lifecycle.stage, 'finalized');
  assert.equal(completed.lifecycle.lastTransition?.reasonCode, 'workspace-finalization-succeeded');
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
