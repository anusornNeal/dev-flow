import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskUiEvidencePath,
  createTaskUiEvidenceRequestGate,
  normalizeTaskUiEvidencePage,
  buildUiPreviewLibraryPath,
  normalizeUiPreviewLibraryPage,
  createUiPreviewLibraryRequestGate,
  createUiPreviewAttachAttemptStore,
  deleteUiPreview,
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

test('preview library path is bounded and never requests raw source mode', () => {
  assert.equal(buildUiPreviewLibraryPath(), '/api/ui-previews?limit=20&filter=all');
  assert.equal(buildUiPreviewLibraryPath({ filter: 'linked', limit: 999, cursor: 'next/cursor=' }), '/api/ui-previews?limit=50&filter=linked&cursor=next%2Fcursor%3D');
  assert.doesNotMatch(buildUiPreviewLibraryPath({ filter: 'standalone' }), /mode=source|revision=/);
});

test('preview library normalization keeps latest summary and linked task context only', () => {
  const page = normalizeUiPreviewLibraryPage({ items: [{ previewId: 'uip-1', taskId: 'task-1', title: 'Checkout', specSummary: { screen: 'Checkout' }, latestRevision: 4, createdAt: 'a', updatedAt: 'b', latestPreviewUrl: 'http://127.0.0.1:3000/latest', linkedTask: { id: 'task-1', displayId: 'DVF-0502', title: 'Task', projectId: 'project-a' }, html: 'secret' }], nextCursor: 'c', limit: 20 });
  assert.equal(page.items[0].latestRevision, 4);
  assert.equal(page.items[0].latestPreviewUrl, 'http://127.0.0.1:3000/latest');
  assert.deepEqual(page.items[0].linkedTask, { id: 'task-1', displayId: 'DVF-0502', title: 'Task', projectId: 'project-a' });
  assert.equal('html' in page.items[0], false);
  assert.equal(page.nextCursor, 'c');
});

test('library request gate invalidates stale filter, refresh, and navigation generations', () => {
  const gate = createUiPreviewLibraryRequestGate();
  const all = gate.begin('all');
  const linked = gate.begin('linked');
  assert.equal(gate.isCurrent(all), false);
  assert.equal(gate.isCurrent(linked), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(linked), false);
});

test('attach attempt store collapses duplicate pending clicks and reuses only uncertain keys', () => {
  let key = 0;
  const store = createUiPreviewAttachAttemptStore(() => `attach-${++key}`);
  const first = store.begin('uip-1', 'DVF-0502');
  assert.ok(first);
  assert.equal(store.begin('uip-1', 'DVF-0502'), null);
  store.settle(first!, 'uncertain');
  const retry = store.begin('uip-1', 'DVF-0502');
  assert.equal(retry?.idempotencyKey, 'attach-1');
  store.settle(retry!, 'terminal');
  const next = store.begin('uip-1', 'DVF-0502');
  assert.equal(next?.idempotencyKey, 'attach-2');
  assert.equal(store.isCurrent(next!), true);
  store.cancel(next!);
  assert.equal(store.isCurrent(next!), false);
  const afterCancel = store.begin('uip-1', 'DVF-0502');
  assert.equal(afterCancel?.idempotencyKey, 'attach-2', 'cancel keeps the uncertain logical key for a safe retry');
});

test('deleteUiPreview sends DELETE to the encoded preview endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let captured: { input: string; method?: string } | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured = { input: String(input), method: init?.method };
    return new Response(JSON.stringify({ previewId: 'uip-1', deleted: true, deletedRevisions: 2 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const result = await deleteUiPreview('uip-1');
    assert.equal(captured?.input, '/api/ui-previews/uip-1');
    assert.equal(captured?.method, 'DELETE');
    assert.deepEqual(result.data, { previewId: 'uip-1', deleted: true, deletedRevisions: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
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
