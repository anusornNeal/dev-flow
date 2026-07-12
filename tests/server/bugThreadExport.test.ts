import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskBugSummaryJson, renderTaskBugSummaryMarkdown } from '../../src/lib/bugThreadExport';

const task = {
  id: 'task-export-1',
  displayId: 'DVF-0281',
  title: 'Export bug summaries',
  status: 'done',
  checklist: [
    { id: 'a', text: 'Finished', completed: true },
    { id: 'b', text: 'Unfinished', completed: false },
  ],
  bugs: [
    {
      id: 'bug-verified',
      taskId: 'task-export-1',
      title: 'Old verified bug',
      status: 'verified',
      source: 'review',
      severity: 'medium',
      versions: [{ version: 1, status: 'verified', prompt: 'Old prompt', createdAt: '2026-07-01T00:00:00.000Z' }],
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      id: 'bug-open',
      taskId: 'task-export-1',
      title: 'Latest open bug',
      status: 'open',
      source: 'auto-close-warning',
      severity: 'high',
      actual: 'Task closed with unfinished mini tasks.',
      expected: 'Export shows the warning bug first.',
      evidence: 'Unfinished',
      relatedAreas: ['src/server/services/taskService.ts'],
      versions: [
        { version: 1, status: 'open', prompt: 'First prompt', summary: 'First attempt', createdAt: '2026-07-02T00:00:00.000Z' },
        { version: 2, status: 'open', prompt: 'Second prompt', summary: 'Second attempt', createdAt: '2026-07-02T01:00:00.000Z' },
      ],
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T01:00:00.000Z',
    },
  ],
};

test('bug summary JSON preserves ordered bugs and version history', () => {
  const summary = buildTaskBugSummaryJson(task as any);
  assert.equal(summary.task.displayId, 'DVF-0281');
  assert.equal(summary.unresolvedBugCount, 1);
  assert.equal(summary.latestUnresolvedBug?.id, 'bug-open');
  assert.equal(summary.bugThreads[0].id, 'bug-open');
  assert.equal(summary.bugThreads[0].versions.length, 2);
});

test('bug summary Markdown puts open bugs before verified history', () => {
  const markdown = renderTaskBugSummaryMarkdown(task as any);
  assert.ok(markdown.includes('# Bug Summary: DVF-0281'));
  assert.ok(markdown.indexOf('Latest open bug') < markdown.indexOf('Old verified bug'));
  assert.ok(markdown.includes('Open bug count: 1'));
  assert.ok(markdown.includes('Second prompt'));
});
