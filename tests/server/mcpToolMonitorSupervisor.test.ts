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

test('diagnostics distinguish API health from zrok service/share recovery state', () => {
  const diagnostics = getDevFlowDiagnostics({
    supervisorState: {
      version: 1,
      supervisor: 'start-all',
      mode: 'all',
      shuttingDown: false,
      startedAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:05.000Z',
      processes: {
        server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
        zrok: {
          label: 'zrok',
          status: 'restarting',
          restartAttempt: 2,
          nextRetryAt: '2026-08-16T00:00:09.000Z',
          lastExitCode: 1,
          message: 'Reconciling zrok service/share.',
        },
      },
    },
  } as any);

  assert.equal(diagnostics.runtimeSupervisor?.summary, 'api-healthy-tunnel-restarting');
  assert.equal(diagnostics.runtimeSupervisor?.api.status, 'healthy');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.status, 'restarting');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.restartAttempt, 2);
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.lastExitCode, 1);
});

test('diagnostics propagate public-route degradation independently from zrok logical readiness', () => {
  const diagnostics = getDevFlowDiagnostics({
    supervisorState: {
      version: 1,
      supervisor: 'start-all',
      mode: 'all',
      shuttingDown: false,
      startedAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:10.000Z',
      processes: {
        server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
        zrok: { label: 'zrok', status: 'running', restartAttempt: 0 },
      },
      tunnelHealth: {
        status: 'degraded',
        generation: 'B',
        lifecyclePhase: 'steady-state',
        lastProbeAt: '2026-08-16T00:00:10.000Z',
        lastProbeStatusCode: 502,
        lastProbeLatencyMs: 120,
        lastSuccessAt: '2026-08-16T00:00:00.000Z',
        lastFailureAt: '2026-08-16T00:00:10.000Z',
        consecutiveProbeFailures: 1,
        lastErrorClass: 'http-5xx',
        lastErrorCode: 'ZROK_PUBLIC_HTTP_502',
      },
    },
  } as any);

  assert.equal(diagnostics.runtimeSupervisor?.api.status, 'healthy');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.processStatus, 'running');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.status, 'degraded');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.lastProbeStatusCode, 502);
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.lastErrorClass, 'http-5xx');
  assert.ok(diagnostics.recommendations.some((entry) => entry.includes('Public zrok route is degraded')));
  assert.equal(diagnostics.runtimeSupervisor?.summary, 'api-healthy-tunnel-degraded');
});

test('diagnostics project bounded zrok supervisor evidence without provider inspector pressure', () => {
  const diagnostics = getDevFlowDiagnostics({
    supervisorState: {
      version: 1,
      supervisor: 'start-all',
      mode: 'all',
      shuttingDown: false,
      startedAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:02:00.000Z',
      processes: {
        server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
        zrok: { label: 'zrok', status: 'running', restartAttempt: 0 },
      },
      tunnelHealth: {
        status: 'degraded',
        generation: 'B',
        lifecyclePhase: 'steady-state',
        lastProbeAt: '2026-08-16T00:02:00.000Z',
        lastProbeStatusCode: 503,
        lastProbeLatencyMs: 91,
        lastFailureAt: '2026-08-16T00:02:00.000Z',
        consecutiveProbeFailures: 2,
        lastErrorClass: 'http-5xx',
        lastErrorCode: 'ZROK_PUBLIC_HTTP_503',
        lastRecoveryAt: '2026-08-16T00:01:30.000Z',
        recoveryAttempt: 1,
        message: 'Public zrok route is degraded.',
      },
    },
  } as any) as any;

  assert.equal(diagnostics.runtimeSupervisor.tunnel.tunnelGeneration, 'B');
  assert.equal(diagnostics.runtimeSupervisor.tunnel.lastProbeLatencyMs, 91);
  assert.equal(diagnostics.runtimeSupervisor.tunnel.lastErrorClass, 'http-5xx');
  assert.equal(diagnostics.runtimeSupervisor.tunnel.lastErrorCode, 'ZROK_PUBLIC_HTTP_503');
  assert.equal(diagnostics.runtimeSupervisor.tunnel.recoveryAttempt, 1);
  assert.equal(diagnostics.runtimeSupervisor.tunnel.pressure, undefined);
  assert.equal(diagnostics.runtimeSupervisor.tunnel.recentFailures, undefined);
});

test.after(() => {
  delete process.env.DEVFLOW_APP_ROOT;
  delete process.env.DEVFLOW_DB_PATH;
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
