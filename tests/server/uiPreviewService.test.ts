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

function reset() {
  db.exec('DELETE FROM task_ui_evidence; DELETE FROM ui_preview_idempotency; DELETE FROM ui_preview_revisions; DELETE FROM ui_previews;');
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

test('create/update/get core does not depend on project workspace, git, verification, or playwright services', async () => {
  const source = fs.readFileSync(path.resolve('src/server/services/uiPreviewService.ts'), 'utf8');
  assert.doesNotMatch(source, /gitService|workspace|runProjectCommand|playwright|screenshot/i);
});
