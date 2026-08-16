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

test('supervisor state models server and persistent zrok lifecycle separately', () => {
  resetState();
  const initial = supervisor.createDevFlowSupervisorState({
    mode: 'all',
    processLabels: ['server', 'zrok'],
    now: '2026-08-16T00:00:00.000Z',
  });
  supervisor.writeDevFlowSupervisorState(initial);

  supervisor.updateDevFlowSupervisorProcess('server', {
    status: 'running',
    pid: 1234,
    startedAt: '2026-08-16T00:00:01.000Z',
    restartAttempt: 0,
  }, '2026-08-16T00:00:01.000Z');
  supervisor.updateDevFlowSupervisorProcess('zrok', {
    status: 'running',
    startedAt: '2026-08-16T00:00:02.000Z',
    restartAttempt: 0,
    message: 'persistent service/share ready',
  }, '2026-08-16T00:00:02.000Z');

  const persisted = supervisor.readDevFlowSupervisorState();
  assert.equal(persisted?.processes.server?.pid, 1234);
  assert.equal(persisted?.processes.zrok?.status, 'running');
  assert.equal(persisted?.processes.zrok?.pid, undefined);
  assert.equal(persisted?.tunnelHealth?.status, 'unknown');
});

test('running zrok readiness is not public healthy until a probe succeeds', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 1,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:02.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      zrok: { label: 'zrok', status: 'running', restartAttempt: 0 },
    },
    tunnelHealth: { status: 'unknown', consecutiveProbeFailures: 0 },
  });

  assert.equal(diagnostics.api.status, 'healthy');
  assert.equal(diagnostics.tunnel.processStatus, 'running');
  assert.equal(diagnostics.tunnel.status, 'unknown');
  assert.equal(diagnostics.summary, 'api-healthy-tunnel-unknown');
});

test('public tunnel probe succeeds independently from local API process state', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 1,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:03.000Z',
    processes: {
      server: { label: 'server', status: 'failed', lastExitCode: 1, restartAttempt: 0 },
      zrok: { label: 'zrok', status: 'running', restartAttempt: 0 },
    },
    tunnelHealth: {
      status: 'healthy',
      lastProbeAt: '2026-08-16T00:00:03.000Z',
      lastProbeStatusCode: 200,
      lastProbeLatencyMs: 50,
      lastSuccessAt: '2026-08-16T00:00:03.000Z',
      consecutiveProbeFailures: 0,
    },
  });

  assert.equal(diagnostics.summary, 'api-down-tunnel-healthy');
  assert.equal(diagnostics.api.status, 'down');
  assert.equal(diagnostics.tunnel.status, 'healthy');
});

test('server-only diagnostics keep tunnel disabled', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 1,
    supervisor: 'start-all',
    mode: 'server-only',
    shuttingDown: false,
    startedAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:01.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
    },
  });
  assert.equal(diagnostics.summary, 'api-healthy-tunnel-disabled');
  assert.equal(diagnostics.tunnel.enabled, false);
  assert.equal(diagnostics.tunnel.status, 'disabled');
});

test('cold start ignores failures during grace then degrades and becomes down', () => {
  let health = supervisor.resetDevFlowTunnelHealthForGeneration(undefined, 'A', {
    startupGraceMs: 5000,
    now: '2026-08-16T00:00:00.000Z',
  });
  health = supervisor.advanceDevFlowTunnelHealth(health, { ok: false, statusCode: 502 }, {
    failureThreshold: 3,
    generation: 'A',
    now: '2026-08-16T00:00:01.000Z',
  });
  assert.equal(health.status, 'unknown');
  assert.equal(health.consecutiveProbeFailures, 0);

  for (const [index, now] of ['2026-08-16T00:00:06.000Z', '2026-08-16T00:00:07.000Z', '2026-08-16T00:00:08.000Z'].entries()) {
    health = supervisor.advanceDevFlowTunnelHealth(health, { ok: false, statusCode: 502 }, {
      failureThreshold: 3,
      generation: 'A',
      now,
    });
    assert.equal(health.consecutiveProbeFailures, index + 1);
  }
  assert.equal(health.status, 'down');
});

test('first success enters steady state and later failure degrades immediately', () => {
  let health = supervisor.resetDevFlowTunnelHealthForGeneration(undefined, 'A', {
    startupGraceMs: 30000,
    now: '2026-08-16T00:00:00.000Z',
  });
  health = supervisor.advanceDevFlowTunnelHealth(health, { ok: true, statusCode: 200 }, {
    failureThreshold: 3,
    generation: 'A',
    now: '2026-08-16T00:00:02.000Z',
  });
  assert.equal(health.lifecyclePhase, 'steady-state');
  assert.equal(health.status, 'healthy');

  health = supervisor.advanceDevFlowTunnelHealth(health, { ok: false, statusCode: 502 }, {
    failureThreshold: 3,
    generation: 'A',
    now: '2026-08-16T00:00:03.000Z',
  });
  assert.equal(health.status, 'degraded');
  assert.equal(health.consecutiveProbeFailures, 1);
});

test('stale probe generation cannot overwrite a newer zrok generation', () => {
  const generationA = supervisor.resetDevFlowTunnelHealthForGeneration(undefined, 'A', {
    startupGraceMs: 0,
    now: '2026-08-16T00:00:00.000Z',
  });
  const generationB = supervisor.resetDevFlowTunnelHealthForGeneration(generationA, 'B', {
    startupGraceMs: 0,
    now: '2026-08-16T00:00:01.000Z',
  });
  const stale = supervisor.advanceDevFlowTunnelHealth(generationB, { ok: true, statusCode: 200 }, {
    failureThreshold: 3,
    generation: 'A',
    now: '2026-08-16T00:00:02.000Z',
  });
  assert.deepEqual(stale, generationB);
});

test('degraded and down public reachability remain independent from service running state', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
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
      lastProbeAt: '2026-08-16T00:00:10.000Z',
      lastProbeStatusCode: 502,
      consecutiveProbeFailures: 1,
    },
  });
  assert.equal(diagnostics.tunnel.processStatus, 'running');
  assert.equal(diagnostics.tunnel.status, 'degraded');
  assert.equal(diagnostics.summary, 'api-healthy-tunnel-degraded');
});

test('intentional shutdown dominates diagnostic summary without changing tunnel proof', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 1,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: true,
    startedAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:10.000Z',
    processes: {
      server: { label: 'server', status: 'stopped', restartAttempt: 0 },
      zrok: { label: 'zrok', status: 'running', restartAttempt: 0 },
    },
    tunnelHealth: { status: 'healthy', consecutiveProbeFailures: 0 },
  });
  assert.equal(diagnostics.summary, 'shutting-down');
  assert.equal(diagnostics.tunnel.status, 'healthy');
});

test.after(() => {
  delete process.env.DEVFLOW_APP_ROOT;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
