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
const { createOrReuseSessionWorkspace, resetSessionWorkspaceRuntimeForTests } = await import('../../src/server/services/sessionWorkspaceService.js');
const { createExecutionSession, getExecutionSessionState } = await import('../../src/server/services/executionSessionService.js');
const { finalizeTaskWorkspace } = await import('../../src/server/services/taskWorkspaceFinalizationService.js');

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
  const workspace = createOrReuseSessionWorkspace(project, `session-${label}`);
  return { root, project, task, workspace, state: { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any };
}

const checks = [{ name: 'focused', command: 'focused-test', status: 'passed' as const, summary: 'focused verification passed' }];

test('committed workspace finalizes into local develop and removes clean worktree/branch', () => {
  const { root, task, workspace, state } = fixture('success');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'implemented\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', 'implement task']);

  const claimed = getTask(task.id)!;
  claimed.claim = { workspaceId: workspace.workspaceId, sessionIdHash: 'fixture-session', ownerLabel: 'Fixture chat', ownerKind: 'chat', claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveTask(claimed);
  const execution = createExecutionSession({ projectId: task.projectId, taskId: task.id, workspaceId: workspace.workspaceId, branch: workspace.branch, repoRoot: workspace.root });

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
  git(workspace.root, ['commit', '-m', 'workspace change']);
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
