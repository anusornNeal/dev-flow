import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import TaskDetailsDrawer from '../../src/components/TaskDetailsDrawer.js';
import UiDesignEvidenceSection from '../../src/components/taskDrawer/UiDesignEvidenceSection.js';
import {
  buildTaskUiEvidencePath,
  createTaskUiEvidenceRequestGate,
  type TaskUiEvidence,
} from '../../src/client/uiPreviewClient.js';
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

test('Work uses balanced technical columns and compact section rhythm', () => {
  const workSource = fs.readFileSync('src/components/taskDrawer/TaskWorkTab.tsx', 'utf8');
  assert.match(workSource, /max-w-\[1400px\] space-y-4/);
  assert.match(workSource, /xl:grid-cols-\[minmax\(360px,0\.9fr\)_minmax\(420px,1\.1fr\)\]/);
  assert.match(workSource, /df-surface min-w-0 p-4/);
  assert.match(workSource, /sm:grid-cols-2/);
  assert.match(workSource, /rounded-lg border border-df-border p-2\.5/);
  assert.doesNotMatch(workSource, /minmax\(0,1\.2fr\)_minmax\(300px,0\.8fr\)/);
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
  assert.match(subtasksHtml, />Subtasks</);
  assert.match(subtasksHtml, /1\/1 complete/);
  assert.match(subtasksHtml, /Dedicated subtask fixture/);
  assert.match(subtasksHtml, /aria-label="1 of 1 subtasks complete"/);
  assert.match(subtasksHtml, /DVF-CHILD/);

  const workHtml = renderDrawer('work', [child]);
  assert.doesNotMatch(workHtml, /Subtasks Breakdown/);
  assert.doesNotMatch(workHtml, /Dedicated subtask fixture/);
});

test('Subtasks tab owns subtask progress, complete list, and create affordance', () => {
  const html = renderDrawer('subtasks');
  assert.match(html, />Subtasks</);
  assert.match(html, /1\/5 complete/);
  assert.match(html, /Child task 1/);
  assert.match(html, /Child task 4/);
  assert.match(html, /Child task 5/);
  assert.doesNotMatch(html, /show \\d+ more/i);
  assert.doesNotMatch(html, /show less/i);
  assert.match(html, /Create Subtask<\/button>/);
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

test('inspector long-content contracts wrap technical metadata and progressively disclose raw execution logs', () => {
  const overviewSource = fs.readFileSync('src/components/taskDrawer/TaskOverviewTab.tsx', 'utf8');
  const workSource = fs.readFileSync('src/components/taskDrawer/TaskWorkTab.tsx', 'utf8');
  const activitySource = fs.readFileSync('src/components/taskDrawer/TaskInspectorActivityTab.tsx', 'utf8');
  const shellSource = fs.readFileSync('src/components/taskDrawer/TaskInspectorShell.tsx', 'utf8');

  assert.match(overviewSource, /df-break-technical/);
  assert.match(overviewSource, /break-words/);
  assert.match(workSource, /df-break-technical/);
  assert.match(activitySource, /Show latest log tail/);
  assert.match(activitySource, /<details/);
  assert.match(activitySource, /df-break-technical/);
  assert.match(shellSource, /overflow-x-hidden/);
  assert.doesNotMatch(shellSource, /<h2[^>]*truncate/);
});

test('edit mode keeps labeled core fields and routes save errors through the inspector footer', () => {
  const overviewSource = fs.readFileSync('src/components/taskDrawer/TaskOverviewTab.tsx', 'utf8');
  const drawerSource = fs.readFileSync('src/components/TaskDetailsDrawer.tsx', 'utf8');
  const editStateSource = fs.readFileSync('src/components/taskDrawer/useTaskDrawerEditState.ts', 'utf8');

  for (const field of ['title', 'status', 'priority', 'category', 'description', 'acceptance', 'reasoning']) {
    assert.match(overviewSource, new RegExp(`htmlFor="task-inspector-${field}"`));
  }
  assert.match(drawerSource, /editError=\{edit\.saveError\}/);
  assert.match(drawerSource, /isSaving=\{edit\.isSaving\}/);
  assert.match(editStateSource, /Title is required before saving/);
  assert.match(editStateSource, /await Promise\.resolve\(onUpdate\(updatedTask\)\)/);
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

test('UI evidence client always requests a bounded page and stale generations cannot win', () => {
  assert.equal(buildTaskUiEvidencePath('task 1'), '/api/tasks/task%201/ui-evidence?limit=20');
  assert.equal(
    buildTaskUiEvidencePath('task 1', { limit: 999, cursor: 'next/cursor=' }),
    '/api/tasks/task%201/ui-evidence?limit=50&cursor=next%2Fcursor%3D',
  );

  const gate = createTaskUiEvidenceRequestGate();
  const taskA = gate.begin('task-a');
  const taskB = gate.begin('task-b');
  assert.equal(gate.isCurrent(taskA), false);
  assert.equal(gate.isCurrent(taskB), true);
  const firstRefresh = gate.begin('task-b');
  const secondRefresh = gate.begin('task-b');
  assert.equal(gate.isCurrent(firstRefresh), false);
  assert.equal(gate.isCurrent(secondRefresh), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(secondRefresh), false);
});

test('UI Design evidence renders frozen/current semantics without duplicate current cards', () => {
  const makeEvidence = (overrides: Partial<TaskUiEvidence> = {}): TaskUiEvidence => ({
    evidenceId: 'ev-a2',
    taskId: 'task-1',
    previewId: 'preview-a',
    title: 'Preview A',
    frozenRevision: 2,
    latestRevision: 3,
    frozenPreviewUrl: 'http://127.0.0.1:3000/previews/a/2',
    latestPreviewUrl: 'http://127.0.0.1:3000/previews/a/latest',
    screenshotUrl: 'http://127.0.0.1:3000/artifacts/a2.png',
    attachedAt: '2026-08-11T02:05:00.000Z',
    current: true,
    spec: { schemaVersion: 1, summary: { screen: 'Checkout', purpose: 'Review purchase' }, layout: { sections: ['Header', 'Cart'] }, emptySection: {} },
    ...overrides,
  });
  const evidence: TaskUiEvidence[] = [
    makeEvidence(),
    makeEvidence({ evidenceId: 'ev-a2-duplicate', attachedAt: '2026-08-11T02:04:59.000Z' }),
    makeEvidence({ evidenceId: 'ev-a1', frozenRevision: 1, current: false, attachedAt: '2026-08-11T01:00:00.000Z', frozenPreviewUrl: 'http://127.0.0.1:3000/previews/a/1' }),
    makeEvidence({ evidenceId: 'ev-b1', previewId: 'preview-b', title: 'Preview B', frozenRevision: 1, latestRevision: 1, latestPreviewUrl: 'http://127.0.0.1:3000/previews/b/latest', attachedAt: '2026-08-11T02:10:00.000Z' }),
  ];
  const html = renderToStaticMarkup(React.createElement(UiDesignEvidenceSection as any, { evidence }));
  assert.match(html, /UI Design/);
  assert.ok(html.indexOf('Preview B') < html.indexOf('Preview A'));
  assert.equal((html.match(/>Preview A<\/div>/g) || []).length, 1);
  assert.match(html, /Previous revisions/);
  assert.match(html, /Revision 1/);
  assert.match(html, /Revision 2/);
  assert.match(html, /Open Preview/);
  assert.equal((html.match(/Open Latest/g) || []).length, 1);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /artifacts\/a2\.png/);
  assert.doesNotMatch(html, /emptySection/);
});

test('Task overview places UI Design evidence between Acceptance Criteria and Reasoning', () => {
  const source = fs.readFileSync('src/components/taskDrawer/TaskOverviewTab.tsx', 'utf8');
  const acceptance = source.indexOf('<ReadSection title="Acceptance criteria">');
  const uiDesign = source.indexOf('<UiDesignEvidenceSection');
  const engineeringContext = source.indexOf('Engineering context');
  assert.ok(acceptance >= 0 && uiDesign > acceptance && engineeringContext > uiDesign);

  const drawerSource = fs.readFileSync('src/components/TaskDetailsDrawer.tsx', 'utf8');
  assert.match(drawerSource, /getTaskUiEvidence\(initialTask\.id, \{ cursor, limit: 20 \}\)/);
  assert.match(drawerSource, /createTaskUiEvidenceRequestGate/);
  assert.match(drawerSource, /uiEvidenceGateRef\.current\.invalidate\(\)/);
});
