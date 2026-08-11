import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-events-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.sqlite');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const events = await import('../../src/server/services/serverEventService.js') as any;
const tasks = await import('../../src/server/repositories/taskRepository.js') as any;
const { createUiPreviewRepository } = await import('../../src/server/repositories/uiPreviewRepository.js');

const repository = createUiPreviewRepository();
const spec = { schemaVersion: 1 as const, summary: { screen: 'Event preview' } };
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };

function collectEvents() {
  const received: any[] = [];
  const subscription = events.subscribeServerEvents((event: any) => received.push(event));
  return { received, stop: () => subscription.unsubscribe() };
}

test.beforeEach(() => events.__resetServerEventsForTests());

test('preview mutations publish ui-preview.changed only after successful committed changes', () => {
  const { received, stop } = collectEvents();
  const suffix = Date.now();
  const taskId = `task-preview-events-${suffix}`;
  const previewId = `uip_preview_events_${suffix}`;
  const deleteId = `uip_preview_delete_${suffix}`;
  const now = new Date().toISOString();

  try {
    tasks.saveTask({ id: taskId, displayId: `EVT-${suffix}`, title: 'Preview event task', status: 'todo', priority: 'medium', category: 'general', createdAt: now, updatedAt: now });
    repository.createPreview({ id: previewId, taskId: null, title: 'Preview', html: '<main>a</main>', css: '', js: '', spec, viewport, contentHash: 'event-a', createdAt: now });
    repository.appendRevision({ previewId, expectedRevision: 1, title: 'Preview', html: '<main>b</main>', css: '', js: '', spec, viewport, contentHash: 'event-b', createdAt: new Date(Date.now() + 1).toISOString() });
    repository.bindPreviewToTask(previewId, taskId);

    const beforeRejectedDelete = received.length;
    assert.throws(() => repository.deleteStandalonePreview(previewId), (error: any) => error?.code === 'UI_PREVIEW_DELETE_LINKED_CONFLICT');
    assert.equal(received.length, beforeRejectedDelete, 'failed linked delete must not publish a success event');

    repository.createPreview({ id: deleteId, taskId: null, title: 'Disposable', html: '<main>x</main>', css: '', js: '', spec, viewport, contentHash: 'delete-a', createdAt: new Date(Date.now() + 2).toISOString() });
    repository.deleteStandalonePreview(deleteId);

    const previewEvents = received.filter((event) => event.type === 'ui-preview.changed');
    assert.deepEqual(previewEvents.map((event) => event.reason), ['created', 'updated', 'bound', 'created', 'deleted']);
    assert.deepEqual(previewEvents.map((event) => event.entityId), [previewId, previewId, previewId, deleteId, deleteId]);
    for (const event of previewEvents) {
      assert.ok(Object.keys(event).every((key) => ['v', 'id', 'type', 'at', 'projectId', 'entityId', 'status', 'reason'].includes(key)));
    }
  } finally {
    stop();
  }
});
