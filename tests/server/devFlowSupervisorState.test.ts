import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-supervisor-state-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;

const supervisor = await import('../../src/lib/devFlowSupervisor.js');

function resetState() {
  fs.rmSync(path.join(tempRoot, '.devflow', 'supervisor-state.json'), { force: true });
}

test('supervisor state round-trips and supports per-child lifecycle updates', () => {
  resetState();
  const initial = supervisor.createDevFlowSupervisorState({
    mode: 'all',
    processLabels: ['server', 'ngrok'],
    now: '2026-08-09T03:00:00.000Z',
  });
  supervisor.writeDevFlowSupervisorState(initial);

  const running = supervisor.updateDevFlowSupervisorProcess('server', {
    status: 'running',
    pid: 1234,
    startedAt: '2026-08-09T03:00:01.000Z',
    restartAttempt: 0,
  }, '2026-08-09T03:00:01.000Z');
  const retrying = supervisor.updateDevFlowSupervisorProcess('ngrok', {
    status: 'restarting',
    lastExitAt: '2026-08-09T03:00:02.000Z',
    lastExitCode: 1,
    lastSignal: null,
    restartAttempt: 2,
    nextRetryAt: '2026-08-09T03:00:04.000Z',
    message: 'Unexpected exit; retry scheduled.',
  }, '2026-08-09T03:00:02.000Z');

  assert.equal(running?.processes.server?.status, 'running');
  assert.equal(retrying?.processes.ngrok?.status, 'restarting');
  assert.equal(retrying?.processes.ngrok?.restartAttempt, 2);
  assert.equal(retrying?.processes.ngrok?.nextRetryAt, '2026-08-09T03:00:04.000Z');

  const persisted = supervisor.readDevFlowSupervisorState();
  assert.equal(persisted?.mode, 'all');
  assert.equal(persisted?.processes.server?.pid, 1234);
  assert.equal(persisted?.processes.ngrok?.lastExitCode, 1);
});

test('legacy supervisor state without tunnel health remains readable and reports reachability unknown', () => {
  resetState();
  const statePath = path.join(tempRoot, '.devflow', 'supervisor-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-09T03:00:00.000Z',
    updatedAt: '2026-08-09T03:00:01.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      ngrok: { label: 'ngrok', status: 'running', pid: 200, restartAttempt: 0 },
    },
  }), 'utf8');

  const persisted = supervisor.readDevFlowSupervisorState();
  assert.equal(persisted?.tunnelHealth, undefined);
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics(persisted);
  assert.equal(diagnostics.tunnel.processStatus, 'running');
  assert.equal(diagnostics.tunnel.status, 'unknown');
});

test('diagnostics distinguish both healthy from API healthy with tunnel restarting', () => {
  const bothHealthy = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 1,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-09T03:00:00.000Z',
    updatedAt: '2026-08-09T03:00:02.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      ngrok: { label: 'ngrok', status: 'running', pid: 200, restartAttempt: 0 },
    },
    tunnelHealth: {
      status: 'healthy',
      lastProbeAt: '2026-08-09T03:00:02.000Z',
      lastProbeStatusCode: 200,
      lastProbeLatencyMs: 80,
      lastSuccessAt: '2026-08-09T03:00:02.000Z',
      consecutiveProbeFailures: 0,
    },
  });
  assert.equal(bothHealthy.summary, 'both-healthy');
  assert.equal(bothHealthy.api.status, 'healthy');
  assert.equal(bothHealthy.tunnel.status, 'healthy');

  const tunnelRestarting = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 1,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-09T03:00:00.000Z',
    updatedAt: '2026-08-09T03:00:05.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      ngrok: { label: 'ngrok', status: 'restarting', restartAttempt: 3, nextRetryAt: '2026-08-09T03:00:09.000Z' },
    },
  });
  assert.equal(tunnelRestarting.summary, 'api-healthy-tunnel-restarting');
  assert.equal(tunnelRestarting.api.status, 'healthy');
  assert.equal(tunnelRestarting.tunnel.status, 'restarting');
  assert.equal(tunnelRestarting.tunnel.restartAttempt, 3);
});

test('diagnostics distinguish ngrok healthy while API child is down', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 1,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-09T03:00:00.000Z',
    updatedAt: '2026-08-09T03:00:05.000Z',
    processes: {
      server: { label: 'server', status: 'failed', lastExitCode: 1, restartAttempt: 0 },
      ngrok: { label: 'ngrok', status: 'running', pid: 200, restartAttempt: 0 },
    },
    tunnelHealth: {
      status: 'healthy',
      lastProbeAt: '2026-08-09T03:00:05.000Z',
      lastProbeStatusCode: 200,
      lastProbeLatencyMs: 90,
      lastSuccessAt: '2026-08-09T03:00:05.000Z',
      consecutiveProbeFailures: 0,
    },
  });

  assert.equal(diagnostics.summary, 'api-down-tunnel-healthy');
  assert.equal(diagnostics.api.status, 'down');
  assert.equal(diagnostics.tunnel.status, 'healthy');
});

test('server-only diagnostics report the tunnel as disabled', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 1,
    supervisor: 'start-all',
    mode: 'server-only',
    shuttingDown: false,
    startedAt: '2026-08-09T03:00:00.000Z',
    updatedAt: '2026-08-09T03:00:01.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
    },
  });

  assert.equal(diagnostics.summary, 'api-healthy-tunnel-disabled');
  assert.equal(diagnostics.tunnel.enabled, false);
  assert.equal(diagnostics.tunnel.status, 'disabled');
});

test('running ngrok is not treated as publicly healthy before a reachability probe succeeds', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 1,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:01.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      ngrok: { label: 'ngrok', status: 'running', pid: 200, restartAttempt: 0 },
    },
  });

  assert.equal(diagnostics.api.status, 'healthy');
  assert.equal(diagnostics.tunnel.processStatus, 'running');
  assert.equal(diagnostics.tunnel.status, 'unknown');
  assert.equal(diagnostics.summary, 'api-healthy-tunnel-unknown');
});

test('public tunnel probe failures degrade before becoming down and recover on success', () => {
  const degraded = supervisor.advanceDevFlowTunnelHealth(undefined, {
    ok: false,
    statusCode: 502,
    latencyMs: 120,
    message: 'public probe failed',
  }, { failureThreshold: 3, now: '2026-08-13T00:00:10.000Z' });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.consecutiveProbeFailures, 1);

  const stillDegraded = supervisor.advanceDevFlowTunnelHealth(degraded, {
    ok: false,
    statusCode: 502,
    latencyMs: 130,
    message: 'public probe failed again',
  }, { failureThreshold: 3, now: '2026-08-13T00:00:20.000Z' });
  assert.equal(stillDegraded.status, 'degraded');
  assert.equal(stillDegraded.consecutiveProbeFailures, 2);

  const down = supervisor.advanceDevFlowTunnelHealth(stillDegraded, {
    ok: false,
    latencyMs: 140,
    message: 'public probe timed out',
  }, { failureThreshold: 3, now: '2026-08-13T00:00:30.000Z' });
  assert.equal(down.status, 'down');
  assert.equal(down.consecutiveProbeFailures, 3);

  const recovered = supervisor.advanceDevFlowTunnelHealth(down, {
    ok: true,
    statusCode: 200,
    latencyMs: 80,
  }, { failureThreshold: 3, now: '2026-08-13T00:00:40.000Z' });
  assert.equal(recovered.status, 'healthy');
  assert.equal(recovered.consecutiveProbeFailures, 0);
  assert.equal(recovered.lastSuccessAt, '2026-08-13T00:00:40.000Z');
});

test('diagnostics expose running process with degraded public tunnel independently', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 1,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:11.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      ngrok: { label: 'ngrok', status: 'running', pid: 200, restartAttempt: 0 },
    },
    tunnelHealth: {
      status: 'degraded',
      lastProbeAt: '2026-08-13T00:00:10.000Z',
      lastProbeStatusCode: 502,
      lastProbeLatencyMs: 120,
      consecutiveProbeFailures: 1,
    },
  } as any);

  assert.equal(diagnostics.tunnel.status, 'degraded');
  assert.equal(diagnostics.tunnel.processStatus, 'running');
  assert.equal(diagnostics.tunnel.consecutiveProbeFailures, 1);
  assert.equal(diagnostics.summary, 'api-healthy-tunnel-degraded');
});

test('supervisor source changes do not introduce MCP authentication fields or token requirements', () => {
  const sources = [
    'scripts/start-all.ts',
    'src/lib/devFlowSupervisor.ts',
    'src/server/services/mcpToolMonitor.ts',
  ].map((filePath) => fs.readFileSync(path.resolve(filePath), 'utf8')).join('\n');

  assert.doesNotMatch(sources, /\bOAuth\b|\bBearer\b|\bAuthorization\b|api[_-]?key/i);
});

test.after(() => {
  delete process.env.DEVFLOW_APP_ROOT;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
