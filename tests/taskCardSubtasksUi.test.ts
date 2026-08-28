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

test('TaskCard shows a non-clickable Design badge only when frozen UI evidence exists', () => {
  const withDesign = renderToStaticMarkup(React.createElement(TaskCard as any, {
    task: makeTask({ hasUiDesign: true }),
    subtasks: [],
    onSelect: noop,
    onDelete: noop,
    onDragStart: noop,
    onUpdate: noop,
  }));
  assert.match(withDesign, /Task has UI Design/);
  assert.match(withDesign, />Design</);
  assert.doesNotMatch(withDesign, /aria-label="Task has UI Design"[^>]*<(button|a)/);

  const withoutDesign = renderToStaticMarkup(React.createElement(TaskCard as any, {
    task: makeTask({ hasUiDesign: false }),
    subtasks: [],
    onSelect: noop,
    onDelete: noop,
    onDragStart: noop,
    onUpdate: noop,
  }));
  assert.doesNotMatch(withoutDesign, /Task has UI Design/);
});

test('TaskCard keeps long content bounded and makes blocked live work explicit', () => {
  const title = 'An intentionally very long task title that must remain readable without widening the board lane even when server text keeps going';
  const branch = 'feature/really-long-branch-name-that-must-never-expand-the-card-beyond-the-lane';
  const activity = 'Verification is blocked because a very long server-provided diagnostic message needs to wrap inside the card instead of forcing horizontal overflow.';
  const html = renderToStaticMarkup(React.createElement(TaskCard as any, {
    task: makeTask({
      title,
      branch,
      priority: 'high',
      unresolvedBugCount: 2,
      targetFiles: ['src/a.ts', 'src/b.ts'],
      checklist: [{ id: '1', text: 'one', completed: true }, { id: '2', text: 'two', completed: false }],
      liveWork: {
        blocked: true,
        phaseLabel: 'verification-with-a-very-long-phase-label-that-must-truncate',
        ownerLabel: 'Agent with a very long owner label that must truncate safely',
        activity,
        phaseCount: 4,
        phaseIndex: 2,
        updatedAt: '2026-08-28T13:40:00.000Z',
      },
    }),
    subtasks: [],
    onSelect: noop,
    onDelete: noop,
    onDragStart: noop,
    onUpdate: noop,
  }));

  assert.match(html, /min-w-0/);
  assert.match(html, /overflow-hidden/);
  assert.match(html, new RegExp(`title="${title}"`));
  assert.match(html, /aria-label="Live work blocked"/);
  assert.match(html, />Blocked</);
  assert.match(html, /line-clamp-2 break-words/);
  assert.match(html, /group-focus-within:opacity-100/);
  assert.match(html, /aria-label="Remove task DVF-0493"/);
  assert.match(html, new RegExp(`title="${branch}"`));
  assert.match(html, /Bugs 2/);
  assert.match(html, />High</);
});

test('TaskCard presents failed execution as one attention state with readable detail', () => {
  const errorMessage = 'Compilation failed because generated output did not match the expected contract and this detail should remain readable.';
  const html = renderToStaticMarkup(React.createElement(TaskCard as any, {
    task: makeTask({
      agent: 'codex',
      latestAgentRun: { id: 'run-1', status: 'failed', errorMessage },
      agentRuns: [{ id: 'run-1', status: 'failed', errorMessage }],
    }),
    subtasks: [],
    onSelect: noop,
    onDelete: noop,
    onDragStart: noop,
    onUpdate: noop,
  }));

  assert.match(html, /aria-label="Execution state: Failed"/);
  assert.equal((html.match(/>Failed</g) || []).length, 1);
  assert.match(html, new RegExp(errorMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /text-\[var\(--df-color-danger\)\]/);
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

test('Task Details subtask cards use compact two-column markup and conditional design badges', () => {
  const task = makeTask();
  const children = [
    makeTask({ id: 'child-design', displayId: 'DVF-DESIGN', title: 'Designed child with a title long enough to wrap onto two compact lines', parentId: task.id, status: 'in-progress', priority: 'high', model: 'GPT-5.6 Sol', hasUiDesign: true }),
    makeTask({ id: 'child-plain', displayId: 'DVF-PLAIN', title: 'Plain child', parentId: task.id, status: 'todo', priority: 'low', model: 'GPT-5.6 Sol', hasUiDesign: false }),
  ];
  const html = renderToStaticMarkup(React.createElement(SubtasksSection as any, {
    task,
    subTasks: children,
    canCreateSubtask: false,
    onCreateSubtask: noop,
    onSelectTask: noop,
  }));

  assert.match(html, /grid-cols-1/);
  assert.match(html, /sm:grid-cols-2/);
  assert.doesNotMatch(html, /h-\[90px\]/);
  assert.match(html, /line-clamp-2/);
  assert.match(html, /DVF-DESIGN/);
  assert.match(html, />active</);
  assert.match(html, />DESIGN</);
  assert.equal((html.match(/>DESIGN</g) || []).length, 1);
  assert.doesNotMatch(html, /GPT-5\.6 Sol/);
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
