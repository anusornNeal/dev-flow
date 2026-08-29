import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskInspectorShell, { TASK_INSPECTOR_DEFAULT_WIDTH_VW } from '../../src/components/taskDrawer/TaskInspectorShell.js';
import TaskDetailsDrawer from '../../src/components/TaskDetailsDrawer.js';

const noop = () => {};

function makeTask(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'task-1',
    displayId: 'DVF-0766',
    projectId: 'project-1',
    title: 'Compact decision-first inspector fixture',
    description: 'Primary implementation description that should stay within a readable measure.',
    acceptanceCriteria: 'Acceptance criteria should follow the description.',
    reasoning: 'Supporting product reasoning belongs in progressive engineering context.',
    repoContext: 'src/components/taskDrawer/TaskOverviewTab.tsx -> Task Inspector composition',
    repo: 'https://github.com/anusornNeal/dev-flow',
    sourceUrl: 'https://example.com/source',
    specUrl: 'https://example.com/spec',
    jiraKey: 'DVF-0766',
    branch: 'overhaul-devflow',
    status: 'in-progress',
    priority: 'high',
    category: 'frontend',
    checklist: [],
    targetFiles: [],
    logs: [],
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T01:00:00.000Z',
    ...overrides,
  };
}

function renderShell(task = makeTask()) {
  return renderToStaticMarkup(React.createElement(TaskInspectorShell as any, {
    task,
    activeTab: 'overview',
    onTabChange: noop,
    onClose: noop,
    onDelete: noop,
    isEditing: false,
    onToggleEdit: noop,
    children: React.createElement('div', null, 'content'),
  }));
}

test('Task Inspector defaults to compact desktop width and only renders attention UI for actionable states', () => {
  assert.equal(TASK_INSPECTOR_DEFAULT_WIDTH_VW, 58);
  const normal = renderShell();
  assert.match(normal, /width:58vw/);
  assert.doesNotMatch(normal, /data-testid="task-inspector-attention"/);

  const blocked = renderShell(makeTask({
    liveWork: {
      blocked: true,
      ownerLabel: 'Codex',
      phaseLabel: 'Verification',
      activity: 'Waiting for prerequisite',
      phaseCount: 4,
      phaseIndex: 2,
      updatedAt: '2026-08-29T01:00:00.000Z',
    },
  }));
  assert.match(blocked, /data-testid="task-inspector-attention"/);
  assert.match(blocked, />Blocked</);
  assert.match(blocked, /Waiting for prerequisite/);
  assert.match(blocked, /Resolve the blocker/);
});

test('Task Inspector uses a compact tab strip with an explicit selected indicator', () => {
  const html = renderShell();
  assert.match(html, /data-density="compact"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /border-b-2/);
  assert.doesNotMatch(html, /min-h-9 flex-none rounded-lg px-4/);
});

test('Overview prioritizes readable task definition, facts, and progressive engineering context', () => {
  const parent = makeTask({ id: 'parent-1', displayId: 'DVF-PARENT', title: 'Parent task' });
  const task = makeTask({ parentId: parent.id });
  const childDone = makeTask({ id: 'child-done', displayId: 'DVF-CHILD-1', parentId: task.id, status: 'done' });
  const childTodo = makeTask({ id: 'child-todo', displayId: 'DVF-CHILD-2', parentId: task.id, status: 'todo' });
  const html = renderToStaticMarkup(React.createElement(TaskDetailsDrawer as any, {
    task,
    allTasks: [parent, task, childDone, childTodo],
    onClose: noop,
    onUpdate: noop,
    onDelete: noop,
    onSelectTask: noop,
  }));

  assert.match(html, /data-testid="task-inspector-main-content"/);
  assert.match(html, /max-w-\[80ch\]/);
  assert.match(html, />Description</);
  assert.match(html, />Acceptance criteria</);
  assert.match(html, />Task facts</);
  assert.match(html, /DVF-PARENT/);
  assert.match(html, /1\/2 subtasks complete/);
  assert.match(html, /overhaul-devflow/);
  assert.match(html, />Engineering context</);
  assert.match(html, /<details/);
  assert.match(html, />Reasoning</);
  assert.match(html, />Repository context</);
  assert.match(html, />References</);

  const description = html.indexOf('>Description<');
  const acceptance = html.indexOf('>Acceptance criteria<');
  const facts = html.indexOf('>Task facts<');
  assert.ok(description >= 0 && description < acceptance, 'description should lead acceptance criteria');
  assert.ok(facts >= 0, 'task facts should be rendered as a secondary region');
});
