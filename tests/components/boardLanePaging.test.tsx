import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardLane } from '../../src/components/BoardLane.js';

const noop = () => {};
const asyncNoop = async () => {};

function renderLane(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(React.createElement(BoardLane as any, {
    column: { id: 'todo', label: 'Todo', iconName: 'ListTodo' },
    tasks: [],
    allTasks: [],
    draggedOverColumn: null,
    draggedTaskId: null,
    setDraggedOverColumn: noop,
    handleDrop: noop,
    setSelectedTask: noop,
    handleDeleteTask: noop,
    handleDragStart: noop,
    handleUpdateTask: asyncNoop,
    totalCount: 60,
    loadedCount: 25,
    hasMore: true,
    loadingMore: false,
    onLoadMore: noop,
    ...overrides,
  }));
}

test('BoardLane shows bounded lane progress and a load-more control', () => {
  const html = renderLane();
  assert.match(html, /25 of 60/);
  assert.match(html, /Load more/);
});

test('BoardLane hides load-more when the lane is fully loaded', () => {
  const html = renderLane({ totalCount: 25, loadedCount: 25, hasMore: false });
  assert.doesNotMatch(html, /Load more/);
  assert.match(html, /25/);
});

test('BoardLane constrains long labels inside the fixed 320px lane', () => {
  const label = 'Ready for review with an intentionally very long server-provided lane label';
  const html = renderLane({
    column: { id: 'ready-for-review', label, iconName: 'GitMerge' },
    totalCount: 2,
    loadedCount: 2,
    hasMore: false,
  });
  assert.match(html, /w-\[320px\]/);
  assert.match(html, /min-w-\[320px\]/);
  assert.match(html, /max-w-\[320px\]/);
  assert.match(html, /overflow-hidden/);
  assert.match(html, /truncate/);
  assert.match(html, new RegExp(`title="${label}"`));
});

test('BoardLane exposes invalid drag state with text as well as color', () => {
  const html = renderLane({
    allTasks: [{ id: 'drag-1', status: 'done' }],
    draggedTaskId: 'drag-1',
    draggedOverColumn: 'todo',
    totalCount: 0,
    loadedCount: 0,
    hasMore: false,
  });
  assert.match(html, /data-drop-valid="false"/);
  assert.match(html, /Move blocked/);
  assert.match(html, /Cannot drop here/);
  assert.match(html, /aria-live="polite"/);
});

test('BoardLane exposes valid drag state without changing transition rules', () => {
  const html = renderLane({
    column: { id: 'in-progress', label: 'In Progress', iconName: 'Terminal' },
    allTasks: [{ id: 'drag-1', status: 'todo' }],
    draggedTaskId: 'drag-1',
    draggedOverColumn: 'in-progress',
    totalCount: 0,
    loadedCount: 0,
    hasMore: false,
  });
  assert.match(html, /data-drop-valid="true"/);
  assert.match(html, /Drop allowed/);
  assert.doesNotMatch(html, /Cannot drop here/);
});
