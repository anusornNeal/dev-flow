import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-bug-routes-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const express = (await import('express')).default;
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');

executeAllMigrations();

const project = { id: 'proj-bug-routes-1', name: 'Bug Routes', repoUrl: 'https://example.com/dev-flow', createdAt: new Date().toISOString() };
createProject(project);

const app = express();
app.use(express.json());
registerApiRoutes(app, {
  state: { projectsCache: [project], countersCache: { DVF: 274 }, skillsRegistry: [] } as any,
  writeAgentLog: () => {},
});
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('Server address unavailable');
const base = `http://127.0.0.1:${addr.port}`;

async function postJson(pathname: string, body: unknown) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('task bug thread routes create embedded bugs, append versions, update status, and expose summaries', async () => {
  const createTaskResponse = await postJson('/api/tasks', {
    projectId: project.id,
    title: 'Task with embedded bugs',
    category: 'backend',
    description: 'Route fixture',
  });
  assert.equal(createTaskResponse.status, 201);
  const createdTask = await createTaskResponse.json() as any;
  const taskId = createdTask.displayId || createdTask.task?.displayId;

  const createBugResponse = await postJson(`/api/tasks/${taskId}/bugs?responseMode=summary`, {
    title: 'Close warning missing',
    source: 'review',
    severity: 'high',
    actual: 'Done status hides incomplete checklist.',
    expected: 'Done status warns about unresolved bugs.',
    prompt: 'Fix the close warning.',
  });
  assert.equal(createBugResponse.status, 201);
  const createBugBody = await createBugResponse.json() as any;
  assert.equal(createBugBody.task.unresolvedBugCount, 1);
  assert.equal(createBugBody.task.latestUnresolvedBug.title, 'Close warning missing');
  const bugId = createBugBody.bug.id;

  const appendVersionResponse = await postJson(`/api/tasks/${taskId}/bugs/${bugId}/versions?responseMode=summary`, {
    prompt: 'Second fix attempt.',
    summary: 'First attempt failed.',
    changedFiles: ['src/server/routes/tasks.ts'],
  });
  assert.equal(appendVersionResponse.status, 201);
  const appendBody = await appendVersionResponse.json() as any;
  assert.equal(appendBody.bug.versions.length, 2);

  const statusResponse = await postJson(`/api/tasks/${taskId}/bugs/${bugId}/status?responseMode=summary`, { status: 'verified' });
  assert.equal(statusResponse.status, 200);
  const statusBody = await statusResponse.json() as any;
  assert.equal(statusBody.task.unresolvedBugCount, 0);

  const fullResponse = await fetch(`${base}/api/tasks/${taskId}?mode=full`);
  const fullTask = await fullResponse.json() as any;
  assert.equal(fullTask.bugs.length, 1);
  assert.equal(fullTask.bugs[0].versions.length, 2);
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
