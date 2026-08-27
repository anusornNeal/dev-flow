import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-git-workflow-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_APP_ROOT = tempRoot;

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTasks } = await import('../../src/server/repositories/taskRepository.js');
const {
  buildTaskGitWarnings,
  deriveParentCompletionVerificationEvidence,
  evaluateReviewSubmission,
  syncTaskWithGit,
  validateRecordedReviewSubmission,
} = await import('../../src/server/services/taskGitWorkflowService.js');
const { pushGitBranch, clearGitRemoteEvidenceCache, getGitRemoteEvidenceMetrics } = await import('../../src/server/services/gitService.js');
const { createOrReuseSessionWorkspace } = await import('../../src/server/services/sessionWorkspaceService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function createRepository(name: string) {
  const root = path.join(tempRoot, name);
  const remote = path.join(tempRoot, `${name}-origin.git`);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(remote, { recursive: true });
  git(remote, ['init', '--bare']);
  git(root, ['init', '-b', 'develop']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'initial']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-u', 'origin', 'develop']);
  return { root, remote };
}

function createTask(projectId: string, overrides: Record<string, any> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `task-${Math.random().toString(36).slice(2)}`,
    displayId: overrides.displayId,
    projectId,
    title: 'Workflow task',
    description: 'Test task',
    status: 'in-progress',
    priority: 'high',
    branch: 'develop',
    category: 'backend',
    tags: [],
    targetFiles: ['src/example.ts'],
    checklist: [{ id: 'one', text: 'Done', completed: true }],
    bugs: [],
    logs: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setup(name: string) {
  const repo = createRepository(name);
  const projectId = `project-${name}`;
  createProject({
    id: projectId,
    name: `Project ${name}`,
    repoUrl: repo.remote,
    localPath: repo.root,
    taskIdPrefix: 'TST',
  });
  return { ...repo, projectId, state: {} as any };
}

const passedChecks = [{ name: 'unit-tests', command: 'npm test', status: 'passed', summary: 'All tests passed' }];

test('syncTaskWithGit records published head and normalized verification evidence', () => {
  const fixture = setup('sync-pass');
  const task = createTask(fixture.projectId);

  const result = syncTaskWithGit(fixture.state, task, {
    remote: 'origin',
    fetch: true,
    checks: passedChecks,
  });

  assert.equal(result.gitEvidence.branch, 'develop');
  assert.equal(result.gitEvidence.pushed, true);
  assert.equal(result.gitEvidence.ahead, 0);
  assert.equal(result.gitEvidence.behind, 0);
  assert.equal(result.gitEvidence.workingTreeClean, true);
  assert.equal(result.verificationEvidence[0].status, 'passed');
  assert.ok(result.verificationEvidence[0].recordedAt);

  const exactHead = git(fixture.root, ['rev-parse', 'HEAD']);
  const exact = syncTaskWithGit(fixture.state, task, {
    remote: 'origin',
    fetch: false,
    checks: [{ ...passedChecks[0], scope: 'full', repoRevision: exactHead }],
  });
  assert.equal(exact.verificationEvidence[0].scope, 'full');
  assert.equal(exact.verificationEvidence[0].repoRevision, exactHead);
});


test('workspace-bound Git evidence stays on the implementation worktree when develop advances concurrently', () => {
  const fixture = setup('workspace-evidence');
  const workspace = createOrReuseSessionWorkspace({ id: fixture.projectId, localPath: fixture.root }, 'task-workspace-evidence');
  const claimedAt = new Date().toISOString();
  const task = createTask(fixture.projectId, {
    branch: 'develop',
    claim: {
      sessionIdHash: 'workspace-evidence',
      workspaceId: workspace.workspaceId,
      ownerKind: 'chat',
      ownerLabel: 'Chat Evidence',
      claimedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  fs.writeFileSync(path.join(workspace.root, 'workspace.txt'), 'task implementation\n');
  git(workspace.root, ['add', 'workspace.txt']);
  git(workspace.root, ['commit', '-m', 'task implementation']);
  const implementationHead = git(workspace.root, ['rev-parse', 'HEAD']);

  fs.writeFileSync(path.join(fixture.root, 'unrelated.txt'), 'other chat integration\n');
  git(fixture.root, ['add', 'unrelated.txt']);
  git(fixture.root, ['commit', '-m', 'unrelated develop work']);
  const unrelatedDevelopHead = git(fixture.root, ['rev-parse', 'HEAD']);
  assert.notEqual(implementationHead, unrelatedDevelopHead);

  const result = syncTaskWithGit(fixture.state, task, {
    workspaceId: workspace.workspaceId,
    remote: 'origin',
    fetch: false,
    checks: passedChecks,
  });

  assert.equal(result.gitEvidence.branch, workspace.branch);
  assert.equal(result.gitEvidence.commit, implementationHead);
  assert.notEqual(result.gitEvidence.commit, unrelatedDevelopHead);
  assert.equal(result.gitEvidence.workspaceId, workspace.workspaceId);
  assert.equal(result.gitEvidence.evidenceSource, 'managed-workspace');
  assert.equal(result.gitEvidence.targetBranch, 'develop');
  assert.equal(result.gitEvidence.workspaceBranch, workspace.branch);
  assert.notEqual(result.gitEvidence.targetBranch, result.gitEvidence.workspaceBranch);

  const recorded = validateRecordedReviewSubmission(result.task, { requirePushedHead: false });
  assert.equal(recorded.readinessDebt.some((entry: any) => entry.code === 'TASK_BRANCH_MISMATCH'), false);
  assert.equal(recorded.readinessDebt.some((entry: any) => entry.code === 'TASK_BRANCH_EVIDENCE_INCOMPLETE'), false);
  const warnings = buildTaskGitWarnings(result.task);
  assert.equal(warnings.some((entry: any) => entry.code === 'TASK_BRANCH_MISMATCH' || entry.code === 'RECORDED_BRANCH_MISMATCH'), false);
});

test('workspace-bound Git evidence rejects a workspace that is not the task active claim', () => {
  const fixture = setup('workspace-foreign-claim');
  const workspace = createOrReuseSessionWorkspace({ id: fixture.projectId, localPath: fixture.root }, 'workspace-foreign-claim');
  const claimedAt = new Date().toISOString();
  const task = createTask(fixture.projectId, {
    branch: 'develop',
    claim: {
      sessionIdHash: 'foreign-claim',
      workspaceId: 'ws_foreign_claim',
      ownerKind: 'chat',
      ownerLabel: 'Chat Other',
      claimedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  assert.throws(
    () => syncTaskWithGit(fixture.state, task, { workspaceId: workspace.workspaceId, remote: 'origin', fetch: false, checks: passedChecks }),
    (error: any) => error?.payload?.code === 'TASK_GIT_EVIDENCE_CLAIM_MISMATCH',
  );
});

test('workspace-bound Git evidence rejects an expired task claim', () => {
  const fixture = setup('workspace-stale-claim');
  const workspace = createOrReuseSessionWorkspace({ id: fixture.projectId, localPath: fixture.root }, 'workspace-stale-claim');
  const task = createTask(fixture.projectId, {
    branch: 'develop',
    claim: {
      sessionIdHash: 'stale-claim',
      workspaceId: workspace.workspaceId,
      ownerKind: 'chat',
      ownerLabel: 'Chat Stale',
      claimedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });

  assert.throws(
    () => syncTaskWithGit(fixture.state, task, { workspaceId: workspace.workspaceId, remote: 'origin', fetch: false, checks: passedChecks }),
    (error: any) => error?.payload?.code === 'TASK_GIT_EVIDENCE_CLAIM_INACTIVE',
  );
});

test('workspace-bound Git evidence rejects a managed workspace created from the wrong base branch', () => {
  const fixture = setup('workspace-base-mismatch');
  git(fixture.root, ['switch', '-c', 'feature/base']);
  const workspace = createOrReuseSessionWorkspace({ id: fixture.projectId, localPath: fixture.root }, 'workspace-base-mismatch');
  const task = createTask(fixture.projectId, {
    branch: 'develop',
    claim: {
      sessionIdHash: 'base-mismatch',
      workspaceId: workspace.workspaceId,
      ownerKind: 'chat',
      ownerLabel: 'Chat Base',
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  assert.throws(
    () => syncTaskWithGit(fixture.state, task, { workspaceId: workspace.workspaceId, remote: 'origin', fetch: false, checks: passedChecks }),
    (error: any) => error?.payload?.code === 'TASK_GIT_EVIDENCE_BRANCH_MISMATCH',
  );
});


test('syncTaskWithGit rejects project-root evidence when the task expects an isolated workspace branch', () => {
  const fixture = setup('workspace-mismatch');
  const workspace = createOrReuseSessionWorkspace({ id: fixture.projectId, localPath: fixture.root }, 'task-workspace-mismatch');
  const task = createTask(fixture.projectId, { branch: workspace.branch });

  assert.throws(
    () => syncTaskWithGit(fixture.state, task, { remote: 'origin', fetch: false, checks: passedChecks }),
    (error: any) => error?.payload?.code === 'TASK_GIT_EVIDENCE_BRANCH_MISMATCH',
  );
});

test('workspace-bound Git evidence rejects a workspace owned by another project', () => {
  const source = setup('workspace-owner-source');
  const other = setup('workspace-owner-other');
  const workspace = createOrReuseSessionWorkspace({ id: source.projectId, localPath: source.root }, 'workspace-owner');
  const task = createTask(other.projectId, { branch: workspace.branch });

  assert.throws(
    () => syncTaskWithGit(other.state, task, { workspaceId: workspace.workspaceId, remote: 'origin', fetch: false, checks: passedChecks }),
    (error: any) => error?.payload?.code === 'WORKSPACE_NOT_FOUND',
  );
});

test('parent completion evidence reuses child GREEN checks only when every child is DONE on the exact same revision', () => {
  const fixture = setup('parent-exact-evidence');
  const commit = git(fixture.root, ['rev-parse', 'HEAD']);
  const gitEvidence = {
    evidenceSource: 'project-root' as const,
    branch: 'develop',
    commit,
    remote: 'origin',
    trackingBranch: 'origin/develop',
    remoteHead: commit,
    ahead: 0,
    behind: 0,
    diverged: false,
    pushed: true,
    workingTreeClean: true,
    recordedAt: new Date().toISOString(),
  };
  const parent = createTask(fixture.projectId, { id: 'parent-exact', status: 'in-progress', verificationEvidence: [] });
  const childA = createTask(fixture.projectId, {
    id: 'child-exact-a', parentId: parent.id, status: 'done', gitEvidence,
    verificationEvidence: [{ name: 'a', command: 'test:a', status: 'passed', scope: 'targeted', repoRevision: commit }],
  });
  const childB = createTask(fixture.projectId, {
    id: 'child-exact-b', parentId: parent.id, status: 'done', gitEvidence,
    verificationEvidence: [{ name: 'b', command: 'test:b', status: 'passed', scope: 'broad', repoRevision: commit }],
  });
  saveTask(parent);
  saveTask(childA);
  saveTask(childB);

  const derived = deriveParentCompletionVerificationEvidence(parent, gitEvidence);
  assert.deepEqual(derived.map((entry) => entry.command).sort(), ['test:a', 'test:b']);
  const synced = syncTaskWithGit(fixture.state, parent, { remote: 'origin', fetch: false });
  assert.equal(synced.verificationEvidence.length, 2);
  const warningCodes = new Set(buildTaskGitWarnings({ ...synced.task, status: 'done' }).map((entry: any) => entry.code));
  assert.equal(warningCodes.has('DONE_VERIFICATION_MISSING'), false);
  assert.equal(warningCodes.has('DONE_GIT_EVIDENCE_MISSING'), false);
});

test('parent completion evidence rejects stale, unbound, or mixed child revisions', () => {
  const fixture = setup('parent-stale-evidence');
  const commit = git(fixture.root, ['rev-parse', 'HEAD']);
  const gitEvidence = {
    evidenceSource: 'project-root' as const,
    branch: 'develop', commit, remote: 'origin', trackingBranch: 'origin/develop', remoteHead: commit,
    ahead: 0, behind: 0, diverged: false, pushed: true, workingTreeClean: true, recordedAt: new Date().toISOString(),
  };
  const parent = createTask(fixture.projectId, { id: 'parent-stale', verificationEvidence: [] });
  saveTask(parent);
  saveTask(createTask(fixture.projectId, {
    id: 'child-stale-a', parentId: parent.id, status: 'done', gitEvidence,
    verificationEvidence: [{ name: 'a', command: 'test:a', status: 'passed', scope: 'targeted', repoRevision: 'older-revision' }],
  }));
  assert.deepEqual(deriveParentCompletionVerificationEvidence(parent, gitEvidence), []);

  const doneParent = { ...parent, status: 'done', gitEvidence, verificationEvidence: [{ name: 'old', command: 'test:old', status: 'passed', scope: 'full', repoRevision: 'older-revision' }] };
  const warningCodes = new Set(buildTaskGitWarnings(doneParent).map((entry: any) => entry.code));
  assert.ok(warningCodes.has('DONE_VERIFICATION_REVISION_MISMATCH'));
});

test('evaluateReviewSubmission returns every material blocker without changing task status', () => {
  const fixture = setup('blocked');
  const task = createTask(fixture.projectId, {
    branch: 'feature/expected',
    checklist: [{ id: 'one', text: 'Not done', completed: false }],
    bugs: [{ id: 'bug-1', status: 'open', title: 'Open defect' }],
  });
  const child = createTask(fixture.projectId, { id: 'child-blocked', parentId: task.id, status: 'in-progress' });
  saveTask(task);
  saveTask(child);
  fs.writeFileSync(path.join(fixture.root, 'dirty.txt'), 'dirty\n');

  const result = evaluateReviewSubmission(fixture.state, task, {
    remote: 'origin',
    fetch: true,
    checks: [{ name: 'unit-tests', command: 'npm test', status: 'failed', summary: 'failed' }],
  });

  assert.equal(result.blocked, true);
  assert.equal(result.ready, false);
  assert.deepEqual(result.readinessDebt, result.blockers);
  const codes = new Set(result.readinessDebt.map((blocker: any) => blocker.code));
  assert.ok(codes.has('WORKING_TREE_DIRTY'));
  assert.ok(codes.has('TASK_BRANCH_MISMATCH'));
  assert.ok(codes.has('CHECKLIST_INCOMPLETE'));
  assert.ok(codes.has('VERIFICATION_FAILED'));
  assert.ok(codes.has('CHILD_TASK_BLOCKING'));
  assert.ok(codes.has('UNRESOLVED_BUGS'));
  assert.equal(task.status, 'in-progress');
}); 

test('recorded readiness reports quality debt without making it lifecycle-blocking', () => {
  const fixture = setup('recorded-readiness-debt');
  const task = createTask(fixture.projectId, {
    checklist: [{ id: 'one', text: 'Not done', completed: false }],
    verificationEvidence: [],
    gitEvidence: undefined,
  });

  const result = validateRecordedReviewSubmission(task);

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.ready, false);
  const debtCodes = new Set(result.readinessDebt.map((entry: any) => entry.code));
  assert.ok(debtCodes.has('CHECKLIST_INCOMPLETE'));
  assert.ok(debtCodes.has('VERIFICATION_EVIDENCE_MISSING'));
  assert.ok(debtCodes.has('GIT_EVIDENCE_MISSING'));
});


test('evaluateReviewSubmission blocks unpublished local commits', () => {
  const fixture = setup('ahead');
  const task = createTask(fixture.projectId);
  fs.writeFileSync(path.join(fixture.root, 'local.txt'), 'local\n');
  git(fixture.root, ['add', 'local.txt']);
  git(fixture.root, ['commit', '-m', 'local only']);

  const result = evaluateReviewSubmission(fixture.state, task, {
    remote: 'origin',
    fetch: true,
    checks: passedChecks,
  });

  assert.equal(result.ready, false);
  const codes = new Set(result.readinessDebt.map((blocker: any) => blocker.code));
  assert.ok(codes.has('HEAD_NOT_PUSHED'));
  assert.ok(codes.has('LOCAL_BRANCH_AHEAD'));
});

test('evaluateReviewSubmission passes with clean published head, completed checklist, and passed checks', () => {
  const fixture = setup('review-pass');
  const task = createTask(fixture.projectId);
  saveTask(task);

  const result = evaluateReviewSubmission(fixture.state, task, {
    remote: 'origin',
    fetch: true,
    checks: passedChecks,
  });

  assert.equal(result.blocked, false);
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.readinessDebt, []);
  assert.equal(result.gitEvidence.pushed, true);
  assert.equal(result.verificationEvidence.length, 1);
});

test('push -> sync -> review reuses one fresh remote observation across the workflow', () => {
  const fixture = setup('reuse-sequence');
  const task = createTask(fixture.projectId);
  saveTask(task);
  fs.writeFileSync(path.join(fixture.root, 'reuse-sequence.txt'), 'sequence\n');
  git(fixture.root, ['add', 'reuse-sequence.txt']);
  git(fixture.root, ['commit', '-m', 'reuse sequence']);
  clearGitRemoteEvidenceCache();

  pushGitBranch(fixture.state, { projectId: fixture.projectId, remote: 'origin', branch: 'develop', nowMs: 1_000 });
  const synced = syncTaskWithGit(fixture.state, task, { remote: 'origin', fetch: true, nowMs: 2_000, checks: passedChecks });
  const reviewed = evaluateReviewSubmission(fixture.state, task, { remote: 'origin', fetch: true, nowMs: 3_000, checks: passedChecks });
  const metrics = getGitRemoteEvidenceMetrics(3_000);

  assert.equal(synced.gitEvidence.remoteEvidenceReused, true);
  assert.equal(reviewed.gitEvidence?.remoteEvidenceReused, true);
  assert.equal(metrics.fetchCount, 1);
  assert.equal(metrics.reusedCount >= 2, true);
  assert.equal(reviewed.blocked, false);
  console.log(`[git-evidence] push->sync->review fetches=${metrics.fetchCount} reused=${metrics.reusedCount} fetchMs=${metrics.fetchDurationMs}`);
});

test('task repository persists optional Git and verification evidence', () => {
  const fixture = setup('persistence');
  const task = createTask(fixture.projectId, {
    gitEvidence: {
      branch: '0053',
      targetBranch: 'develop',
      workspaceBranch: '0053',
      evidenceSource: 'managed-workspace',
      workspaceId: 'ws-persisted',
      commit: 'abc123',
      remote: 'origin',
      trackingBranch: 'origin/develop',
      remoteHead: 'abc123',
      ahead: 0,
      behind: 0,
      diverged: false,
      pushed: true,
      workingTreeClean: true,
      recordedAt: new Date().toISOString(),
    },
    verificationEvidence: passedChecks,
  });

  saveTask(task);
  const loaded = getTasks().find((entry: any) => entry.id === task.id);

  assert.equal(loaded?.gitEvidence?.commit, 'abc123');
  assert.equal(loaded?.gitEvidence?.targetBranch, 'develop');
  assert.equal(loaded?.gitEvidence?.workspaceBranch, '0053');
  assert.equal(loaded?.verificationEvidence?.[0]?.status, 'passed');
});

test('buildTaskGitWarnings reports branch mismatch, dirty completed work, and unpublished review state', () => {
  const fixture = setup('warnings');
  const task = createTask(fixture.projectId, {
    status: 'ready-for-review',
    branch: 'feature/expected',
    gitEvidence: {
      branch: 'develop',
      commit: git(fixture.root, ['rev-parse', 'HEAD']),
      remote: 'origin',
      trackingBranch: null,
      remoteHead: null,
      ahead: 1,
      behind: 0,
      diverged: false,
      pushed: false,
      workingTreeClean: false,
      recordedAt: new Date().toISOString(),
    },
  });
  fs.writeFileSync(path.join(fixture.root, 'dirty.txt'), 'dirty\n');

  const warnings = buildTaskGitWarnings(task);
  const codes = new Set(warnings.map((warning: any) => warning.code));

  assert.ok(codes.has('TASK_BRANCH_MISMATCH'));
  assert.ok(codes.has('WORKING_TREE_DIRTY'));
  assert.ok(codes.has('UPSTREAM_NOT_CONFIGURED'));
  assert.ok(codes.has('REVIEW_HEAD_NOT_PUSHED'));
});

test('historical managed Git evidence without explicit branch identities is conservative', () => {
  const fixture = setup('historical-managed-evidence');
  const task = createTask(fixture.projectId, {
    branch: 'develop',
    gitEvidence: {
      evidenceSource: 'managed-workspace',
      workspaceId: 'ws-historical',
      branch: '0053',
      commit: git(fixture.root, ['rev-parse', 'HEAD']),
      remote: 'origin',
      trackingBranch: 'origin/0053',
      remoteHead: null,
      ahead: 0,
      behind: 0,
      diverged: false,
      pushed: false,
      workingTreeClean: true,
      recordedAt: new Date().toISOString(),
    },
    verificationEvidence: passedChecks,
  });

  const recorded = validateRecordedReviewSubmission(task, { requirePushedHead: false });
  assert.ok(recorded.readinessDebt.some((entry: any) => entry.code === 'TASK_BRANCH_EVIDENCE_INCOMPLETE'));

  const warnings = buildTaskGitWarnings(task);
  assert.ok(warnings.some((entry: any) => entry.code === 'RECORDED_BRANCH_IDENTITY_INCOMPLETE'));
  assert.equal(warnings.some((entry: any) => entry.code === 'RECORDED_BRANCH_MISMATCH'), false);
});

test('DONE warnings preserve quality debt without presenting status as GREEN or approved', () => {
  const fixture = setup('done-readiness-debt');
  const task = createTask(fixture.projectId, {
    status: 'done',
    checklist: [{ id: 'one', text: 'Deferred', completed: false }],
    verificationEvidence: [],
    gitEvidence: undefined,
  });

  const warnings = buildTaskGitWarnings(task);
  const codes = new Set(warnings.map((warning: any) => warning.code));

  assert.ok(codes.has('DONE_CHECKLIST_DEBT'));
  assert.ok(codes.has('DONE_VERIFICATION_MISSING'));
  assert.ok(codes.has('DONE_GIT_EVIDENCE_MISSING'));
  assert.ok(warnings.some((warning: any) => /does not imply GREEN verification/.test(warning.message)));
  assert.ok(warnings.some((warning: any) => /does not imply review approval/.test(warning.message)));
});

