import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-root-isolation-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { resolveProjectRoot, readLocalFile, writeLocalFile } = await import('../../src/server/services/localFileService.js');
const { commitGitChanges, getGitStatus } = await import('../../src/server/services/gitService.js');
const { prepareCompactEdit } = await import('../../src/server/services/stenoEditProtocolService.js');
const { applyPreparedEditPlan } = await import('../../src/server/services/preparedEditService.js');
const {
  cleanupSessionWorkspace,
  createOrReuseSessionWorkspace,
  getSessionWorkspaceMetadataForRecovery,
  resetSessionWorkspaceRuntimeForTests,
} = await import('../../src/server/services/sessionWorkspaceService.js');
const { inspectWorkspaceRecovery } = await import('../../src/server/services/workspaceRecoveryService.js');
const { claimTaskForSession } = await import('../../src/server/services/taskClaimService.js');
const { finalizeTaskWorkspace } = await import('../../src/server/services/taskWorkspaceFinalizationService.js');
const executionSessions = await import('../../src/server/services/executionSessionService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function createRepo(name: string, value: string) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'value.txt'), value, 'utf8');
  git(root, ['init', '-b', 'develop']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  git(root, ['config', 'user.email', 'devflow@example.test']);  git(root, ['config', 'core.autocrlf', 'false']);

  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return root;
}

function errorCode(error: unknown) {
  return (error as any)?.payload?.code;
}

function finalizeThroughContinuation(state: any, taskId: string, workspaceId: string, initialCheck: any) {
  let result: any = finalizeTaskWorkspace(state, { taskId, workspaceId, checks: [initialCheck] });
  for (let attempt = 0; attempt < 3 && result.status === 'continuation'; attempt += 1) {
    const repoRevision = String(result.continuation?.repoRevision || result.postIntegration?.repoRevision || result.integration?.baseHeadAfter || '').trim();
    const requiredCommands = Array.isArray(result.continuation?.requiredCommands) && result.continuation.requiredCommands.length > 0
      ? result.continuation.requiredCommands
      : Array.isArray(result.postIntegration?.requiredCommands) && result.postIntegration.requiredCommands.length > 0
        ? result.postIntegration.requiredCommands
        : [initialCheck.command];
    const broad = result.continuation?.broadEvidenceRequired === true || result.postIntegration?.broadEvidenceRequired === true;
    const checks = repoRevision
      ? requiredCommands.map((command: string) => ({
          name: `post-integration:${command}`,
          command,
          scope: broad ? 'full' as const : 'targeted' as const,
          status: 'passed' as const,
          repoRevision,
          summary: 'post-integration regression evidence',
        }))
      : [initialCheck];
    result = finalizeTaskWorkspace(state, {
      taskId,
      workspaceId,
      operationId: result.operation?.id,
      checks,
    });
  }
  return result;
}


function markClaimedExecutionCommitted(workspaceId: string, label: string) {
  const active = executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId);
  assert.ok(active, `expected active task execution for ${workspaceId}`);
  const stages = ['context-ready', 'implementing', 'verifying', 'committed'] as const;
  for (const stage of stages) {
    executionSessions.recordExecutionLifecycleTransition(active.id, {
      toStage: stage,
      reasonCode: `${label}-${stage}`,
      evidence: { id: `${label}:${stage}`, kind: 'test-fixture', status: 'completed' },
    });
  }
}


test('workspaceId-only file and Git flows stay on the authoritative managed workspace root', () => {
  resetSessionWorkspaceRuntimeForTests();
  const projectRoot = createRepo('primary', 'base-copy\n');
  const project = {
    id: 'project-workspace-isolation',
    name: 'Workspace Isolation',
    repoUrl: 'https://example.com/workspace-isolation',
    localPath: projectRoot,
  };
  createProject(project);
  const state = { projectsCache: [project] } as any;
  const workspace = createOrReuseSessionWorkspace(project, 'workspace-isolation-session');
  assert.match(path.basename(workspace.root), /^ws_[a-f0-9]{16}$/);

  try {
    const resolvedRoot = resolveProjectRoot(state, { workspaceId: workspace.workspaceId });
    assert.equal(path.resolve(resolvedRoot), path.resolve(workspace.root), 'workspaceId alone must select the managed worktree before any mutation');

    const write = writeLocalFile(state, {
      workspaceId: workspace.workspaceId,
      filePath: 'value.txt',
      content: 'workspace-copy\n',
    });
    assert.equal(path.resolve(write.root), path.resolve(workspace.root));
    assert.equal(fs.readFileSync(path.join(projectRoot, 'value.txt'), 'utf8'), 'base-copy\n');
    assert.equal(fs.readFileSync(path.join(workspace.root, 'value.txt'), 'utf8'), 'workspace-copy\n');

    const status = getGitStatus(state, { workspaceId: workspace.workspaceId, mode: 'compact' });
    assert.equal(path.resolve(status.root), path.resolve(workspace.root));
    assert.deepEqual(status.files.map((entry: any) => entry.path), ['value.txt']);

    const recovery = inspectWorkspaceRecovery(workspace.workspaceId);
    assert.equal(recovery.disposition, 'needs-recovery');
    assert.deepEqual(recovery.dirtyFiles, ['value.txt']);

    const read = readLocalFile(state, {
      workspaceId: workspace.workspaceId,
      filePath: 'value.txt',
      includeFileRef: true,
    });
    assert.equal(read.content, 'workspace-copy\n');
    assert.match(String(read.fileRef || ''), /^file-ref-/);

    const plan = prepareCompactEdit(state, {
      workspaceId: workspace.workspaceId,
      v: 1,
      f: [[read.fileRef, [['R', 'workspace-copy', 'workspace-compact-edit']]]],
      responseMode: 'compact',
    });
    assert.equal(plan.ok, true);
    assert.match(String(plan.editPlanId || ''), /^edit-plan-/);
    const applied = applyPreparedEditPlan({ editPlanId: plan.editPlanId });
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(path.join(workspace.root, 'value.txt'), 'utf8'), 'workspace-compact-edit\n');
    assert.equal(fs.readFileSync(path.join(projectRoot, 'value.txt'), 'utf8'), 'base-copy\n');
  } finally {
    git(workspace.root, ['restore', '--staged', '--worktree', '--', 'value.txt']);
    cleanupSessionWorkspace(workspace.workspaceId);
  }
});

test('prepared edit rejects stale task execution provenance before writing', () => {
  resetSessionWorkspaceRuntimeForTests();
  const projectRoot = createRepo('prepared-execution-provenance', 'before\n');
  const project = {
    id: 'project-prepared-execution-provenance',
    name: 'Prepared Execution Provenance',
    repoUrl: 'https://example.com/prepared-execution-provenance',
    localPath: projectRoot,
  };
  createProject(project);
  const state = { projectsCache: [project] } as any;
  const workspace = createOrReuseSessionWorkspace(project, 'prepared-execution-provenance-session');
  const execution = executionSessions.createExecutionSession({
    projectId: project.id,
    taskId: 'task-prepared-execution-provenance',
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
  });

  try {
    const read = readLocalFile(state, { workspaceId: workspace.workspaceId, filePath: 'value.txt', includeFileRef: true });
    const plan = prepareCompactEdit(state, {
      workspaceId: workspace.workspaceId,
      v: 1,
      f: [[read.fileRef, [['R', 'before', 'after']]]],
      responseMode: 'compact',
    });
    assert.equal(plan.ok, true);
    executionSessions.cancelExecutionSession(execution.id);

    const applied = applyPreparedEditPlan({ editPlanId: plan.editPlanId });
    assert.equal(applied.ok, false);
    assert.equal(applied.code, 'EDIT_PLAN_STALE');
    assert.match(String(applied.message || ''), /execution|workspace/i);
    assert.equal(fs.readFileSync(path.join(workspace.root, 'value.txt'), 'utf8'), 'before\n');
  } finally {
    cleanupSessionWorkspace(workspace.workspaceId);
  }
});

test('explicit workspace metadata fails closed when missing, stale, or conflicting', () => {
  resetSessionWorkspaceRuntimeForTests();
  const primaryRoot = createRepo('negative-primary', 'primary\n');
  const otherRoot = createRepo('negative-other', 'other\n');
  const primary = {
    id: 'project-workspace-negative-primary',
    name: 'Workspace Negative Primary',
    repoUrl: 'https://example.com/workspace-negative-primary',
    localPath: primaryRoot,
  };
  const other = {
    id: 'project-workspace-negative-other',
    name: 'Workspace Negative Other',
    repoUrl: 'https://example.com/workspace-negative-other',
    localPath: otherRoot,
  };
  createProject(primary);
  createProject(other);
  const state = { projectsCache: [primary, other] } as any;
  const workspace = createOrReuseSessionWorkspace(primary, 'workspace-negative-session');

  assert.throws(
    () => resolveProjectRoot(state, { workspaceId: 'ws_missing_workspace' }),
    (error: unknown) => errorCode(error) === 'WORKSPACE_NOT_FOUND',
  );
  assert.throws(
    () => resolveProjectRoot(state, { projectId: other.id, workspaceId: workspace.workspaceId }),
    (error: unknown) => errorCode(error) === 'WORKSPACE_PROJECT_MISMATCH' || errorCode(error) === 'WORKSPACE_NOT_FOUND',
  );

  cleanupSessionWorkspace(workspace.workspaceId);
  assert.throws(
    () => resolveProjectRoot(state, { workspaceId: workspace.workspaceId }),
    (error: unknown) => errorCode(error) === 'WORKSPACE_NOT_FOUND',
  );
  assert.equal(fs.readFileSync(path.join(primaryRoot, 'value.txt'), 'utf8'), 'primary\n');
  assert.equal(fs.readFileSync(path.join(otherRoot, 'value.txt'), 'utf8'), 'other\n');
});

test('task-bound mutation authorization requires active claimed scope and honors reserved paths', () => {
  resetSessionWorkspaceRuntimeForTests();
  const projectRoot = createRepo('mutation-scope', 'value-before\n');
  fs.writeFileSync(path.join(projectRoot, 'extra.txt'), 'extra-before\n', 'utf8');
  git(projectRoot, ['add', 'extra.txt']);
  git(projectRoot, ['commit', '-m', 'add extra fixture']);
  const project = {
    id: 'project-workspace-mutation-scope',
    name: 'Workspace Mutation Scope',
    repoUrl: 'https://example.com/workspace-mutation-scope',
    localPath: projectRoot,
  };
  createProject(project);
  const now = new Date().toISOString();
  const task = {
    id: 'task-workspace-mutation-scope',
    displayId: 'DVF-SCOPE-0001',
    title: 'Task mutation scope regression',
    description: 'Proves mutation authorization is bound to active target and reserved scope.',
    projectId: project.id,
    status: 'todo',
    priority: 'high',
    category: 'backend',
    tags: [],
    targetFiles: ['value.txt'],
    checklist: [],
    logs: [],
    bugs: [],
    images: [],
    createdAt: now,
    updatedAt: now,
  } as any;
  saveTask(task);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, {
    sessionId: 'workspace-mutation-scope-session',
    ownerKind: 'chat',
    ownerLabel: 'Scope regression',
  });
  const workspaceId = claimed.claim.workspaceId;
  const workspaceRoot = resolveProjectRoot(state, { workspaceId });  const sharedValueBefore = fs.readFileSync(path.join(projectRoot, 'value.txt'), 'utf8');

  try {
    assert.doesNotThrow(() => executionSessions.authorizeTaskExecutionMutationPaths({ workspaceId }, ['value.txt']));    assert.throws(
      () => writeLocalFile(state, {
        projectId: project.id,
        filePath: 'value.txt',
        content: 'shared-escape-must-be-blocked\n',
        __authorizeOwnedChanges: (paths: string[]) => executionSessions.authorizeTaskExecutionMutationPaths({ projectId: project.id }, paths),
      }),
      (error: any) => error?.payload?.code === 'TASK_MUTATION_WORKSPACE_REQUIRED',
    );
    assert.equal(fs.readFileSync(path.join(projectRoot, 'value.txt'), 'utf8'), sharedValueBefore);

    assert.throws(
      () => executionSessions.authorizeTaskExecutionMutationPaths({ workspaceId }, ['extra.txt']),
      (error: any) => error?.payload?.code === 'TASK_SCOPE_EXPANSION_REQUIRED',
    );
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'extra.txt'), 'utf8'), 'extra-before\n');

    const active = getTask(task.id)!;
    saveTask({ ...active, claim: { ...active.claim, reservedPaths: ['extra.txt'] }, updatedAt: new Date().toISOString() });
    assert.doesNotThrow(() => executionSessions.authorizeTaskExecutionMutationPaths({ workspaceId }, ['extra.txt']));

    const reservedWrite = writeLocalFile(state, {
      workspaceId,
      filePath: 'extra.txt',
      content: 'extra-after\n',
      __authorizeOwnedChanges: (paths: string[]) => executionSessions.authorizeTaskExecutionMutationPaths({ workspaceId }, paths),
      __recordOwnedChanges: (paths: string[]) => executionSessions.recordTaskExecutionMutationPaths({ workspaceId }, paths, 'test'),
    });
    assert.equal(reservedWrite.changed, true);
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'extra.txt'), 'utf8'), 'extra-after\n');
    const ownership = executionSessions.getExecutionOwnershipState(
      executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)!.id,
      { repoRoot: workspaceRoot },
    );
    assert.deepEqual(ownership.scopeDrift, [], 'reserved paths must remain inside commit/review scope');

    const refreshed = getTask(task.id)!;
    saveTask({
      ...refreshed,
      claim: { ...refreshed.claim, expiresAt: new Date(Date.now() - 1_000).toISOString() },
      updatedAt: new Date().toISOString(),
    });
    assert.throws(
      () => executionSessions.authorizeTaskExecutionMutationPaths({ workspaceId }, ['value.txt']),
      (error: any) => error?.payload?.code === 'TASK_MUTATION_ACTIVE_CLAIM_REQUIRED',
    );
  } finally {
    fs.writeFileSync(path.join(projectRoot, 'value.txt'), sharedValueBefore, 'utf8');
    git(workspaceRoot, ['restore', '--staged', '--worktree', '--', 'extra.txt']);
    const live = getTask(task.id);
    if (live?.claim) saveTask({ ...live, claim: undefined, updatedAt: new Date().toISOString() });
    const activeExecution = executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId);
    if (activeExecution) executionSessions.cancelExecutionSession(activeExecution.id);
    cleanupSessionWorkspace(workspaceId);
  }
});

test('claimed workspace commit and finalization keep the shared base untouched until integration', () => {
  resetSessionWorkspaceRuntimeForTests();
  const projectRoot = createRepo('finalize-flow', 'base-before-finalize\n');
  const project = {
    id: 'project-workspace-finalize-flow',
    name: 'Workspace Finalize Flow',
    repoUrl: 'https://example.com/workspace-finalize-flow',
    localPath: projectRoot,
  };
  createProject(project);
  const now = new Date().toISOString();
  const task = {
    id: 'task-workspace-finalize-flow',
    displayId: 'DVF-ROOT-0001',
    title: 'Workspace finalize isolation regression',
    description: 'Proves claimed workspace mutation, commit, recovery, and finalization share one authoritative root.',
    projectId: project.id,
    status: 'todo',
    priority: 'high',
    branch: 'develop',
    category: 'backend',
    tags: [],
    targetFiles: ['value.txt'],
    checklist: [{ id: 'implemented', text: 'implemented', completed: true }],
    verificationEvidence: [],
    logs: [],
    bugs: [],
    images: [],
    designImages: [],
    createdAt: now,
    updatedAt: now,
  } as any;
  saveTask(task);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, {
    sessionId: 'workspace-finalize-flow-session',
    ownerKind: 'chat',
    ownerLabel: 'Isolation regression',
  });
  const workspaceId = claimed.claim.workspaceId;
  const workspaceRoot = resolveProjectRoot(state, { workspaceId });

  writeLocalFile(state, {
    workspaceId,
    filePath: 'value.txt',
    content: 'implemented-in-workspace\n',
  });
  assert.equal(fs.readFileSync(path.join(projectRoot, 'value.txt'), 'utf8'), 'base-before-finalize\n');
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'value.txt'), 'utf8'), 'implemented-in-workspace\n');
  assert.deepEqual(getGitStatus(state, { workspaceId, mode: 'compact' }).files.map((entry: any) => entry.path), ['value.txt']);

  git(workspaceRoot, ['add', 'value.txt']);
  git(workspaceRoot, ['commit', '-m', '[DVF-ROOT-0001] test: workspace root isolation']);
  const committedHead = git(workspaceRoot, ['rev-parse', 'HEAD']);
  assert.match(committedHead, /^[0-9a-f]{40}$/);  markClaimedExecutionCommitted(workspaceId, 'root-isolation-finalize');

  assert.equal(fs.readFileSync(path.join(projectRoot, 'value.txt'), 'utf8'), 'base-before-finalize\n', 'workspace commit must not mutate shared base before integration');
  const recovery = inspectWorkspaceRecovery(workspaceId);
  assert.equal(recovery.disposition, 'committed-not-integrated');
  assert.equal(recovery.dirtyFiles.length, 0);
  assert.equal(recovery.uniqueCommits.length, 1);

  const finalized = finalizeThroughContinuation(state, task.id, workspaceId, {
    name: 'workspace-root-isolation',
    command: 'focused-regression',
    status: 'passed',
    summary: 'workspace root isolation regression passed',
  });
  assert.equal(finalized.status, 'completed');
  assert.equal(fs.existsSync(workspaceRoot), false);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'value.txt'), 'utf8').trim(), 'implemented-in-workspace');
  assert.equal(git(projectRoot, ['status', '--porcelain']), '');
  assert.equal(getTask(task.id)?.status, 'done');
});


test('feature-target finalization updates only the declared task branch while develop stays untouched', () => {
  resetSessionWorkspaceRuntimeForTests();
  const projectRoot = createRepo('feature-finalize-flow', 'develop-before-feature-finalize\n');
  const project = {
    id: 'project-workspace-feature-finalize-flow',
    name: 'Workspace Feature Finalize Flow',
    repoUrl: 'https://example.com/workspace-feature-finalize-flow',
    localPath: projectRoot,
  };
  createProject(project);
  const targetBranch = 'feature/workspace-finalize-target';
  const developBefore = git(projectRoot, ['rev-parse', 'develop']);
  const now = new Date().toISOString();
  const task = {
    id: 'task-workspace-feature-finalize-flow',
    displayId: 'DVF-ROOT-0002',
    title: 'Workspace feature target finalization regression',
    description: 'Proves task branch authority integrates without switching or mutating the shared develop checkout.',
    projectId: project.id,
    status: 'todo',
    priority: 'high',
    branch: targetBranch,
    category: 'backend',
    tags: [],
    targetFiles: ['value.txt'],
    checklist: [{ id: 'implemented', text: 'implemented', completed: true }],
    verificationEvidence: [],
    logs: [],
    bugs: [],
    images: [],
    designImages: [],
    createdAt: now,
    updatedAt: now,
  } as any;
  saveTask(task);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, {
    sessionId: 'workspace-feature-finalize-flow-session',
    ownerKind: 'chat',
    ownerLabel: 'Feature target regression',
  });
  const workspaceId = claimed.claim.workspaceId;
  const workspaceRoot = resolveProjectRoot(state, { workspaceId });
  assert.equal(git(projectRoot, ['branch', '--show-current']), 'develop');
  assert.equal(getSessionWorkspaceMetadataForRecovery(workspaceId)?.baseBranch, targetBranch);

  writeLocalFile(state, {
    workspaceId,
    filePath: 'value.txt',
    content: 'implemented-on-feature-target\n',
  });
  git(workspaceRoot, ['add', 'value.txt']);
  git(workspaceRoot, ['commit', '-m', '[DVF-ROOT-0002] test: feature target isolation']);
  assert.match(git(workspaceRoot, ['rev-parse', 'HEAD']), /^[0-9a-f]{40}$/);  markClaimedExecutionCommitted(workspaceId, 'feature-target-finalize');


  const finalized = finalizeThroughContinuation(state, task.id, workspaceId, {
    name: 'feature-target-isolation',
    command: 'focused-regression',
    status: 'passed',
    summary: 'feature target isolation regression passed',
  });
  assert.equal(finalized.status, 'completed');
  assert.equal(git(projectRoot, ['branch', '--show-current']), 'develop');
  assert.equal(git(projectRoot, ['rev-parse', 'develop']), developBefore);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'value.txt'), 'utf8'), 'develop-before-feature-finalize\n');
  assert.equal(git(projectRoot, ['show', `${targetBranch}:value.txt`]), 'implemented-on-feature-target');
  assert.equal(getTask(task.id)?.status, 'done');
});


test.after(() => {
  resetSessionWorkspaceRuntimeForTests();
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {}
});
