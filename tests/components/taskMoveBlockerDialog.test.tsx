import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('soft move blockers render recovery first and keep Move Anyway available', () => {
  const html = renderToStaticMarkup(React.createElement(TaskMoveBlockerDialog, {
    decision: softDecision,
    sourceLabel: 'In Progress',
    targetLabel: 'Ready for Review',
    onMoveAnyway: noop,
    onCancel: noop,
  }));
  assert.match(html, /Workflow check/);
  assert.match(html, /What happened/);
  assert.match(html, /What you can do/);
  assert.match(html, /Why/);
  assert.match(html, /Complete 2 remaining checklist items/);
  assert.match(html, /Move Anyway/);
  assert.match(html, /Technical details/);
  assert.match(html, /CHECKLIST_INCOMPLETE/);
  assert.match(html, /warning-surface/);
});

test('hard blockers are visually and behaviorally non-bypassable', () => {
  const html = renderToStaticMarkup(React.createElement(TaskMoveBlockerDialog, {
    decision: hardDecision,
    sourceLabel: 'In Progress',
    targetLabel: 'Ready for Review',
    onMoveAnyway: noop,
    onCancel: noop,
  }));
  assert.match(html, /Safety blocker/);
  assert.match(html, /danger-surface/);
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

test('move blocker contains long messages and technical payloads inside bounded scroll areas', () => {
  const source = fs.readFileSync('src/components/TaskMoveBlockerDialog.tsx', 'utf8');
  assert.match(source, /max-h-\[calc\(100vh-1\.5rem\)\]/);
  assert.match(source, /break-words/);
  assert.match(source, /max-h-44/);
  assert.match(source, /overflow-auto/);
  assert.match(source, /whitespace-pre-wrap/);
});

test('task authoring dialogs share required-optional hierarchy and bounded error states', () => {
  const createSource = fs.readFileSync('src/components/CreateTaskModal.tsx', 'utf8');
  const batchSource = fs.readFileSync('src/components/BatchImportModal.tsx', 'utf8');

  assert.match(createSource, /Task authoring/);
  assert.match(createSource, /Basics/);
  assert.match(createSource, /Planning/);
  assert.match(createSource, /Agent execution/);
  assert.match(createSource, /Scope & evidence/);
  assert.match(createSource, /aria-required="true"/);
  assert.match(createSource, /disabled=\{submitting \|\| !title\.trim\(\)\}/);
  assert.match(createSource, /Creating task…/);
  assert.match(createSource, /Could not create task/);
  assert.match(createSource, /max-h-32 overflow-y-auto break-words/);

  assert.match(batchSource, /Batch authoring/);
  assert.match(batchSource, /JSON payload/);
  assert.match(batchSource, /aria-invalid=\{Boolean\(errorMsg\)\}/);
  assert.match(batchSource, /disabled=\{importing \|\| !jsonText\.trim\(\)\}/);
  assert.match(batchSource, /Importing tasks…/);
  assert.match(batchSource, /Import could not continue/);
  assert.match(batchSource, /max-h-36/);
  assert.match(batchSource, /break-words/);
});
