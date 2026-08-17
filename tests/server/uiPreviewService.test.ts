import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-service-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { createUiPreviewRepository } = await import('../../src/server/repositories/uiPreviewRepository.js');
const { createUiPreviewService } = await import('../../src/server/services/uiPreviewService.js');

const repository = createUiPreviewRepository(db as any);
const service = createUiPreviewService({ repository, runtimePort: () => 43123 });
const spec = { schemaVersion: 1, summary: { screen: 'Service' }, sections: [{ id: 'main' }] };

function createWorkspaceService() {
  const previews = new Map<string, { record: any; revisions: any[] }>();
  const idempotency = new Map<string, { fingerprint: string; result: any }>();
  let previewId = 0;
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const repository = {
    runIdempotent(operation: string, key: string | undefined, fingerprint: string, work: () => any) {
      if (!key) return { replayed: false, result: work() };
      const storageKey = `${operation}:${key}`;
      const existing = idempotency.get(storageKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          const error: any = new Error('idempotency conflict');
          error.code = 'UI_PREVIEW_IDEMPOTENCY_CONFLICT';
          throw error;
        }
        return { replayed: true, result: clone(existing.result) };
      }
      const result = work();
      idempotency.set(storageKey, { fingerprint, result: clone(result) });
      return { replayed: false, result };
    },
    createPreview(input: any) {
      const createdAt = '2026-08-17T00:00:00.000Z';
      const record = { id: input.id, taskId: input.taskId ?? null, latestRevision: 1, createdAt, updatedAt: createdAt };
      const revision = { ...clone(input), previewId: input.id, revision: 1, createdAt };
      previews.set(input.id, { record, revisions: [revision] });
      return record;
    },
    getPreview(id: string) {
      return previews.get(id)?.record ?? null;
    },
    getRevision(id: string, revision?: number) {
      const stored = previews.get(id);
      if (!stored) return null;
      const selected = revision ?? stored.record.latestRevision;
      return stored.revisions.find((item) => item.revision === selected) ?? null;
    },
    appendRevision(input: any) {
      const stored = previews.get(input.previewId);
      if (!stored) throw new Error('missing preview');
      if (input.expectedRevision !== undefined && input.expectedRevision !== stored.record.latestRevision) {
        const error: any = new Error('revision conflict');
        error.code = 'UI_PREVIEW_REVISION_CONFLICT';
        throw error;
      }
      const current = stored.revisions[stored.revisions.length - 1];
      const comparable = (value: any) => JSON.stringify({
        title: value.title,
        screens: value.screens,
        defaultScreenId: value.defaultScreenId,
        viewport: value.viewport,
      });
      if (comparable(current) === comparable(input)) return { changed: false, preview: stored.record, revision: current };
      const nextRevision = stored.record.latestRevision + 1;
      const createdAt = `2026-08-17T00:00:0${nextRevision}.000Z`;
      const revision = { ...clone(input), previewId: input.previewId, revision: nextRevision, createdAt };
      stored.revisions.push(revision);
      stored.record.latestRevision = nextRevision;
      stored.record.updatedAt = createdAt;
      return { changed: true, preview: stored.record, revision };
    },
    listPreviews(input: any = {}) {
      const items = [...previews.values()].map(({ record, revisions }) => {
        const revision = revisions[revisions.length - 1];
        return {
          previewId: record.id,
          taskId: record.taskId,
          title: revision.title,
          specSummary: revision.spec?.summary ?? {},
          latestRevision: record.latestRevision,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          linkedTask: null,
        };
      });
      return { items, nextCursor: null, limit: input.limit ?? 20, filter: input.filter ?? 'all' };
    },
  } as any;
  return {
    service: createUiPreviewService({ repository, runtimePort: () => 43123, createId: () => `uip_workspace_${++previewId}` }),
    repository,
  };
}

function reset() {
  db.exec('DELETE FROM task_ui_evidence; DELETE FROM ui_preview_idempotency; DELETE FROM ui_preview_revisions; DELETE FROM ui_previews; DELETE FROM tasks;');
}

function seedTask(id: string) {
  db.prepare('INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)').run(id, id, 'todo');
}

test.beforeEach(reset);

test('create returns bounded metadata and source is opt-in', () => {
  const created = service.create({ title: 'Demo', html: '<main>hello</main>', css: 'main{}', js: 'window.x=1', spec });
  assert.match(created.previewId, /^uip_/);
  assert.equal(created.revision, 1);
  assert.equal(created.latestRevision, 1);
  assert.equal(created.changed, true);
  assert.equal('html' in created, false);
  assert.equal('css' in created, false);
  assert.match(created.previewUrl, /^http:\/\/127\.0\.0\.1:43123\//);

  const summary = service.get({ previewId: created.previewId });
  assert.equal('html' in summary, false);
  assert.equal('spec' in summary, false);
  assert.equal(summary.specSummary.screen, 'Service');

  const source = service.get({ previewId: created.previewId, mode: 'source' });
  assert.equal(source.html, '<main>hello</main>');
  assert.equal(source.css, 'main{}');
  assert.equal(source.js, 'window.x=1');
  assert.deepEqual(source.spec, spec);
});

test('multi-screen service preserves canonical workspace metadata, full replacement, and idempotency identity', () => {
  const { service: workspaceService } = createWorkspaceService();
  const screens = [
    { screenId: 'overview', name: 'Overview', html: '<main>secret-overview</main>', css: 'o{}', js: 'o()', spec: { schemaVersion: 1, summary: { screen: 'Overview' } } },
    { screenId: 'details', name: 'Details', html: '<main>secret-details</main>', css: 'd{}', js: 'd()', spec: { schemaVersion: 1, summary: { screen: 'Details' } } },
  ];
  const created = workspaceService.create({ title: 'Workspace', screens, defaultScreenId: 'details', idempotencyKey: 'workspace-create' });
  assert.equal(created.screenCount, 2);
  assert.equal(created.defaultScreenId, 'details');
  assert.equal(created.defaultScreenSummary.name, 'Details');
  assert.equal(created.specSummary.screen, 'Details');

  const summary = workspaceService.get({ previewId: created.previewId });
  assert.equal(summary.screenCount, 2);
  assert.equal(summary.defaultScreenId, 'details');
  assert.equal('screens' in summary, false);
  assert.equal('html' in summary, false);

  const source = workspaceService.get({ previewId: created.previewId, mode: 'source' });
  assert.deepEqual(source.screens, screens);
  assert.equal(source.defaultScreenId, 'details');
  assert.equal(source.html, '<main>secret-details</main>', 'legacy source aliases follow the default screen');
  assert.equal(source.spec.summary.screen, 'Details');

  const page = workspaceService.list({ filter: 'all', limit: 20 });
  assert.equal(page.items[0].screenCount, 2);
  assert.equal(page.items[0].defaultScreenId, 'details');
  assert.equal(page.items[0].defaultScreenSummary.name, 'Details');
  assert.doesNotMatch(JSON.stringify(page), /secret-overview|secret-details|o\(\)|d\(\)/);

  const replacement = [
    { ...screens[0], html: '<main>overview-v2</main>' },
    { ...screens[1], html: '<main>details-v2</main>' },
  ];
  const updated = workspaceService.update({
    previewId: created.previewId,
    expectedRevision: 1,
    screens: replacement,
    defaultScreenId: 'overview',
    idempotencyKey: 'workspace-update',
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.defaultScreenId, 'overview');
  assert.equal(updated.defaultScreenSummary.name, 'Overview');

  const replay = workspaceService.update({
    previewId: created.previewId,
    expectedRevision: 1,
    screens: replacement,
    defaultScreenId: 'overview',
    idempotencyKey: 'workspace-update',
  });
  assert.equal(replay.revision, 2);
  assert.equal(replay.replayed, true);
  assert.throws(() => workspaceService.update({
    previewId: created.previewId,
    expectedRevision: 1,
    screens: [{ ...replacement[0], html: '<main>different</main>' }, replacement[1]],
    defaultScreenId: 'overview',
    idempotencyKey: 'workspace-update',
  }), (error: any) => error?.code === 'UI_PREVIEW_IDEMPOTENCY_CONFLICT');
  assert.throws(() => workspaceService.update({ previewId: created.previewId, html: '<main>legacy patch</main>' }), /replace the complete screens array/i);
});

test('canonical hash is stable across spec key insertion order and exact-source significant', () => {
  const a = service.create({ html: '<main>x</main>', spec: { schemaVersion: 1, summary: { screen: 'A', b: 2, a: 1 }, z: { y: 2, x: 1 } } });
  const b = service.create({ html: '<main>x</main>', spec: { z: { x: 1, y: 2 }, summary: { a: 1, b: 2, screen: 'A' }, schemaVersion: 1 } });
  assert.equal(a.contentHash, b.contentHash);
  const golden = service.create({ html: '<main>x</main>', spec: { schemaVersion: 1, summary: { screen: 'A' } } });
  assert.equal(golden.contentHash, '3c1b082b0ca38df0066f5fe8180ce11dc81290693ea06c166dca09db3edfe872');
  const c = service.create({ html: '<main>x</main>\n', spec: { schemaVersion: 1, summary: { screen: 'A', a: 1, b: 2 }, z: { x: 1, y: 2 } } });
  assert.notEqual(a.contentHash, c.contentHash);
});

test('update is patch-like, supports explicit clears, duplicate suppression, and intentional revert', () => {
  const created = service.create({ title: 'Title', html: '<main>a</main>', css: 'a{}', js: 'x()', spec });
  const rev2 = service.update({ previewId: created.previewId, expectedRevision: 1, html: '<main>b</main>' });
  assert.equal(rev2.revision, 2);
  const source2 = service.get({ previewId: created.previewId, revision: 2, mode: 'source' });
  assert.equal(source2.css, 'a{}');
  assert.equal(source2.js, 'x()');
  assert.equal(source2.title, 'Title');

  const cleared = service.update({ previewId: created.previewId, expectedRevision: 2, title: '', css: '', js: '' });
  assert.equal(cleared.revision, 3);
  const source3 = service.get({ previewId: created.previewId, revision: 3, mode: 'source' });
  assert.equal(source3.title, null);
  assert.equal(source3.css, '');
  assert.equal(source3.js, '');

  const duplicate = service.update({ previewId: created.previewId, expectedRevision: 3, title: '', css: '', js: '' });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.revision, 3);

  const reverted = service.update({ previewId: created.previewId, expectedRevision: 3, title: 'Title', html: '<main>a</main>', css: 'a{}', js: 'x()' });
  assert.equal(reverted.changed, true);
  assert.equal(reverted.revision, 4);
});

test('stale expectedRevision fails with the stable preview conflict code', () => {
  const created = service.create({ html: '<main>a</main>', spec });
  assert.throws(() => service.update({ previewId: created.previewId, expectedRevision: 99, html: '<main>b</main>' }), (error: any) => error?.code === 'UI_PREVIEW_REVISION_CONFLICT');
});

test('durable create/update idempotency replays the original logical revision after later mutations', () => {
  const first = service.create({ html: '<main>a</main>', spec, idempotencyKey: 'create-key' });
  const createReplay = service.create({ html: '<main>a</main>', spec, idempotencyKey: 'create-key' });
  assert.equal(createReplay.previewId, first.previewId);
  assert.equal(createReplay.revision, 1);

  const update = service.update({ previewId: first.previewId, expectedRevision: 1, html: '<main>b</main>', idempotencyKey: 'update-key' });
  service.update({ previewId: first.previewId, expectedRevision: 2, html: '<main>c</main>' });
  const delayedReplay = service.update({ previewId: first.previewId, expectedRevision: 1, html: '<main>b</main>', idempotencyKey: 'update-key' });
  assert.equal(delayedReplay.revision, update.revision);
  assert.equal(delayedReplay.replayed, true);
  assert.equal(repository.countRevisions(first.previewId), 3);
  assert.throws(() => service.update({ previewId: first.previewId, expectedRevision: 1, html: '<main>DIFFERENT</main>', idempotencyKey: 'update-key' }), (error: any) => error?.code === 'UI_PREVIEW_IDEMPOTENCY_CONFLICT');
});

test('library list resolves latest unpinned runtime URLs and returns summary metadata only', () => {
  const created = service.create({ title: 'Library', html: '<main>secret</main>', css: 'secret-css', js: 'secret-js', spec });
  service.update({ previewId: created.previewId, expectedRevision: 1, html: '<main>latest secret</main>' });
  const page = service.list({ filter: 'all', limit: 20 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].latestRevision, 2);
  assert.equal(page.items[0].specSummary.screen, 'Service');
  assert.match(page.items[0].latestPreviewUrl, /^http:\/\/127\.0\.0\.1:43123\/api\/ui-previews\//);
  assert.doesNotMatch(page.items[0].latestPreviewUrl, /revision=/);
  assert.doesNotMatch(JSON.stringify(page), /latest secret|secret-css|secret-js/);
});

test('delete removes standalone previews and rejects linked or missing previews', () => {
  const created = service.create({ html: '<main>delete</main>', spec });
  service.update({ previewId: created.previewId, expectedRevision: 1, html: '<main>delete-2</main>' });
  const removed = (service as any).delete({ previewId: created.previewId });
  assert.deepEqual(removed, { previewId: created.previewId, deleted: true, deletedRevisions: 2 });
  assert.equal(repository.getPreview(created.previewId), null);

  seedTask('task-linked-service');
  const linked = service.create({ taskId: 'task-linked-service', html: '<main>linked</main>', spec });
  assert.throws(() => (service as any).delete({ previewId: linked.previewId }), (error: any) => error?.code === 'UI_PREVIEW_DELETE_LINKED_CONFLICT');
  assert.throws(() => (service as any).delete({ previewId: 'uip_missing_service' }), (error: any) => error?.code === 'UI_PREVIEW_NOT_FOUND');
});

test('create/update/get core does not depend on project workspace, git, verification, or playwright services', async () => {
  const source = fs.readFileSync(path.resolve('src/server/services/uiPreviewService.ts'), 'utf8');
  assert.doesNotMatch(source, /gitService|sessionWorkspace|projectWorkspace|runProjectCommand|playwright|screenshot/i);
});
