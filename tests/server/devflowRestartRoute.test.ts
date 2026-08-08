import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-restart-route-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { registerDevFlowRoutes } = await import('../../src/server/routes/devflow.js');
const {
  __setToolJobTestRunner,
  cancelToolJob,
  enqueueToolJob,
  getToolJobStatus,
} = await import('../../src/server/services/mcpToolJobService.js');

const restartStatePath = path.join(tempRoot, '.devflow', 'restart-state.json');

function resetRestartState() {
  fs.rmSync(restartStatePath, { force: true });
}

function enableSupervisor() {
  process.env.DEVFLOW_RESTART_SUPERVISOR = 'start-all';
  process.env.DEVFLOW_RESTART_SUPERVISOR_TOKEN = 'restart-route-test-token';
}

async function waitUntil(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function withServer(
  restartProcess: (exitCode: number) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  registerDevFlowRoutes(app, {
    state: { countersCache: {} },
    writeAgentLog: () => {},
    restartProcess,
  } as any);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind restart route test server.');

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('restart route rejects hosts without the start-all supervisor', async () => {
  resetRestartState();
  delete process.env.DEVFLOW_RESTART_SUPERVISOR;
  delete process.env.DEVFLOW_RESTART_SUPERVISOR_TOKEN;
  const exits: number[] = [];

  await withServer((code) => exits.push(code), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await response.json() as any;

    assert.equal(response.status, 409);
    assert.equal(body.error?.code, 'RESTART_UNSUPPORTED');
    assert.match(body.error?.message || '', /npm run dev/);
    assert.match(body.error?.message || '', /dev:server/);
    assert.deepEqual(exits, []);
  });
});

test('supervised restart acknowledges before scheduling server exit', async () => {
  resetRestartState();
  enableSupervisor();
  const exits: number[] = [];

  await withServer((code) => exits.push(code), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(body.accepted, true);
    assert.equal(body.duplicate, false);
    assert.match(body.ticket, /^restart-/);
    assert.equal('supervisorToken' in body, false);

    const statusResponse = await fetch(`${baseUrl}/api/restart/status?ticket=${encodeURIComponent(body.ticket)}`);
    const statusBody = await statusResponse.json() as any;
    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.status, 'accepted');
    assert.equal('supervisorToken' in statusBody, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [75]);
  });
});

test('duplicate restart requests reuse one ticket and schedule one exit', async () => {
  resetRestartState();
  enableSupervisor();
  const exits: number[] = [];

  await withServer((code) => exits.push(code), async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const firstBody = await first.json() as any;
    const second = await fetch(`${baseUrl}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const secondBody = await second.json() as any;

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(firstBody.ticket, secondBody.ticket);
    assert.equal(secondBody.duplicate, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [75]);
  });
});

test('tool jobs are rejected while a restart ticket is pending', () => {
  resetRestartState();
  fs.mkdirSync(path.dirname(restartStatePath), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(restartStatePath, JSON.stringify({
    ticket: 'restart-pending-job-guard',
    status: 'accepted',
    supervisor: 'start-all',
    requestedAt: now,
    updatedAt: now,
    requestedByPid: process.pid,
  }), 'utf8');

  assert.throws(
    () => enqueueToolJob(
      { countersCache: {} } as any,
      `restart-guard-${Date.now()}`,
      { localPath: tempRoot },
      'repo-command',
    ),
    (error: any) => error?.payload?.code === 'RESTART_IN_PROGRESS',
  );
});

test('restart route rejects while an MCP tool job is active', async () => {
  resetRestartState();
  enableSupervisor();
  const exits: number[] = [];
  const toolName = `restart-busy-${Date.now()}`;
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  __setToolJobTestRunner(toolName, async () => {
    await blocker;
    return { ok: true };
  });

  const job = enqueueToolJob({ countersCache: {} } as any, toolName, { localPath: tempRoot }, 'repo-command');
  await waitUntil(() => getToolJobStatus(job.jobId)?.status === 'running', 'Expected blocker job to become running.');

  try {
    await withServer((code) => exits.push(code), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json() as any;

      assert.equal(response.status, 409);
      assert.equal(body.error?.code, 'RESTART_BUSY');
      assert.deepEqual(exits, []);
    });
  } finally {
    release();
    cancelToolJob(job.jobId);
    __setToolJobTestRunner(toolName, null);
  }
});

test.after(() => {
  delete process.env.DEVFLOW_RESTART_SUPERVISOR;
  delete process.env.DEVFLOW_RESTART_SUPERVISOR_TOKEN;
  delete process.env.DEVFLOW_APP_ROOT;
  delete process.env.DEVFLOW_DB_PATH;
});
