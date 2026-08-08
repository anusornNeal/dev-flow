import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskMoveBlockerDialog, { buildTaskMoveDialogModel } from '../../src/components/TaskMoveBlockerDialog.js';

const noop = () => {};

const softDecision = {
  code: 'MOVE_CONFIRMATION_REQUIRED',
  message: 'This manual move is blocked only by workflow-quality checks.',
  confirmationRequired: true,
  blockers: [
    { code: 'CHECKLIST_INCOMPLETE', message: 'Complete 2 remaining checklist items.', bypassable: true },
    { code: 'HEAD_NOT_PUSHED', message: 'The current local HEAD is not published.', bypassable: true },
  ],
};

const hardDecision = {
  code: 'MOVE_HARD_BLOCKED',
  message: 'Task is actively owned by Codex.',
  confirmationRequired: false,
  blockers: [
    { code: 'ACTIVE_AGENT_LOCK', message: 'Codex is still running this task.', bypassable: false },
  ],
};

test('soft move blockers render actionable sections and Move Anyway', () => {
  const html = renderToStaticMarkup(React.createElement(TaskMoveBlockerDialog, {
    decision: softDecision,
    sourceLabel: 'In Progress',
    targetLabel: 'Ready for Review',
    onMoveAnyway: noop,
    onCancel: noop,
  }));
  assert.match(html, /What happened/);
  assert.match(html, /Why/);
  assert.match(html, /What you can do/);
  assert.match(html, /Complete 2 remaining checklist items/);
  assert.match(html, /Move Anyway/);
  assert.match(html, /Technical details/);
  assert.match(html, /CHECKLIST_INCOMPLETE/);
});

test('hard blockers never expose Move Anyway and explain the concrete resolution', () => {
  const html = renderToStaticMarkup(React.createElement(TaskMoveBlockerDialog, {
    decision: hardDecision,
    sourceLabel: 'In Progress',
    targetLabel: 'Ready for Review',
    onMoveAnyway: noop,
    onCancel: noop,
  }));
  assert.doesNotMatch(html, /Move Anyway/);
  assert.match(html, /Cancel or complete the active agent run/);
  assert.match(html, /Codex is still running this task/);
  assert.match(html, /ACTIVE_AGENT_LOCK/);
});

test('override is offered only when every blocker is explicitly bypassable', () => {
  const mixed = buildTaskMoveDialogModel({
    ...softDecision,
    blockers: [...softDecision.blockers, { code: 'LOCK_CONFLICT', message: 'Resolve task lock.', bypassable: false }],
  });
  assert.equal(mixed.canMoveAnyway, false);

  const soft = buildTaskMoveDialogModel(softDecision);
  assert.equal(soft.canMoveAnyway, true);
});
