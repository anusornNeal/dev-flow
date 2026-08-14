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

test('diagnostics distinguish API health from ngrok tunnel recovery state', () => {
  const diagnostics = getDevFlowDiagnostics({
    supervisorState: {
      version: 1,
      supervisor: 'start-all',
      mode: 'all',
      shuttingDown: false,
      startedAt: '2026-08-09T03:00:00.000Z',
      updatedAt: '2026-08-09T03:00:05.000Z',
      processes: {
        server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
        ngrok: {
          label: 'ngrok',
          status: 'restarting',
          restartAttempt: 2,
          nextRetryAt: '2026-08-09T03:00:09.000Z',
          lastExitCode: 1,
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

test('diagnostics propagate public tunnel degradation independently from ngrok process liveness', () => {
  const diagnostics = getDevFlowDiagnostics({
    supervisorState: {
      version: 1,
      supervisor: 'start-all',
      mode: 'all',
      shuttingDown: false,
      startedAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:10.000Z',
      processes: {
        server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
        ngrok: { label: 'ngrok', status: 'running', pid: 200, restartAttempt: 0 },
      },
      tunnelHealth: {
        status: 'degraded',
        lastProbeAt: '2026-08-13T00:00:10.000Z',
        lastProbeStatusCode: 502,
        lastProbeLatencyMs: 120,
        lastSuccessAt: '2026-08-13T00:00:00.000Z',
        consecutiveProbeFailures: 1,
      },
    },
  } as any);

  assert.equal(diagnostics.runtimeSupervisor?.api.status, 'healthy');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.processStatus, 'running');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.status, 'degraded');
  assert.equal(diagnostics.runtimeSupervisor?.tunnel.lastProbeStatusCode, 502);
  assert.ok(diagnostics.recommendations.some((entry) => entry.includes('Public ngrok tunnel is degraded')));
  assert.equal(diagnostics.runtimeSupervisor?.summary, 'api-healthy-tunnel-degraded');
});

test('diagnostics expose only bounded sanitized recent tunnel failure and pressure evidence', () => {
  const diagnosticsDir = path.join(tempRoot, '.devflow');
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const diagnosticsPath = path.join(diagnosticsDir, 'ngrok-diagnostics.jsonl');
  const lines: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    lines.push(JSON.stringify({
      at: `2026-08-13T00:01:${String(index).padStart(2, '0')}.000Z`,
      kind: 'public-probe-failure',
      failureClass: index % 3 === 0 ? 'rate-limit' : index % 3 === 1 ? 'timeout' : 'http-5xx',
      statusCode: index % 3 === 0 ? 429 : index % 3 === 2 ? 503 : undefined,
      latencyMs: 80 + index,
      generation: 'B',
      consecutiveProbeFailures: index + 1,
      recoveryDecision: index === 11 ? 'restart-ngrok' : 'threshold-not-reached',
      retryAfter: index % 3 === 0 ? '120' : undefined,
      url: 'https://secret.ngrok-free.app/token=abc123',
      headers: { authorization: 'Bearer secret-token' },
      body: 'raw-secret-body',
    }));
  }
  lines.push(JSON.stringify({
    at: '2026-08-13T00:02:00.000Z',
    kind: 'ngrok-pressure',
    generation: 'B',
    pressure: { connectionCount: 12, activeConnections: 2, connectionRate1: 1.5, requestCount: 30, requestRate1: 4.5 },
    publicUrl: 'https://secret.ngrok-free.app',
    rawRequestHistory: 'must-not-project',
  }));
  fs.writeFileSync(diagnosticsPath, `${lines.join('\n')}\n`, 'utf8');

  const diagnostics = getDevFlowDiagnostics({
    supervisorState: {
      version: 1,
      supervisor: 'start-all',
      mode: 'all',
      shuttingDown: false,
      startedAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:02:00.000Z',
      processes: {
        server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
        ngrok: { label: 'ngrok', status: 'running', pid: 200, restartAttempt: 0 },
      },
      tunnelHealth: { status: 'degraded', generation: 'B', consecutiveProbeFailures: 2 },
    },
  } as any) as any;

  assert.equal(diagnostics.runtimeSupervisor.tunnel.recentFailures.length, 8);
  assert.equal(diagnostics.runtimeSupervisor.tunnel.recentFailures[0].consecutiveProbeFailures, 12);
  assert.equal(diagnostics.runtimeSupervisor.tunnel.recentFailures[0].recoveryDecision, 'restart-ngrok');
  assert.equal(diagnostics.runtimeSupervisor.tunnel.pressure.requestRate1, 4.5);
  const projected = JSON.stringify(diagnostics.runtimeSupervisor.tunnel);
  assert.doesNotMatch(projected, /secret\.ngrok|abc123|Bearer|secret-token|raw-secret-body|must-not-project/i);
});

test.after(() => {
  delete process.env.DEVFLOW_APP_ROOT;
  delete process.env.DEVFLOW_DB_PATH;
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
