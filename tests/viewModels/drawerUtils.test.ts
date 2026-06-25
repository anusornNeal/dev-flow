import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEditStateFromTask,
  diffEditState,
  toggleChecklistItem,
} from '../../src/viewModels/drawerUtils.js';
import type { DomainTask } from '../../src/domain/mappers/taskMapper.js';

function makeTask(overrides: Partial<DomainTask> = {}): DomainTask {
  return {
    id: 't-1',
    displayId: 'DVF-0001',
    title: 'Original Title',
    description: 'Original desc',
    status: 'todo',
    priority: 'medium',
    images: [],
    checklist: [
      { id: 'c1', text: 'Step 1', completed: false },
      { id: 'c2', text: 'Step 2', completed: false },
    ],
    ...overrides,
  } as DomainTask;
}

test('buildEditStateFromTask copies all editable fields from a task', () => {
  const task = makeTask();
  const edit = buildEditStateFromTask(task);
  assert.equal(edit.title, 'Original Title');
  assert.equal(edit.description, 'Original desc');
  assert.equal(edit.status, 'todo');
  assert.equal(edit.priority, 'medium');
  assert.equal(edit.checklist.length, 2);
});

test('diffEditState returns empty array when nothing changed', () => {
  const task = makeTask();
  const edit = buildEditStateFromTask(task);
  assert.deepEqual(diffEditState(edit, edit), []);
});

test('diffEditState returns changed fields only', () => {
  const task = makeTask();
  const baseline = buildEditStateFromTask(task);
  const modified = { ...baseline, title: 'New Title', status: 'in-progress' };
  const changes = diffEditState(baseline, modified);
  assert.deepEqual(changes.sort(), ['status', 'title']);
});

test('toggleChecklistItem flips the completed flag for matching id', () => {
  const items = [
    { id: 'c1', text: 'a', completed: false },
    { id: 'c2', text: 'b', completed: false },
  ];
  const next = toggleChecklistItem(items, 'c1');
  assert.equal(next[0].completed, true);
  assert.equal(next[1].completed, false);
});

test('toggleChecklistItem is a no-op when id is not found', () => {
  const items = [{ id: 'c1', text: 'a', completed: false }];
  const next = toggleChecklistItem(items, 'missing');
  assert.equal(next, items);
});
