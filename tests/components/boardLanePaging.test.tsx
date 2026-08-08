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
