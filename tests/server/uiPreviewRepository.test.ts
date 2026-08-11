import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-repo-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { createUiPreviewRepository, fingerprintCanonicalRequest } = await import('../../src/server/repositories/uiPreviewRepository.js');
const { createTaskUiEvidenceRepository } = await import('../../src/server/repositories/taskUiEvidenceRepository.js');

const repo = createUiPreviewRepository(db as any);
const evidenceRepo = createTaskUiEvidenceRepository(db as any);
const spec = { schemaVersion: 1, summary: { screen: 'Repo' } } as const;
const viewport = { width: 1440, height: 900, deviceScaleFactor: 1 };

function seedTask(id: string) {
  db.prepare('INSERT OR IGNORE INTO tasks (id, title, status) VALUES (?, ?, ?)').run(id, id, 'todo');
}

function reset() {
  db.exec('DELETE FROM task_ui_evidence; DELETE FROM ui_preview_idempotency; DELETE FROM ui_preview_revisions; DELETE FROM ui_previews;');
  db.exec('DELETE FROM tasks;');
}

test.beforeEach(reset);

test('creates immutable revisions and suppresses only an effective duplicate of current head', () => {
  const created = repo.createPreview({ id: 'uip_one', taskId: null, title: null, html: '<main>a</main>', css: '', js: '', spec, viewport, contentHash: 'hash-a' });
  assert.equal(created.latestRevision, 1);
  const duplicate = repo.appendRevision({ previewId: 'uip_one', expectedRevision: 1, title: null, html: '<main>a</main>', css: '', js: '', spec, viewport, contentHash: 'hash-a' });
  assert.equal(duplicate.changed, false);
  assert.equal(repo.countRevisions('uip_one'), 1);
  const rev2 = repo.appendRevision({ previewId: 'uip_one', expectedRevision: 1, title: null, html: '<main>b</main>', css: '', js: '', spec, viewport, contentHash: 'hash-b' });
  assert.equal(rev2.changed, true);
  assert.equal(rev2.revision.revision, 2);
  const revert = repo.appendRevision({ previewId: 'uip_one', expectedRevision: 2, title: null, html: '<main>a</main>', css: '', js: '', spec, viewport, contentHash: 'hash-a' });
  assert.equal(revert.revision.revision, 3);
  assert.equal(repo.getRevision('uip_one', 1)?.html, '<main>a</main>');
});

test('rejects stale expectedRevision and task rebinding', () => {
  seedTask('task-a'); seedTask('task-b');
  repo.createPreview({ id: 'uip_bound', taskId: null, title: null, html: '<main>a</main>', css: '', js: '', spec, viewport, contentHash: 'hash-a' });
  repo.bindPreviewToTask('uip_bound', 'task-a');
  assert.equal(repo.bindPreviewToTask('uip_bound', 'task-a').taskId, 'task-a');
  assert.throws(() => repo.bindPreviewToTask('uip_bound', 'task-b'), (error: any) => error?.code === 'UI_PREVIEW_TASK_CONFLICT');
  assert.throws(() => repo.appendRevision({ previewId: 'uip_bound', expectedRevision: 9, title: null, html: '<main>b</main>', css: '', js: '', spec, viewport, contentHash: 'hash-b' }), (error: any) => error?.code === 'UI_PREVIEW_REVISION_CONFLICT');
});

test('persists operation-scoped idempotency and rejects conflicting key reuse', () => {
  const fingerprint = fingerprintCanonicalRequest({ previewId: 'uip_one', html: '<main>a</main>' });
  const first = repo.runIdempotent('update', 'retry-key', fingerprint, () => ({ previewId: 'uip_one', revision: 2, changed: true }));
  assert.equal(first.replayed, false);
  const replay = repo.runIdempotent('update', 'retry-key', fingerprint, () => { throw new Error('must not run'); });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, { previewId: 'uip_one', revision: 2, changed: true });
  assert.throws(() => repo.runIdempotent('update', 'retry-key', fingerprintCanonicalRequest({ previewId: 'uip_one', html: '<main>b</main>' }), () => ({})), (error: any) => error?.code === 'UI_PREVIEW_IDEMPOTENCY_CONFLICT');
});

test('preview revisions and idempotency replay survive database close and reopen', async () => {
  const reopenPath = path.join(tempRoot, 'reopen.db');
  try { fs.rmSync(reopenPath, { force: true }); } catch {}
  const { openIsolatedDatabase } = await import('../../src/db/index.js');
  const { runMigrations } = await import('../../src/db/migrations/runner.js');
  const { DEVFLOW_MIGRATIONS } = await import('../../src/db/migrations/index.js');
  const firstDb = openIsolatedDatabase(reopenPath);
  runMigrations(firstDb, [...DEVFLOW_MIGRATIONS]);
  const firstRepo = createUiPreviewRepository(firstDb as any);
  firstRepo.createPreview({ id: 'uip_reopen', taskId: null, title: null, html: '<main>persisted</main>', css: '', js: '', spec, viewport, contentHash: 'persisted-hash' });
  const fingerprint = fingerprintCanonicalRequest({ request: 'same' });
  firstRepo.runIdempotent('create', 'reopen-key', fingerprint, () => ({ previewId: 'uip_reopen', revision: 1 }));
  firstDb.close();

  const secondDb = openIsolatedDatabase(reopenPath);
  const secondRepo = createUiPreviewRepository(secondDb as any);
  assert.equal(secondRepo.getRevision('uip_reopen', 1)?.html, '<main>persisted</main>');
  const replay = secondRepo.runIdempotent('create', 'reopen-key', fingerprint, () => { throw new Error('must not run after reopen'); });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, { previewId: 'uip_reopen', revision: 1 });
  assert.equal(secondRepo.countRevisions('uip_reopen'), 1);
  secondDb.close();
});

test('evidence keeps highest frozen revision current and collapses same revision', () => {
  seedTask('task-a');
  repo.createPreview({ id: 'uip_one', taskId: 'task-a', title: null, html: '<main>a</main>', css: '', js: '', spec, viewport, contentHash: 'hash-a' });
  repo.appendRevision({ previewId: 'uip_one', expectedRevision: 1, title: null, html: '<main>b</main>', css: '', js: '', spec, viewport, contentHash: 'hash-b' });
  repo.appendRevision({ previewId: 'uip_one', expectedRevision: 2, title: null, html: '<main>c</main>', css: '', js: '', spec, viewport, contentHash: 'hash-c' });
  const rev2 = evidenceRepo.recordEvidence({ evidenceId: 'uie_two', taskId: 'task-a', previewId: 'uip_one', frozenRevision: 2, frozenSpec: spec, screenshotArtifactId: 'shot-2', screenshotWidth: 1440, screenshotHeight: 900 });
  assert.equal(rev2.outcome, 'inserted');
  const same = evidenceRepo.recordEvidence({ evidenceId: 'uie_two_other', taskId: 'task-a', previewId: 'uip_one', frozenRevision: 2, frozenSpec: spec, screenshotArtifactId: 'shot-2b', screenshotWidth: 1440, screenshotHeight: 900 });
  assert.equal(same.outcome, 'same-revision');
  assert.equal(same.evidence.evidenceId, 'uie_two');
  const rev3 = evidenceRepo.recordEvidence({ evidenceId: 'uie_three', taskId: 'task-a', previewId: 'uip_one', frozenRevision: 3, frozenSpec: spec, screenshotArtifactId: 'shot-3', screenshotWidth: 1440, screenshotHeight: 900 });
  assert.equal(rev3.outcome, 'superseded');
  const late2 = evidenceRepo.recordEvidence({ evidenceId: 'uie_late', taskId: 'task-a', previewId: 'uip_one', frozenRevision: 2, frozenSpec: spec, screenshotArtifactId: 'shot-late', screenshotWidth: 1440, screenshotHeight: 900 });
  assert.equal(late2.outcome, 'stale');
  assert.equal(evidenceRepo.getCurrentEvidence('task-a', 'uip_one')?.frozenRevision, 3);
  assert.equal(evidenceRepo.listEvidence('task-a', 'uip_one').length, 2);
});

test('evidence for another preview remains current', () => {
  seedTask('task-a');
  for (const id of ['uip_one', 'uip_two']) repo.createPreview({ id, taskId: 'task-a', title: null, html: '<main>a</main>', css: '', js: '', spec, viewport, contentHash: `hash-${id}` });
  evidenceRepo.recordEvidence({ evidenceId: 'uie_one', taskId: 'task-a', previewId: 'uip_one', frozenRevision: 1, frozenSpec: spec, screenshotArtifactId: 'shot-1', screenshotWidth: 1440, screenshotHeight: 900 });
  evidenceRepo.recordEvidence({ evidenceId: 'uie_two', taskId: 'task-a', previewId: 'uip_two', frozenRevision: 1, frozenSpec: spec, screenshotArtifactId: 'shot-2', screenshotWidth: 1440, screenshotHeight: 900 });
  assert.equal(evidenceRepo.getCurrentEvidence('task-a', 'uip_one')?.evidenceId, 'uie_one');
  assert.equal(evidenceRepo.getCurrentEvidence('task-a', 'uip_two')?.evidenceId, 'uie_two');
});
