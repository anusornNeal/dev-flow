import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-monitor-supervisor-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { getDevFlowDiagnostics } = await import('../../src/server/services/mcpToolMonitor.js');

test('diagnostics distinguish API health from OpenAI tunnel startup state', () => {
  const diagnostics = getDevFlowDiagnostics({
    supervisorState: {
      version: 2,
      supervisor: 'start-all',
      mode: 'all',
      shuttingDown: false,
      startedAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:05.000Z',
      processes: {
        server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
        tunnel: {
          label: 'tunnel',
          status: 'starting',
          restartAttempt: 0,
          message: 'Starting OpenAI tunnel runtime.',
        },
      },
      tunnelHealth: {
        status: 'unknown',
        lastCheckedAt: '2026-08-28T00:00:05.000Z',
      },
    },
  } as any);

  assert.equal(diagnostics.runtimeSupervisor?.summary, 'api-healthy-tunnel-restarting');
  assert.equal(diagnostics.runtimeSupervisor?.api.status, 'healthy');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.status, 'restarting');
});

test('diagnostics recommend native tunnel status when local API is healthy but tunnel is down', () => {
  const diagnostics = getDevFlowDiagnostics({
    supervisorState: {
      version: 2,
      supervisor: 'start-all',
      mode: 'all',
      shuttingDown: false,
      startedAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:10.000Z',
      processes: {
        server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
        tunnel: { label: 'tunnel', status: 'failed', restartAttempt: 0 },
      },
      tunnelHealth: {
        status: 'down',
        lastCheckedAt: '2026-08-28T00:00:10.000Z',
        lastFailureAt: '2026-08-28T00:00:10.000Z',
        lastErrorClass: 'tunnel-client',
        lastErrorCode: 'TUNNEL_CLIENT_NOT_FOUND',
        message: 'tunnel-client executable was not found',
      },
    },
  } as any) as any;

  assert.equal(diagnostics.runtimeSupervisor.tunnel.status, 'down');
  assert.equal(diagnostics.runtimeSupervisor.tunnel.lastErrorCode, 'TUNNEL_CLIENT_NOT_FOUND');
  assert.ok(diagnostics.recommendations.some((entry: string) => entry.includes('npm run tunnel:status')));
  assert.ok(diagnostics.recommendations.every((entry: string) => !/zrok/i.test(entry)));
});

test('diagnostics resolve to both-healthy when tunnel-client reports healthy runtime state', () => {
  const diagnostics = getDevFlowDiagnostics({
    supervisorState: {
      version: 2,
      supervisor: 'start-all',
      mode: 'all',
      shuttingDown: false,
      startedAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:20.000Z',
      processes: {
        server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
        tunnel: {
          label: 'tunnel',
          status: 'running',
          restartAttempt: 0,
          startedAt: '2026-08-28T00:00:20.000Z',
          message: 'OpenAI tunnel runtime connected.',
        },
      },
      tunnelHealth: {
        status: 'healthy',
        lastCheckedAt: '2026-08-28T00:00:20.000Z',
        lastSuccessAt: '2026-08-28T00:00:20.000Z',
        message: 'OpenAI tunnel runtime is healthy.',
      },
    },
  } as any);

  assert.equal(diagnostics.runtimeSupervisor?.summary, 'both-healthy');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.processStatus, 'running');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.status, 'healthy');
});

test.after(() => {
  delete process.env.DEVFLOW_APP_ROOT;
  delete process.env.DEVFLOW_DB_PATH;
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
