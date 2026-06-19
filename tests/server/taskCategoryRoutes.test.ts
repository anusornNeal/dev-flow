import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getDevFlowAppRoot } from '../../src/lib/devFlowPaths.js';

const appRoot = getDevFlowAppRoot();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-category-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { saveProjects } = await import('../../src/server/repositories/projectRepository.js');
const { loadTasks, saveTasks } = await import('../../src/server/repositories/taskRepository.js');

const state = {
  tasksCache: [
    {
      id: 'task-legacy-1',
      displayId: 'DVF-0300',
      title: 'Legacy backend task',
      description: 'legacy',
      projectId: 'proj-category-1',
      status: 'backlog',
      priority: 'medium',
      branch: 'legacy-branch',
      tags: ['backend', 'queue'],
      targetFiles: [],
      checklist: [],
      logs: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  projectsCache: [
    {
      id: 'proj-category-1',
      name: 'Dev Flow',
      repoUrl: 'https://github.com/anusornNeal/dev-flow',
      localPath: appRoot,
      taskIdPrefix: 'DVF',
      createdAt: '',
    },
  ],
  countersCache: { DVF: 300 },
  settingsCache: { ngrokUrl: '', githubToken: '', jiraToken: '', jiraBaseUrl: '', jiraEmail: '', autoWork: false, agentExecutionMode: 'safe' },
  skillsRegistry: [],
};

saveProjects(state as any);
saveTasks(state as any);
loadTasks(state as any);

const app = express();
registerApiRoutes(app, { state: state as any, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const addr = server.address();
if (!addr || typeof addr === 'string') {
  throw new Error('Server address unavailable');
}
const base = `http://127.0.0.1:${addr.port}`;

async function request(method: string, route: string, body?: unknown) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({}));
  return { status: response.status, body: parsed };
}

test('loadTasks backfills legacy type tags into category and preserves free-form labels', () => {
  const legacyTask = state.tasksCache.find((task: any) => task.id === 'task-legacy-1') as any;
  assert.ok(legacyTask);
  assert.equal(legacyTask.category, 'backend');
  assert.deepEqual(legacyTask.tags, ['queue']);
});

test('POST /api/tasks rejects free-form tags without a primary category', async () => {
  const response = await request('POST', '/api/tasks', {
    projectId: 'proj-category-1',
    title: 'Missing category',
    tags: ['queue', 'auto-work'],
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error?.message || response.body.error, "Field 'category' is required and must be one of: frontend, backend, general.");
});

test('POST /api/tasks persists explicit category separately from tags', async () => {
  const response = await request('POST', '/api/tasks', {
    projectId: 'proj-category-1',
    title: 'Frontend task',
    category: 'frontend',
    tags: ['queue', 'auto-work'],
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.category, 'frontend');
  assert.deepEqual(response.body.tags, ['queue', 'auto-work']);

  loadTasks(state as any);
  const createdTask = state.tasksCache.find((task: any) => task.id === response.body.id) as any;
  assert.ok(createdTask);
  assert.equal(createdTask.category, 'frontend');
  assert.deepEqual(createdTask.tags, ['queue', 'auto-work']);
});

test('POST /api/tasks accepts general as the explicit category', async () => {
  const response = await request('POST', '/api/tasks', {
    projectId: 'proj-category-1',
    title: 'General task',
    category: 'general',
    tags: ['docs'],
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.category, 'general');
  assert.deepEqual(response.body.tags, ['docs']);
});

test('POST /api/tasks supports one legacy category tag for compatibility', async () => {
  const response = await request('POST', '/api/tasks', {
    projectId: 'proj-category-1',
    title: 'Legacy frontend task',
    tags: ['frontend', 'runner'],
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.category, 'frontend');
  assert.deepEqual(response.body.tags, ['runner']);
});

test('PUT /api/tasks/:id updates category while keeping free-form tags', async () => {
  const existingTask = state.tasksCache.find((task: any) => task.title === 'Frontend task');
  assert.ok(existingTask);

  const response = await request('PUT', `/api/tasks/${existingTask.id}`, {
    category: 'backend',
    tags: ['queue', 'runner'],
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.category, 'backend');
  assert.deepEqual(response.body.tags, ['queue', 'runner']);
});

test('import-file accepts category and strips legacy type tags from labels', async () => {
  const fixtureDir = path.join(appRoot, '.category-test-fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const patchPath = path.join(fixtureDir, 'category-import.json');

  fs.writeFileSync(
    patchPath,
    JSON.stringify({
      version: 'devflow.taskPatch.v1',
      defaults: { projectName: 'Dev Flow' },
      tasks: [
        {
          operation: 'create',
          title: 'Imported backend task',
          fields: {
            category: 'backend',
            tags: ['queue', 'logs'],
          },
        },
        {
          operation: 'create',
          title: 'Imported legacy frontend task',
          fields: {
            tags: ['frontend', 'auto-work'],
          },
        },
      ],
    }),
  );

  const response = await request('POST', '/api/tasks/import-file', {
    mode: 'apply',
    strategy: 'patch',
    patchFilePath: patchPath,
  });

  try {
    assert.equal(response.status, 200);
    loadTasks(state as any);

    const importedBackend = state.tasksCache.find((task: any) => task.title === 'Imported backend task') as any;
    assert.ok(importedBackend);
    assert.equal(importedBackend.category, 'backend');
    assert.deepEqual(importedBackend.tags, ['queue', 'logs']);

    const importedLegacy = state.tasksCache.find((task: any) => task.title === 'Imported legacy frontend task') as any;
    assert.ok(importedLegacy);
    assert.equal(importedLegacy.category, 'frontend');
    assert.deepEqual(importedLegacy.tags, ['auto-work']);
  } finally {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {}
  }
});

test('A & B. PUT /api/tasks/:id preserves tags when omitted from payload (including status changes)', async () => {
  const existingTask = state.tasksCache.find((task: any) => task.title === 'Frontend task');
  assert.ok(existingTask);
  const oldCategory = existingTask.category;
  const oldTags = existingTask.tags;

  const response = await request('PUT', `/api/tasks/${existingTask.id}`, {
    title: 'New frontend task title',
    status: 'in-progress'
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.category, oldCategory);
  assert.deepEqual(response.body.tags, oldTags);
});

test('C. POST /api/tasks/batch preserves tags when omitted', async () => {
  const existingTask = state.tasksCache.find((task: any) => task.title === 'General task');
  assert.ok(existingTask);

  const response = await request('POST', '/api/tasks/batch', {
    projectId: 'proj-category-1',
    tasks: [
      { id: existingTask.id, title: 'Updated general task' }
    ]
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.tasks[0].category, 'general');
  assert.deepEqual(response.body.tasks[0].tags, ['docs']);
});

test('D. import-file patch preserves tags when omitted', async () => {
  const existingTask = state.tasksCache.find((task: any) => task.title === 'Imported backend task');
  assert.ok(existingTask);

  const fixtureDir = path.join(appRoot, '.category-test-fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const patchPath = path.join(fixtureDir, 'category-patch.json');

  fs.writeFileSync(
    patchPath,
    JSON.stringify({
      version: 'devflow.taskPatch.v1',
      defaults: { projectName: 'Dev Flow' },
      tasks: [
        {
          operation: 'update',
          taskId: existingTask.id,
          fields: {
            description: 'Updated backend description'
          },
        }
      ],
    }),
  );

  const response = await request('POST', '/api/tasks/import-file', {
    mode: 'apply',
    strategy: 'patch',
    patchFilePath: patchPath,
  });

  try {
    assert.equal(response.status, 200);
    const updatedBackend = state.tasksCache.find((task: any) => task.id === existingTask.id);
    assert.ok(updatedBackend);
    assert.equal(updatedBackend.category, 'backend');
    assert.deepEqual(updatedBackend.tags, ['queue', 'logs']);
  } finally {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {}
  }
});

test('E. Explicit tags update still works and wipes old tags if provided', async () => {
  const existingTask = state.tasksCache.find((task: any) => task.title === 'Updated general task');
  assert.ok(existingTask);

  const response = await request('PUT', `/api/tasks/${existingTask.id}`, {
    tags: ['figma', 'mcp']
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.category, 'general');
  assert.deepEqual(response.body.tags, ['figma', 'mcp']);
});

test('F. PUT /api/tasks list-update preserves tags when omitted', async () => {
  const existingTask = state.tasksCache.find((task: any) => task.title === 'Legacy frontend task');
  assert.ok(existingTask);
  const oldCategory = existingTask.category;
  const oldTags = existingTask.tags;

  const response = await request('PUT', '/api/tasks', [
    { id: existingTask.id, title: 'Updated via list PUT' }
  ]);

  assert.equal(response.status, 200);
  assert.equal(response.body.tasks[0].category, oldCategory);
  assert.deepEqual(response.body.tasks[0].tags, oldTags);
  assert.equal(response.body.tasks[0].title, 'Updated via list PUT');
});

test('G. PUT /api/tasks/:id category-only update preserves tags', async () => {
  // Use 'Updated via list PUT' which currently has tags ['runner']
  const existingTask = state.tasksCache.find((task: any) => task.title === 'Updated via list PUT');
  assert.ok(existingTask);
  const oldTags = existingTask.tags;

  const response = await request('PUT', `/api/tasks/${existingTask.id}`, {
    category: 'backend'
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.category, 'backend');
  assert.deepEqual(response.body.tags, oldTags);
});

test('H. import-file patch category-only update preserves tags', async () => {
  const existingTask = state.tasksCache.find((task: any) => task.title === 'Imported backend task');
  assert.ok(existingTask);
  const oldTags = existingTask.tags;

  const fixtureDir = path.join(appRoot, '.category-test-fixtures-2');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const patchPath = path.join(fixtureDir, 'category-patch-2.json');

  fs.writeFileSync(
    patchPath,
    JSON.stringify({
      version: 'devflow.taskPatch.v1',
      defaults: { projectName: 'Dev Flow' },
      tasks: [
        {
          operation: 'update',
          taskId: existingTask.id,
          fields: {
            category: 'frontend'
          },
        }
      ],
    }),
  );

  const response = await request('POST', '/api/tasks/import-file', {
    mode: 'apply',
    strategy: 'patch',
    patchFilePath: patchPath,
  });

  try {
    assert.equal(response.status, 200);
    const updatedBackend = state.tasksCache.find((task: any) => task.id === existingTask.id);
    assert.ok(updatedBackend);
    assert.equal(updatedBackend.category, 'frontend');
    assert.deepEqual(updatedBackend.tags, oldTags);
  } finally {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {}
  }
});

test('I. explicit empty tags array clears tags', async () => {
  const existingTask = state.tasksCache.find((task: any) => task.title === 'Updated general task');
  assert.ok(existingTask);
  const oldCategory = existingTask.category;

  const response = await request('PUT', `/api/tasks/${existingTask.id}`, {
    tags: []
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.category, oldCategory);
  assert.deepEqual(response.body.tags, []);
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
