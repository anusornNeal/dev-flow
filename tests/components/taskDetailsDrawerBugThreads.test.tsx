import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskDetailsDrawer from '../../src/components/TaskDetailsDrawer.js';
import type { Task } from '../../src/types.js';

function makeTask(): Task {
  return {
    id: 'task-drawer-bugs-1',
    displayId: 'DVF-TEST',
    projectId: 'project-1',
    title: 'Drawer bug visibility fixture',
    description: 'Task description',
    status: 'in-progress',
    priority: 'high',
    category: 'frontend',
    tags: [],
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T01:00:00.000Z',
    logs: [],
    checklist: [],
    images: [],
    bugs: [
      {
        id: 'bug-visible-in-details',
        taskId: 'task-drawer-bugs-1',
        title: 'Embedded bug must be visible in Task Detail',
        status: 'open',
        source: 'user',
        severity: 'high',
        actual: 'The bug is hidden in normal detail view.',
        expected: 'The bug is visible without entering edit mode.',
        evidence: 'Regression fixture',
        relatedAreas: ['TaskDetailsDrawer'],
        versions: [
          {
            version: 1,
            status: 'open',
            prompt: 'Show bug details in normal view.',
            createdAt: '2026-07-10T01:00:00.000Z',
          },
        ],
        createdAt: '2026-07-10T01:00:00.000Z',
        updatedAt: '2026-07-10T01:00:00.000Z',
      },
    ],
  };
}

test('Task Detail renders embedded bug threads in the normal Bugs tab', () => {
  const task = makeTask();
  const html = renderToStaticMarkup(
    <TaskDetailsDrawer
      task={task}
      allTasks={[task]}
      initialTab="bugs"
      onClose={() => {}}
      onUpdate={() => {}}
      onDelete={() => {}}
    />,
  );

  assert.match(html, /Bugs to Fix/);
  assert.match(html, /Embedded bug must be visible in Task Detail/);
  assert.match(html, /The bug is visible without entering edit mode\./);
  assert.match(html, /Regression fixture/);
});
