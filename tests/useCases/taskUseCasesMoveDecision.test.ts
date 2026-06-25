import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMove, type TaskLike } from '../../src/server/useCases/taskUseCases.js';

test('evaluateMove allows moving from backlog to todo', () => {
  const t: TaskLike = { id: 'a', status: 'backlog' };
  assert.deepEqual(evaluateMove(t, 'todo'), { allowed: true });
});

test('evaluateMove allows moving from in-progress to ready-for-review', () => {
  const t: TaskLike = { id: 'a', status: 'in-progress' };
  assert.deepEqual(evaluateMove(t, 'ready-for-review'), { allowed: true });
});

test('evaluateMove allows any other transition (no spurious block)', () => {
  const t: TaskLike = { id: 'a', status: 'todo' };
  assert.deepEqual(evaluateMove(t, 'in-progress'), { allowed: true });
  assert.deepEqual(evaluateMove(t, 'done'), { allowed: true });
});
