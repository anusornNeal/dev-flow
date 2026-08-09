import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import TaskDetailsDrawer from '../../src/components/TaskDetailsDrawer.js';
import type { Task } from '../../src/types.js';

function makeTask(): Task {
  return {
    id: 'task-inspector-1',
    displayId: 'DVF-INSPECT',
    projectId: 'project-1',
    title: 'Inspector information architecture fixture',
    description: 'Readable overview description.',
    status: 'in-progress',
    priority: 'high',
    category: 'frontend',
    tags: ['ux'],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T01:00:00.000Z',
    branch: 'develop',
    targetFiles: ['src/components/taskDrawer/TaskInspectorShell.tsx'],
    checklist: [
      { id: 'step-1', text: 'Ship wide inspector', completed: true },
      { id: 'step-2', text: 'Preserve task mutations', completed: false },
    ],
    acceptanceCriteria: 'Overview and Work stay easy to scan.',
    reasoning: 'The narrow drawer made implementation cards hard to read.',
    repoContext: 'Reuse existing taskDrawer hooks and subcomponents.',
    verification: 'Run focused inspector tests and production build.',
    verificationEvidence: [
      { name: 'typecheck', command: 'typecheck', status: 'passed', summary: 'TypeScript passed.' },
    ],
    repo: 'https://github.com/anusornNeal/dev-flow',
    sourceUrl: 'https://example.com/source',
    specUrl: 'https://example.com/spec',
    agent: 'Codex',
    model: 'GPT-5.6 Sol',
    effort: 'high',
    logs: [
      { id: 'note-1', timestamp: '2026-08-08T00:30:00.000Z', message: '💬 Note: Activity note fixture', type: 'comment' },
      { id: 'move-1', timestamp: '2026-08-08T00:45:00.000Z', message: 'Moved to in-progress', type: 'move' },
    ],
    latestAgentRun: {
      id: 'run-1',
      status: 'succeeded',
      agent: 'Codex',
      createdAt: '2026-08-08T00:20:00.000Z',
      startedAt: '2026-08-08T00:21:00.000Z',
      endedAt: '2026-08-08T00:25:00.000Z',
    },
    bugs: [
      {
        id: 'bug-1',
        taskId: 'task-inspector-1',
        title: 'Inspector bug fixture',
        status: 'open',
        source: 'user',
        severity: 'high',
        actual: 'Dense card is hard to inspect.',
        expected: 'Bug details are readable in a dedicated tab.',
        evidence: 'Inspector regression fixture',
        relatedAreas: ['TaskDetailsDrawer'],
        versions: [{ version: 1, status: 'open', prompt: 'Fix inspector bug.', createdAt: '2026-08-08T00:10:00.000Z' }],
        createdAt: '2026-08-08T00:10:00.000Z',
        updatedAt: '2026-08-08T00:10:00.000Z',
      },
    ],
  };
}

const noop = () => {};

function defaultChildTasks(task: Task): Task[] {
  return Array.from({ length: 5 }, (_, index) => ({
    ...makeTask(),
    id: `child-${index + 1}`,
    displayId: `DVF-CHILD-${index + 1}`,
    title: `Child task ${index + 1}`,
    parentId: task.id,
    status: index === 0 ? 'done' : 'backlog',
  }));
}

function renderDrawer(initialTab: 'overview' | 'work' | 'subtasks' | 'bugs' | 'activity', extraTasks?: Task[]) {
  const task = makeTask();
  const relatedTasks = extraTasks ?? defaultChildTasks(task);
  return renderToStaticMarkup(React.createElement(TaskDetailsDrawer as any, {
    task,
    allTasks: [task, ...relatedTasks],
    initialTab,
    onClose: noop,
    onUpdate: noop,
    onDelete: noop,
    onSelectTask: noop,
    onCreateTask: async () => {},
  }));
}

test('Overview groups readable task definition and context without Work-only details', () => {
  const html = renderDrawer('overview');
  assert.match(html, /Readable overview description/);
  assert.match(html, /Overview and Work stay easy to scan/);
  assert.match(html, /The narrow drawer made implementation cards hard to read/);
  assert.match(html, /Reuse existing taskDrawer hooks and subcomponents/);
  assert.match(html, /example\.com\/source/);
  assert.match(html, /example\.com\/spec/);
  assert.doesNotMatch(html, /Ship wide inspector/);
});

test('Work groups checklist, target files, execution assignment, and verification evidence', () => {
  const html = renderDrawer('work');
  assert.match(html, /1 of 2 complete/);
  assert.match(html, /Ship wide inspector/);
  assert.match(html, /TaskInspectorShell\.tsx<\/span>/);
  assert.match(html, /src\/components\/taskDrawer\/<\/span>/);
  assert.match(html, /aria-label="Copy target file path"/);
  assert.match(html, /title="src\/components\/taskDrawer\/TaskInspectorShell\.tsx"/);
  assert.match(html, /develop/);
  assert.match(html, /Codex/);
  assert.match(html, /GPT-5\.6 Sol/);
  assert.match(html, /Run focused inspector tests and production build/);
  assert.match(html, /TypeScript passed/);
});

test('Subtasks has dedicated content while Work stays focused on implementation details', () => {
  const child: Task = {
    ...makeTask(),
    id: 'task-inspector-child',
    displayId: 'DVF-CHILD',
    title: 'Dedicated subtask fixture',
    parentId: 'task-inspector-1',
    status: 'done',
  };
  const subtasksHtml = renderDrawer('subtasks', [child]);
  assert.match(subtasksHtml, /Subtasks Breakdown \(1\/1\)/);
  assert.match(subtasksHtml, /Dedicated subtask fixture/);
  assert.match(subtasksHtml, /100% complete/);
  assert.match(subtasksHtml, /ID: #DVF-CHILD/);

  const workHtml = renderDrawer('work', [child]);
  assert.doesNotMatch(workHtml, /Subtasks Breakdown/);
  assert.doesNotMatch(workHtml, /Dedicated subtask fixture/);
});

test('Subtasks tab owns subtask progress, list, show-more, and create affordance', () => {
  const html = renderDrawer('subtasks');
  assert.match(html, /Subtasks Breakdown \(1\/5\)/);
  assert.match(html, /Child task 1/);
  assert.match(html, /Child task 4/);
  assert.doesNotMatch(html, /Child task 5/);
  assert.match(html, /show 1 more/);
  assert.match(html, /Create Subtask Spec/);
  assert.doesNotMatch(html, /1 of 2 complete/);
});

test('Work no longer renders the Subtasks section', () => {
  const html = renderDrawer('work');
  assert.doesNotMatch(html, /Subtasks Breakdown/);
  assert.doesNotMatch(html, /Create Subtask Spec/);
});

test('Bugs keeps embedded bug details visible in normal read mode', () => {
  const html = renderDrawer('bugs');
  assert.match(html, /Bugs to Fix/);
  assert.match(html, /Inspector bug fixture/);
  assert.match(html, /Bug details are readable in a dedicated tab/);
  assert.match(html, /Inspector regression fixture/);
});

test('Activity contains notes, agent execution, and task history without visible Auto Work UI', () => {
  const html = renderDrawer('activity');
  assert.match(html, /Activity note fixture/);
  assert.match(html, /run-1/);
  assert.match(html, /Moved to in-progress/);
  assert.doesNotMatch(html, /Auto[- ]Work/i);
});

test('child task renders parent navigation in the inspector header without the old content banner', () => {
  const parent = makeTask();
  const child: Task = {
    ...makeTask(),
    id: 'child-parent-nav',
    displayId: 'DVF-CHILD-NAV',
    title: 'Child navigation fixture',
    parentId: parent.id,
  };
  const html = renderToStaticMarkup(React.createElement(TaskDetailsDrawer as any, {
    task: child,
    allTasks: [parent, child],
    onClose: noop,
    onUpdate: noop,
    onDelete: noop,
    onSelectTask: noop,
  }));

  assert.match(html, /aria-label="Open parent task DVF-INSPECT"/);
  assert.match(html, /Inspector information architecture fixture/);
  assert.doesNotMatch(html, />Parent task</);
  assert.doesNotMatch(html, />Open parent</);
});

test('root tasks and children with unavailable parent data omit parent navigation', () => {
  const rootHtml = renderToStaticMarkup(React.createElement(TaskDetailsDrawer as any, {
    task: makeTask(), allTasks: [makeTask()], onClose: noop, onUpdate: noop, onDelete: noop, onSelectTask: noop,
  }));
  assert.doesNotMatch(rootHtml, /Open parent task/);

  const orphan: Task = { ...makeTask(), id: 'orphan', parentId: 'missing-parent' };
  const orphanHtml = renderToStaticMarkup(React.createElement(TaskDetailsDrawer as any, {
    task: orphan, allTasks: [orphan], onClose: noop, onUpdate: noop, onDelete: noop, onSelectTask: noop,
  }));
  assert.doesNotMatch(orphanHtml, /Open parent task/);
});

test('TaskDetailsDrawer is materially decomposed instead of remaining a 1,200-line monolith', () => {
  const source = fs.readFileSync('src/components/TaskDetailsDrawer.tsx', 'utf8');
  const lineCount = source.split(/\r?\n/).length;
  assert.ok(lineCount < 650, `expected TaskDetailsDrawer under 650 lines, got ${lineCount}`);
  for (const component of ['TaskInspectorShell', 'TaskOverviewTab', 'TaskWorkTab', 'TaskInspectorActivityTab']) {
    assert.match(source, new RegExp(component));
  }
});
