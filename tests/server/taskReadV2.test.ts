import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-read-v2-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const db = (await import('../../src/db/index.js')).default;

const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const taskRepository = await import('../../src/server/repositories/taskRepository.js') as any;
const { createAgentRun } = await import('../../src/server/repositories/agentRunRepository.js');
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');

createProject({
  id: 'proj-task-read-v2',
  name: 'Task Read V2',
  repoUrl: 'https://example.com/task-read-v2',
  taskIdPrefix: 'TRV',
  createdAt: '2026-08-09T00:00:00.000Z',
});

taskRepository.saveTask({
  id: 'task-read-v2-prereq',
  displayId: 'TRV-0002',
  title: 'Read prerequisite fixture',
  description: '',
  projectId: 'proj-task-read-v2',
  status: 'done',
  priority: 'medium',
  category: 'backend',
  tags: [],
  targetFiles: [],
  checklist: [],
  logs: [],
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
});

taskRepository.saveTask({
  id: 'task-read-v2-1',
  displayId: 'TRV-0001',
  title: 'Indexed task read fixture',
  description: 'Heavy description that compact modes should not return.',
  projectId: 'proj-task-read-v2',
  status: 'todo',
  priority: 'high',
  category: 'backend',
  agent: 'Codex',
  model: 'GPT-5.6 Sol',
  effort: 'high',
  reasoning: 'Heavy reasoning blob.',
  acceptanceCriteria: 'Heavy acceptance criteria blob.',
  verification: 'Heavy verification blob.',
  repoContext: 'Heavy repository context blob.',
  logs: [{ id: 'log-1', timestamp: '2026-08-09T00:00:00.000Z', message: 'Heavy log entry', type: 'comment' }],
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
});

const latestRun = createAgentRun({
  taskId: 'task-read-v2-1',
  projectId: 'proj-task-read-v2',
  agent: 'Codex',
  model: 'GPT-5.6 Sol',
  effort: 'high',
});

const state: any = {
  projectsCache: [{ id: 'proj-task-read-v2', name: 'Task Read V2', repoUrl: 'https://example.com/task-read-v2', taskIdPrefix: 'TRV' }],
  countersCache: { TRV: 1 },
  skillsRegistry: [],
};
const app = express();
app.use(express.json());
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Server address unavailable');
const base = `http://127.0.0.1:${address.port}`;

test('production identifier lookup uses the standalone displayId index instead of scanning tasks', () => {
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id, displayId, title, status, projectId
    FROM tasks
    WHERE id = ? OR displayId = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).all('TRV-0001', 'TRV-0001', 'TRV-0001') as Array<{ detail?: string }>;
  const detail = plan.map((entry) => entry.detail || '').join(' ');
  assert.doesNotMatch(detail, /SCAN tasks/, `Identifier lookup must not scan tasks: ${detail}`);
  assert.match(detail, /idx_tasks_display_id/, `Expected displayId index in query plan, got: ${detail}`);
});

test('repository resolves a task by displayId through the Task Read V2 primitive', () => {
  assert.equal(typeof taskRepository.getTaskByIdentifier, 'function', 'Task Read V2 repository primitive should exist');
  const task = taskRepository.getTaskByIdentifier('TRV-0001', 'minimal');
  assert.deepEqual(task, {
    id: 'task-read-v2-1',
    displayId: 'TRV-0001',
    title: 'Indexed task read fixture',
    status: 'todo',
    projectId: 'proj-task-read-v2',
  });
});

test('summary repository read omits heavy fields and only exposes the latest run summary', () => {
  const task = taskRepository.getTaskByIdentifier('TRV-0001', 'summary');
  assert.equal(task.id, 'task-read-v2-1');
  assert.equal(task.agent, 'Codex');
  assert.equal(task.description, undefined);
  assert.equal(task.reasoning, undefined);
  assert.equal(task.repoContext, undefined);
  assert.equal(task.logs, undefined);
  assert.equal(task.agentRuns, undefined);
  assert.equal(task.latestAgentRun?.id, latestRun.id);
});

test('task update resolves display-id prerequisites to canonical ids and exposes them in summary and agent context', async () => {
  const updateResponse = await fetch(`${base}/api/tasks/TRV-0001`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prerequisiteTaskIds: ['TRV-0002'], status: 'backlog' }),
  });
  assert.equal(updateResponse.status, 200, await updateResponse.text());
  assert.deepEqual(taskRepository.getTaskByIdentifier('TRV-0001', 'full').prerequisiteTaskIds, ['task-read-v2-prereq']);

  const summaryResponse = await fetch(`${base}/api/tasks/TRV-0001?mode=summary`);
  const summary = await summaryResponse.json() as any;
  assert.deepEqual(summary.prerequisiteTaskIds, ['task-read-v2-prereq']);

  const agentResponse = await fetch(`${base}/api/tasks/TRV-0001?mode=agent-context`);
  const agent = await agentResponse.json() as any;
  assert.deepEqual(agent.requirements.prerequisiteTaskIds, ['task-read-v2-prereq']);
});

test('single-task HTTP modes preserve compact and full response contracts', async () => {
  const summaryResponse = await fetch(`${base}/api/tasks/TRV-0001?mode=summary`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json() as any;
  assert.equal(summary.id, 'task-read-v2-1');
  assert.equal(summary.description, undefined);
  assert.equal(summary.logs, undefined);
  assert.equal(summary.latestAgentRun?.id, latestRun.id);

  const fullResponse = await fetch(`${base}/api/tasks/task-read-v2-1?mode=full`);
  assert.equal(fullResponse.status, 200);
  const full = await fullResponse.json() as any;
  assert.equal(full.description, 'Heavy description that compact modes should not return.');
  assert.equal(full.reasoning, 'Heavy reasoning blob.');
  assert.equal(full.logs.length > 0, true);

  assert.ok(Buffer.byteLength(JSON.stringify(summary), 'utf8') < Buffer.byteLength(JSON.stringify(full), 'utf8') / 2);
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
