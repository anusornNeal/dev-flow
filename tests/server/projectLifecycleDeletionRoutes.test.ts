import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-project-delete-lifecycle-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'shared.ts'), 'export const shared = 1;\n');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.test']);
git(['add', '.']);
git(['commit', '-m', 'base']);
git(['branch', '-M', 'develop']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject, getProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTask, getTasksByProjectId, deleteTasksByIds } = await import('../../src/server/repositories/taskRepository.js');
const claims = await import('../../src/server/services/taskClaimService.js');
const workspaces = await import('../../src/server/services/sessionWorkspaceService.js');
const executions = await import('../../src/server/repositories/executionSessionRepository.js');
const checkpoints = await import('../../src/server/services/executionCheckpointService.js');

workspaces.resetSessionWorkspaceRuntimeForTests();
const state: any = { countersCache: {}, projectsCache: [], skillsRegistry: [] };
let projectSequence = 0;
let taskSequence = 0;

function seedProject(label: string) {
  projectSequence += 1;
  const project = {
    id: `project-delete-${label}-${projectSequence}`,
    name: `Delete ${label} ${projectSequence}`,
    repoUrl: `https://example.test/delete-${label}-${projectSequence}.git`,
    localPath: repoRoot,
    taskIdPrefix: `PD${projectSequence}`,
    createdAt: new Date().toISOString(),
  };
  createProject(project as any);
  state.projectsCache.push(project);
  return project;
}

function seedTask(project: any, label: string) {
  taskSequence += 1;
  const now = new Date().toISOString();
  const id = `task-project-delete-${taskSequence}`;
  saveTask({
    id,
    displayId: `${project.taskIdPrefix}-${String(taskSequence).padStart(4, '0')}`,
    title: label,
    description: 'Project deletion lifecycle regression fixture.',
    reasoning: 'Project deletion must preserve durable lifecycle and workspace recovery authority.',
    repoContext: 'Implementation map:\n- File: src/shared.ts\n- Current behavior: destructive project deletion may orphan lifecycle state.\n- Expected change: fail closed before deleting project/task rows.',
    projectId: project.id,
    status: 'todo',
    priority: 'medium',
    category: 'backend',
    tags: [],
    targetFiles: ['src/shared.ts'],
    checklist: [],
    createdAt: now,
    updatedAt: now,
    logs: [],
    bugs: [],
    images: [],
  } as any);
  return id;
}

const app = express();
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server did not bind');
const base = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function deleteProject(projectId: string) {
  const response = await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' });
  let body: any = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

test('project deletion rejects active claim/execution without removing project or tasks', async () => {
  const project = seedProject('active');
  const taskId = seedTask(project, 'active task');
  claims.claimTaskForSession(taskId, { sessionId: `session-${taskId}`, ownerKind: 'chat', ownerLabel: 'Project delete test' });
  const beforeCount = getTasksByProjectId(project.id).length;

  const result = await deleteProject(project.id);
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, 'PROJECT_DELETE_LIFECYCLE_BLOCKED');
  assert.ok(getProject(project.id));
  assert.equal(getTasksByProjectId(project.id).length, beforeCount);
});

test('project deletion rejects a durable pending operation even after claim and execution authority drift', async () => {
  const project = seedProject('pending-operation');
  const taskId = seedTask(project, 'pending operation task');
  const sessionId = `session-${taskId}`;
  claims.claimTaskForSession(taskId, { sessionId, ownerKind: 'chat', ownerLabel: 'Project delete test' });
  const execution = executions.listExecutionSessionsForTask(taskId).find((entry: any) => entry.status === 'active');
  assert.ok(execution);
  checkpoints.recordExecutionPendingOperationReference(execution.id, {
    operationId: `operation-${taskId}`,
    evidenceId: `evidence-${taskId}`,
    kind: 'repo-command',
    status: 'running',
  });
  executions.updateExecutionSessionRecord(execution.id, {
    status: 'completed',
    endedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const task = getTask(taskId)!;
  saveTask({ ...task, claim: undefined, status: 'todo', updatedAt: new Date().toISOString() } as any);

  const result = await deleteProject(project.id);
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, 'PROJECT_DELETE_LIFECYCLE_BLOCKED');
  assert.ok(result.body?.error?.details?.blockers?.some((entry: any) => entry.reason === 'pending-operation'
    || entry.operationIds?.includes(`operation-${taskId}`)));
  assert.ok(getProject(project.id));
  assert.equal(getTasksByProjectId(project.id).length, 1);
});

test('project deletion rejects claimless actionable workspace and preserves workspace bytes', async () => {
  const project = seedProject('claimless-wip');
  const taskId = seedTask(project, 'claimless task');
  const sessionId = `session-${taskId}`;
  const claimed = claims.claimTaskForSession(taskId, { sessionId, ownerKind: 'chat', ownerLabel: 'Project delete test' });
  const workspace = workspaces.resolveSessionWorkspace(claimed.claim.workspaceId)!;
  claims.releaseTaskClaim(taskId, { sessionId, nextStatus: 'todo' });
  fs.writeFileSync(path.join(workspace.root, 'src', 'shared.ts'), 'export const shared = 77;\n');

  const result = await deleteProject(project.id);
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, 'PROJECT_DELETE_LIFECYCLE_BLOCKED');
  assert.ok(getProject(project.id));
  assert.equal(getTasksByProjectId(project.id).length, 1);
  assert.equal(fs.readFileSync(path.join(workspace.root, 'src', 'shared.ts'), 'utf8'), 'export const shared = 77;\n');
});

test('project deletion rejects historical execution/workspace whose task row is already missing', async () => {
  const project = seedProject('orphan');
  const taskId = seedTask(project, 'orphan task');
  claims.claimTaskForSession(taskId, { sessionId: `session-${taskId}`, ownerKind: 'chat', ownerLabel: 'Project delete test' });
  deleteTasksByIds([taskId]);
  assert.equal(getTasksByProjectId(project.id).length, 0);

  const result = await deleteProject(project.id);
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, 'PROJECT_DELETE_LIFECYCLE_BLOCKED');
  assert.ok(getProject(project.id));
  assert.equal(getTasksByProjectId(project.id).length, 0);
});

test('project deletion does not orphan clean historical execution or workspace records', async () => {
  const project = seedProject('historical-clean');
  const taskId = seedTask(project, 'historical clean task');
  const sessionId = `session-${taskId}`;
  claims.claimTaskForSession(taskId, { sessionId, ownerKind: 'chat', ownerLabel: 'Project delete test' });
  claims.releaseTaskClaim(taskId, { sessionId, nextStatus: 'todo' });

  const result = await deleteProject(project.id);
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, 'PROJECT_DELETE_LIFECYCLE_BLOCKED');
  assert.ok(getProject(project.id));
  assert.equal(getTasksByProjectId(project.id).length, 1);
});

test('project deletion handles more than 100 task rows without bounded health-page assumptions', async () => {
  const project = seedProject('large');
  for (let index = 0; index < 125; index += 1) seedTask(project, `large task ${index}`);
  assert.equal(getTasksByProjectId(project.id).length, 125);

  const result = await deleteProject(project.id);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(getProject(project.id), undefined);
  assert.equal(getTasksByProjectId(project.id).length, 0);
});

test('safe empty project deletion still succeeds', async () => {
  const project = seedProject('empty');
  const result = await deleteProject(project.id);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(getProject(project.id), undefined);
  assert.equal(getTasksByProjectId(project.id).length, 0);
});
