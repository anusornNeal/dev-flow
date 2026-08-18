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
const { claimTaskForSession } = await import('../../src/server/services/taskClaimService.js');
const { cleanupSessionWorkspace, resetSessionWorkspaceRuntimeForTests } = await import('../../src/server/services/sessionWorkspaceService.js');
const executionSessions = await import('../../src/server/services/executionSessionService.js');
const { preflightHarnessExecutionGuard, recordHarnessExecutionOutcome } = await import('../../src/server/services/harnessExecutionGuardService.js');
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
    recordHarnessExecutionOutcome(verifySuccess, { status: 'passed', ok: true, exitCode: 0 });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verifying');
    assert.equal(lifecycleEvidenceCount(session.id), lifecycleBeforeRecoverySuccess + 1);
    const verifySuccessReplay = preflightHarnessExecutionGuard(state, 'run_project_command', greenVerificationArgs);
    assert.equal(verifySuccessReplay.operationId, verifySuccess.operationId);
    recordHarnessExecutionOutcome(verifySuccessReplay, { status: 'passed', ok: true, exitCode: 0 });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verifying');
    assert.equal(lifecycleEvidenceCount(session.id), lifecycleBeforeRecoverySuccess + 1);

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
