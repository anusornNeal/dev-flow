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

test('cold-start failures are diagnostic-only until success or grace expiry', () => {
  const coldStart = supervisor.resetDevFlowTunnelHealthForGeneration(undefined, 'cold', {
    startupGraceMs: 30000,
    now: '2026-08-13T00:00:00.000Z',
  });
  assert.equal(coldStart.lifecyclePhase, 'cold-start');

  const firstFailure = supervisor.advanceDevFlowTunnelHealth(coldStart, { ok: false, statusCode: 502 }, {
    failureThreshold: 3,
    generation: 'cold',
    now: '2026-08-13T00:00:05.000Z',
  });
  const secondFailure = supervisor.advanceDevFlowTunnelHealth(firstFailure, { ok: false }, {
    failureThreshold: 3,
    generation: 'cold',
    now: '2026-08-13T00:00:10.000Z',
  });
  assert.equal(secondFailure.status, 'unknown');
  assert.equal(secondFailure.lifecyclePhase, 'cold-start');
  assert.equal(secondFailure.consecutiveProbeFailures, 0);
  assert.equal(secondFailure.lastFailureAt, '2026-08-13T00:00:10.000Z');

  const firstSuccess = supervisor.advanceDevFlowTunnelHealth(secondFailure, { ok: true, statusCode: 200 }, {
    failureThreshold: 3,
    generation: 'cold',
    now: '2026-08-13T00:00:12.000Z',
  });
  assert.equal(firstSuccess.status, 'healthy');
  assert.equal(firstSuccess.lifecyclePhase, 'steady-state');
  assert.equal(firstSuccess.consecutiveProbeFailures, 0);

  const steadyFailureInsideOriginalGrace = supervisor.advanceDevFlowTunnelHealth(firstSuccess, { ok: false, statusCode: 502 }, {
    failureThreshold: 3,
    generation: 'cold',
    now: '2026-08-13T00:00:15.000Z',
  });
  assert.equal(steadyFailureInsideOriginalGrace.status, 'degraded');
  assert.equal(steadyFailureInsideOriginalGrace.lifecyclePhase, 'steady-state');
  assert.equal(steadyFailureInsideOriginalGrace.consecutiveProbeFailures, 1);
});

test('tunnel health is reset and isolated by ngrok process generation', () => {
  const generationA = supervisor.resetDevFlowTunnelHealthForGeneration(undefined, 'A', {
    startupGraceMs: 0,
    now: '2026-08-13T00:00:00.000Z',
  });
  const a1 = supervisor.advanceDevFlowTunnelHealth(generationA, { ok: false }, {
    failureThreshold: 3,
    generation: 'A',
    now: '2026-08-13T00:00:01.000Z',
  });
  const a2 = supervisor.advanceDevFlowTunnelHealth(a1, { ok: false }, {
    failureThreshold: 3,
    generation: 'A',
    now: '2026-08-13T00:00:02.000Z',
  });
  const a3 = supervisor.advanceDevFlowTunnelHealth(a2, { ok: false }, {
    failureThreshold: 3,
    generation: 'A',
    now: '2026-08-13T00:00:03.000Z',
  });
  assert.equal(a3.status, 'down');
  assert.equal(a3.consecutiveProbeFailures, 3);

  const generationB = supervisor.resetDevFlowTunnelHealthForGeneration(a3, 'B', {
    startupGraceMs: 5000,
    now: '2026-08-13T00:00:04.000Z',
  });
  assert.equal(generationB.status, 'unknown');
  assert.equal(generationB.generation, 'B');
  assert.equal(generationB.consecutiveProbeFailures, 0);  assert.equal(generationB.lifecyclePhase, 'cold-start');

  const duringGrace = supervisor.advanceDevFlowTunnelHealth(generationB, { ok: false }, {
    failureThreshold: 3,
    generation: 'B',
    now: '2026-08-13T00:00:05.000Z',
  });
  assert.equal(duringGrace.status, 'unknown');
  assert.equal(duringGrace.consecutiveProbeFailures, 0);

  const b1 = supervisor.advanceDevFlowTunnelHealth(duringGrace, { ok: false }, {
    failureThreshold: 3,
    generation: 'B',
    now: '2026-08-13T00:00:10.000Z',
  });
  const b2 = supervisor.advanceDevFlowTunnelHealth(b1, { ok: false }, {
    failureThreshold: 3,
    generation: 'B',
    now: '2026-08-13T00:00:11.000Z',
  });
  assert.equal(b1.status, 'degraded');
  assert.equal(b1.consecutiveProbeFailures, 1);
  assert.equal(b2.status, 'degraded');
  assert.equal(b2.consecutiveProbeFailures, 2);  assert.equal(b2.lifecyclePhase, 'cold-start');

  const staleSuccessFromA = supervisor.advanceDevFlowTunnelHealth(b2, { ok: true, statusCode: 200 }, {
    failureThreshold: 3,
    generation: 'A',
    now: '2026-08-13T00:00:12.000Z',
  });
  assert.deepEqual(staleSuccessFromA, b2);

  const b3 = supervisor.advanceDevFlowTunnelHealth(b2, { ok: false }, {
    failureThreshold: 3,
    generation: 'B',
    now: '2026-08-13T00:00:13.000Z',
  });
  assert.equal(b3.status, 'down');
  assert.equal(b3.consecutiveProbeFailures, 3);

  const recoveredB = supervisor.advanceDevFlowTunnelHealth(b3, { ok: true, statusCode: 200 }, {
    failureThreshold: 3,
    generation: 'B',
    now: '2026-08-13T00:00:14.000Z',
  });
  assert.equal(recoveredB.status, 'healthy');
  assert.equal(recoveredB.generation, 'B');
  assert.equal(recoveredB.consecutiveProbeFailures, 0);  assert.equal(recoveredB.lifecyclePhase, 'steady-state');
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
