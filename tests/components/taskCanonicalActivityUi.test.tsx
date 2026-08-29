import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskCard from '../../src/components/TaskCard.js';
import TaskDetailsDrawer from '../../src/components/TaskDetailsDrawer.js';
import SubtasksSection from '../../src/components/taskDrawer/SubtasksSection.js';
import TaskInspectorActivityTab from '../../src/components/taskDrawer/TaskInspectorActivityTab.js';
import { resolveTaskInspectorStatusSummary } from '../../src/components/taskDrawer/TaskInspectorShell.js';

const noop = () => {};

function makeTask(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'task-canonical',
    displayId: 'DVF-CANONICAL',
    projectId: 'project-1',
    title: 'Canonical activity fixture',
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

function renderCard(task: any) {
  return renderToStaticMarkup(React.createElement(TaskCard as any, {
    task,
    subtasks: [],
    onSelect: noop,
    onDelete: noop,
    onDragStart: noop,
  }));
}

test('historical legacy failure never becomes current TaskCard or inspector authority', () => {
  const task = makeTask({
    latestAgentRun: { id: 'legacy-run', status: 'failed', errorMessage: 'legacy failure detail' },
    agentRuns: [{ id: 'legacy-run', status: 'failed', errorMessage: 'legacy failure detail' }],
    activeAgent: 'legacy-worker',
  });

  const cardHtml = renderCard(task);
  assert.doesNotMatch(cardHtml, /Execution state:/);
  assert.doesNotMatch(cardHtml, /legacy failure detail/);
  assert.doesNotMatch(cardHtml, /legacy-worker/);

  const summary = resolveTaskInspectorStatusSummary(task);
  assert.equal(summary.label, 'Work in progress');
  assert.doesNotMatch(summary.summary, /legacy|run/i);
});

test('canonical liveWork drives active and blocked presentation', () => {
  const task = makeTask({
    liveWork: {
      blocked: true,
      ownerLabel: 'Worker C',
      phaseLabel: 'Verification',
      activity: 'Waiting for exact recovery evidence',
      phaseIndex: 2,
      phaseCount: 4,
      updatedAt: '2026-08-29T00:00:00.000Z',
    },
    latestAgentRun: { id: 'legacy-run', status: 'failed', errorMessage: 'legacy failure detail' },
  });

  const cardHtml = renderCard(task);
  assert.match(cardHtml, /aria-label="Live work blocked"/);
  assert.match(cardHtml, /Worker C/);
  assert.match(cardHtml, /Waiting for exact recovery evidence/);
  assert.doesNotMatch(cardHtml, /legacy failure detail/);

  const summary = resolveTaskInspectorStatusSummary(task);
  assert.equal(summary.label, 'Blocked');
  assert.match(summary.summary, /Waiting for exact recovery evidence/);
});

test('activity tab separates current live work from read-only historical legacy metadata', () => {
  const task = makeTask({
    liveWork: {
      blocked: false,
      ownerLabel: 'External Worker',
      phaseLabel: 'Implementation',
      activity: 'Editing canonical activity UI',
      phaseIndex: 1,
      phaseCount: 4,
      updatedAt: '2026-08-29T00:00:00.000Z',
    },
    latestAgentRun: {
      id: 'legacy-run-42',
      status: 'failed',
      agent: 'legacy-agent',
      startedAt: '2026-08-28T12:00:00.000Z',
      errorMessage: 'historical failure',
    },
  });

  const html = renderToStaticMarkup(React.createElement(TaskInspectorActivityTab as any, {
    task,
    newComment: '',
    setNewComment: noop,
    onAddComment: noop,
  }));

  assert.match(html, /Current activity/);
  assert.match(html, /External Worker/);
  assert.match(html, /Editing canonical activity UI/);
  assert.match(html, /Historical legacy run/);
  assert.match(html, /legacy-run-42/);
  assert.match(html, /read-only/i);
  assert.doesNotMatch(html, /Retry run/);
  assert.doesNotMatch(html, /Execution log/);
  assert.doesNotMatch(html, /Run artifacts/);
});

test('subtask attention ignores legacy run status and follows canonical blocked state', () => {
  const parent = makeTask({ id: 'parent', displayId: 'DVF-PARENT' });
  const historicalFailure = makeTask({
    id: 'legacy-child',
    displayId: 'DVF-LEGACY',
    parentId: 'parent',
    status: 'todo',
    latestAgentRun: { id: 'legacy-run', status: 'failed' },
  });
  const blocked = makeTask({
    id: 'blocked-child',
    displayId: 'DVF-BLOCKED',
    parentId: 'parent',
    status: 'in-progress',
    liveWork: {
      blocked: true,
      ownerLabel: 'Worker B',
      phaseLabel: 'Recovery',
      activity: 'Needs attention',
      phaseIndex: 1,
      phaseCount: 3,
      updatedAt: '2026-08-29T00:00:00.000Z',
    },
  });

  const html = renderToStaticMarkup(React.createElement(SubtasksSection as any, {
    task: parent,
    subTasks: [historicalFailure, blocked],
    canCreateSubtask: false,
    onCreateSubtask: noop,
    onSelectTask: noop,
  }));

  const attentionSection = html.split('data-subtask-group="attention"')[1]?.split('data-subtask-group="ready"')[0] || '';
  assert.match(attentionSection, /DVF-BLOCKED/);
  assert.doesNotMatch(attentionSection, /DVF-LEGACY/);
  assert.match(html, /DVF-LEGACY/);
});

test('idle task stays neutral when no canonical or legacy execution metadata exists', () => {
  const task = makeTask({ status: 'todo', liveWork: undefined, latestAgentRun: undefined, activeAgent: undefined });
  const cardHtml = renderCard(task);
  assert.doesNotMatch(cardHtml, /Execution state:|Live work|Blocked/);

  const summary = resolveTaskInspectorStatusSummary(task);
  assert.equal(summary.label, 'Ready to start');

  const activityHtml = renderToStaticMarkup(React.createElement(TaskInspectorActivityTab as any, {
    task,
    newComment: '',
    setNewComment: noop,
    onAddComment: noop,
  }));
  assert.match(activityHtml, /No canonical live work is currently active/);
  assert.doesNotMatch(activityHtml, /Historical legacy run/);
});

test('Task Drawer activity keeps legacy run read-only and exposes no retry action', () => {
  const task = makeTask({
    latestAgentRun: { id: 'legacy-drawer-run', status: 'failed', errorMessage: 'old failure' },
    activeAgent: 'legacy-worker',
  });
  const html = renderToStaticMarkup(React.createElement(TaskDetailsDrawer as any, {
    task,
    allTasks: [task],
    initialTab: 'activity',
    onClose: noop,
    onUpdate: noop,
    onDelete: noop,
    onSelectTask: noop,
  }));

  assert.match(html, /Historical legacy run/);
  assert.match(html, /Read-only legacy history/);
  assert.doesNotMatch(html, /Retry run|Execution log|Run artifacts/);
});
