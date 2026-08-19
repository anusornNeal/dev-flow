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
const { createUiPreviewRepository, fingerprintCanonicalRequest, hashUiPreviewContent } = await import('../../src/server/repositories/uiPreviewRepository.js');
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

test('preview library list is deterministic, filtered, cursor-paged, and summary-only', () => {
  seedTask('task-linked');
  db.prepare('UPDATE tasks SET displayId = ?, projectId = ?, title = ? WHERE id = ?')
    .run('DVF-0502', 'project-a', 'Linked task', 'task-linked');

  repo.createPreview({ id: 'uip_old', taskId: null, title: 'Old', html: '<main>old secret</main>', css: 'secret-css', js: 'secret-js', spec: { schemaVersion: 1, summary: { screen: 'Old screen' } }, viewport, contentHash: 'old', createdAt: '2026-08-11T01:00:00.000Z' });
  repo.createPreview({ id: 'uip_linked', taskId: 'task-linked', title: 'Linked', html: '<main>linked secret</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'Linked screen' } }, viewport, contentHash: 'linked', createdAt: '2026-08-11T02:00:00.000Z' });
  repo.createPreview({ id: 'uip_latest', taskId: null, title: 'Latest', html: '<main>latest secret</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'Latest screen' } }, viewport, contentHash: 'latest', createdAt: '2026-08-11T03:00:00.000Z' });

  const first = repo.listPreviews({ filter: 'all', limit: 2 });
  assert.deepEqual(first.items.map((item: any) => item.previewId), ['uip_latest', 'uip_linked']);
  assert.ok(first.nextCursor);
  const second = repo.listPreviews({ filter: 'all', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item: any) => item.previewId), ['uip_old']);
  assert.equal(second.nextCursor, null);

  const standalone = repo.listPreviews({ filter: 'standalone', limit: 50 });
  assert.deepEqual(standalone.items.map((item: any) => item.previewId), ['uip_latest', 'uip_old']);
  const linked = repo.listPreviews({ filter: 'linked', limit: 50 });
  assert.deepEqual(linked.items.map((item: any) => item.previewId), ['uip_linked']);
  assert.deepEqual(linked.items[0].linkedTask, { id: 'task-linked', displayId: 'DVF-0502', title: 'Linked task', projectId: 'project-a' });
  assert.deepEqual(linked.items[0].specSummary, { screen: 'Linked screen' });
  assert.doesNotMatch(JSON.stringify(linked), /linked secret|secret-css|secret-js|html|css|js/);

  assert.throws(() => repo.listPreviews({ filter: 'all', limit: 20, cursor: 'not-a-valid-cursor' }), (error: any) => error?.code === 'UI_PREVIEW_CURSOR_INVALID');
  assert.equal(repo.listPreviews({ filter: 'all', limit: 999 }).limit, 50);
});

test('standalone preview deletion removes all revisions while linked and missing previews fail closed', () => {
  repo.createPreview({ id: 'uip_delete', taskId: null, title: 'Delete me', html: '<main>a</main>', css: '', js: '', spec, viewport, contentHash: 'delete-a' });
  repo.appendRevision({ previewId: 'uip_delete', expectedRevision: 1, title: 'Delete me', html: '<main>b</main>', css: '', js: '', spec, viewport, contentHash: 'delete-b' });

  const removed = (repo as any).deleteStandalonePreview('uip_delete');
  assert.deepEqual(removed, { previewId: 'uip_delete', deleted: true, deletedRevisions: 2 });
  assert.equal(repo.getPreview('uip_delete'), null);
  assert.equal(repo.countRevisions('uip_delete'), 0);

  seedTask('task-delete-linked');
  repo.createPreview({ id: 'uip_linked_delete', taskId: 'task-delete-linked', title: 'Keep me', html: '<main>linked</main>', css: '', js: '', spec, viewport, contentHash: 'linked-delete' });
  evidenceRepo.recordEvidence({ evidenceId: 'uie_keep', taskId: 'task-delete-linked', previewId: 'uip_linked_delete', frozenRevision: 1, frozenSpec: spec, screenshotArtifactId: 'shot-keep', screenshotWidth: 1440, screenshotHeight: 900 });

  assert.throws(
    () => (repo as any).deleteStandalonePreview('uip_linked_delete'),
    (error: any) => error?.code === 'UI_PREVIEW_DELETE_LINKED_CONFLICT',
  );
  assert.equal(repo.getPreview('uip_linked_delete')?.taskId, 'task-delete-linked');
  assert.equal(repo.countRevisions('uip_linked_delete'), 1);
  assert.equal(evidenceRepo.listEvidence('task-delete-linked', 'uip_linked_delete').length, 1);

  assert.throws(
    () => (repo as any).deleteStandalonePreview('uip_missing_delete'),
    (error: any) => error?.code === 'UI_PREVIEW_NOT_FOUND',
  );
});


test('canonical workspace hashing is stable for JSON key order and sensitive to workspace-visible changes', () => {
  const screens = [
    { screenId: 'overview', name: 'Overview', html: '<main>overview</main>', css: '', js: '', spec: { schemaVersion: 1 as const, summary: { screen: 'Overview', alpha: 'a', beta: 'b' } } },
    { screenId: 'details', name: 'Details', html: '<main>details</main>', css: '.x{}', js: '', spec: { schemaVersion: 1 as const, summary: { screen: 'Details' } } },
  ];
  const base = hashUiPreviewContent({ title: 'Workspace', screens, defaultScreenId: 'overview', viewport });
  const reorderedKeys = hashUiPreviewContent({
    title: 'Workspace',
    screens: [
      { ...screens[0], spec: { summary: { beta: 'b', alpha: 'a', screen: 'Overview' }, schemaVersion: 1 as const } },
      screens[1],
    ],
    defaultScreenId: 'overview',
    viewport,
  });
  assert.equal(base, reorderedKeys);
  assert.notEqual(base, hashUiPreviewContent({ title: 'Workspace', screens: [...screens].reverse(), defaultScreenId: 'overview', viewport }));
  assert.notEqual(base, hashUiPreviewContent({ title: 'Workspace', screens, defaultScreenId: 'details', viewport }));
  assert.notEqual(base, hashUiPreviewContent({ title: 'Workspace', screens: [{ ...screens[0], html: '<main>changed</main>' }, screens[1]], defaultScreenId: 'overview', viewport }));
});

test('canonical workspace revisions persist immutable design provenance and font snapshots while legacy revisions remain readable', () => {
  const screens = [{ screenId: 'main', name: 'Main', html: '<main>one</main>', css: '', js: '', spec }];
  const provenance = {
    schemaVersion: 1,
    scope: { kind: 'project', projectId: 'project-a' },
    repositoryRevision: 'repo-a',
    contextHash: 'a'.repeat(64),
    contextSchemaVersion: 1,
    gatePolicyVersion: 'ui-preview-design-gate.v1',
    sufficiency: 'sufficient',
    unknowns: [],
    sources: [{ path: 'src/styles/theme.css', startLine: 1, endLine: 20, trustClass: 'repo-evidence-untrusted', evidenceRole: 'project-foundation' }],
    findings: [],
    suppressedFindings: [],
    exceptionRefs: [],
    exceptionResults: [],
    renderAssets: [],
    fontRenderability: 'available',
    fontContentIdentities: [`sha256:${'b'.repeat(64)}`],
  } as any;
  const fontSnapshot = {
    contextHash: 'a'.repeat(64),
    fontRenderability: 'available',
    fonts: [{ assetId: 'font_inter', contentIdentity: `sha256:${'b'.repeat(64)}`, family: 'Inter', weight: 400, style: 'normal', mimeType: 'font/woff2', format: 'woff2', dataUri: 'data:font/woff2;base64,d09GMg==' }],
    unavailable: [],
  } as any;
  repo.createPreview({
    id: 'uip_provenance', taskId: null, title: 'Scoped', html: screens[0].html, css: '', js: '', spec,
    screens, defaultScreenId: 'main', viewport, contentHash: 'prov-a', scope: { kind: 'project', projectId: 'project-a' }, designProvenance: provenance, fontSnapshot,
  } as any);
  const rev1 = repo.getRevision('uip_provenance', 1) as any;
  assert.deepEqual(rev1.designProvenance, provenance);
  assert.deepEqual(rev1.scope, { kind: 'project', projectId: 'project-a' });
  assert.deepEqual(rev1.fontSnapshot, fontSnapshot);

  const provenance2 = { ...provenance, repositoryRevision: 'repo-b', contextHash: 'c'.repeat(64) };
  repo.appendRevision({
    previewId: 'uip_provenance', expectedRevision: 1, title: 'Scoped', html: '<main>two</main>', css: '', js: '', spec,
    screens: [{ ...screens[0], html: '<main>two</main>' }], defaultScreenId: 'main', viewport, contentHash: 'prov-b',
    scope: { kind: 'project', projectId: 'project-a' }, designProvenance: provenance2, fontSnapshot: { ...fontSnapshot, contextHash: 'c'.repeat(64) },
  } as any);
  assert.deepEqual((repo.getRevision('uip_provenance', 1) as any).designProvenance, provenance, 'historical provenance remains immutable');
  assert.equal((repo.getRevision('uip_provenance', 2) as any).designProvenance.contextHash, 'c'.repeat(64));

  repo.createPreview({ id: 'uip_legacy_prov', taskId: null, title: null, html: '<main>legacy</main>', css: '', js: '', spec, viewport, contentHash: 'legacy-prov' });
  const legacy = repo.getRevision('uip_legacy_prov', 1) as any;
  assert.equal(legacy.scope, undefined);
  assert.equal(legacy.designProvenance, undefined);
  assert.equal(legacy.fontSnapshot, undefined);
});

test('canonical workspace revisions persist and unchanged full replacements do not manufacture revisions', () => {
  const screens = [
    { screenId: 'overview', name: 'Overview', html: '<main>overview</main>', css: '', js: '', spec: { schemaVersion: 1 as const, summary: { screen: 'Overview' } } },
    { screenId: 'details', name: 'Details', html: '<main>details</main>', css: '', js: '', spec: { schemaVersion: 1 as const, summary: { screen: 'Details' } } },
  ];
  const contentHash = hashUiPreviewContent({ title: 'Workspace', screens, defaultScreenId: 'details', viewport });
  repo.createPreview({
    id: 'uip_workspace', taskId: null, title: 'Workspace',
    html: screens[1].html, css: screens[1].css, js: screens[1].js, spec: screens[1].spec,
    screens, defaultScreenId: 'details', viewport, contentHash,
  });
  const first = repo.getRevision('uip_workspace', 1)!;
  assert.equal(first.defaultScreenId, 'details');
  assert.deepEqual(first.screens, screens);
  assert.equal(first.html, '<main>details</main>');

  const changedScreens = [screens[0], { ...screens[1], html: '<main>details v2</main>' }];
  const changedHash = hashUiPreviewContent({ title: 'Workspace', screens: changedScreens, defaultScreenId: 'details', viewport });
  const changed = repo.appendRevision({
    previewId: 'uip_workspace', expectedRevision: 1, title: 'Workspace',
    html: changedScreens[1].html, css: changedScreens[1].css, js: changedScreens[1].js, spec: changedScreens[1].spec,
    screens: changedScreens, defaultScreenId: 'details', viewport, contentHash: changedHash,
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.revision.revision, 2);
  assert.equal(repo.countRevisions('uip_workspace'), 2);
  assert.equal(repo.getRevision('uip_workspace', 2)?.screens[1].html, '<main>details v2</main>');

  const duplicate = repo.appendRevision({
    previewId: 'uip_workspace', expectedRevision: 2, title: 'Workspace',
    html: changedScreens[1].html, css: changedScreens[1].css, js: changedScreens[1].js, spec: changedScreens[1].spec,
    screens: changedScreens, defaultScreenId: 'details', viewport, contentHash: changedHash,
  });
  assert.equal(duplicate.changed, false);
  assert.equal(repo.countRevisions('uip_workspace'), 2);
});

test('evidence for another preview remains current', () => {
  seedTask('task-a');
  for (const id of ['uip_one', 'uip_two']) repo.createPreview({ id, taskId: 'task-a', title: null, html: '<main>a</main>', css: '', js: '', spec, viewport, contentHash: `hash-${id}` });
  evidenceRepo.recordEvidence({ evidenceId: 'uie_one', taskId: 'task-a', previewId: 'uip_one', frozenRevision: 1, frozenSpec: spec, screenshotArtifactId: 'shot-1', screenshotWidth: 1440, screenshotHeight: 900 });
  evidenceRepo.recordEvidence({ evidenceId: 'uie_two', taskId: 'task-a', previewId: 'uip_two', frozenRevision: 1, frozenSpec: spec, screenshotArtifactId: 'shot-2', screenshotWidth: 1440, screenshotHeight: 900 });
  assert.equal(evidenceRepo.getCurrentEvidence('task-a', 'uip_one')?.evidenceId, 'uie_one');
  assert.equal(evidenceRepo.getCurrentEvidence('task-a', 'uip_two')?.evidenceId, 'uie_two');
});
