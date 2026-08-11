import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskCard from '../src/components/TaskCard.js';
import TaskDetailsDrawer from '../src/components/TaskDetailsDrawer.js';
import SubtasksSection from '../src/components/taskDrawer/SubtasksSection.js';
import TaskInspectorShell, { resolveTaskInspectorTabKey } from '../src/components/taskDrawer/TaskInspectorShell.js';

const noop = () => {};

function makeTask(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'parent-1',
    displayId: 'DVF-0493',
    projectId: 'project-1',
    title: 'Parent task',
    description: 'Parent overview description',
    status: 'in-progress',
    priority: 'medium',
    category: 'frontend',
    tags: [],
    checklist: [],
    targetFiles: [],
    logs: [],
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

function makeChildren(count = 6): any[] {
  return Array.from({ length: count }, (_, index) => makeTask({
    id: `child-${index + 1}`,
    displayId: `DVF-${500 + index}`,
    title: `Very long child title ${index + 1} that may truncate but must keep its ID visible`,
    parentId: 'parent-1',
    status: index === 0 ? 'done' : 'todo',
  }));
}

test('TaskCard shows every child display ID alongside all subtask titles', () => {
  const task = makeTask();
  const children = makeChildren();
  const html = renderToStaticMarkup(React.createElement(TaskCard as any, {
    task,
    subtasks: children,
    onSelect: noop,
    onDelete: noop,
    onDragStart: noop,
    onUpdate: noop,
  }));
  for (const child of children) {
    assert.match(html, new RegExp(child.displayId));
    assert.match(html, new RegExp(`Very long child title ${children.indexOf(child) + 1}`));
  }
});

test('Task Details subtask section renders more than five children without show-more controls', () => {
  const task = makeTask();
  const children = makeChildren();
  const html = renderToStaticMarkup(React.createElement(SubtasksSection as any, {
    task,
    subTasks: children,
    canCreateSubtask: true,
    onCreateSubtask: noop,
    onSelectTask: noop,
  }));
  for (const child of children) assert.match(html, new RegExp(child.displayId));
  assert.doesNotMatch(html, /show \d+ more/i);
  assert.doesNotMatch(html, /show less/i);
});

test('inspector hides Subtasks and keyboard navigation skips it when unavailable', () => {
  const task = makeTask();
  const html = renderToStaticMarkup(React.createElement(TaskInspectorShell as any, {
    task,
    activeTab: 'overview',
    showSubtasks: false,
    onTabChange: noop,
    onClose: noop,
    onDelete: noop,
    isEditing: false,
    onToggleEdit: noop,
    children: React.createElement('div', null, 'overview'),
  }));
  assert.doesNotMatch(html, />Subtasks<\/button>/);
  assert.equal(resolveTaskInspectorTabKey('work', 'ArrowRight', false), 'bugs');
  assert.equal(resolveTaskInspectorTabKey('overview', 'ArrowLeft', false), 'activity');
});

test('drawer falls back to Overview when Subtasks is requested for a task with no children', () => {
  const task = makeTask();
  const html = renderToStaticMarkup(React.createElement(TaskDetailsDrawer as any, {
    task,
    allTasks: [task],
    initialTab: 'subtasks',
    onClose: noop,
    onUpdate: noop,
    onDelete: noop,
    onSelectTask: noop,
  }));
  assert.doesNotMatch(html, />Subtasks<\/button>/);
  assert.match(html, /Parent overview description/);
  assert.doesNotMatch(html, /Subtasks Breakdown/);
});
