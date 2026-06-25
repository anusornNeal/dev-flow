import test from 'node:test';
import assert from 'node:assert/strict';

// Importing the view-model module under test pulls React indirectly. We only
// verify the pure helpers exported alongside the hook.

import { groupTasksByLane, type Lane } from '../../src/viewModels/boardUtils.js';
import type { DomainTask } from '../../src/domain/mappers/taskMapper.js';

function makeTask(id: string, status: string): DomainTask {
  return { id, displayId: id, title: id, status, images: [] } as any;
}

test('groupTasksByLane returns all 5 lanes even when empty', () => {
  const lanes = groupTasksByLane([]);
  const expected: Lane[] = ['backlog', 'todo', 'in-progress', 'ready-for-review', 'done'];
  assert.deepEqual(Object.keys(lanes).sort(), expected.sort());
  for (const lane of expected) {
    assert.deepEqual(lanes[lane], []);
  }
});

test('groupTasksByLane buckets tasks by status preserving order within lane', () => {
  const tasks = [
    makeTask('a', 'todo'),
    makeTask('b', 'in-progress'),
    makeTask('c', 'todo'),
    makeTask('d', 'done'),
  ];
  const lanes = groupTasksByLane(tasks);
  assert.deepEqual(lanes.todo.map((t) => t.id), ['a', 'c']);
  assert.deepEqual(lanes['in-progress'].map((t) => t.id), ['b']);
  assert.deepEqual(lanes.done.map((t) => t.id), ['d']);
  assert.equal(lanes.backlog.length, 0);
  assert.equal(lanes['ready-for-review'].length, 0);
});

test('groupTasksByLane puts unknown statuses into backlog (safe default)', () => {
  const tasks = [makeTask('x', 'something-else')];
  const lanes = groupTasksByLane(tasks);
  assert.equal(lanes.backlog.length, 1);
  assert.equal(lanes.backlog[0].id, 'x');
});
