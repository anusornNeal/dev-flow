import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidStatus, isValidPriority, VALID_STATUSES, VALID_PRIORITIES } from '../../src/server/domain/task.js';

test('VALID_STATUSES contains the five canonical lanes', () => {
  assert.deepEqual([...VALID_STATUSES].sort(), ['backlog', 'done', 'in-progress', 'ready-for-review', 'todo']);
});

test('VALID_PRIORITIES contains the three priority levels', () => {
  assert.deepEqual([...VALID_PRIORITIES].sort(), ['high', 'low', 'medium']);
});

test('isValidStatus accepts known statuses', () => {
  for (const s of VALID_STATUSES) {
    assert.equal(isValidStatus(s), true);
  }
});

test('isValidStatus rejects unknown statuses', () => {
  assert.equal(isValidStatus('something-else'), false);
  assert.equal(isValidStatus(''), false);
});

test('isValidPriority accepts known priorities', () => {
  for (const p of VALID_PRIORITIES) {
    assert.equal(isValidPriority(p), true);
  }
});

test('isValidPriority rejects unknown priorities', () => {
  assert.equal(isValidPriority('urgent'), false);
  assert.equal(isValidPriority(''), false);
});
