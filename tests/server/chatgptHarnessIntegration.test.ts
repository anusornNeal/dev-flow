import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-chatgpt-harness-integration-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { claimTaskForSession } = await import('../../src/server/services/taskClaimService.js');
const { cleanupSessionWorkspace, resetSessionWorkspaceRuntimeForTests } = await import('../../src/server/services/sessionWorkspaceService.js');
const executionSessions = await import('../../src/server/services/executionSessionService.js');
const { recordExecutionPendingOperationReference } = await import('../../src/server/services/executionCheckpointService.js');
const { getExecutionSessionResumeView } = await import('../../src/server/services/executionSessionHandoffService.js');
const { preflightHarnessExecutionGuard, recordHarnessExecutionOutcome } = await import('../../src/server/services/harnessExecutionGuardService.js');
const { getAgentTaskContext } = await import('../../src/server/services/taskService.js');
const { getChatGptHarnessHealthSnapshot } = await import('../../src/server/services/workflowHealthService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

function createRepo(name: string) {
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

function createTask(projectId: string, id: string, displayId: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const task = {
    id,
    displayId,
    title: 'ChatGPT harness integration fixture',
    description: 'Exercise compact ChatGPT-only control-plane state without a live model call.',
    projectId,
    status: 'todo',
    priority: 'medium',
    category: 'backend',
    tags: ['harness'],
    targetFiles: ['value.txt'],
    checklist: [],
    logs: [],
    bugs: [],
    images: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as any;
  saveTask(task);
  return task;
}

test('pre-claim agent context exposes a bounded legacy-compatible ChatGPT harness envelope without inventing a session', () => {
  resetSessionWorkspaceRuntimeForTests();
  const repoRoot = createRepo('preclaim');
  const project = { id: 'project-chatgpt-preclaim', name: 'ChatGPT Preclaim', repoUrl: 'https://example.com/chatgpt-preclaim', localPath: repoRoot };
  createProject(project);
  const task = createTask(project.id, 'task-chatgpt-preclaim', 'DVF-CHATGPT-0001');
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;

  const context = getAgentTaskContext(state, task.id, false)!;
  assert.ok(context.harness);
  assert.equal(context.harness.routing, 'chatgpt-only');
  assert.equal(context.harness.execution.claimed, false);
  assert.equal(context.harness.execution.sessionId, null);
  assert.equal(context.harness.execution.stage, 'unclaimed');
  assert.deepEqual(context.harness.allowedNextActionClasses, ['claim']);
  assert.equal(context.harness.strategy.mode, 'shadow');
  assert.equal(context.harness.strategy.status, 'fallback');
  assert.equal(context.task.displayId, task.displayId);
  assert.ok(JSON.stringify(context.harness).length < 6_000);

  const serialized = JSON.stringify(context.harness).toLowerCase();
  assert.equal(serialized.includes(repoRoot.toLowerCase()), false);
  assert.equal(serialized.includes('"model"'), false);
  assert.equal(serialized.includes('"provider"'), false);
  assert.equal(serialized.includes('"agent"'), false);
});

test('combined harness envelope follows claim, context, mutation, repair, resume, commit and finalize lifecycle with durable recovery pointers', () => {
  resetSessionWorkspaceRuntimeForTests();
  const repoRoot = createRepo('combined');
  const project = { id: 'project-chatgpt-combined', name: 'ChatGPT Combined', repoUrl: 'https://example.com/chatgpt-combined', localPath: repoRoot };
  createProject(project);
  const task = createTask(project.id, 'task-chatgpt-combined', 'DVF-CHATGPT-0002');
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, { sessionId: 'chatgpt-harness-integration-session', ownerKind: 'chat', ownerLabel: 'Harness integration' });
  const workspaceId = claimed.claim.workspaceId;

  try {
    const session = executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)!;
    assert.equal(session.lifecycle.stage, 'created');
    executionSessions.recordTaskExecutionContextReady({ workspaceId }, {
      contextHandle: 'ctx-harness-a',
      repoRevision: session.repoRevision,
      contextPlanIdentity: 'plan-harness-a',
    });
    executionSessions.recordTaskExecutionContextReady({ workspaceId }, {
      contextHandle: 'ctx-harness-a',
      repoRevision: session.repoRevision,
      contextPlanIdentity: 'plan-harness-a',
    });
    const contextTransitions = executionSessions.getExecutionSessionState(session.id).evidence
      .filter((entry: any) => entry.kind === 'lifecycle-transition' && entry.metadata?.toStage === 'context-ready');
    assert.equal(contextTransitions.length, 1);

    let context = getAgentTaskContext(state, task.id, false)!;
    assert.equal(context.harness.execution.sessionId, session.id);
    assert.equal(context.harness.execution.workspaceId, workspaceId);
    assert.equal(context.harness.execution.stage, 'context-ready');
    assert.equal(context.harness.context.handle, 'ctx-harness-a');
    assert.equal(context.harness.context.freshness, 'fresh');
    assert.ok(context.harness.allowedNextActionClasses.includes('mutation'));
    assert.match(context.harness.policy.inputFingerprint, /^[a-f0-9]{64}$/);

    const unsafe = preflightHarnessExecutionGuard(state, 'write_local_file', { workspaceId, filePath: 'C:/outside/value.txt' });
    assert.equal(unsafe.allowed, false);
    assert.equal(unsafe.reasonCode, 'REPO_RELATIVE_PATH_SAFETY_REQUIRED');

    const mutation = preflightHarnessExecutionGuard(state, 'write_local_file', {
      workspaceId,
      filePath: 'value.txt',
      harnessOperationId: 'integration-mutation',
    });
    assert.equal(mutation.allowed, true);
    recordHarnessExecutionOutcome(mutation, { ok: true, changed: true });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'implementing');

    const failedVerify = preflightHarnessExecutionGuard(state, 'run_project_command', {
      workspaceId,
      harnessOperationId: 'integration-verify-failed',
    });
    recordHarnessExecutionOutcome(failedVerify, { status: 'failed', ok: false, exitCode: 1 });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'repairing');

    recordExecutionPendingOperationReference(session.id, {
      operationId: 'job-lost-response-1',
      evidenceId: 'job-evidence-1',
      kind: 'project-command',
      status: 'accepted',
    });
    let health = getChatGptHarnessHealthSnapshot(state, { workspaceId });
    assert.equal(health.status, 'active');
    assert.equal(health.execution.stage, 'repairing');
    assert.equal(health.recovery.pendingOperationCount, 1);
    assert.ok(health.checkpoint.ref);

    executionSessions.updateExecutionSessionProgress(session.id, { contextHandle: 'ctx-harness-b' });
    context = getAgentTaskContext(state, task.id, false)!;
    assert.equal(context.harness.context.freshness, 'stale');
    recordExecutionPendingOperationReference(session.id, {
      operationId: 'job-lost-response-1',
      evidenceId: 'job-evidence-1',
      kind: 'project-command',
      status: 'running',
    });
    context = getAgentTaskContext(state, task.id, false)!;
    assert.equal(context.harness.context.freshness, 'fresh');

    const repairMutation = preflightHarnessExecutionGuard(state, 'write_local_file', {
      workspaceId,
      filePath: 'value.txt',
      harnessOperationId: 'integration-repair',
    });
    assert.equal(repairMutation.allowed, true);
    recordHarnessExecutionOutcome(repairMutation, { ok: true, changed: true });

    const successfulVerify = preflightHarnessExecutionGuard(state, 'run_project_command', {
      workspaceId,
      harnessOperationId: 'integration-verify-passed',
    });
    assert.equal(successfulVerify.allowed, true);
    recordHarnessExecutionOutcome(successfulVerify, { status: 'passed', ok: true, exitCode: 0 });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verifying');

    const commitPreview = preflightHarnessExecutionGuard(state, 'commit_task_owned_changes', {
      workspaceId,
      taskId: task.id,
      harnessOperationId: 'integration-commit-preview',
    });
    const oldFingerprint = commitPreview.policy!.inputFingerprint;
    saveTask({ ...task, claim: claimed.claim, priority: 'high', updatedAt: new Date(Date.now() + 1000).toISOString() } as any);
    const stalePolicy = preflightHarnessExecutionGuard(state, 'commit_task_owned_changes', {
      workspaceId,
      taskId: task.id,
      harnessPolicyFingerprint: oldFingerprint,
      harnessOperationId: 'integration-commit-stale-policy',
    });
    assert.equal(stalePolicy.allowed, false);
    assert.equal(stalePolicy.reasonCode, 'HARNESS_POLICY_STALE');

    const commit = preflightHarnessExecutionGuard(state, 'commit_task_owned_changes', {
      workspaceId,
      taskId: task.id,
      harnessOperationId: 'integration-commit',
    });
    assert.equal(commit.allowed, true);
    recordHarnessExecutionOutcome(commit, { dryRun: false, commitHash: 'a'.repeat(40), hash: 'a'.repeat(40) });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'committed');

    const resumed = getExecutionSessionResumeView(state, session.id, { workspaceId, repoRoot });
    assert.equal(resumed.executionSessionId, session.id);
    assert.equal(resumed.stage, 'committed');
    assert.ok(resumed.pendingOperations.some((entry: any) => entry.operationId === 'job-lost-response-1'));
    assert.ok(resumed.recoveryBlockers.some((entry: any) => entry.code === 'PENDING_DURABLE_OPERATION'));

    const finalization = preflightHarnessExecutionGuard(state, 'finalize_task_workspace', {
      workspaceId,
      taskId: task.id,
      harnessOperationId: 'integration-finalize',
    });
    assert.equal(finalization.allowed, true);
    executionSessions.recordExecutionLifecycleTransition(session.id, {
      toStage: 'finalized',
      reasonCode: 'integration-finalization-completed',
      evidence: { id: 'finalize-evidence-1', kind: 'finalization', status: 'completed' },
    });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'finalized');

    health = getChatGptHarnessHealthSnapshot(state, { workspaceId });
    assert.equal(health.mode, 'chatgpt-only');
    assert.equal(health.strategy.mode, 'shadow');
    assert.equal(health.strategy.regressionState, 'unknown');
    assert.equal(JSON.stringify(health).toLowerCase().includes(repoRoot.toLowerCase()), false);
  } finally {
    cleanupSessionWorkspace(workspaceId);
  }
});

test('harness health degrades explicitly to idle deterministic baseline when no adaptive execution is available', () => {
  const health = getChatGptHarnessHealthSnapshot({ projectsCache: [], countersCache: {}, skillsRegistry: [] } as any, {});
  assert.equal(health.status, 'idle');
  assert.equal(health.mode, 'chatgpt-only');
  assert.equal(health.execution.stage, 'unclaimed');
  assert.equal(health.policy.freshness, 'unavailable');
  assert.equal(health.strategy.mode, 'shadow');
  assert.equal(health.strategy.status, 'baseline');
  assert.equal(health.checkpoint.freshness, 'missing');
});
