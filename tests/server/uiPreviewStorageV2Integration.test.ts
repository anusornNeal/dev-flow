import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openIsolatedDatabase } from '../../src/db/index.js';
import { DEVFLOW_MIGRATIONS } from '../../src/db/migrations/index.js';
import { runMigrations } from '../../src/db/migrations/runner.js';
import { createUiPreviewRepository } from '../../src/server/repositories/uiPreviewRepository.js';
import { createUiPreviewObjectMetadataRepository } from '../../src/server/repositories/uiPreviewObjectMetadataRepository.js';
import { createUiPreviewArtifactStore } from '../../src/server/services/uiPreviewArtifactStore.js';
import { createUiPreviewSourceObjectStore } from '../../src/server/services/uiPreviewSourceObjectStore.js';
import { createUiPreviewScreenshotCasStore } from '../../src/server/services/uiPreviewScreenshotCasStore.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-v2-integration-'));
const spec = { schemaVersion: 1 as const, summary: { screen: 'Storage V2' } };
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };

function createDatabase(name: string) {
  const database = openIsolatedDatabase(path.join(root, `${name}.sqlite`));
  runMigrations(database, [...DEVFLOW_MIGRATIONS]);
  return database;
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('new revisions persist source bodies in Brotli CAS and reconstruct through manifests', () => {
  const database = createDatabase('revision-cas');
  const sourceStore = createUiPreviewSourceObjectStore({ rootDir: path.join(root, 'source-objects') });
  const repository = createUiPreviewRepository({ database, sourceStore });
  try {
    repository.createPreview({
      id: 'uip_v2', taskId: null, title: 'One', html: '<main>Hello</main>', css: '', js: '',
      spec, viewport, contentHash: 'content-1',
    });
    repository.appendRevision({
      previewId: 'uip_v2', title: 'Two', html: '<main>Hello</main>', css: '', js: '',
      spec, viewport, contentHash: 'content-2',
    });

    const rows = database.prepare('SELECT revision, html, css, js, spec_json FROM ui_preview_revisions ORDER BY revision').all() as any[];
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.html, '');
      assert.equal(row.css, '');
      assert.equal(row.js, '');
      assert.equal(row.spec_json, '{}');
    }

    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM ui_preview_revision_manifests').get() as any).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM ui_preview_objects WHERE kind = 'source'").get() as any).count, 3);

    const reconstructed = repository.getRevision('uip_v2', 2)!;
    assert.equal(reconstructed.html, '<main>Hello</main>');
    assert.equal(reconstructed.css, '');
    assert.equal(reconstructed.js, '');
    assert.deepEqual(reconstructed.spec, spec);
  } finally {
    database.close();
  }
});

test('legacy revision migration is idempotent and clears bodies only after a manifest exists', () => {
  const database = createDatabase('legacy');
  const sourceStore = createUiPreviewSourceObjectStore({ rootDir: path.join(root, 'legacy-source-objects') });
  const repository = createUiPreviewRepository({ database, sourceStore });
  try {
    const createdAt = '2026-08-11T00:00:00.000Z';
    database.prepare('INSERT INTO ui_previews (id, task_id, latest_revision, created_at, updated_at) VALUES (?, NULL, 1, ?, ?)')
      .run('uip_legacy', createdAt, createdAt);
    database.prepare(`INSERT INTO ui_preview_revisions
      (preview_id, revision, title, html, css, js, spec_json, viewport_json, content_hash, created_at)
      VALUES (?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`)
      .run('uip_legacy', '<main>Legacy</main>', 'body{}', 'console.log(1)', JSON.stringify(spec), JSON.stringify(viewport), 'legacy-hash', createdAt);

    assert.deepEqual(repository.migrateLegacyRevisions(), { scanned: 1, migrated: 1 });
    assert.deepEqual(repository.migrateLegacyRevisions(), { scanned: 0, migrated: 0 });
    const stored = database.prepare('SELECT html, css, js, spec_json FROM ui_preview_revisions WHERE preview_id = ?').get('uip_legacy') as any;
    assert.deepEqual(stored, { html: '', css: '', js: '', spec_json: '{}' });
    assert.equal(repository.getRevision('uip_legacy', 1)?.html, '<main>Legacy</main>');
  } finally {
    database.close();
  }
});

test('public artifact ids remain stable while identical PNG bytes dedupe physically', async () => {
  const database = createDatabase('screenshot-cas');
  const metadataRepository = createUiPreviewObjectMetadataRepository(database);
  const casStore = createUiPreviewScreenshotCasStore({ rootDir: path.join(root, 'screenshot-objects') });
  const artifactStore = createUiPreviewArtifactStore({
    rootDir: path.join(root, 'legacy-artifacts'),
    casStore,
    metadataRepository,
  });
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('same-png')]);
    const first = await artifactStore.writePng(png);
    const second = await artifactStore.writePng(png);
    assert.notEqual(first.artifactId, second.artifactId);
    assert.equal(first.absolutePath, second.absolutePath);
    assert.equal(artifactStore.resolveArtifactPath(first.artifactId), first.absolutePath);
    assert.equal(artifactStore.resolveArtifactPath(second.artifactId), first.absolutePath);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM ui_preview_objects WHERE kind = 'screenshot'").get() as any).count, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM ui_preview_artifact_objects').get() as any).count, 2);
  } finally {
    database.close();
  }
});
