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

test('supervisor state models server and OpenAI tunnel lifecycle separately', () => {
  resetState();
  const initial = supervisor.createDevFlowSupervisorState({
    mode: 'all',
    processLabels: ['server', 'tunnel'],
    now: '2026-08-28T00:00:00.000Z',
  });
  supervisor.writeDevFlowSupervisorState(initial);

  supervisor.updateDevFlowSupervisorProcess('server', {
    status: 'running',
    pid: 1234,
    startedAt: '2026-08-28T00:00:01.000Z',
    restartAttempt: 0,
  }, '2026-08-28T00:00:01.000Z');
  supervisor.updateDevFlowSupervisorProcess('tunnel', {
    status: 'running',
    startedAt: '2026-08-28T00:00:02.000Z',
    restartAttempt: 0,
    message: 'managed tunnel runtime connected',
  }, '2026-08-28T00:00:02.000Z');

  const persisted = supervisor.readDevFlowSupervisorState();
  assert.equal(persisted?.version, 2);
  assert.equal(persisted?.processes.server?.pid, 1234);
  assert.equal(persisted?.processes.tunnel?.status, 'running');
  assert.equal(persisted?.processes.tunnel?.pid, undefined, 'tunnel-client owns its managed runtime process');
  assert.equal(persisted?.tunnelHealth?.status, 'unknown');
});

test('running tunnel process remains unknown until tunnel-client health is explicit', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 2,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:02.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      tunnel: { label: 'tunnel', status: 'running', restartAttempt: 0 },
    },
    tunnelHealth: { status: 'unknown', lastCheckedAt: '2026-08-28T00:00:02.000Z' },
  });

  assert.equal(diagnostics.api.status, 'healthy');
  assert.equal(diagnostics.tunnel.processStatus, 'running');
  assert.equal(diagnostics.tunnel.status, 'unknown');
  assert.equal(diagnostics.summary, 'api-healthy-tunnel-unknown');
});

test('explicit healthy tunnel status produces both-healthy diagnostics', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 2,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:03.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      tunnel: { label: 'tunnel', status: 'running', restartAttempt: 0 },
    },
    tunnelHealth: {
      status: 'healthy',
      lastCheckedAt: '2026-08-28T00:00:03.000Z',
      lastSuccessAt: '2026-08-28T00:00:03.000Z',
      message: 'OpenAI tunnel runtime is healthy.',
    },
  });

  assert.equal(diagnostics.summary, 'both-healthy');
  assert.equal(diagnostics.tunnel.status, 'healthy');
  assert.equal(diagnostics.tunnel.lastSuccessAt, '2026-08-28T00:00:03.000Z');
});

test('server-only diagnostics keep tunnel disabled', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 2,
    supervisor: 'start-all',
    mode: 'server-only',
    shuttingDown: false,
    startedAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:01.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
    },
  });
  assert.equal(diagnostics.summary, 'api-healthy-tunnel-disabled');
  assert.equal(diagnostics.tunnel.enabled, false);
  assert.equal(diagnostics.tunnel.status, 'disabled');
});

test('a reused server-only owner can become tunnel-enabled without replacing the API owner', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 2,
    supervisor: 'start-all',
    mode: 'server-only',
    shuttingDown: false,
    startedAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:05.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      tunnel: { label: 'tunnel', status: 'running', restartAttempt: 0 },
    },
    tunnelHealth: { status: 'healthy', lastCheckedAt: '2026-08-28T00:00:05.000Z' },
  });

  assert.equal(diagnostics.tunnel.enabled, true);
  assert.equal(diagnostics.summary, 'both-healthy');
});

test('failed tunnel lifecycle is down while the API remains healthy', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 2,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:10.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      tunnel: { label: 'tunnel', status: 'failed', restartAttempt: 0, message: 'tunnel-client failed' },
    },
    tunnelHealth: {
      status: 'down',
      lastCheckedAt: '2026-08-28T00:00:10.000Z',
      lastFailureAt: '2026-08-28T00:00:10.000Z',
      lastErrorCode: 'TUNNEL_CLIENT_NOT_FOUND',
    },
  });
  assert.equal(diagnostics.tunnel.status, 'down');
  assert.equal(diagnostics.summary, 'api-healthy-tunnel-down');
  assert.equal(diagnostics.tunnel.lastErrorCode, 'TUNNEL_CLIENT_NOT_FOUND');
});

test('intentional shutdown dominates diagnostic summary', () => {
  const diagnostics = supervisor.buildDevFlowSupervisorDiagnostics({
    version: 2,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: true,
    startedAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:10.000Z',
    processes: {
      server: { label: 'server', status: 'stopped', restartAttempt: 0 },
      tunnel: { label: 'tunnel', status: 'stopped', restartAttempt: 0 },
    },
    tunnelHealth: { status: 'down', lastCheckedAt: '2026-08-28T00:00:10.000Z' },
  });
  assert.equal(diagnostics.summary, 'shutting-down');
});

test('unexpected server crash evidence survives supervisor reinitialization and redacts bounded stderr', () => {
  resetState();
  const initial = supervisor.createDevFlowSupervisorState({
    mode: 'all',
    processLabels: ['server', 'tunnel'],
    now: '2026-08-30T07:59:00.000Z',
  });
  supervisor.writeDevFlowSupervisorState(initial);
  supervisor.updateDevFlowSupervisorUnexpectedCrash({
    observedAt: '2026-08-30T07:59:10.000Z',
    previousPid: 4242,
    runtimeOwnerInstanceId: 'owner-before-crash',
    exitCode: 1,
    signal: null,
    restartAttempt: 1,
    recoveryStatus: 'recovering',
    stderrTail: `Authorization: Bearer secret-token\n${'x'.repeat(7000)}\nserver exploded`,
  }, '2026-08-30T07:59:10.000Z');

  const previous = supervisor.readDevFlowSupervisorState();
  const next = supervisor.createDevFlowSupervisorState({
    mode: 'all',
    processLabels: ['server', 'tunnel'],
    now: '2026-08-30T08:00:00.000Z',
    previousState: previous,
  });

  assert.equal(next.lastUnexpectedServerCrash?.previousPid, 4242);
  assert.equal(next.lastUnexpectedServerCrash?.runtimeOwnerInstanceId, 'owner-before-crash');
  assert.equal(next.lastUnexpectedServerCrash?.recoveryStatus, 'recovering');
  assert.ok(Buffer.byteLength(next.lastUnexpectedServerCrash?.stderrTail || '', 'utf8') <= supervisor.MAX_SUPERVISOR_CRASH_STDERR_BYTES);
  assert.doesNotMatch(next.lastUnexpectedServerCrash?.stderrTail || '', /secret-token/);
  assert.match(next.lastUnexpectedServerCrash?.stderrTail || '', /server exploded/);
});

test('supervisor diagnostics distinguish unexpected recovery, exhaustion, recovered state, and guarded restart', () => {
  const base = {
    version: 2 as const,
    supervisor: 'start-all' as const,
    mode: 'all' as const,
    shuttingDown: false,
    startedAt: '2026-08-30T07:59:00.000Z',
    updatedAt: '2026-08-30T07:59:10.000Z',
    tunnelHealth: { status: 'healthy' as const, lastCheckedAt: '2026-08-30T07:59:10.000Z' },
  };

  const recovering = supervisor.buildDevFlowSupervisorDiagnostics({
    ...base,
    processes: {
      server: { label: 'server', status: 'restarting', restartAttempt: 2, recoveryKind: 'unexpected-crash', recoveryStatus: 'recovering' },
      tunnel: { label: 'tunnel', status: 'running', restartAttempt: 0 },
    },
  });
  assert.equal(recovering.api.recoveryKind, 'unexpected-crash');
  assert.equal(recovering.api.recoveryStatus, 'recovering');
  assert.equal(recovering.summary, 'api-recovering-tunnel-healthy');

  const exhausted = supervisor.buildDevFlowSupervisorDiagnostics({
    ...base,
    processes: {
      server: { label: 'server', status: 'failed', restartAttempt: 4, recoveryKind: 'unexpected-crash', recoveryStatus: 'restart-exhausted' },
      tunnel: { label: 'tunnel', status: 'running', restartAttempt: 0 },
    },
  });
  assert.equal(exhausted.summary, 'api-restart-exhausted-tunnel-healthy');

  const recovered = supervisor.buildDevFlowSupervisorDiagnostics({
    ...base,
    processes: {
      server: { label: 'server', status: 'running', pid: 5000, restartAttempt: 0, recoveryKind: 'unexpected-crash', recoveryStatus: 'recovered' },
      tunnel: { label: 'tunnel', status: 'running', restartAttempt: 0 },
    },
  });
  assert.equal(recovered.summary, 'both-healthy');
  assert.equal(recovered.api.recoveryStatus, 'recovered');

  const guarded = supervisor.buildDevFlowSupervisorDiagnostics({
    ...base,
    processes: {
      server: { label: 'server', status: 'restarting', restartAttempt: 0, recoveryKind: 'guarded-restart', recoveryStatus: 'recovering' },
      tunnel: { label: 'tunnel', status: 'running', restartAttempt: 0 },
    },
  });
  assert.equal(guarded.api.recoveryKind, 'guarded-restart');
  assert.equal(guarded.summary, 'api-restarting-tunnel-healthy');
});

test.after(() => {
  delete process.env.DEVFLOW_APP_ROOT;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
