import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRunStatus,
  canRetryRun,
  canCancelRun,
  type AgentRunLike,
} from '../../src/server/useCases/agentRunUseCases.js';

function makeRun(overrides: Partial<AgentRunLike> = {}): AgentRunLike {
  return {
    id: 'run-1',
    status: 'failed',
    taskId: 'task-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('normalizeRunStatus maps known statuses to canonical values', () => {
  assert.equal(normalizeRunStatus('success'), 'success');
  assert.equal(normalizeRunStatus('failed'), 'failed');
  assert.equal(normalizeRunStatus('cancelled'), 'cancelled');
  assert.equal(normalizeRunStatus('running'), 'running');
});

test('normalizeRunStatus returns "failed" for unknown statuses', () => {
  assert.equal(normalizeRunStatus('weird'), 'failed');
  assert.equal(normalizeRunStatus(undefined), 'failed');
});

test('canRetryRun allows retrying a failed run', () => {
  assert.equal(canRetryRun(makeRun({ status: 'failed' })), true);
});

test('canRetryRun blocks retrying a successful run', () => {
  assert.equal(canRetryRun(makeRun({ status: 'success' })), false);
});

test('canRetryRun blocks retrying a still-running run', () => {
  assert.equal(canRetryRun(makeRun({ status: 'running' })), false);
});

test('canCancelRun allows cancelling a running run', () => {
  assert.equal(canCancelRun(makeRun({ status: 'running' })), true);
});

test('canCancelRun blocks cancelling an already-finished run', () => {
  assert.equal(canCancelRun(makeRun({ status: 'success' })), false);
  assert.equal(canCancelRun(makeRun({ status: 'failed' })), false);
  assert.equal(canCancelRun(makeRun({ status: 'cancelled' })), false);
});
