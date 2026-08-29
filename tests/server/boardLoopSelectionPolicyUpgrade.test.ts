import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-board-loop-policy-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const {
  DEFAULT_BOARD_LOOP_SELECTION_POLICY,
  resolveBoardLoopSelectionPolicy,
} = await import('../../src/server/services/executionContinuationService.js');

test('board-loop policy defaults to todo-only when no durable or explicit policy exists', () => {
  assert.equal(resolveBoardLoopSelectionPolicy(null, null), DEFAULT_BOARD_LOOP_SELECTION_POLICY);
  assert.equal(resolveBoardLoopSelectionPolicy(undefined, undefined), 'todo-only');
});

test('fresh explicit backlog authorization selects include-backlog', () => {
  assert.equal(resolveBoardLoopSelectionPolicy(null, 'include-backlog'), 'include-backlog');
});

test('omitted reconnect policy preserves active durable authority', () => {
  assert.equal(resolveBoardLoopSelectionPolicy('todo-only', null), 'todo-only');
  assert.equal(resolveBoardLoopSelectionPolicy('include-backlog', undefined), 'include-backlog');
});

test('explicit backlog authorization monotonically upgrades an active todo-only loop', () => {
  assert.equal(resolveBoardLoopSelectionPolicy('todo-only', 'include-backlog'), 'include-backlog');
  assert.equal(resolveBoardLoopSelectionPolicy('include-backlog', 'include-backlog'), 'include-backlog');
});

test('active include-backlog authority cannot be downgraded', () => {
  assert.throws(
    () => resolveBoardLoopSelectionPolicy('include-backlog', 'todo-only'),
    (error: any) => {
      assert.equal(error?.payload?.code, 'BOARD_LOOP_SELECTION_POLICY_CONFLICT');
      return true;
    },
  );
});
