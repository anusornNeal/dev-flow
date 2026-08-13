import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-checklist-terminal-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');

const project = {
  id: 'project-checklist-terminal',
  name: 'Checklist Terminal State',
  repoUrl: 'https://example.com/checklist-terminal',
  localPath: tempDir,
};
createProject(project as any);
const state: any = { projectsCache: [project], countersCache: {}, skillsRegistry: [] };

function makeTask(id: string, status: string, completed: boolean) {
  return {
    id,
    displayId: id.toUpperCase(),
    title: id,
    description: 'Checklist terminal-state fixture',
    projectId: project.id,
    status,
    priority: 'medium',
    branch: null,
    category: 'backend',
    tags: [],
    targetFiles: [],
    checklist: [{ id: 'c1', text: 'terminal invariant item', completed }],
    verificationEvidence: [],
    logs: [],
    bugs: [],
    images: [],
    designImages: [],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  } as any;
}

for (const fixture of [
  makeTask('done-specific-block', 'done', true),
  makeTask('done-batch-block', 'done', true),
  makeTask('done-specific-repair', 'done', false),
  makeTask('done-batch-repair', 'done', false),
  makeTask('backlog-allowed', 'backlog', false),
  makeTask('todo-allowed', 'todo', false),
  makeTask('ready-allowed', 'ready-for-review', false),
  makeTask('in-progress-locked', 'in-progress', false),
  makeTask('in-progress-emergency', 'in-progress', false),
]) saveTask(fixture);

const app = express();
app.use(express.json());
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server did not bind');
const base = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

async function post(route: string, body: unknown) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

function persisted(id: string) {
  const task = getTask(id) as any;
  assert.ok(task);
  return task;
}

test('specific toggle rejects DONE completed-to-incomplete without mutation side effects', async () => {
  const before = structuredClone(persisted('done-specific-block'));
  const result = await post('/api/tasks/done-specific-block/checklist/toggle', { checklistId: 'c1' });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'CHECKLIST_TERMINAL_STATE_CONFLICT');
  assert.deepEqual(persisted('done-specific-block'), before);
});

test('batch toggle returns structured DONE failure and leaves the forbidden task unchanged', async () => {
  const before = structuredClone(persisted('done-batch-block'));
  const result = await post('/api/tasks/batch/checklist/toggle', {
    toggles: [{ taskId: 'done-batch-block', checklistId: 'c1' }],
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, false);
  assert.equal(result.body.errorCount, 1);
  assert.equal(result.body.results[0].success, false);
  assert.equal(result.body.results[0].error.code, 'CHECKLIST_TERMINAL_STATE_CONFLICT');
  assert.deepEqual(persisted('done-batch-block'), before);
});

test('DONE repair toggle incomplete-to-complete remains allowed on both endpoints', async () => {
  const specific = await post('/api/tasks/done-specific-repair/checklist/toggle', { checklistId: 'c1' });
  assert.equal(specific.response.status, 200);
  assert.equal(persisted('done-specific-repair').checklist[0].completed, true);

  const batch = await post('/api/tasks/batch/checklist/toggle', {
    toggles: [{ taskId: 'done-batch-repair', checklistId: 'c1' }],
  });
  assert.equal(batch.response.status, 200);
  assert.equal(batch.body.results[0].success, true);
  assert.equal(persisted('done-batch-repair').checklist[0].completed, true);
});

test('ordinary non-DONE statuses retain checklist toggle behavior', async () => {
  for (const id of ['backlog-allowed', 'todo-allowed', 'ready-allowed']) {
    const result = await post(`/api/tasks/${id}/checklist/toggle`, { checklistId: 'c1' });
    assert.equal(result.response.status, 200, id);
    assert.equal(persisted(id).checklist[0].completed, true, id);
  }
});

test('in-progress lock semantics remain unchanged, including deliberate emergency override', async () => {
  const blockedBefore = structuredClone(persisted('in-progress-locked'));
  const blocked = await post('/api/tasks/in-progress-locked/checklist/toggle', { checklistId: 'c1' });
  assert.equal(blocked.response.status, 403);
  assert.deepEqual(persisted('in-progress-locked'), blockedBefore);

  const allowed = await post('/api/tasks/in-progress-emergency/checklist/toggle', { checklistId: 'c1', emergency: true });
  assert.equal(allowed.response.status, 200);
  assert.equal(persisted('in-progress-emergency').checklist[0].completed, true);
});
