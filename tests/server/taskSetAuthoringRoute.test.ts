import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-set-authoring-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTasks } = await import('../../src/server/repositories/taskRepository.js');
const express = (await import('express')).default;
const { registerTaskSetAuthoringRoute } = await import('../../src/server/routes/taskSetAuthoringRoute.js');
const { getToolDefinitionByName } = await import('../../src/server/contracts/devflowContract.js');

const projectId = 'project-task-set-authoring';
createProject({ id: projectId, name: 'Task Set Authoring', repoUrl: 'https://example.invalid/task-set', localPath: tempDir, taskIdPrefix: 'TSA' });

const state: any = {
  projectsCache: [{ id: projectId, name: 'Task Set Authoring', repoUrl: 'https://example.invalid/task-set', localPath: tempDir, taskIdPrefix: 'TSA' }],
  countersCache: {},
};

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  registerTaskSetAuthoringRoute(app, { state, writeAgentLog: () => {} } as any);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const parent = {
  title: 'Author parent set',
  category: 'backend',
  status: 'backlog',
  description: 'Parent orchestration.',
};

const validChild = (title: string) => ({
  title,
  category: 'backend',
  status: 'backlog',
  description: 'Focused child implementation.',
});

test('create_task contract exposes atomic parent/children authoring in one call', () => {
  const tool = getToolDefinitionByName('create_task');
  assert.ok(tool);
  assert.ok(tool.inputSchema.properties.parent);
  assert.ok(tool.inputSchema.properties.children);
  assert.equal(Array.isArray(tool.inputSchema.anyOf), true);
  const request = tool.buildHttpRequest({ projectId, parent, children: [validChild('Contract child')], responseMode: 'summary' });
  assert.equal(request.method, 'POST');
  assert.match(request.path, /^\/api\/tasks\/task-set/);
  assert.equal((request.body as any).children.length, 1);
});

test('task-set authoring creates parent and children atomically with deterministic linkage', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-set?responseMode=standard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, parent, children: [validChild('Child A'), validChild('Child B')] }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.createdCount, 3);
    assert.equal(body.children.length, 2);
    assert.equal(body.children.every((child: any) => child.parentId === body.parent.id), true);
    assert.equal(getTasks().filter((task: any) => task.projectId === projectId).length, 3);
  });
});

test('task-set authoring reports invalid child quality and writes nothing', async () => {
  const before = getTasks().length;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        parent,
        children: [{
          title: 'Invalid implementation-ready child',
          category: 'backend',
          status: 'in-progress',
          description: 'Implementation-ready but missing repo evidence.',
          targetFiles: [],
        }],
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'TASK_SET_VALIDATION_FAILED');
    assert.equal(body.error.details.failures[0].role, 'child');
    assert.equal(body.error.details.failures[0].index, 0);
    assert.equal(body.error.details.failures[0].stage, 'quality');
    assert.equal(body.error.details.failures[0].fields.includes('repoContext'), true);
    assert.equal(body.error.details.failures[0].fields.includes('targetFiles'), true);
  });
  assert.equal(getTasks().length, before);
});

test('task-set authoring rejects child linkage conflicts before mutation', async () => {
  const before = getTasks().length;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, parent, children: [{ ...validChild('Conflicting child'), parentId: 'another-parent' }] }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'TASK_SET_VALIDATION_FAILED');
    assert.equal(body.error.details.failures[0].code, 'TASK_SET_CHILD_PARENT_CONFLICT');
  });
  assert.equal(getTasks().length, before);
});

test.after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
