import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Set up isolated sqlite DB per test file run
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-adversarial-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTasks } = await import('../../src/server/repositories/taskRepository.js');
const db = (await import('../../src/db/index.js')).default;

// Spy on database prepare to count database actions
const originalPrepare = db.prepare;
let preparedStatementsCounts: Record<string, number> = {};

db.prepare = function (sql: string) {
  preparedStatementsCounts[sql] = (preparedStatementsCounts[sql] || 0) + 1;
  const stmt = originalPrepare.call(db, sql);
  const originalRun = stmt.run;
  const originalAll = stmt.all;

  stmt.run = function (...args: any[]) {
    // Count execution of specific statements
    const key = sql + ' [run]';
    preparedStatementsCounts[key] = (preparedStatementsCounts[key] || 0) + 1;
    return originalRun.apply(stmt, args);
  };

  stmt.all = function (...args: any[]) {
    const key = sql + ' [all]';
    preparedStatementsCounts[key] = (preparedStatementsCounts[key] || 0) + 1;
    return originalAll.apply(stmt, args);
  };

  return stmt;
} as any;

function clearPreparedCounts() {
  preparedStatementsCounts = {};
}

const state: any = {
  tasksCache: [
    {
      id: 'task-adversarial-1',
      displayId: 'DVF-0950',
      title: 'Adversarial target task',
      description: 'Used for task lock and idempotency testing.',
      projectId: 'proj-adversarial-1',
      status: 'todo',
      priority: 'medium',
      category: 'backend',
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  projectsCache: [
    { id: 'proj-adversarial-1', name: 'Dev Flow', repoUrl: 'https://example.com/dev-flow', createdAt: new Date().toISOString() },
  ],
  countersCache: { DVF: 950 },
  
  skillsRegistry: [],
};

((state as any).projectsCache || []).forEach(p => createProject(p));
saveTasks(state as any);

const app = express();
app.use(express.json());
registerApiRoutes(app, { state: state as any, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('Server address unavailable');
const base = `http://127.0.0.1:${addr.port}`;

test('Resource locks prevent conflicting operations and return RESOURCE_BUSY error', async () => {
  const { acquireLock, releaseLock } = await import('../../src/server/services/lockAndIdempotencyService.js');
  
  // Lock the project/task ID
  const token = acquireLock('proj-adversarial-1');

  try {
    // Attempting to create a task on project 'proj-adversarial-1' should result in RESOURCE_BUSY
    const response = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-adversarial-1',
        title: 'Task under locked project',
        category: 'backend',
      }),
    });

    assert.equal(response.status, 409);
    const body = await response.json() as any;
    
    assert.equal(body.error.code, 'RESOURCE_BUSY');
    assert.equal(body.error.message, 'Resource proj-adversarial-1 is currently locked by another operation. Please try again.');
    assert.equal(body.error.retryable, true);
    assert.ok(typeof body.error.correlationId === 'string');
  } finally {
    releaseLock('proj-adversarial-1', token);
  }

  // After releasing, it should succeed
  const successResponse = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'proj-adversarial-1',
      title: 'Task after lock release',
      category: 'backend',
    }),
  });
  assert.equal(successResponse.status, 201);
});

test('Resource locks cannot be bypassed by public request body fields', async () => {
  const { acquireLock, releaseLock } = await import('../../src/server/services/lockAndIdempotencyService.js');
  const token = acquireLock('proj-adversarial-1');

  try {
    const response = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-adversarial-1',
        title: 'Task attempting public lock bypass',
        category: 'backend',
        resourceLockOverride: true,
      }),
    });

    assert.equal(response.status, 409);
    const body = await response.json() as any;
    assert.equal(body.error.code, 'RESOURCE_BUSY');
  } finally {
    releaseLock('proj-adversarial-1', token);
  }
});

test('Duplicate API calls within the idempotency window return cached result and do not duplicate DB actions', async () => {
  const idempotencyKey = `idemp-key-${Date.now()}`;
  clearPreparedCounts();

  const payload = {
    projectId: 'proj-adversarial-1',
    title: 'Idempotent Task',
    category: 'backend',
    idempotencyKey,
  };

  // First request
  const res1 = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(res1.status, 201);
  const body1 = await res1.json() as any;

  // Let's see if the database write happened
  const insertSqlKey = Object.keys(preparedStatementsCounts).find(k => k.includes('INSERT OR REPLACE INTO tasks') && k.includes('[run]'));
  assert.ok(insertSqlKey, 'Insert SQL should be executed');
  const initialWrites = preparedStatementsCounts[insertSqlKey];
  assert.equal(initialWrites, 1);

  // Clear query tracker counts
  clearPreparedCounts();

  // Second request (within idempotency window)
  const res2 = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.ok([200, 201].includes(res2.status), `Status was ${res2.status}`);
  const body2 = await res2.json() as any;

  // Verify the response is identical (e.g. same task ID, title)
  assert.equal(body1.id, body2.id);
  assert.equal(body1.title, body2.title);

  // Verify NO duplicate database writes happened
  const insertSqlKey2 = Object.keys(preparedStatementsCounts).find(k => k.includes('INSERT OR REPLACE INTO tasks') && k.includes('[run]'));
  assert.equal(insertSqlKey2, undefined, 'No insert SQL should run on duplicate idempotent call');
});

test('Reusing an idempotency key with a different payload returns IDEMPOTENCY_CONFLICT', async () => {
  const idempotencyKey = `idemp-key-conflict-${Date.now()}`;

  const res1 = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'proj-adversarial-1',
      title: 'Conflict first payload',
      category: 'backend',
      idempotencyKey,
    }),
  });
  assert.equal(res1.status, 201);

  const res2 = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'proj-adversarial-1',
      title: 'Conflict second payload',
      category: 'backend',
      idempotencyKey,
    }),
  });
  assert.equal(res2.status, 409);
  const body = await res2.json() as any;
  assert.equal(body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('Concurrent API calls with the same idempotency key await the same pending promise', async () => {
  const idempotencyKey = `idemp-key-concurrent-${Date.now()}`;
  clearPreparedCounts();

  const payload = {
    projectId: 'proj-adversarial-1',
    title: 'Concurrent Idempotent Task',
    category: 'backend',
    idempotencyKey,
  };

  // Trigger two fetch requests concurrently
  const [res1, res2] = await Promise.all([
    fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  ]);

  assert.ok([200, 201].includes(res1.status), `Status res1 was ${res1.status}`);
  assert.ok([200, 201].includes(res2.status), `Status res2 was ${res2.status}`);

  const body1 = await res1.json() as any;
  const body2 = await res2.json() as any;

  // Verify the response is identical
  assert.equal(body1.id, body2.id);

  // Verify database write happened exactly once
  const insertSqlKey = Object.keys(preparedStatementsCounts).find(k => k.includes('INSERT OR REPLACE INTO tasks') && k.includes('[run]'));
  assert.ok(insertSqlKey);
  assert.equal(preparedStatementsCounts[insertSqlKey], 1);
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
