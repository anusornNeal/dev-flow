import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-restart-state-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;

const {
  DEVFLOW_RESTART_EXTERNAL_TRANSPORT_POLICY,
  DEVFLOW_RESTART_RUNTIME_SCOPE,
  markDevFlowRestartFailed,
  markDevFlowRestartHealthy,
  markDevFlowRestartRestarting,
  readDevFlowRestartState,
  writeDevFlowRestartState,
} = await import('../../src/lib/devFlowRestart.js');

function seedAcceptedRestart(ticket: string) {
  const now = new Date().toISOString();
  return writeDevFlowRestartState({
    ticket,
    status: 'accepted',
    supervisor: 'start-all',
    supervisorToken: 'restart-state-test-token',
    runtimeScope: DEVFLOW_RESTART_RUNTIME_SCOPE,
    externalTransportPolicy: DEVFLOW_RESTART_EXTERNAL_TRANSPORT_POLICY,
    requestedAt: now,
    updatedAt: now,
    requestedByPid: 123,
  });
}

test('restart state becomes healthy only for the matching supervisor token', () => {
  const ticket = 'restart-state-healthy';
  seedAcceptedRestart(ticket);

  const restarting = markDevFlowRestartRestarting(ticket, 456);
  assert.equal(restarting?.status, 'restarting');
  assert.equal(restarting?.replacementPid, 456);

  const rejected = markDevFlowRestartHealthy('wrong-token');
  assert.equal(rejected, null);
  assert.equal(readDevFlowRestartState()?.status, 'restarting');

  const healthy = markDevFlowRestartHealthy('restart-state-test-token');
  assert.equal(healthy?.status, 'healthy');
  assert.match(healthy?.message || '', /healthy/i);
});

test('restart failure is persisted with a diagnosable message', () => {
  const ticket = 'restart-state-failed';
  seedAcceptedRestart(ticket);

  const failed = markDevFlowRestartFailed(ticket, 'replacement process failed to launch');
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.message || '', /failed to launch/);

  const persisted = readDevFlowRestartState();
  assert.equal(persisted?.ticket, ticket);
  assert.equal(persisted?.status, 'failed');
  assert.match(persisted?.message || '', /failed to launch/);
});

test.after(() => {
  delete process.env.DEVFLOW_APP_ROOT;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
