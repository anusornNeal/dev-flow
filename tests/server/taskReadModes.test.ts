import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-read-modes-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();

const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');

const state: any = {
  _testTasks: [
    {
      id: 'task-board-1',
      displayId: 'DVF-0900',
      title: 'Board payload fixture',
      description: 'Longer description that should stay out of board mode.',
      projectId: 'proj-read-mode-1',
      status: 'todo',
      priority: 'high',
      category: 'frontend',
      branch: 'feature/board-payload',
      tags: ['ux', 'perf'],
      targetFiles: ['src/App.tsx'],
      checklist: [{ id: 'step-1', text: 'Ship board mode', completed: false }],
      images: [
        {
          id: 'img-1',
          filename: 'fixture.png',
          url: '/api/static/images/fixture.png',
          absolutePath: 'C:\\images\\fixture.png',
          createdAt: '2026-06-19T00:00:00.000Z',
        },
      ],
      specUrl: 'https://example.com/spec',
      agent: 'Codex',
      activeAgent: 'Codex',
      latestAgentRun: {
        id: 'run-1',
        status: 'running',
        agent: 'Codex',
        createdAt: '2026-06-19T00:00:00.000Z',
      },
      agentRuns: [{ id: 'run-1', status: 'running', logFile: 'run-1.log' }],
      model: 'gpt-5',
      effort: 'medium',
      repo: 'https://github.com/anusornNeal/dev-flow',
      reasoning: 'Heavy detail should stay out of board mode.',
      acceptanceCriteria: 'Board mode is lean.',
      verification: 'Benchmarked.',
      repoContext: 'Large repo context.',
      jiraKey: 'DVF-900',
      sourceUrl: 'https://example.com/source',
      logs: [
        {
          id: 'log-1',
          timestamp: '2026-06-19T00:00:00.000Z',
          message: 'This log should stay out of board payloads.',
          type: 'comment',
        },
      ],
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
    },
  ],
  projectsCache: [
    {
      id: 'proj-read-mode-1',
      name: 'Dev Flow',
      repoUrl: 'https://github.com/anusornNeal/dev-flow',
      createdAt: '2026-06-19T00:00:00.000Z',
    },
  ],
  countersCache: { DVF: 900 },
  
  skillsRegistry: [],
};

((state as any).projectsCache || []).forEach(p => createProject(p));
((state as any)._testTasks || []).forEach((task: any) => saveTask(task));

createProject({
  id: 'proj-search-paging',
  name: 'Search Paging Fixture',
  repoUrl: 'https://github.com/example/search-paging',
  createdAt: '2026-06-19T00:00:00.000Z',
});
for (let index = 0; index < 120; index += 1) {
  saveTask({
    id: `task-paging-${String(index).padStart(3, '0')}`,
    displayId: `PG-${String(index + 1).padStart(4, '0')}`,
    title: `Paging task ${index + 1}`,
    description: `Paging fixture ${index + 1}`,
    projectId: 'proj-search-paging',
    status: index % 2 === 0 ? 'todo' : 'backlog',
    priority: 'medium',
    category: 'backend',
    branch: 'develop',
    tags: [],
    targetFiles: [],
    checklist: [],
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: `2026-06-19T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
  });
}



const app = express();
registerApiRoutes(app, { state: state as any, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const addr = server.address();
if (!addr || typeof addr === 'string') {
  throw new Error('Server address unavailable');
}
const base = `http://127.0.0.1:${addr.port}`;

test('GET /api/tasks?mode=board returns board fields without full detail blobs', async () => {
  const response = await fetch(`${base}/api/tasks?mode=board&projectId=proj-read-mode-1`);
  assert.equal(response.status, 200);

  const body = await response.json() as { items: any[]; mode: string };
  assert.equal(body.mode, 'board');
  assert.equal(body.items.length, 1);

  const item = body.items[0];
  assert.equal(item.id, 'task-board-1');
  assert.equal(item.branch, 'feature/board-payload');
  assert.deepEqual(item.tags, ['ux', 'perf']);
  assert.deepEqual(item.targetFiles, ['src/App.tsx']);
  assert.equal(item.images.length, 1);
  assert.equal(item.agent, 'Codex');
  assert.equal(item.model, 'gpt-5');
  assert.deepEqual(item.agentRuns, []);
  assert.equal(item.description, undefined);
  assert.equal(item.logs, undefined);
  assert.equal(item.reasoning, undefined);
  assert.equal(item.acceptanceCriteria, undefined);
});

test('GET /api/tasks modern summary defaults to a bounded page and preserves totals', async () => {
  const response = await fetch(`${base}/api/tasks?mode=summary&projectId=proj-search-paging`);
  assert.equal(response.status, 200);
  const responseText = await response.text();
  const body = JSON.parse(responseText) as { items: any[]; total: number; offset: number; limit: number; mode: string };
  assert.equal(body.items.length, 50);
  assert.equal(body.total, 120);
  assert.equal(body.offset, 0);
  assert.equal(body.limit, 50);
  assert.equal(body.mode, 'summary');

  const nextResponse = await fetch(`${base}/api/tasks?mode=summary&projectId=proj-search-paging&offset=50`);
  const next = await nextResponse.json() as { items: any[]; total: number; offset: number; limit: number };
  assert.equal(next.items.length, 50);
  assert.equal(next.total, 120);
  assert.equal(next.offset, 50);
  assert.equal(next.limit, 50);
  assert.equal(new Set([...body.items, ...next.items].map((item) => item.id)).size, 100);

  const filteredResponse = await fetch(`${base}/api/tasks?mode=summary&projectId=proj-search-paging&status=todo&limit=17&offset=10`);
  const filtered = await filteredResponse.json() as { items: any[]; total: number; offset: number; limit: number };
  assert.equal(filtered.items.length, 17);
  assert.equal(filtered.total, 60);
  assert.equal(filtered.offset, 10);
  assert.equal(filtered.limit, 17);
  assert.equal(filtered.items.every((item) => item.status === 'todo'), true);

  const explicitResponse = await fetch(`${base}/api/tasks?mode=summary&projectId=proj-search-paging&limit=120`);
  const explicitText = await explicitResponse.text();
  const explicit = JSON.parse(explicitText) as { items: any[]; total: number; limit: number };
  assert.equal(explicit.items.length, 120);
  assert.equal(explicit.total, 120);
  assert.equal(explicit.limit, 120);
  assert.equal(Buffer.byteLength(responseText, 'utf8') < Buffer.byteLength(explicitText, 'utf8') * 0.6, true);
  const fullResponse = await fetch(`${base}/api/tasks?mode=full&projectId=proj-search-paging`);
  const full = await fullResponse.json() as { items: any[]; total: number; limit: number; mode: string };
  assert.equal(full.items.length, 50);
  assert.equal(full.total, 120);
  assert.equal(full.limit, 50);
  assert.equal(full.mode, 'full');

  const debugResponse = await fetch(`${base}/api/tasks?mode=debug&projectId=proj-search-paging`);
  const debug = await debugResponse.json() as { items: any[]; total: number; limit: number; mode: string };
  assert.equal(debug.items.length, 50);
  assert.equal(debug.total, 120);
  assert.equal(debug.limit, 50);
  assert.equal(debug.mode, 'debug');

  const allResponse = await fetch(`${base}/api/tasks?mode=full&projectId=proj-search-paging&all=true`);
  const all = await allResponse.json() as { items: any[]; total: number; limit: number; mode: string };
  assert.equal(all.items.length, 120);
  assert.equal(all.total, 120);
  assert.equal(all.limit, 120);
  assert.equal(all.mode, 'full');

});

test('GET prompt-json returns JSON content', async () => {
  const response = await fetch(base + '/api/tasks/DVF-0900/prompt-json');
  assert.equal(response.status, 200);
  const body = await response.json() as { content: string; taskId: string };
  assert.equal(body.taskId, 'task-board-1');
  assert.ok(body.content.includes('# DevFlow Agent Task'));
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
