import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskInspectorShell, {
  TASK_INSPECTOR_DEFAULT_WIDTH_VW,
  TASK_INSPECTOR_MAX_WIDTH_VW,
  TASK_INSPECTOR_MIN_WIDTH_VW,
  clampTaskInspectorWidth,
  resolveTaskInspectorResize,
  resolveTaskInspectorTabKey,
} from '../../src/components/taskDrawer/TaskInspectorShell.js';

const task: any = {
  id: 'task-shell',
  displayId: 'DVF-SHELL',
  title: 'Wide inspector fixture',
  status: 'in-progress',
  priority: 'high',
  category: 'frontend',
  updatedAt: '2026-08-08T00:00:00.000Z',
};

const noop = () => {};

function renderShell(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(React.createElement(TaskInspectorShell as any, {
    task,
    activeTab: 'overview',
    onTabChange: noop,
    onClose: noop,
    onDelete: noop,
    isEditing: false,
    onToggleEdit: noop,
    children: React.createElement('div', null, 'panel content'),
    ...overrides,
  }));
}

test('inspector sizing clamps to the approved 45–85vw range with 65vw default', () => {
  assert.equal(TASK_INSPECTOR_DEFAULT_WIDTH_VW, 65);
  assert.equal(clampTaskInspectorWidth(20), TASK_INSPECTOR_MIN_WIDTH_VW);
  assert.equal(clampTaskInspectorWidth(72), 72);
  assert.equal(clampTaskInspectorWidth(120), TASK_INSPECTOR_MAX_WIDTH_VW);
  assert.equal(resolveTaskInspectorResize(65, 180, 1200), 80);
});

test('shell renders a wide desktop inspector and narrow-window full-screen CSS contract', () => {
  const html = renderShell();
  assert.match(html, /width:65vw/);
  assert.match(html, /height:92vh/);
  assert.match(html, /max-lg:!w-screen/);
  assert.match(html, /max-lg:!h-screen/);
  assert.match(html, /aria-label="Resize task inspector"/);
  assert.match(html, /aria-label="Enter full screen"/);
  assert.match(html, /items-center justify-center/);
  assert.doesNotMatch(html, /justify-end/);
});

test('shell exposes exactly five primary tabs with accessible selection state', () => {
  const html = renderShell({ activeTab: 'subtasks' });
  const tabRoles = html.match(/role="tab"/g) || [];
  assert.equal(tabRoles.length, 5);
  for (const label of ['Overview', 'Work', 'Subtasks', 'Bugs', 'Activity']) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /aria-selected="true"[^>]*>Subtasks</);
  assert.doesNotMatch(html, />Auto Work</);
});

test('tab keyboard navigation resolves Arrow, Home, and End keys', () => {
  assert.equal(resolveTaskInspectorTabKey('overview', 'ArrowRight'), 'work');
  assert.equal(resolveTaskInspectorTabKey('work', 'ArrowRight'), 'subtasks');
  assert.equal(resolveTaskInspectorTabKey('subtasks', 'ArrowRight'), 'bugs');
  assert.equal(resolveTaskInspectorTabKey('overview', 'ArrowLeft'), 'activity');
  assert.equal(resolveTaskInspectorTabKey('bugs', 'Home'), 'overview');
  assert.equal(resolveTaskInspectorTabKey('work', 'End'), 'activity');
  assert.equal(resolveTaskInspectorTabKey('work', 'Enter'), null);
});

test('header and tab bar remain sticky while panel content scrolls', () => {
  const html = renderShell();
  const stickyCount = (html.match(/sticky/g) || []).length;
  assert.ok(stickyCount >= 2);
  assert.match(html, /overflow-y-auto/);
});
