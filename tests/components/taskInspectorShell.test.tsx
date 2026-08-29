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
  resolveTaskInspectorStatusSummary,
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

test('inspector sizing clamps to the approved 45–85vw range with a roomier 68vw default', () => {
  assert.equal(TASK_INSPECTOR_DEFAULT_WIDTH_VW, 68);
  assert.equal(clampTaskInspectorWidth(20), TASK_INSPECTOR_MIN_WIDTH_VW);
  assert.equal(clampTaskInspectorWidth(72), 72);
  assert.equal(clampTaskInspectorWidth(120), TASK_INSPECTOR_MAX_WIDTH_VW);
  assert.equal(resolveTaskInspectorResize(68, 180, 1200), 83);
});

test('shell renders a wide desktop inspector and narrow-window full-screen CSS contract', () => {
  const html = renderShell();
  assert.match(html, /width:68vw/);
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
  assert.equal(resolveTaskInspectorTabKey('subtasks', 'Enter'), null);
});

test('status summary explains blocked, failed, and review-ready states with an actionable next step', () => {
  const blocked = resolveTaskInspectorStatusSummary({
    ...task,
    liveWork: { blocked: true, ownerLabel: 'Chat A', phaseLabel: 'Verification', activity: 'Waiting for a prerequisite', phaseIndex: 2, phaseCount: 4, updatedAt: '2026-08-08T00:00:00.000Z' },
  } as any);
  assert.equal(blocked.label, 'Blocked');
  assert.match(blocked.summary, /Waiting for a prerequisite/);
  assert.match(blocked.nextAction, /Resolve the blocker/);

  const failed = resolveTaskInspectorStatusSummary({
    ...task,
    activeAgent: undefined,
    latestAgentRun: { id: 'run-failed', status: 'failed' },
  } as any);
  assert.equal(failed.label, 'Run needs attention');
  assert.match(failed.nextAction, /Open Activity/);

  const review = resolveTaskInspectorStatusSummary({
    ...task,
    status: 'ready-for-review',
    unresolvedBugCount: 2,
    latestAgentRun: undefined,
  } as any);
  assert.equal(review.label, 'Ready for review');
  assert.match(review.summary, /2 unresolved bug threads/);
  assert.match(review.nextAction, /Work evidence and Bugs/);
});

test('shell suppresses routine status explanation and surfaces compact attention only when action is needed', () => {
  const normalHtml = renderShell();
  assert.doesNotMatch(normalHtml, /task-inspector-attention/);

  const blockedHtml = renderShell({
    task: {
      ...task,
      liveWork: { blocked: true, ownerLabel: 'Chat A', phaseLabel: 'Verification', activity: 'Waiting for a prerequisite', phaseIndex: 2, phaseCount: 4, updatedAt: '2026-08-08T00:00:00.000Z' },
    },
  });
  assert.match(blockedHtml, /data-testid="task-inspector-attention"/);
  assert.match(blockedHtml, />Blocked</);
  assert.match(blockedHtml, /Resolve the blocker/);
});

test('edit mode has visible cancel, save, saving, and error states without duplicate preview action', () => {
  const html = renderShell({ isEditing: true, isSaving: true, editError: 'Title is required before saving.' });
  assert.match(html, />Cancel</);
  assert.match(html, />Saving…</);
  assert.match(html, /role="alert"/);
  assert.match(html, /Title is required before saving/);
  assert.doesNotMatch(html, /aria-label="Edit task"/);
  assert.doesNotMatch(html, /task-inspector-attention/);
});

test('header and tab bar remain sticky while panel content scrolls', () => {
  const html = renderShell();
  const stickyCount = (html.match(/sticky/g) || []).length;
  assert.ok(stickyCount >= 2);
  assert.match(html, /overflow-y-auto/);
});

test('shell renders compact parent navigation only when parent data and callback are available', () => {
  const parentTask = { ...task, id: 'parent-1', displayId: 'DVF-PARENT', title: 'Parent fixture' };
  const childHtml = renderShell({ parentTask, onSelectParent: noop });
  assert.match(childHtml, /aria-label="Open parent task DVF-PARENT"/);
  assert.match(childHtml, /DVF-PARENT/);
  assert.match(childHtml, /Parent fixture/);

  assert.doesNotMatch(renderShell(), /Open parent task/);
  assert.doesNotMatch(renderShell({ parentTask }), /Open parent task/);
});

test('parent control invokes the existing selection callback with the resolved parent', async () => {
  const moduleExports: any = await import('../../src/components/taskDrawer/TaskInspectorShell.js');
  assert.equal(typeof moduleExports.TaskInspectorParentControl, 'function');

  const parentTask = { ...task, id: 'parent-1', displayId: 'DVF-PARENT', title: 'Parent fixture' };
  let selected: any = null;
  const element = moduleExports.TaskInspectorParentControl({
    parentTask,
    onSelectParent: (selectedTask: any) => { selected = selectedTask; },
  });
  element.props.onClick();
  assert.equal(selected, parentTask);
});
