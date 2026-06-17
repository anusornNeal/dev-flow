import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTaskPatch,
  isParentBlocked,
  applyChecklistToggle,
  type TaskPatch,
} from '../../src/server/useCases/taskUseCases.js';

test('validateTaskPatch rejects empty title on create', () => {
  const result = validateTaskPatch({ title: '' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /title/i);
  }
});

test('validateTaskPatch accepts a valid title and unknown extra fields', () => {
  const result = validateTaskPatch({ title: 'Hello', randomField: 'ok' });
  assert.equal(result.ok, true);
});

test('isParentBlocked returns true when any sibling is in progress', () => {
  const siblings = [
    { id: 's1', status: 'in-progress' },
    { id: 's2', status: 'done' },
  ];
  assert.equal(isParentBlocked(siblings, 'self'), true);
});

test('isParentBlocked returns false when no siblings are in progress', () => {
  const siblings = [
    { id: 's1', status: 'done' },
    { id: 's2', status: 'todo' },
  ];
  assert.equal(isParentBlocked(siblings, 'self'), false);
});

test('isParentBlocked excludes the task itself', () => {
  const siblings = [{ id: 'self', status: 'in-progress' }];
  assert.equal(isParentBlocked(siblings, 'self'), false);
});

test('applyChecklistToggle flips the completed flag for matching id', () => {
  const items = [
    { id: 'c1', text: 'a', completed: false },
    { id: 'c2', text: 'b', completed: false },
  ];
  const next = applyChecklistToggle(items, 'c1');
  assert.equal(next[0].completed, true);
  assert.equal(next[1].completed, false);
});

test('applyChecklistToggle is a no-op when id is not found', () => {
  const items = [{ id: 'c1', text: 'a', completed: false }];
  const next = applyChecklistToggle(items, 'missing');
  assert.equal(next, items);
});
