import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-git-workflow-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTasks } = await import('../../src/server/repositories/taskRepository.js');
const {
  buildTaskGitWarnings,
  evaluateReviewSubmission,
  syncTaskWithGit,
} = await import('../../src/server/services/taskGitWorkflowService.js');

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
  const codes = new Set(result.blockers.map((blocker: any) => blocker.code));
  assert.ok(codes.has('WORKING_TREE_DIRTY'));
  assert.ok(codes.has('TASK_BRANCH_MISMATCH'));
  assert.ok(codes.has('CHECKLIST_INCOMPLETE'));
  assert.ok(codes.has('VERIFICATION_FAILED'));
  assert.ok(codes.has('CHILD_TASK_BLOCKING'));
  assert.ok(codes.has('UNRESOLVED_BUGS'));
  assert.equal(task.status, 'in-progress');
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

  const codes = new Set(result.blockers.map((blocker: any) => blocker.code));
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
  assert.deepEqual(result.blockers, []);
  assert.equal(result.gitEvidence.pushed, true);
  assert.equal(result.verificationEvidence.length, 1);
});

test('task repository persists optional Git and verification evidence', () => {
  const fixture = setup('persistence');
  const task = createTask(fixture.projectId, {
    gitEvidence: {
      branch: 'develop',
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
