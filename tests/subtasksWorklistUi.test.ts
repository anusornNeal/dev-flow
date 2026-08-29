import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SubtasksSection from '../src/components/taskDrawer/SubtasksSection.js';

const noop = () => {};

function makeTask(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'parent-1',
    displayId: 'DVF-0762',
    projectId: 'project-1',
    title: 'Parent task',
    description: '',
    status: 'in-progress',
    priority: 'medium',
    category: 'frontend',
    tags: [],
    checklist: [],
    targetFiles: [],
    logs: [],
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

function render(children: any[]) {
  return renderToStaticMarkup(React.createElement(SubtasksSection as any, {
    task: makeTask(),
    subTasks: children,
    canCreateSubtask: true,
    onCreateSubtask: noop,
    onSelectTask: noop,
  }));
}

test('SubtasksSection renders a hierarchy-first grouped worklist with compact progress', () => {
  const html = render([
    makeTask({ id: 'done', displayId: 'DVF-1004', title: 'Finished child', parentId: 'parent-1', status: 'done' }),
    makeTask({ id: 'todo', displayId: 'DVF-1003', title: 'Ready child', parentId: 'parent-1', status: 'todo', priority: 'low' }),
    makeTask({ id: 'active', displayId: 'DVF-1002', title: 'Active child', parentId: 'parent-1', status: 'in-progress' }),
    makeTask({ id: 'blocked', displayId: 'DVF-1001', title: 'Blocked child', parentId: 'parent-1', status: 'todo', liveWork: { blocked: true, ownerLabel: 'Codex', phaseLabel: 'verification', phaseCount: 4, phaseIndex: 2, updatedAt: '2026-08-29T00:00:00.000Z' } }),
  ]);

  assert.match(html, />Subtasks</);
  assert.match(html, /1\/4 complete/);
  assert.match(html, /role="progressbar"/);
  assert.doesNotMatch(html, /sm:grid-cols-2/);
  assert.match(html, /data-subtask-group="attention"/);
  assert.match(html, /data-subtask-group="in-progress"/);
  assert.match(html, /data-subtask-group="ready"/);
  assert.match(html, /data-subtask-group="completed"/);

  const attention = html.indexOf('data-subtask-group="attention"');
  const active = html.indexOf('data-subtask-group="in-progress"');
  const ready = html.indexOf('data-subtask-group="ready"');
  const completed = html.indexOf('data-subtask-group="completed"');
  assert.ok(attention < active && active < ready && ready < completed, 'unfinished work should be encountered before completed history');
});

test('SubtasksSection collapses a large completed group by default but keeps its count discoverable', () => {
  const children = Array.from({ length: 6 }, (_, index) => makeTask({
    id: `done-${index}`,
    displayId: `DVF-${1100 + index}`,
    title: `Completed child ${index + 1}`,
    parentId: 'parent-1',
    status: 'done',
  }));

  const html = render(children);
  assert.match(html, /Completed/);
  assert.match(html, /6/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Show 6 completed/);
  assert.doesNotMatch(html, /Completed child 1/);
});

test('Subtask rows expose non-color status, bounded title, and only useful metadata', () => {
  const html = render([
    makeTask({
      id: 'active',
      displayId: 'DVF-1201',
      title: 'A very long active child title that should remain a single bounded row rather than becoming a tall mini card',
      parentId: 'parent-1',
      status: 'in-progress',
      priority: 'high',
      hasUiDesign: true,
      activeAgent: 'Codex',
      model: 'GPT-5.6 Sol',
    }),
    makeTask({
      id: 'low',
      displayId: 'DVF-1202',
      title: 'Low priority child',
      parentId: 'parent-1',
      status: 'todo',
      priority: 'low',
    }),
  ]);

  assert.match(html, /aria-label="Status: In progress"/);
  assert.match(html, /title="A very long active child title/);
  assert.match(html, /truncate/);
  assert.match(html, />High</);
  assert.match(html, />Design</);
  assert.match(html, /Codex/);
  assert.doesNotMatch(html, />Low</);
  assert.match(html, /aria-label="Copy task ID DVF-1201"/);
  assert.match(html, /focus-visible:/);
});
