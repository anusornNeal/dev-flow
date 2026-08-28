import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { executeAllMigrations } from '../../src/db/migrations/index.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-restart-route-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
executeAllMigrations();

const { registerDevFlowRoutes } = await import('../../src/server/routes/devflow.js');
const {
  __setToolJobTestRunner,
  cancelToolJob,
  enqueueToolJob,
  getToolJobStatus,
} = await import('../../src/server/services/mcpToolJobService.js');
const {
  classifyMcpTransportOperation,
  clearMcpTransportRecords,
  createMcpTransportRequestTracker,
  recordMcpTransportRequest,
} = await import('../../src/server/services/mcpTransportMonitor.js');
const { getDevFlowRestartStatus, requestDevFlowRestart } = await import('../../src/server/services/restartService.js');

const restartStatePath = path.join(tempRoot, '.devflow', 'restart-state.json');

function resetRestartState() {
  fs.rmSync(restartStatePath, { force: true });
  clearMcpTransportRecords();
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

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.accepted, true);
    assert.equal(body.duplicate, false);
    assert.equal(body.runtimeScope, 'devflow-api-only');
    assert.equal(body.externalTransportPolicy, 'preserve-service-and-endpoint');
    assert.match(body.ticket, /^restart-/);
    assert.equal('supervisorToken' in body, false);

    const statusResponse = await fetch(`${baseUrl}/api/restart/status?ticket=${encodeURIComponent(body.ticket)}`);
    const statusBody = await statusResponse.json() as any;
    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.status, 'accepted');
    assert.equal(statusBody.runtimeScope, 'devflow-api-only');
    assert.equal(statusBody.externalTransportPolicy, 'preserve-service-and-endpoint');
    assert.equal('supervisorToken' in statusBody, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [75]);
  });
});

test('legacy restart tickets normalize to the API-only lifecycle contract after reconnect', () => {
  resetRestartState();
  fs.mkdirSync(path.dirname(restartStatePath), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(restartStatePath, JSON.stringify({
    ticket: 'restart-legacy-contract',
    status: 'restarting',
    supervisor: 'start-all',
    supervisorToken: 'legacy-token',
    requestedAt: now,
    updatedAt: now,
    requestedByPid: process.pid,
  }), 'utf8');

  const status = getDevFlowRestartStatus({ ticket: 'restart-legacy-contract' }) as any;
  assert.equal(status.status, 'restarting');
  assert.equal(status.runtimeScope, 'devflow-api-only');
  assert.equal(status.externalTransportPolicy, 'preserve-service-and-endpoint');
  assert.equal('supervisorToken' in status, false);
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
    assert.equal(secondBody.runtimeScope, 'devflow-api-only');
    assert.equal(secondBody.externalTransportPolicy, 'preserve-service-and-endpoint');
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

test('restart route rejects while a meaningful MCP operation is in flight', async () => {
  resetRestartState();
  enableSupervisor();
  const exits: number[] = [];
  const tracker = createMcpTransportRequestTracker({ operation: 'tools/list' });

  try {
    await withServer((code) => exits.push(code), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json() as any;

      assert.equal(response.status, 409);
      assert.equal(body.error?.code, 'RESTART_BUSY');
      assert.equal(body.error?.details?.blockers?.inFlightMcp, true);
      assert.equal(body.error?.details?.blockers?.recentMcpActivity, false);
      assert.deepEqual(exits, []);
      assert.equal(fs.existsSync(restartStatePath), false, 'blocked restart must not write a ticket');
    });
  } finally {
    tracker.complete({ statusCode: 200 });
  }
});

test('a single completed initialize does not extend restart quiescence', () => {
  resetRestartState();
  const activityAt = 10_000;
  recordMcpTransportRequest({
    operation: 'initialize',
    statusCode: 200,
    totalMs: 10,
    phaseMs: { parse: 1, connect: 0, handle: 7, close: 0, responseFinalize: 2 },
    timestamp: activityAt,
  });

  const accepted = requestDevFlowRestart({}, {
    env: {
      DEVFLOW_RESTART_SUPERVISOR: 'start-all',
      DEVFLOW_RESTART_SUPERVISOR_TOKEN: 'restart-initialize-test-token',
    },
    now: () => new Date(activityAt + 1_000),
    uuid: () => 'initialize-window-test',
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.duplicate, false);
});

test('a single completed tools/list does not extend restart quiescence', () => {
  resetRestartState();
  const activityAt = 10_000;
  recordMcpTransportRequest({
    operation: 'tools/list',
    statusCode: 200,
    totalMs: 10,
    phaseMs: { parse: 1, connect: 0, handle: 7, close: 0, responseFinalize: 2 },
    timestamp: activityAt,
  });

  const accepted = requestDevFlowRestart({}, {
    env: {
      DEVFLOW_RESTART_SUPERVISOR: 'start-all',
      DEVFLOW_RESTART_SUPERVISOR_TOKEN: 'restart-discovery-test-token',
    },
    now: () => new Date(activityAt + 1_000),
    uuid: () => 'discovery-window-test',
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.duplicate, false);
});

test('multiple completed tools/list calls preserve multi-client restart quiescence', () => {
  resetRestartState();
  const activityAt = 10_000;
  for (const timestamp of [activityAt, activityAt + 100]) {
    recordMcpTransportRequest({
      operation: 'tools/list',
      statusCode: 200,
      totalMs: 10,
      phaseMs: { parse: 1, connect: 0, handle: 7, close: 0, responseFinalize: 2 },
      timestamp,
    });
  }

  assert.throws(
    () => requestDevFlowRestart({}, {
      env: {
        DEVFLOW_RESTART_SUPERVISOR: 'start-all',
        DEVFLOW_RESTART_SUPERVISOR_TOKEN: 'restart-multi-discovery-test-token',
      },
      now: () => new Date(activityAt + 1_000),
      uuid: () => 'multi-discovery-window-test',
    }),
    (error: any) => {
      assert.equal(error?.payload?.code, 'RESTART_BUSY');
      assert.equal(error?.payload?.details?.mcpActivity?.recentToolsListOperations, 2);
      return true;
    },
  );
});

test('recent meaningful MCP activity blocks restart until the bounded quiescence window expires', () => {
  resetRestartState();
  const activityAt = 10_000;
  let nowMs = activityAt + 1_000;
  recordMcpTransportRequest({
    operation: 'tools/call',
    statusCode: 200,
    totalMs: 25,
    phaseMs: { parse: 1, connect: 0, handle: 20, close: 0, responseFinalize: 4 },
    timestamp: activityAt,
  });
  const deps = {
    env: {
      DEVFLOW_RESTART_SUPERVISOR: 'start-all',
      DEVFLOW_RESTART_SUPERVISOR_TOKEN: 'restart-quiescence-test-token',
    },
    now: () => new Date(nowMs),
    uuid: () => 'quiescence-window-test',
  };

  assert.throws(
    () => requestDevFlowRestart({}, deps),
    (error: any) => {
      assert.equal(error?.payload?.code, 'RESTART_BUSY');
      assert.equal(error?.payload?.details?.blockers?.recentMcpActivity, true);
      assert.equal(error?.payload?.details?.mcpActivity?.quiescenceWindowMs, 5_000);
      return true;
    },
  );
  assert.equal(fs.existsSync(restartStatePath), false, 'recent activity must not write a restart ticket');

  nowMs = activityAt + 5_001;
  const accepted = requestDevFlowRestart({}, deps);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.duplicate, false);
  assert.equal(fs.existsSync(restartStatePath), true);
});

test('restart_devflow MCP request does not block itself', async () => {
  resetRestartState();
  enableSupervisor();
  const exits: number[] = [];
  const operation = classifyMcpTransportOperation({
    method: 'tools/call',
    params: { name: 'restart_devflow', arguments: {} },
  });
  assert.equal(operation, 'other');
  const namespacedOperation = classifyMcpTransportOperation({
    method: 'tools/call',
    params: { name: 'devflowz.restart_devflow', arguments: {} },
  });
  assert.equal(namespacedOperation, 'other');
  const tracker = createMcpTransportRequestTracker({ operation });

  try {
    await withServer((code) => exits.push(code), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.accepted, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(exits, [75]);
    });
  } finally {
    tracker.complete({ statusCode: 200 });
  }
});

test('idle long-lived MCP stream activity does not block restart indefinitely', async () => {
  resetRestartState();
  enableSupervisor();
  const exits: number[] = [];
  const idleStreamTracker = createMcpTransportRequestTracker({ operation: 'other' });

  try {
    await withServer((code) => exits.push(code), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.accepted, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(exits, [75]);
    });
  } finally {
    idleStreamTracker.complete({ statusCode: 200 });
  }
});

test.after(() => {
  delete process.env.DEVFLOW_RESTART_SUPERVISOR;
  delete process.env.DEVFLOW_RESTART_SUPERVISOR_TOKEN;
  delete process.env.DEVFLOW_APP_ROOT;
  delete process.env.DEVFLOW_DB_PATH;
});
