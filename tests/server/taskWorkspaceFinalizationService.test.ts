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
const { createExecutionSession, getExecutionSessionState, recordExecutionLifecycleTransition } = await import('../../src/server/services/executionSessionService.js');
const { finalizeTaskWorkspace, __setTaskFinalizationFaultBoundaryForTests } = await import('../../src/server/services/taskWorkspaceFinalizationService.js');
const { getTaskFinalizationOperation } = await import('../../src/server/repositories/taskFinalizationOperationRepository.js');

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

  const result = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(result.status, 'completed');
  assert.equal(fs.existsSync(workspace.root), false);
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8').trim(), 'implemented');
  const saved = getTask(task.id)!;
  assert.equal(saved.status, 'done');
  assert.equal(saved.branch, 'develop');
  assert.equal(saved.gitEvidence?.commit, git(root, ['rev-parse', 'HEAD']).stdout);
  assert.equal(saved.verificationEvidence?.[0]?.status, 'passed');
  assert.equal(saved.claim, undefined);
  assert.equal(getExecutionSessionState(execution.id).session.status, 'completed');
  assert.ok((saved.logs || []).some((entry: any) => /Finalized managed workspace/.test(entry.message)));
});

test('execution-stage finalization failure keeps task, claim, and execution recoverable before idempotent retry', () => {
  const { root, task, workspace, state } = fixture('execution-stage-retry');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'implemented\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'implement task')]);

  const claimed = getTask(task.id)!;
  claimed.claim = { workspaceId: workspace.workspaceId, sessionIdHash: 'fixture-session', ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveTask(claimed);
  const execution = createExecutionSession({ projectId: task.projectId, taskId: task.id, workspaceId: workspace.workspaceId, branch: workspace.branch, repoRoot: workspace.root });

  const first = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(first.status, 'continuation', JSON.stringify(first));
  assert.equal(first.code, 'POST_INTEGRATION_FINALIZATION_REQUIRED');
  assert.equal(first.continuation.phase, 'evidence-recorded');
  assert.equal(first.operation.phase, 'evidence-recorded');
  assert.equal(first.continuation.operationId, first.operation.id);
  assert.equal(first.continuation.error.code, 'TASK_FINALIZATION_EXECUTION_STAGE_INVALID');
  const integratedHead = git(root, ['rev-parse', 'HEAD']).stdout;
  const afterFailure = getTask(task.id)!;
  assert.equal(afterFailure.status, 'in-progress');
  assert.equal(afterFailure.claim?.workspaceId, workspace.workspaceId);
  assert.equal(getExecutionSessionState(execution.id).session.status, 'active');
  assert.equal(getExecutionSessionState(execution.id).session.lifecycle.stage, 'created');
  assert.equal(fs.existsSync(workspace.root), true);

  advanceExecutionToCommitted(execution.id, 'stage-retry');
  const second = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(second.status, 'completed', JSON.stringify(second));
  assert.equal(second.operation.id, first.operation.id);
  assert.equal(second.integration.baseHeadAfter, integratedHead);
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

test('finalization refuses incomplete checklist and missing verification before integration', () => {
  const { task, workspace, state } = fixture('guards');
  const saved = getTask(task.id)!;
  saved.checklist[0].completed = false;
  saveTask(saved);
  const checklistBlocked = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(checklistBlocked.status, 'blocked');
  assert.equal(checklistBlocked.code, 'CHECKLIST_INCOMPLETE');
  saved.checklist[0].completed = true;
  saveTask(saved);
  const verificationBlocked = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks: [] });
  assert.equal(verificationBlocked.status, 'blocked');
  assert.equal(verificationBlocked.code, 'VERIFICATION_EVIDENCE_MISSING');
  assert.equal(fs.existsSync(workspace.root), true);
});


test('finalization blocks pre-integration evidence when sibling changes escalate combined-state verification', () => {
  const { root, task, workspace, state } = fixture('combined-gate');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'implemented\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', taskCommitSubject(task, 'implement task')]);
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"verify":"node -e \\\"process.exit(0)\\\""}}\n');
  git(root, ['add', 'package.json']);
  git(root, ['commit', '-m', 'sibling config change']);

  const preIntegration = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(preIntegration.status, 'continuation');
  assert.equal(preIntegration.code, 'POST_INTEGRATION_VERIFICATION_REQUIRED');
  assert.ok(preIntegration.integration.combinedChangedFiles.includes('package.json'));
  assert.equal(getTask(task.id)?.status, 'in-progress');

  const integratedHead = git(root, ['rev-parse', 'HEAD']).stdout;
  assert.equal(preIntegration.continuation.repoRevision, integratedHead);
  assert.deepEqual(preIntegration.continuation.requiredCommands, preIntegration.postIntegration.requiredCommands);
  assert.deepEqual(preIntegration.continuation.missingCommands, preIntegration.postIntegration.missingCommands);
  assert.equal(preIntegration.continuation.broadEvidenceRequired, preIntegration.postIntegration.broadEvidenceRequired);
  assert.equal(preIntegration.continuation.requiredScope, preIntegration.postIntegration.broadEvidenceRequired ? 'broad-or-full' : 'targeted');
  assert.equal(preIntegration.continuation.nextAction.action, 'RUN_POST_INTEGRATION_VERIFICATION_AND_RETRY');
  assert.equal(preIntegration.continuation.nextAction.tool, 'finalize_task_workspace');
  assert.equal(preIntegration.continuation.nextAction.bindChecksToRepoRevision, true);
  const postIntegrationChecks = [
    ...checks,
    { name: 'combined-full', command: 'verify', scope: 'full' as const, status: 'passed' as const, repoRevision: integratedHead },
  ];
  const completed = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks: postIntegrationChecks });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.operation.id, preIntegration.operation.id);
  assert.equal(completed.integration.baseHeadAfter, integratedHead);
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, integratedHead);
  assert.equal(getTask(task.id)?.status, 'done');
});

test('combined repository mapping can require a verification command absent from pre-integration evidence', () => {
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

  const result = finalizeTaskWorkspace(state, {
    taskId: task.id,
    workspaceId: workspace.workspaceId,
    checks: [{ name: 'service', command: 'test:service', status: 'passed' }],
  });

  assert.equal(result.status, 'continuation');
  assert.equal(result.code, 'POST_INTEGRATION_VERIFICATION_REQUIRED');
  assert.ok(result.combinedPlan.commands.includes('test:integration'));
  assert.ok(result.postIntegration.missingCommands.includes('test:integration'));
  assert.equal(getTask(task.id)?.status, 'in-progress');
});

test('post-integration evidence failure returns a resumable continuation and retry does not integrate twice', () => {
  const { root, task, workspace, state } = fixture('post-integration-evidence-retry');
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

  const second = finalizeTaskWorkspace(state, { taskId: task.id, workspaceId: workspace.workspaceId, checks });
  assert.equal(second.status, 'completed', JSON.stringify(second));
  assert.equal(second.operation.id, first.operation.id);
  assert.equal(second.integration.baseHeadAfter, integratedHead);
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout, integratedHead);
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
