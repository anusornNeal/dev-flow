// DVF-0685 regression coverage for finalization-time reusable verification evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-finalize-db-'));
process.env.DEVFLOW_DB_PATH = path.join(dbRoot, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTask } = await import('../../src/server/repositories/taskRepository.js');
const { createOrReuseSessionWorkspace, resetSessionWorkspaceRuntimeForTests, acquireSessionWorkspace, releaseSessionWorkspace } = await import('../../src/server/services/sessionWorkspaceService.js');
const {
  cancelExecutionSession,
  createExecutionSession,
  getExecutionOwnershipState,
  getExecutionSessionState,
  getExecutionSessionOwnershipEpoch,
  recordExecutionLifecycleTransition,
  recordExecutionOwnedChanges,
  recordExecutionSessionEvidence,
  recordExecutionVerificationEvidence,
} = await import('../../src/server/services/executionSessionService.js');
const { getProjectCommandExecutionIdentity } = await import('../../src/server/services/projectCommandService.js');
const { buildVerificationCoverageIdentity } = await import('../../src/server/services/verificationBatchService.js');
const { integrateWorkspaceCommits, reconstructRecordedWorkspaceIntegration } = await import('../../src/server/services/workspaceIntegrationService.js');
const { finalizeTaskWorkspace, runTaskWorkspaceHappyPathTail, __setTaskFinalizationFaultBoundaryForTests } = await import('../../src/server/services/taskWorkspaceFinalizationService.js');
const { buildTaskCommitPlan, commitTaskOwnedChanges } = await import('../../src/server/services/taskCommitPlanService.js');
const { getAgentTaskContext } = await import('../../src/server/services/taskService.js');
const { getTaskFinalizationOperation } = await import('../../src/server/repositories/taskFinalizationOperationRepository.js');
const {
  __getRecordedIntegrationValidationMetricsForTests,
  __resetRecordedIntegrationValidationMetricsForTests,
} = await import('../../src/server/services/taskWorkspaceFinalizationOperationService.js');

function git(root: string, args: string[], allowFailure = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return { status: result.status ?? -1, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

function createRepo(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `devflow-finalize-${label}-`));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: `finalization-${label}`,
    private: true,
    scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['branch', '-M', 'develop']);
  return root;
}

let sequence = 0;
function fixture(label: string) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `devflow-finalize-runtime-${label}-`));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;
  resetSessionWorkspaceRuntimeForTests();
  const root = createRepo(label);
  const project = { id: `project-finalize-${label}-${sequence++}`, name: `Finalize ${label}`, repoUrl: `https://example.test/${label}`, localPath: root } as any;
  createProject(project);
  const task = {
    id: `task-finalize-${label}-${sequence}`,
    displayId: `DVF-FIN-${sequence}`,
    title: `Finalize ${label}`,
    description: 'finalization fixture',
    projectId: project.id,
    status: 'in-progress',
    priority: 'medium',
    branch: null,
    tags: [],
    targetFiles: ['tracked.txt'],
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
  const workspace = createOrReuseSessionWorkspace(project, `session-${label}`, { taskDisplayId: task.displayId });
  return { root, project, task, workspace, state: { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any };
}

const checks = [{ name: 'focused', command: 'focused-test', status: 'passed' as const, summary: 'focused verification passed' }];

function taskCommitSubject(task: any, title: string, type = 'chore') {
  return `[${task.jiraKey || task.displayId || task.id}] ${type}: ${title}`;
}

function advanceExecutionToCommitted(executionId: string, label: string) {
  const advance = (toStage: any, id: string, kind: string) => recordExecutionLifecycleTransition(executionId, {
    toStage,
    reasonCode: id,
    evidence: { id, kind, status: 'completed', operationId: `op-${id}` },
  });
  advance('context-ready', `${label}-context`, 'context-bundle');
  advance('implementing', `${label}-change`, 'owned-change');
  advance('verifying', `${label}-verify`, 'verification-candidate');
  advance('committed', `${label}-commit`, 'git-commit');
}

function preparedFinalizationFixture(label: string) {
  const prepared = fixture(label);
  fs.writeFileSync(path.join(prepared.workspace.root, 'tracked.txt'), `implemented-${label}\n`);
  git(prepared.workspace.root, ['add', 'tracked.txt']);
  git(prepared.workspace.root, ['commit', '-m', taskCommitSubject(prepared.task, `implement ${label}`)]);
  const claimed = getTask(prepared.task.id)!;
  claimed.claim = { workspaceId: prepared.workspace.workspaceId, sessionIdHash: `fixture-${label}`, ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveTask(claimed);
  const execution = createExecutionSession({ projectId: prepared.task.projectId, taskId: prepared.task.id, workspaceId: prepared.workspace.workspaceId, branch: prepared.workspace.branch, repoRoot: prepared.workspace.root });
  advanceExecutionToCommitted(execution.id, label);
  return { ...prepared, execution };
}

function preparedCoverageFinalizationFixture(label: string) {
  const prepared = fixture(label);
  fs.writeFileSync(path.join(prepared.workspace.root, 'tracked.txt'), `implemented-${label}\n`);
  git(prepared.workspace.root, ['add', 'tracked.txt']);
  git(prepared.workspace.root, ['commit', '-m', taskCommitSubject(prepared.task, `implement ${label}`)]);
  const claimed = getTask(prepared.task.id)!;
  claimed.claim = { workspaceId: prepared.workspace.workspaceId, sessionIdHash: `fixture-${label}`, ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveTask(claimed);
  const execution = createExecutionSession({ projectId: prepared.task.projectId, taskId: prepared.task.id, workspaceId: prepared.workspace.workspaceId, branch: prepared.workspace.branch, repoRoot: prepared.workspace.root });
  recordExecutionLifecycleTransition(execution.id, {
    toStage: 'context-ready',
    reasonCode: `${label}-context`,
    evidence: { id: `${label}-context`, kind: 'context-bundle', status: 'completed' },
  });
  recordExecutionLifecycleTransition(execution.id, {
    toStage: 'implementing',
    reasonCode: `${label}-implementing`,
    evidence: { id: `${label}-implementing`, kind: 'owned-change', status: 'completed' },
  });
  recordExecutionOwnedChanges(execution.id, ['tracked.txt'], { repoRoot: prepared.workspace.root, source: 'coverage-fixture' });
  const ownership = getExecutionOwnershipState(execution.id, { repoRoot: prepared.workspace.root });
  const identity = getProjectCommandExecutionIdentity(prepared.state, {
    projectId: prepared.project.id,
    workspaceId: prepared.workspace.workspaceId,
    command: 'test',
    affectedInputPaths: ['tracked.txt'],
  });
  assert.ok(identity);
  const coverage = buildVerificationCoverageIdentity(identity);
  assert.ok(coverage);
  recordExecutionVerificationEvidence(execution.id, [{ name: 'test', command: 'test', status: 'passed' }], {
    repoRoot: prepared.workspace.root,
    provenance: {
      policy: 'checks-passed',
      expectedRepoRevision: ownership.repoRevision,
      expectedOwnedFingerprint: ownership.ownedFingerprint,
      candidateId: `coverage-${label}`,
      candidateRepoRevision: ownership.repoRevision,
      executionKey: identity!.key,
      coverage: [coverage!],
    },
  });
  recordExecutionLifecycleTransition(execution.id, {
    toStage: 'verifying',
    reasonCode: `${label}-verification`,
    evidence: { id: `${label}-verification`, kind: 'verification-candidate', status: 'completed' },
  });
  recordExecutionLifecycleTransition(execution.id, {
    toStage: 'committed',
    reasonCode: `${label}-committed`,
    evidence: { id: `${label}-committed`, kind: 'git-commit', status: 'completed' },
  });
  return { ...prepared, execution };
}

function preparedAutonomousTailFixture(label: string) {
  const prepared = fixture(label);
  fs.writeFileSync(path.join(prepared.workspace.root, 'tracked.txt'), `autonomous-${label}\n`);
  const claimed = getTask(prepared.task.id)!;
  const ownershipEpochId = `claim-epoch-00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  claimed.claim = { workspaceId: prepared.workspace.workspaceId, sessionIdHash: prepared.workspace.sessionIdHash, ownershipEpochId, ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  saveTask(claimed);
  const execution = createExecutionSession({ projectId: prepared.task.projectId, taskId: prepared.task.id, workspaceId: prepared.workspace.workspaceId, branch: prepared.workspace.branch, repoRoot: prepared.workspace.root, ownershipEpochId });
  recordExecutionLifecycleTransition(execution.id, {
    toStage: 'context-ready',
    reasonCode: `${label}-context`,
    evidence: { id: `${label}-context`, kind: 'context-bundle', status: 'completed' },
  });
  recordExecutionLifecycleTransition(execution.id, {
    toStage: 'implementing',
    reasonCode: `${label}-implementing`,
    evidence: { id: `${label}-implementing`, kind: 'owned-change', status: 'completed' },
  });
  recordExecutionOwnedChanges(execution.id, ['tracked.txt'], { repoRoot: prepared.workspace.root, source: 'autonomous-tail-fixture' });
  const ownership = getExecutionOwnershipState(execution.id, { repoRoot: prepared.workspace.root });
  const identity = getProjectCommandExecutionIdentity(prepared.state, {
    projectId: prepared.project.id,
    workspaceId: prepared.workspace.workspaceId,
    command: 'test',
    affectedInputPaths: ['tracked.txt'],
  });
  assert.ok(identity);
  const coverage = buildVerificationCoverageIdentity(identity);
  assert.ok(coverage);
  recordExecutionVerificationEvidence(execution.id, [{ name: 'test', command: 'test', status: 'passed' }], {
    repoRoot: prepared.workspace.root,
    provenance: {
      policy: 'checks-passed',
      expectedRepoRevision: ownership.repoRevision,
      expectedOwnedFingerprint: ownership.ownedFingerprint,
      candidateId: `autonomous-${label}`,
      candidateRepoRevision: ownership.repoRevision,
      executionKey: identity!.key,
      coverage: [coverage!],
    },
  });
  recordExecutionLifecycleTransition(execution.id, {
    toStage: 'verifying',
    reasonCode: `${label}-verification`,
    evidence: { id: `${label}-verification`, kind: 'verification-candidate', status: 'completed' },
  });
  return { ...prepared, execution };
}

function preparedAutonomousNoOpTailFixture(label: string) {
  const prepared = fixture(label);
  const claimed = getTask(prepared.task.id)!;
  const ownershipEpochId = `claim-epoch-00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  claimed.claim = { workspaceId: prepared.workspace.workspaceId, sessionIdHash: prepared.workspace.sessionIdHash, ownershipEpochId, ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  saveTask(claimed);
  const execution = createExecutionSession({ projectId: prepared.task.projectId, taskId: prepared.task.id, workspaceId: prepared.workspace.workspaceId, branch: prepared.workspace.branch, repoRoot: prepared.workspace.root, ownershipEpochId });
  recordExecutionLifecycleTransition(execution.id, {
    toStage: 'context-ready',
    reasonCode: `${label}-context`,
    evidence: { id: `${label}-context`, kind: 'context-bundle', status: 'completed' },
  });
  recordExecutionLifecycleTransition(execution.id, {
    toStage: 'implementing',
    reasonCode: `${label}-implementing`,
    evidence: { id: `${label}-implementing`, kind: 'coordination', status: 'completed' },
  });
  const ownership = getExecutionOwnershipState(execution.id, { repoRoot: prepared.workspace.root });
  const identity = getProjectCommandExecutionIdentity(prepared.state, {
    projectId: prepared.project.id,
    workspaceId: prepared.workspace.workspaceId,
    command: 'test',
    affectedInputPaths: [],
  });
  assert.ok(identity);
  const coverage = buildVerificationCoverageIdentity(identity);
  assert.ok(coverage);
  recordExecutionVerificationEvidence(execution.id, [{ name: 'test', command: 'test', status: 'passed' }], {
    repoRoot: prepared.workspace.root,
    provenance: {
      policy: 'checks-passed',
      expectedRepoRevision: ownership.repoRevision,
      expectedOwnedFingerprint: ownership.ownedFingerprint,
      candidateId: `autonomous-no-op-${label}`,
      candidateRepoRevision: ownership.repoRevision,
      executionKey: identity!.key,
      coverage: [coverage!],
    },
  });
  recordExecutionLifecycleTransition(execution.id, {
    toStage: 'verifying',
    reasonCode: `${label}-verification`,
    evidence: { id: `${label}-verification`, kind: 'verification-candidate', status: 'completed' },
  });
  return { ...prepared, execution };
}

function detachedFinalizationFixture(label: string) {
  const prepared = preparedFinalizationFixture(label);
  const sourceHead = git(prepared.workspace.root, ['rev-parse', 'HEAD']).stdout;
  const integrated = integrateWorkspaceCommits(prepared.workspace.workspaceId, { task: getTask(prepared.task.id) });
  assert.equal(integrated.status, 'succeeded');
  const baseHead = git(prepared.root, ['rev-parse', 'HEAD']).stdout;
  const reconstruction = reconstructRecordedWorkspaceIntegration({
    workspaceId: prepared.workspace.workspaceId,
    projectRoot: prepared.root,
    baseBranch: prepared.workspace.baseBranch,
    sourceBranch: prepared.workspace.branch,
    baseRevision: prepared.workspace.baseRevision,
    sourceHead,
    strategy: prepared.workspace.gitWorkflowPolicy?.integrationStrategy || 'rebase-ff',
  });
  assert.equal(reconstruction.alreadyIntegrated, true);
  assert.notEqual(reconstruction.patchEquivalent, true);
  const ownershipEpochId = getExecutionSessionOwnershipEpoch(prepared.execution.id).ownershipEpochId;
  const detachedChecks = [{
    name: 'detached-full',
    command: 'detached-full',
    status: 'passed' as const,
    scope: 'full' as const,
    repoRevision: baseHead,
  }];
  return { ...prepared, sourceHead, baseHead, reconstruction, ownershipEpochId, detachedChecks };
}

test('already-committed task skips duplicate commit and proceeds directly to finalization', () => {
  const f = preparedFinalizationFixture('already-committed-route');
  const sourceHead = git(f.workspace.root, ['rev-parse', 'HEAD']).stdout;
  recordExecutionSessionEvidence(f.execution.id, [{
    evidenceId: `task-owned-commit:${sourceHead}`,
    kind: 'task-owned-commit',
    revisionIdentity: sourceHead,
    metadata: {
      commitHash: sourceHead,
      taskId: f.task.id,
      workspaceId: f.workspace.workspaceId,
      executionSessionId: f.execution.id,
      tool: 'commit_task_owned_changes',
      owned: true,
    },
  }]);

  const plan = buildTaskCommitPlan(f.state, { taskId: f.task.id, workspaceId: f.workspace.workspaceId });
  assert.equal(plan.commitDisposition, 'already-committed');
  assert.deepEqual(plan.nextAction, { tool: 'finalize_task_workspace', taskId: f.task.id, workspaceId: f.workspace.workspaceId });
  const commitCount = git(f.workspace.root, ['rev-list', '--count', 'HEAD']).stdout;
  const replay = commitTaskOwnedChanges(f.state, { taskId: f.task.id, workspaceId: f.workspace.workspaceId, message: 'chore: duplicate attempt' });
  assert.equal(replay.status, 'already-committed');
  assert.equal(git(f.workspace.root, ['rev-list', '--count', 'HEAD']).stdout, commitCount);

  const result = finalizeTaskWorkspace(f.state, { taskId: f.task.id, workspaceId: f.workspace.workspaceId, checks });
  assert.equal(result.status, 'completed', JSON.stringify(result));
});

test('evidence-recorded finalization resumes after the originating execution is cancelled and replay stays idempotent', () => {
  const f = preparedFinalizationFixture('cancelled-execution-resume');
  __setTaskFinalizationFaultBoundaryForTests('after-evidence');
  let interrupted: any;
  try {
    interrupted = finalizeTaskWorkspace(f.state, { taskId: f.task.id, workspaceId: f.workspace.workspaceId, checks });
  } finally {
    __setTaskFinalizationFaultBoundaryForTests(null);
  }
  assert.equal(interrupted.status, 'continuation', JSON.stringify(interrupted));
  assert.equal(interrupted.operation?.phase, 'evidence-recorded');
  cancelExecutionSession(f.execution.id);

  const resumed = finalizeTaskWorkspace(f.state, {
    taskId: f.task.id,
    workspaceId: f.workspace.workspaceId,
    operationId: interrupted.operation.id,
  });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(resumed.operation?.id, interrupted.operation.id);
  assert.equal(getTask(f.task.id)?.status, 'done');

  const replay = finalizeTaskWorkspace(f.state, {
    taskId: f.task.id,
    workspaceId: f.workspace.workspaceId,
    operationId: interrupted.operation.id,
  });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.operation?.id, interrupted.operation.id);
});

test('frozen finalization retry fails closed when a replacement execution supersedes the cancelled origin', () => {
  const f = preparedFinalizationFixture('cancelled-execution-superseded');
  __setTaskFinalizationFaultBoundaryForTests('after-evidence');
  let interrupted: any;
  try {
    interrupted = finalizeTaskWorkspace(f.state, { taskId: f.task.id, workspaceId: f.workspace.workspaceId, checks });
  } finally {
    __setTaskFinalizationFaultBoundaryForTests(null);
  }
  cancelExecutionSession(f.execution.id);
  const replacement = createExecutionSession({
    projectId: f.task.projectId,
    taskId: f.task.id,
    workspaceId: f.workspace.workspaceId,
    branch: f.workspace.branch,
    repoRoot: f.workspace.root,
  });
  try {
    assert.throws(
      () => finalizeTaskWorkspace(f.state, {
        taskId: f.task.id,
        workspaceId: f.workspace.workspaceId,
        operationId: interrupted.operation.id,
      }),
      (error: any) => error?.payload?.code === 'FINALIZATION_OPERATION_SUPERSEDED_BY_EXECUTION' || error?.code === 'FINALIZATION_OPERATION_SUPERSEDED_BY_EXECUTION',
    );
  } finally {
    cancelExecutionSession(replacement.id);
  }
});

test('detached finalization consumes exact already-integrated evidence and skips cleanup when the workspace root is unavailable', () => {
  const f = detachedFinalizationFixture('detached-direct');
  fs.rmSync(f.workspace.root, { recursive: true, force: true });

  const result = finalizeTaskWorkspace(f.state, {
    taskId: f.task.id,
    workspaceId: f.workspace.workspaceId,
    checks: f.detachedChecks,
    detachedIntegrated: {
      sourceHead: f.sourceHead,
      baseRevision: f.workspace.baseRevision,
      baseBranch: f.workspace.baseBranch,
      executionSessionId: f.execution.id,
      ownershipEpochId: f.ownershipEpochId,
      integration: f.reconstruction,
    },
  });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.operation?.cleanup?.reason, 'detached-workspace-already-unavailable');
  assert.equal(getTask(f.task.id)?.status, 'done');
  assert.equal(getTask(f.task.id)?.claim, undefined);
  assert.equal(getExecutionSessionState(f.execution.id).session.status, 'completed');
  assert.equal(getExecutionSessionState(f.execution.id).session.lifecycle.stage, 'finalized');
  assert.equal(fs.existsSync(f.workspace.root), false);

  const replay = finalizeTaskWorkspace(f.state, {
    taskId: f.task.id,
    workspaceId: f.workspace.workspaceId,
    checks: f.detachedChecks,
    detachedIntegrated: {
      sourceHead: f.sourceHead,
      baseRevision: f.workspace.baseRevision,
      baseBranch: f.workspace.baseBranch,
      executionSessionId: f.execution.id,
      ownershipEpochId: f.ownershipEpochId,
      integration: f.reconstruction,
    },
  });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.operation?.id, result.operation?.id);
  assert.equal((getTask(f.task.id)?.logs || []).filter((entry: any) => /Finalized managed workspace/.test(entry.message)).length, 1);
});

test('detached finalization rejects bypass while the original managed workspace root still exists', () => {
  const f = detachedFinalizationFixture('detached-live');
  assert.throws(
    () => finalizeTaskWorkspace(f.state, {
      taskId: f.task.id,
      workspaceId: f.workspace.workspaceId,
      checks: f.detachedChecks,
      detachedIntegrated: {
        sourceHead: f.sourceHead,
        baseRevision: f.workspace.baseRevision,
        baseBranch: f.workspace.baseBranch,
        executionSessionId: f.execution.id,
        ownershipEpochId: f.ownershipEpochId,
        integration: f.reconstruction,
      },
    }),
    (error: any) => error?.payload?.code === 'DETACHED_FINALIZATION_LIVE_WORKSPACE',
  );
  assert.equal(getTask(f.task.id)?.status, 'in-progress');
  assert.equal(getExecutionSessionState(f.execution.id).session.status, 'active');
  assert.equal(fs.existsSync(f.workspace.root), true);
});

test('committed workspace finalizes into local develop and removes clean worktree/branch', () => {
  const { root, task, workspace, state } = fixture('success');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'implemented\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'implement task')]);

  const claimed = getTask(task.id)!;
  claimed.claim = { workspaceId: workspace.workspaceId, sessionIdHash: 'fixture-session', ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveTask(claimed);
  const execution = createExecutionSession({ projectId: task.projectId, taskId: task.id, workspaceId: workspace.workspaceId, branch: workspace.branch, repoRoot: workspace.root });
  advanceExecutionToCommitted(execution.id, 'success');

  const integratedRevision = git(workspace.root, ['rev-parse', 'HEAD']).stdout;
  const scopedChecks = checks.map((check) => ({ ...check, scope: 'targeted' as const, repoRevision: integratedRevision }));
  const result = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks: scopedChecks });
  assert.equal(result.status, 'completed');
  assert.equal(fs.existsSync(workspace.root), false);
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8').trim(), 'implemented');
  const saved = getTask(task.id)!;
  assert.equal(saved.status, 'done');
  assert.equal(saved.branch, 'develop');
  assert.equal(saved.gitEvidence?.commit, git(root, ['rev-parse', 'HEAD']).stdout);
  assert.equal(saved.verificationEvidence?.[0]?.status, 'passed');
  assert.equal(saved.verificationEvidence?.[0]?.scope, 'targeted');
  assert.equal(saved.verificationEvidence?.[0]?.repoRevision, saved.gitEvidence?.commit);
  assert.equal(result.qualityDebt.status, 'clear');
  assert.deepEqual(result.qualityDebt.codes, []);
  assert.deepEqual((getTaskFinalizationOperation(result.operation.id)?.verification as any)?.qualityDebtSummary, result.qualityDebt);
  const context = getAgentTaskContext(state, task.id, false)!;
  assert.deepEqual(context.harness.qualityDebt, []);
  assert.deepEqual(context.harness.terminalQualityDebt, result.qualityDebt);
  assert.equal(saved.claim, undefined);
  assert.equal(getExecutionSessionState(execution.id).session.status, 'completed');
  assert.ok((saved.logs || []).some((entry: any) => /Finalized managed workspace/.test(entry.message)));
});

test('execution-stage finalization directly reconciles stale lifecycle metadata to finalized', () => {
  const { root, task, workspace, state } = fixture('execution-stage-direct');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'implemented\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'implement task')]);

  const claimed = getTask(task.id)!;
  claimed.claim = { workspaceId: workspace.workspaceId, sessionIdHash: 'fixture-session', ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveTask(claimed);
  const execution = createExecutionSession({ projectId: task.projectId, taskId: task.id, workspaceId: workspace.workspaceId, branch: workspace.branch, repoRoot: workspace.root });
  assert.equal(getExecutionSessionState(execution.id).session.lifecycle.stage, 'created');

  const result = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.integration.baseHeadAfter, git(root, ['rev-parse', 'HEAD']).stdout);
  const completedTask = getTask(task.id)!;
  assert.equal(completedTask.status, 'done');
  assert.equal(completedTask.claim, undefined);
  assert.equal(getExecutionSessionState(execution.id).session.status, 'completed');
  assert.equal(getExecutionSessionState(execution.id).session.lifecycle.stage, 'finalized');
  assert.equal(fs.existsSync(workspace.root), false);
});

test('finalization rejects malformed task commit subjects before mutating develop', () => {
  const { root, task, workspace, state } = fixture('malformed-subject');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'malformed\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', 'feat(scope): bypass task policy']);
  const baseHead = git(root, ['rev-parse', 'HEAD']).stdout;

  assert.throws(
    () => finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks }),
    (error: any) => error?.payload?.code === 'TASK_COMMIT_SUBJECT_INVALID',
  );
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, baseHead);
  assert.equal(getTask(task.id)?.status, 'in-progress');
  assert.equal(fs.existsSync(workspace.root), true);
});

test('dirty workspace is preserved as needs-recovery and task stays open', () => {
  const { task, workspace, state } = fixture('dirty');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'uncommitted\n');
  const result = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(result.status, 'needs-recovery');
  assert.equal(result.code, 'WORKSPACE_DIRTY');
  assert.equal(fs.existsSync(workspace.root), true);
  assert.equal(getTask(task.id)?.status, 'in-progress');
});

test('integration conflict is preserved and shared base is not marked done', () => {
  const { root, task, workspace, state } = fixture('conflict');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'workspace\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'workspace change')]);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base changed\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'advance base']);

  const result = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(result.status, 'needs-recovery');
  assert.equal(result.code, 'INTEGRATION_CONFLICT');
  assert.equal(fs.existsSync(workspace.root), true);
  assert.equal(getTask(task.id)?.status, 'in-progress');
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
});

test('finalization preserves checklist and verification debt while completing after a terminal combined-state verification attempt', () => {
  const incomplete = fixture('guards-incomplete');
  const saved = getTask(incomplete.task.id)!;
  saved.checklist[0].completed = false;
  saveTask(saved);
  const failedChecks = [{ name: 'focused', command: 'focused-test', status: 'failed' as const, summary: 'known quality debt' }];
  const withDebt = finalizeTaskWorkspace(incomplete.state, { taskId: incomplete.task.id, workspaceId: incomplete.workspace.workspaceId, checks: failedChecks });
  assert.equal(withDebt.status, 'completed');
  assert.equal(getTask(incomplete.task.id)?.status, 'done');
  assert.equal(getTask(incomplete.task.id)?.checklist?.[0]?.completed, false);
  assert.equal(fs.existsSync(incomplete.workspace.root), false);
  assert.deepEqual((withDebt.operation.verification as any)?.qualityDebt?.map((entry: any) => entry.code).sort(), ['CHECKLIST_INCOMPLETE', 'POST_INTEGRATION_VERIFICATION_REQUIRED', 'VERIFICATION_NOT_PASSED']);
  assert.deepEqual((getTaskFinalizationOperation(withDebt.operation.id)?.verification as any)?.qualityDebtSummary?.codes.slice().sort(), ['CHECKLIST_INCOMPLETE', 'POST_INTEGRATION_VERIFICATION_REQUIRED', 'VERIFICATION_NOT_PASSED']);

  const missing = fixture('guards-missing-verification');
  const withoutChecks = finalizeTaskWorkspace(missing.state, { taskId: missing.task.id, workspaceId: missing.workspace.workspaceId, checks: [] });
  assert.equal(withoutChecks.status, 'completed');
  assert.equal(getTask(missing.task.id)?.status, 'done');
  assert.equal(fs.existsSync(missing.workspace.root), false);
  assert.equal((withoutChecks.operation.verification as any)?.qualityDebt?.some((entry: any) => entry.code === 'POST_INTEGRATION_VERIFICATION_REQUIRED'), false);
  assert.equal((withoutChecks.operation.verification as any)?.qualityDebt?.some((entry: any) => entry.code === 'VERIFICATION_EVIDENCE_MISSING'), true);
});test('finalization freezes explicit checklist completion while preserving terminal verification debt', () => {
  const incomplete = fixture('checklist-attestation');
  const saved = getTask(incomplete.task.id)!;
  saved.checklist[0].completed = false;
  saveTask(saved);
  const failedChecks = [{ name: 'focused', command: 'focused-test', status: 'failed' as const, summary: 'known verification debt' }];

  const result = finalizeTaskWorkspace(incomplete.state, {
    taskId: incomplete.task.id,
    workspaceId: incomplete.workspace.workspaceId,
    checks: failedChecks,
    completedChecklistIds: ['done'],
  });

  assert.equal(result.status, 'completed');
  assert.equal(getTask(incomplete.task.id)?.status, 'done');
  assert.equal(getTask(incomplete.task.id)?.checklist?.[0]?.completed, true);
  assert.deepEqual((result.operation.verification as any)?.completedChecklistIds, ['done']);
  assert.equal((result.operation.verification as any)?.qualityDebt?.some((entry: any) => entry.code === 'CHECKLIST_INCOMPLETE'), false);
  assert.equal((result.operation.verification as any)?.qualityDebt?.some((entry: any) => entry.code === 'VERIFICATION_NOT_PASSED'), true);

  assert.throws(
    () => finalizeTaskWorkspace(incomplete.state, {
      taskId: incomplete.task.id,
      workspaceId: incomplete.workspace.workspaceId,
      operationId: result.operation.id,
      checks: failedChecks,
      completedChecklistIds: [],
    }),
    (error: any) => error?.payload?.code === 'FINALIZATION_CHECKLIST_OPERATION_MISMATCH' || error?.code === 'FINALIZATION_CHECKLIST_OPERATION_MISMATCH',
  );
});

test('finalization rejects invalid checklist completion ids before creating finalization state', () => {
  const incomplete = fixture('checklist-invalid');
  const saved = getTask(incomplete.task.id)!;
  saved.checklist[0].completed = false;
  saveTask(saved);

  assert.throws(
    () => finalizeTaskWorkspace(incomplete.state, {
      taskId: incomplete.task.id,
      workspaceId: incomplete.workspace.workspaceId,
      checks,
      completedChecklistIds: ['missing'],
    }),
    (error: any) => error?.payload?.code === 'FINALIZATION_CHECKLIST_ID_UNKNOWN' || error?.code === 'FINALIZATION_CHECKLIST_ID_UNKNOWN',
  );
  assert.equal(getTask(incomplete.task.id)?.checklist?.[0]?.completed, false);

  assert.throws(
    () => finalizeTaskWorkspace(incomplete.state, {
      taskId: incomplete.task.id,
      workspaceId: incomplete.workspace.workspaceId,
      checks,
      completedChecklistIds: ['done', 'done'],
    }),
    (error: any) => error?.payload?.code === 'FINALIZATION_CHECKLIST_IDS_DUPLICATE' || error?.code === 'FINALIZATION_CHECKLIST_IDS_DUPLICATE',
  );
  assert.equal(getTask(incomplete.task.id)?.checklist?.[0]?.completed, false);
});



test('finalization records combined-state verification escalation debt and still terminalizes after the attempt', () => {
  const { root, task, workspace, state } = fixture('combined-gate');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'implemented\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'implement task')]);
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"verify":"node -e \\\"process.exit(0)\\\""}}\n');
  git(root, ['add', 'package.json']);
  git(root, ['commit', '-m', 'sibling config change']);

  const paused = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(paused.status, 'completed');
  assert.ok(paused.integration.combinedChangedFiles.includes('package.json'));
  assert.equal(paused.postIntegration?.required, false);
  assert.equal((paused.operation.verification as any)?.qualityDebt?.some((entry: any) => entry.code === 'POST_INTEGRATION_VERIFICATION_REQUIRED'), false);
  assert.equal(paused.integration.baseHeadAfter, git(root, ['rev-parse', 'HEAD']).stdout);
  assert.equal(getTask(task.id)?.status, 'done');
  assert.equal(fs.existsSync(workspace.root), false);
});

test('reusable coverage finalizes after an unrelated base advance without rerunning verification', () => {
  const { root, task, workspace, state } = preparedCoverageFinalizationFixture('coverage-unrelated-base');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'unrelated base change\n');
  git(root, ['add', 'notes.txt']);
  git(root, ['commit', '-m', 'unrelated sibling note']);

  const result = finalizeTaskWorkspace(state, {
    taskId: task.id,
    workspaceId: workspace.workspaceId,
    checks: [],
  });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.postIntegration?.required, false);
  assert.equal((result.operation.verification as any)?.coverage?.target?.status, 'covered', JSON.stringify((result.operation.verification as any)?.coverage?.target));
  assert.match(String(result.verificationEvidence?.[0]?.summary || ''), /Reused authoritative GREEN verification coverage/);
  assert.equal(result.verificationEvidence?.[0]?.repoRevision, result.integration.baseHeadAfter);
  assert.equal(getTask(task.id)?.status, 'done');
});

test('combined repository mapping preserves missing integrated-head verification as terminal quality debt', () => {
  const { root, task, workspace, state } = fixture('combined-mapping');
  fs.mkdirSync(path.join(workspace.root, 'src', 'service'), { recursive: true });
  fs.writeFileSync(path.join(workspace.root, 'src', 'service', 'a.ts'), 'export const a = 1;\n');
  git(workspace.root, ['add', 'src/service/a.ts']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'service change')]);

  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'feature', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(root, '.devflow', 'verification-impact.json'), JSON.stringify({
    rules: [
      { id: 'service', patterns: ['src/service/**'], commands: ['test:service'] },
      { id: 'feature', patterns: ['src/feature/**'], commands: ['test:integration'] },
      { id: 'impact-policy', patterns: ['.devflow/verification-impact.json'], commands: ['test:integration'] },
    ],
  }));
  git(root, ['add', 'src/feature/b.ts', '.devflow/verification-impact.json']);
  git(root, ['commit', '-m', 'sibling feature and impact mapping']);

  const claimed = getTask(task.id)!;
  claimed.claim = { workspaceId: workspace.workspaceId, sessionIdHash: 'fixture-session', ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveTask(claimed);

  const first = finalizeTaskWorkspace(state, {
    taskId: task.id,
    workspaceId: workspace.workspaceId,
    checks: [{ name: 'service', command: 'test:service', status: 'passed' }],
  });

  assert.equal(first.status, 'completed');
  assert.deepEqual(first.combinedPlan.commands, ['test'], JSON.stringify({ combinedPlan: first.combinedPlan, postIntegration: first.postIntegration }));
  assert.deepEqual(first.combinedPlan.impact.unavailableChecks.map((entry: any) => entry.command).sort(), ['test:integration', 'test:service']);
  assert.equal(first.postIntegration.required, false);
  assert.deepEqual(first.postIntegration.missingCommands, []);
  assert.equal((first.operation.verification as any)?.qualityDebt?.some((entry: any) => entry.code === 'POST_INTEGRATION_VERIFICATION_REQUIRED'), false);
  const integratedHead = git(root, ['rev-parse', 'HEAD']).stdout;
  assert.equal(first.integration.baseHeadAfter, integratedHead);
  assert.equal(getTask(task.id)?.status, 'done');
  assert.equal(fs.existsSync(workspace.root), false);
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, integratedHead);
});

test('post-integration evidence failure returns a resumable continuation and retry does not integrate twice', () => {
  const { root, task, workspace, state } = fixture('post-integration-evidence-retry');
  __resetRecordedIntegrationValidationMetricsForTests();
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'implemented\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'implement task')]);
  const claimed = getTask(task.id)!;
  claimed.claim = { workspaceId: workspace.workspaceId, sessionIdHash: 'fixture-session', ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveTask(claimed);

  const first = finalizeTaskWorkspace(state, {
    taskId: task.id,
    workspaceId: workspace.workspaceId,
    checks: [{ name: 'broken-evidence', command: '', status: 'passed' }],
  });
  assert.equal(first.status, 'continuation');
  assert.equal(first.code, 'POST_INTEGRATION_FINALIZATION_REQUIRED');
  assert.equal(first.continuation.phase, 'verification-cleared');
  assert.equal(first.operation.phase, 'verification-cleared');
  assert.equal(first.continuation.error.code, 'VERIFICATION_COMMAND_REQUIRED');
  assert.equal(first.continuation.nextAction.action, 'RETRY_FINALIZE_TASK_WORKSPACE');
  assert.equal(first.continuation.nextAction.reintegrate, false);
  const integratedHead = git(root, ['rev-parse', 'HEAD']).stdout;
  assert.equal(first.integration.baseHeadAfter, integratedHead);
  assert.equal(getTask(task.id)?.status, 'in-progress');
  assert.equal(fs.existsSync(workspace.root), true);
  assert.deepEqual(__getRecordedIntegrationValidationMetricsForTests(), { durableHeadMatch: 0, reconstructed: 0 });

  const second = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(second.status, 'completed', JSON.stringify(second));
  assert.equal(second.operation.id, first.operation.id);
  assert.equal(second.integration.baseHeadAfter, integratedHead);
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, integratedHead);
  assert.deepEqual(__getRecordedIntegrationValidationMetricsForTests(), { durableHeadMatch: 1, reconstructed: 0 });
  assert.equal(getTask(task.id)?.status, 'done');
  assert.equal(fs.existsSync(workspace.root), false);
});

test('durable finalization operation resumes the same identity across injected phase failures without duplicate completion effects', () => {
  const boundaries = [
    'after-freeze',
    'after-integration',
    'after-verification-clear',
    'after-evidence',
    'after-execution-terminalization',
    'after-task-projection',
    'before-cleanup',
    'after-cleanup',
  ] as const;

  for (const boundary of boundaries) {
    const { root, task, workspace, state, execution } = preparedFinalizationFixture(`fault-${boundary}`);
    __resetRecordedIntegrationValidationMetricsForTests();
    const baseHeadBefore = git(root, ['rev-parse', 'HEAD']).stdout;
    __setTaskFinalizationFaultBoundaryForTests(boundary);
    let first: any;
    try {
      first = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
    } finally {
      __setTaskFinalizationFaultBoundaryForTests(null);
    }
    assert.notEqual(first.status, 'completed', `${boundary} should interrupt the first attempt`);
    assert.ok(first.operation?.id, `${boundary} must expose a durable operation id`);
    const durable = getTaskFinalizationOperation(first.operation.id)!;
    assert.equal(durable.id, first.operation.id);
    assert.equal(durable.taskId, task.id);
    assert.equal(durable.workspaceId, workspace.workspaceId);

    if (boundary === 'after-integration') {
      fs.writeFileSync(path.join(root, 'after-integration.txt'), 'base advanced after recorded integration\n');
      git(root, ['add', 'after-integration.txt']);
      git(root, ['commit', '-m', 'advance base after recorded integration']);
    }
    const headAfterFirst = git(root, ['rev-parse', 'HEAD']).stdout;
    const retry = finalizeTaskWorkspace(state, {
      taskId: task.id,
      workspaceId: workspace.workspaceId,
      operationId: first.operation.id,
      checks,
    });
    assert.equal(retry.status, 'completed', `${boundary}: ${JSON.stringify(retry)}`);
    assert.equal(retry.operation.id, first.operation.id);
    assert.equal(retry.operation.status, 'completed');
    if (boundary === 'after-integration') {
      assert.deepEqual(__getRecordedIntegrationValidationMetricsForTests(), { durableHeadMatch: 0, reconstructed: 1 });
    }
    assert.equal(getTaskFinalizationOperation(first.operation.id)?.status, 'completed');
    assert.equal(getTask(task.id)?.status, 'done');
    assert.equal(getExecutionSessionState(execution.id).session.status, 'completed');
    assert.equal((getTask(task.id)?.logs || []).filter((entry: any) => entry.id === `log-workspace-finalized-${first.operation.id}`).length, 1);
    assert.equal(fs.existsSync(workspace.root), false);
    if (boundary !== 'after-freeze') assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, headAfterFirst, `${boundary} must not integrate twice`);
    else assert.notEqual(git(root, ['rev-parse', 'HEAD']).stdout, baseHeadBefore);

    const replay = finalizeTaskWorkspace(state, {
      taskId: task.id,
      workspaceId: workspace.workspaceId,
      operationId: first.operation.id,
      checks,
    });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.operation.id, first.operation.id);
    assert.equal((getTask(task.id)?.logs || []).filter((entry: any) => entry.id === `log-workspace-finalized-${first.operation.id}`).length, 1);
  }
});

test('autonomous tail freezes explicit checklist completion attestation before finalization', async () => {
  const prepared = preparedAutonomousTailFixture('autonomous-checklist-attestation');
  const task = getTask(prepared.task.id)!;
  task.checklist = [{ id: 'done', text: 'implemented', completed: false }];
  saveTask(task);

  const result = await runTaskWorkspaceHappyPathTail(prepared.state, {
    taskId: prepared.task.id,
    workspaceId: prepared.workspace.workspaceId,
    commitMessage: 'feat: autonomous checklist attestation',
    triggerJobId: 'job-checklist-attestation',
    completedChecklistIds: ['done'],
  });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  const saved = getTask(prepared.task.id)!;
  assert.equal(saved.checklist?.find((item: any) => item.id === 'done')?.completed, true);
  assert.equal(result.result?.qualityDebt?.items?.some((entry: any) => entry.code === 'CHECKLIST_INCOMPLETE') ?? false, false);
});

test('autonomous tail resumes the same integrated operation after workspace runtime restart without duplicate terminal effects', async () => {
  const prepared = preparedAutonomousTailFixture('autonomous-restart-after-integration');
  const beforeCommitCount = Number(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout);
  __setTaskFinalizationFaultBoundaryForTests('after-integration');
  let first: any;
  try {
    first = await runTaskWorkspaceHappyPathTail(prepared.state, {
      taskId: prepared.task.id,
      workspaceId: prepared.workspace.workspaceId,
      commitMessage: 'feat: autonomous restart proof',
      triggerJobId: 'job-green-restart-proof',
    });
  } finally {
    __setTaskFinalizationFaultBoundaryForTests(null);
  }

  assert.equal(first.status, 'attention', JSON.stringify(first));
  assert.equal(first.code, 'POST_INTEGRATION_FINALIZATION_REQUIRED');
  assert.ok(first.operationId);
  const integratedHead = git(prepared.root, ['rev-parse', 'HEAD']).stdout;
  assert.equal(Number(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout), beforeCommitCount + 1);

  resetSessionWorkspaceRuntimeForTests();
  const resumed = await runTaskWorkspaceHappyPathTail(prepared.state, {
    taskId: prepared.task.id,
    workspaceId: prepared.workspace.workspaceId,
    commitMessage: 'feat: autonomous restart proof',
    triggerJobId: 'job-green-restart-proof',
  });

  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(resumed.operationId, first.operationId);
  assert.equal(git(prepared.root, ['rev-parse', 'HEAD']).stdout, integratedHead, 'restart recovery must not integrate twice');
  assert.equal(Number(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout), beforeCommitCount + 1, 'restart recovery must not create a duplicate commit');
  assert.equal((getTask(prepared.task.id)?.logs || []).filter((entry: any) => entry.id === `log-workspace-finalized-${first.operationId}`).length, 1);
  assert.equal(getTask(prepared.task.id)?.status, 'done');
  assert.equal(fs.existsSync(prepared.workspace.root), false);

  const replay = await runTaskWorkspaceHappyPathTail(prepared.state, {
    taskId: prepared.task.id,
    workspaceId: prepared.workspace.workspaceId,
    commitMessage: 'feat: autonomous restart proof',
    triggerJobId: 'job-green-restart-proof',
  });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.idempotent, true);
  assert.equal(Number(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout), beforeCommitCount + 1);
  assert.equal((getTask(prepared.task.id)?.logs || []).filter((entry: any) => entry.id === `log-workspace-finalized-${first.operationId}`).length, 1);
});

test('autonomous tail finalizes a verified clean no-op task without creating an empty commit', async () => {
  const prepared = preparedAutonomousNoOpTailFixture('autonomous-clean-no-op');
  const beforeHead = git(prepared.root, ['rev-parse', 'HEAD']).stdout;
  const beforeCount = Number(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout);

  const result = await runTaskWorkspaceHappyPathTail(prepared.state, {
    taskId: prepared.task.id,
    workspaceId: prepared.workspace.workspaceId,
    commitMessage: 'refactor: clean no-op coordination proof',
    triggerJobId: 'job-clean-no-op-proof',
  });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.transitions.some((entry: any) => entry.stage === 'commit' && entry.status === 'skipped-clean-no-op'), true);
  assert.equal(git(prepared.root, ['rev-parse', 'HEAD']).stdout, beforeHead);
  assert.equal(Number(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout), beforeCount, 'clean no-op tail must not create an empty commit');
  assert.equal(getTask(prepared.task.id)?.status, 'done');
  assert.equal(fs.existsSync(prepared.workspace.root), false);

  const replay = await runTaskWorkspaceHappyPathTail(prepared.state, {
    taskId: prepared.task.id,
    workspaceId: prepared.workspace.workspaceId,
    commitMessage: 'refactor: clean no-op coordination proof',
    triggerJobId: 'job-clean-no-op-proof',
  });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.idempotent, true);
  assert.equal(Number(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout), beforeCount);
});

test('task presentation drift after integration does not revoke a frozen finalization operation', () => {
  const { task, workspace, state, execution } = preparedFinalizationFixture('status-drift-resume');
  __setTaskFinalizationFaultBoundaryForTests('after-integration');
  let first: any;
  try {
    first = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  } finally {
    __setTaskFinalizationFaultBoundaryForTests(null);
  }
  assert.equal(first.operation.phase, 'integrated');
  const drifted = getTask(task.id)!;
  drifted.status = 'todo';
  drifted.updatedAt = new Date().toISOString();
  saveTask(drifted);

  const retry = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, operationId: first.operation.id, checks });
  assert.equal(retry.status, 'completed', JSON.stringify(retry));
  assert.equal(retry.operation.id, first.operation.id);
  assert.equal(getTask(task.id)?.status, 'done');
  assert.equal(getExecutionSessionState(execution.id).session.status, 'completed');
});

test('fresh retry can resume a frozen post-integration operation without resupplying prior checks', () => {
  const { task, workspace, state, execution } = preparedFinalizationFixture('resume-without-checks');
  __setTaskFinalizationFaultBoundaryForTests('after-integration');
  let first: any;
  try {
    first = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  } finally {
    __setTaskFinalizationFaultBoundaryForTests(null);
  }
  assert.equal(first.operation.phase, 'integrated');
  assert.ok(Array.isArray(getTaskFinalizationOperation(first.operation.id)?.verification?.submittedChecks));

  const retry = finalizeTaskWorkspace(state, {
    taskId: task.id,
    workspaceId: workspace.workspaceId,
    operationId: first.operation.id,
  });
  assert.equal(retry.status, 'completed', JSON.stringify(retry));
  assert.equal(retry.operation.id, first.operation.id);
  assert.equal(getTask(task.id)?.status, 'done');
  assert.equal(getExecutionSessionState(execution.id).session.status, 'completed');
});

test('frozen finalization operation rejects a changed source HEAD instead of silently adopting new work', () => {
  const { task, workspace, state } = preparedFinalizationFixture('source-fence');
  __setTaskFinalizationFaultBoundaryForTests('after-freeze');
  let first: any;
  try {
    first = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  } finally {
    __setTaskFinalizationFaultBoundaryForTests(null);
  }
  fs.writeFileSync(path.join(workspace.root, 'late.txt'), 'late work\n');
  git(workspace.root, ['add', 'late.txt']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'late work after freeze')]);

  assert.throws(
    () => finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, operationId: first.operation.id, checks }),
    (error: any) => error?.payload?.code === 'FINALIZATION_OPERATION_SOURCE_CHANGED',
  );
  assert.equal(getTask(task.id)?.status, 'in-progress');
  assert.equal(getTaskFinalizationOperation(first.operation.id)?.phase, 'frozen');
});

test('local finalization succeeds with an origin remote but no upstream or pushed head', () => {
  const { root, task, workspace, state } = fixture('local-no-upstream');
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-finalize-unpublished-origin-'));
  git(remote, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'implemented\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'implement task')]);
  const claimed = getTask(task.id)!;
  claimed.claim = { workspaceId: workspace.workspaceId, sessionIdHash: 'fixture-session', ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveTask(claimed);

  const result = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(result.status, 'completed');
  assert.equal(result.gitEvidence.commit, git(root, ['rev-parse', 'HEAD']).stdout);
  assert.equal(result.gitEvidence.trackingBranch, null);
  assert.equal(result.gitEvidence.remoteHead, null);
  assert.equal(result.gitEvidence.pushed, false);
  assert.equal(getTask(task.id)?.status, 'done');
});

test('cleanup failure is resumable after task evidence and lifecycle are durable', () => {
  const { root, task, workspace, state } = fixture('cleanup-retry');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'implemented\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'implement task')]);
  const claimed = getTask(task.id)!;
  claimed.claim = { workspaceId: workspace.workspaceId, sessionIdHash: 'fixture-session', ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveTask(claimed);
  const execution = createExecutionSession({ projectId: task.projectId, taskId: task.id, workspaceId: workspace.workspaceId, branch: workspace.branch, repoRoot: workspace.root });
  const advance = (toStage: any, id: string, kind: string) => recordExecutionLifecycleTransition(execution.id, {
    toStage,
    reasonCode: id,
    evidence: { id, kind, status: 'completed', operationId: `op-${id}` },
  });
  advance('context-ready', 'cleanup-context', 'context-bundle');
  advance('implementing', 'cleanup-change', 'owned-change');
  advance('verifying', 'cleanup-verify', 'verification-candidate');
  advance('committed', 'cleanup-commit', 'git-commit');
  acquireSessionWorkspace(workspace.workspaceId);

  const first = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(first.status, 'cleanup-pending');
  assert.equal(first.code, 'FINALIZATION_CLEANUP_PENDING');
  assert.equal(first.operation.phase, 'cleanup-pending');
  assert.equal(first.operation.status, 'cleanup-pending');
  assert.equal(first.operation.failure?.code, 'WORKSPACE_ACTIVE');
  const integratedHead = git(root, ['rev-parse', 'HEAD']).stdout;
  const durableTask = getTask(task.id)!;
  assert.equal(durableTask.status, 'done');
  assert.equal(durableTask.gitEvidence?.commit, integratedHead);
  assert.equal(getExecutionSessionState(execution.id).session.status, 'completed');
  assert.equal(getExecutionSessionState(execution.id).session.lifecycle.stage, 'finalized');
  const finalizationLogCount = (durableTask.logs || []).filter((entry: any) => /Finalized managed workspace/.test(entry.message)).length;
  assert.equal(finalizationLogCount, 1);
  assert.equal(fs.existsSync(workspace.root), true);

  releaseSessionWorkspace(workspace.workspaceId);
  const second = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(second.status, 'completed', JSON.stringify(second));
  assert.equal(second.operation.id, first.operation.id);
  assert.equal(second.integration.baseHeadAfter, integratedHead);
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, integratedHead);
  assert.equal((getTask(task.id)?.logs || []).filter((entry: any) => /Finalized managed workspace/.test(entry.message)).length, 1);
  assert.equal(fs.existsSync(workspace.root), false);
});

test('reopened prerequisite blocks terminal finalization while preserving dependent workspace WIP', () => {
  const prepared = preparedFinalizationFixture('prerequisite-drift');
  const prerequisite = {
    id: `prerequisite-${prepared.task.id}`,
    displayId: `PRE-${sequence}`,
    title: 'Prerequisite foundation',
    description: '',
    projectId: prepared.project.id,
    status: 'done',
    priority: 'medium',
    category: 'backend',
    tags: [],
    targetFiles: [],
    checklist: [],
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any;
  saveTask(prerequisite);
  const dependent = getTask(prepared.task.id)!;
  dependent.prerequisiteTaskIds = [prerequisite.id];
  saveTask(dependent);

  prerequisite.status = 'backlog';
  prerequisite.updatedAt = new Date().toISOString();
  saveTask(prerequisite);
  const sourceHeadBefore = git(prepared.workspace.root, ['rev-parse', 'HEAD']).stdout;
  const baseHeadBefore = git(prepared.root, ['rev-parse', 'HEAD']).stdout;

  assert.throws(
    () => finalizeTaskWorkspace(prepared.state, { taskId: prepared.task.id, workspaceId: prepared.workspace.workspaceId, checks }),
    (error: any) => error?.payload?.code === 'TASK_PREREQUISITE_DRIFT'
      && error?.payload?.details?.preserveWorkspace === true
      && error?.payload?.details?.blockers?.[0]?.taskId === prerequisite.id,
  );
  assert.equal(fs.existsSync(prepared.workspace.root), true, 'dependent WIP workspace must be preserved');
  assert.equal(git(prepared.workspace.root, ['rev-parse', 'HEAD']).stdout, sourceHeadBefore);
  assert.equal(git(prepared.root, ['rev-parse', 'HEAD']).stdout, baseHeadBefore, 'blocked finalization must not integrate source commit');
  assert.equal(getTask(prepared.task.id)?.status, 'in-progress');
});


test('autonomous tail implementation fans independent post-integration checks concurrently and preserves planned result order', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/server/services/taskWorkspaceHappyPathTailService.ts'), 'utf8');
  assert.match(source, /Promise\.all\([\s\S]*verificationRequests\.map/);
  assert.doesNotMatch(source, /for \(const request of verificationRequests\)/, 'post-integration checks must not be unconditionally serialized by the tail');
  assert.match(source, /verificationResults\.find/);
  assert.match(source, /verificationResults\.map/);
});

test('autonomous happy-path tail commits, finalizes, cleans up, and replays idempotently', async () => {
  const prepared = preparedAutonomousTailFixture('autonomous-happy');
  const beforeCommitCount = Number(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout);
  let postIntegrationRuns = 0;

  const first = await runTaskWorkspaceHappyPathTail(prepared.state, {
    taskId: prepared.task.id,
    workspaceId: prepared.workspace.workspaceId,
    commitMessage: 'feat: autonomous happy path',
    triggerJobId: 'job-green-happy',
  }, async () => {
    postIntegrationRuns += 1;
    return { ok: true, status: 'succeeded', exitCode: 0 };
  });

  assert.equal(first.status, 'completed', JSON.stringify(first));
  assert.equal(getTask(prepared.task.id)?.status, 'done');
  assert.equal(fs.existsSync(prepared.workspace.root), false);
  assert.equal(Number(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout), beforeCommitCount + 1);
  assert.equal(postIntegrationRuns, 0, 'unchanged base should reuse authoritative source verification');

  const replay = await runTaskWorkspaceHappyPathTail(prepared.state, {
    taskId: prepared.task.id,
    workspaceId: prepared.workspace.workspaceId,
    commitMessage: 'feat: autonomous happy path',
    triggerJobId: 'job-green-happy',
  });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.idempotent, true);
  assert.equal(Number(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout), beforeCommitCount + 1, 'replay must not duplicate commit/integration');
});

test('autonomous tail stops on post-integration verification failure and resumes the same finalization operation safely', async () => {
  const prepared = preparedAutonomousTailFixture('autonomous-post-integration');
  const packageJsonPath = path.join(prepared.root, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  packageJson.version = '1.0.1';
  packageJson.scripts.verify = 'node -e "process.exit(0)"';
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const verificationImpactPath = path.join(prepared.root, '.devflow', 'verification-impact.json');
  fs.mkdirSync(path.dirname(verificationImpactPath), { recursive: true });
  fs.writeFileSync(verificationImpactPath, `${JSON.stringify({
    rules: [{ id: 'package-combined-state', patterns: ['package.json'], commands: ['verify'], lane: 'full' }],
  }, null, 2)}\n`);
  git(prepared.root, ['add', 'package.json', '.devflow/verification-impact.json']);
  git(prepared.root, ['commit', '-m', 'chore: advance dependency state']);

  let verificationRuns = 0;
  const failed = await runTaskWorkspaceHappyPathTail(prepared.state, {
    taskId: prepared.task.id,
    workspaceId: prepared.workspace.workspaceId,
    commitMessage: 'feat: autonomous post integration',
    triggerJobId: 'job-green-post-integration',
  }, async () => {
    verificationRuns += 1;
    return { ok: false, status: 'failed', exitCode: 1 };
  });

  assert.equal(failed.status, 'attention', JSON.stringify(failed));
  assert.equal(failed.code, 'POST_INTEGRATION_VERIFICATION_FAILED');
  assert.equal(getTask(prepared.task.id)?.status, 'in-progress');
  assert.equal(fs.existsSync(prepared.workspace.root), true);
  const integratedHead = git(prepared.root, ['rev-parse', 'HEAD']).stdout;
  const operationId = (failed as any).operationId;
  assert.ok(operationId);

  const resumed = await runTaskWorkspaceHappyPathTail(prepared.state, {
    taskId: prepared.task.id,
    workspaceId: prepared.workspace.workspaceId,
    commitMessage: 'feat: autonomous post integration',
    triggerJobId: 'job-green-post-integration',
  }, async () => {
    verificationRuns += 1;
    return { ok: true, status: 'succeeded', exitCode: 0 };
  });

  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(resumed.operationId, operationId);
  assert.equal(git(prepared.root, ['rev-parse', 'HEAD']).stdout, integratedHead, 'resume must not integrate twice');
  assert.equal(getTask(prepared.task.id)?.status, 'done');
  assert.equal(fs.existsSync(prepared.workspace.root), false);
  assert.equal(verificationRuns >= 2, true);
});
