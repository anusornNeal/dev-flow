import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-mutation-modes-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { saveProjects } = await import('../../src/server/repositories/projectRepository.js');
const { saveTasks } = await import('../../src/server/repositories/taskRepository.js');

const state: any = {
  tasksCache: [
    {
      id: 'task-lean-write-1',
      displayId: 'DVF-0910',
      title: 'Lean mutation fixture',
      description: 'Large detail should not come back in lean mutation responses.',
      projectId: 'proj-lean-write-1',
      status: 'todo',
      priority: 'medium',
      category: 'backend',
      logs: [{ id: 'log-1', timestamp: '2026-06-19T00:00:00.000Z', message: 'Verbose log', type: 'update' }],
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
    },
  ],
  projectsCache: [
    { id: 'proj-lean-write-1', name: 'Dev Flow', repoUrl: 'https://example.com/dev-flow', createdAt: '2026-06-19T00:00:00.000Z' },
  ],
  countersCache: { DVF: 910 },
  settingsCache: { ngrokUrl: '', githubToken: '', jiraToken: '', jiraBaseUrl: '', jiraEmail: '', autoWork: false, agentExecutionMode: 'safe' },
  skillsRegistry: [],
};

saveProjects(state as any);
saveTasks(state as any);

const app = express();
app.use(express.json());
registerApiRoutes(app, { state: state as any, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('Server address unavailable');
const base = `http://127.0.0.1:${addr.port}`;

test('task mutation endpoints can return summary payloads for tool efficiency', async () => {
  const response = await fetch(`${base}/api/tasks/DVF-0910/move?responseMode=summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'in-progress' }),
  });
  assert.equal(response.status, 200);

  const body = await response.json() as { task: any; responseMode: string };
  assert.equal(body.responseMode, 'summary');
  assert.equal(body.task.displayId, 'DVF-0910');
  assert.equal(body.task.status, 'in-progress');
  assert.equal(body.task.description, undefined);
  assert.equal(body.task.logs, undefined);
});

test('task creation can return summary payloads for tool efficiency', async () => {
  const response = await fetch(`${base}/api/tasks?responseMode=summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'proj-lean-write-1',
      title: 'Created lean task',
      category: 'backend',
      description: 'Large create detail should not come back in summary responses.',
    }),
  });
  assert.equal(response.status, 201);

  const body = await response.json() as { task: any; responseMode: string };
  assert.equal(body.responseMode, 'summary');
  assert.equal(body.task.title, 'Created lean task');
  assert.equal(body.task.description, undefined);
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
