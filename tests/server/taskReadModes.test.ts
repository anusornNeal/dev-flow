import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-read-modes-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const {  } = await import('../../src/server/repositories/taskRepository.js');

const state: any = {
  tasksCache: [
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

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
