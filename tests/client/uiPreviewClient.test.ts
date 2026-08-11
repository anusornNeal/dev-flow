import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskUiEvidencePath,
  createTaskUiEvidenceRequestGate,
  normalizeTaskUiEvidencePage,
} from '../../src/client/uiPreviewClient.js';

test('buildTaskUiEvidencePath always uses bounded paging and encodes cursor/task ids', () => {
  assert.equal(buildTaskUiEvidencePath('task 1'), '/api/tasks/task%201/ui-evidence?limit=20');
  assert.equal(
    buildTaskUiEvidencePath('task 1', { limit: 999, cursor: 'next/cursor=' }),
    '/api/tasks/task%201/ui-evidence?limit=50&cursor=next%2Fcursor%3D',
  );
  assert.equal(buildTaskUiEvidencePath('task 1', { limit: 0 }), '/api/tasks/task%201/ui-evidence?limit=1');
});

test('normalizeTaskUiEvidencePage keeps metadata/spec urls and bounded cursor metadata only', () => {
  const page = normalizeTaskUiEvidencePage({
    items: [{
      evidenceId: 'ev-1',
      taskId: 'task-1',
      previewId: 'preview-1',
      frozenRevision: 2,
      latestRevision: 4,
      frozenPreviewUrl: 'http://127.0.0.1:3000/p/frozen',
      latestPreviewUrl: 'http://127.0.0.1:3000/p/latest',
      screenshotUrl: 'http://127.0.0.1:3000/a/shot',
      attachedAt: '2026-08-11T02:00:00.000Z',
      current: true,
      spec: { schemaVersion: 1, summary: { screen: 'Checkout' } },
    }],
    nextCursor: 'cursor-2',
    limit: 20,
  });

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].previewId, 'preview-1');
  assert.equal(page.items[0].frozenRevision, 2);
  assert.equal(page.items[0].latestRevision, 4);
  assert.equal(page.items[0].frozenPreviewUrl, 'http://127.0.0.1:3000/p/frozen');
  assert.deepEqual(page.items[0].spec, { schemaVersion: 1, summary: { screen: 'Checkout' } });
  assert.equal(page.nextCursor, 'cursor-2');
  assert.equal(page.limit, 20);
});

test('request gate invalidates older task and refresh generations', () => {
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
