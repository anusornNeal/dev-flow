import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getDevFlowAppRoot } from '../../src/lib/devFlowPaths.js';

const appRoot = getDevFlowAppRoot();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-import-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

// Fixture files go inside project root to pass path safety check
const fixtureDir = path.join(appRoot, '.import-test-fixtures');
fs.mkdirSync(fixtureDir, { recursive: true });
const fixture = (name: string) => path.join(fixtureDir, name);

const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTasks } = await import('../../src/server/repositories/taskRepository.js');

const state = {
  tasksCache: [
    {
      id: 'task-import-1', displayId: 'DVF-0200', title: 'Test task for import', description: 'old desc',
      projectId: 'proj-import-1', status: 'backlog', priority: 'medium', branch: 'old-branch',
      tags: ['old'], targetFiles: [], checklist: [], designImages: [], logs: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  projectsCache: [
    { id: 'proj-import-1', name: 'Dev Flow', repoUrl: 'https://github.com/a/b', localPath: appRoot, taskIdPrefix: 'DVF', createdAt: '' },
  ],
  countersCache: { DVF: 200 },
  
  skillsRegistry: [],
};

((state as any).projectsCache || []).forEach(p => createProject(p));


const app = express();
registerApiRoutes(app, { state: state as any, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, r));
const addr = server.address();
if (!addr || typeof addr === 'string') throw 'no addr';
const base = `http://127.0.0.1:${addr.port}`;

async function post(p, b) {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

try {
  // 1. dry-run update — file not found
  const r1 = await post('/api/tasks/import-file', {
    mode: 'dry-run', patchFilePath: fixture('nonexistent.json'),
  });
  assert.equal(r1.status, 400);

  // 2. unsupported version
  fs.writeFileSync(fixture('bad-version.json'), JSON.stringify({ version: 'v0', tasks: [] }));
  const r2 = await post('/api/tasks/import-file', {
    mode: 'dry-run', patchFilePath: fixture('bad-version.json'),
  });
  assert.equal(r2.status, 400);

  // 3. path traversal rejection
  const r3 = await post('/api/tasks/import-file', {
    mode: 'dry-run', patchFilePath: '../etc/passwd',
  });
  assert.equal(r3.status, 400);

  // 4. oversized
  fs.writeFileSync(fixture('big.json'), 'x'.repeat(6_000_000));
  const r4 = await post('/api/tasks/import-file', {
    mode: 'dry-run', patchFilePath: fixture('big.json'),
  });
  assert.equal(r4.status, 400);

  // 5. valid patch file — update dry-run
  const validPatch = { version: 'devflow.taskPatch.v1', tasks: [{ taskId: 'DVF-0200', operation: 'update', fields: { description: 'new desc from import' } }] };
  fs.writeFileSync(fixture('patch.json'), JSON.stringify(validPatch));
  const r5 = await post('/api/tasks/import-file', {
    mode: 'dry-run', strategy: 'patch', patchFilePath: fixture('patch.json'),
  });
  assert.equal(r5.status, 200);
  assert.equal(r5.body.summary.updated, 1);
  assert.equal(getTasks()[0].description, 'old desc', 'dry-run must not mutate');

  // 6. apply
  const r6 = await post('/api/tasks/import-file', {
    mode: 'apply', strategy: 'patch', patchFilePath: fixture('patch.json'),
  });
  assert.equal(r6.status, 200);
  assert.equal((getTasks()[0] as any).description, 'new desc from import');
  assert.equal((getTasks()[0] as any).status, 'backlog');

  // 7. apply create
  const createPatch = { version: 'devflow.taskPatch.v1', defaults: { projectName: 'Dev Flow' }, tasks: [{ operation: 'create', title: 'New import task', fields: { category: 'general', priority: 'high' } }] };
  fs.writeFileSync(fixture('create.json'), JSON.stringify(createPatch));
  const r7 = await post('/api/tasks/import-file', {
    mode: 'apply', strategy: 'patch', patchFilePath: fixture('create.json'),
  });
  assert.equal(r7.status, 200);
  assert.equal(r7.body.summary.created, 1);
  assert.ok(getTasks().some((t: any) => t.title === 'New import task'), 'new task must exist');

  // 8. unknown field
  const unknownPatch = { version: 'devflow.taskPatch.v1', tasks: [{ taskId: 'DVF-0200', operation: 'update', fields: { fakeField: 'bad' } }] };
  fs.writeFileSync(fixture('unknown.json'), JSON.stringify(unknownPatch));
  const r8 = await post('/api/tasks/import-file', {
    mode: 'dry-run', patchFilePath: fixture('unknown.json'),
  });
  assert.equal(r8.status, 200);
  assert.equal(r8.body.summary.failed, 1);

  // 9. malformed JSON
  fs.writeFileSync(fixture('bad.json'), 'not json');
  const r9 = await post('/api/tasks/import-file', {
    mode: 'dry-run', patchFilePath: fixture('bad.json'),
  });
  assert.equal(r9.status, 400);

  // 10. mixed valid + invalid = all-or-nothing
  const mixedPatch = { version: 'devflow.taskPatch.v1', tasks: [
    { taskId: 'DVF-0200', operation: 'update', fields: { description: 'should not apply' } },
    { taskId: 'DVF-9999', operation: 'update', fields: { description: 'bad' } },
  ]};
  fs.writeFileSync(fixture('mixed.json'), JSON.stringify(mixedPatch));
  const descBeforeMixed = (getTasks()[0] as any).description;
  const r10 = await post('/api/tasks/import-file', {
    mode: 'apply', strategy: 'patch', patchFilePath: fixture('mixed.json'),
  });
  assert.equal(r10.status, 200);
  assert.equal(r10.body.mode, 'dry-run');
  assert.equal((getTasks()[0] as any).description, descBeforeMixed, 'invalid prevents all mutations');

  console.log('[import-tasks-from-file] all tests passed');
} finally {
  await new Promise<void>((r, j) => server.close((e) => e ? j(e) : r()));
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
}
