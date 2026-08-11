import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openIsolatedDatabase } from '../../src/db/index.js';
import { DEVFLOW_MIGRATIONS } from '../../src/db/migrations/index.js';
import { runMigrations } from '../../src/db/migrations/runner.js';
import { UI_PREVIEW_STORAGE_V2_SCHEMA } from '../../src/db/uiPreviewStorageV2Schema.js';
import { createUiPreviewObjectMetadataRepository } from '../../src/server/repositories/uiPreviewObjectMetadataRepository.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-storage-v2-'));
const createdAt = '2026-08-11T00:00:00.000Z';
const htmlHash = 'a'.repeat(64);
const cssHash = 'b'.repeat(64);
const jsHash = 'c'.repeat(64);
const specHash = 'd'.repeat(64);
const screenshotHash = 'e'.repeat(64);
const otherScreenshotHash = 'f'.repeat(64);

function createDatabase(name: string) {
  const filePath = path.join(tempRoot, `${name}.sqlite`);
  try { fs.rmSync(filePath, { force: true }); } catch {}
  const database = openIsolatedDatabase(filePath);
  runMigrations(database, [...DEVFLOW_MIGRATIONS]);
  database.exec(UI_PREVIEW_STORAGE_V2_SCHEMA);
  return { database, filePath };
}

function seedRevision(database: any, previewId = 'uip_storage_v2', revision = 1) {
  database.prepare(`
    INSERT INTO ui_previews (id, task_id, latest_revision, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?)
  `).run(previewId, revision, createdAt, createdAt);
  database.prepare(`
    INSERT INTO ui_preview_revisions (
      preview_id, revision, title, html, css, js, spec_json, viewport_json, content_hash, created_at
    ) VALUES (?, ?, NULL, ?, '', '', ?, ?, ?, ?)
  `).run(previewId, revision, '<main>legacy revision</main>', '{"schemaVersion":1,"summary":{"screen":"Storage V2"}}', '{"width":800,"height":600,"deviceScaleFactor":1}', 'legacy-hash', createdAt);
}

function insertSourceObjects(repository: ReturnType<typeof createUiPreviewObjectMetadataRepository>) {
  for (const [objectHash, rawBytes] of [[htmlHash, 100], [cssHash, 20], [jsHash, 30], [specHash, 40]] as const) {
    repository.insertOrVerifyObjectMetadata({
      objectHash,
      kind: 'source',
      codec: 'br',
      rawBytes,
      storedBytes: Math.max(1, rawBytes - 5),
      createdAt,
    });
  }
}

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

test('standalone DDL applies after migration 016 and enforces lowercase 64-hex object hashes', () => {
  const { database } = createDatabase('ddl');
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'ui_preview_%'
      ORDER BY name
    `).all().map((row: any) => row.name);
    assert.ok(tables.includes('ui_preview_objects'));
    assert.ok(tables.includes('ui_preview_revision_manifests'));
    assert.ok(tables.includes('ui_preview_artifact_objects'));

    database.prepare(`
      INSERT INTO ui_preview_objects (object_hash, kind, codec, raw_bytes, stored_bytes, created_at)
      VALUES (?, 'source', 'identity', 1, 1, ?)
    `).run(htmlHash, createdAt);

    assert.throws(() => database.prepare(`
      INSERT INTO ui_preview_objects (object_hash, kind, codec, raw_bytes, stored_bytes, created_at)
      VALUES (?, 'source', 'identity', 1, 1, ?)
    `).run('A'.repeat(64), createdAt), /CHECK constraint failed/i);
  } finally {
    database.close();
  }
});

test('object metadata insertion is idempotent and rejects conflicting metadata for the same hash', () => {
  const { database } = createDatabase('object-meta');
  try {
    const repository = createUiPreviewObjectMetadataRepository(database as any);
    const first = repository.insertOrVerifyObjectMetadata({
      objectHash: htmlHash,
      kind: 'source',
      codec: 'br',
      rawBytes: 100,
      storedBytes: 80,
      createdAt,
    });
    const replay = repository.insertOrVerifyObjectMetadata({
      objectHash: htmlHash,
      kind: 'source',
      codec: 'br',
      rawBytes: 100,
      storedBytes: 80,
      createdAt,
    });
    assert.deepEqual(replay, first);
    assert.throws(() => repository.insertOrVerifyObjectMetadata({
      objectHash: htmlHash,
      kind: 'source',
      codec: 'identity',
      rawBytes: 100,
      storedBytes: 100,
      createdAt,
    }), (error: any) => error?.code === 'UI_PREVIEW_STORAGE_OBJECT_METADATA_CONFLICT');
  } finally {
    database.close();
  }
});

test('revision manifests replay identically, reject conflicts, and validate every component hash', () => {
  const { database } = createDatabase('manifest');
  try {
    seedRevision(database);
    const repository = createUiPreviewObjectMetadataRepository(database as any);
    insertSourceObjects(repository);

    const manifest = {
      previewId: 'uip_storage_v2',
      revision: 1,
      htmlObjectHash: htmlHash,
      cssObjectHash: cssHash,
      jsObjectHash: jsHash,
      specObjectHash: specHash,
      createdAt,
    };
    const first = repository.insertOrVerifyRevisionManifest(manifest);
    assert.deepEqual(repository.insertOrVerifyRevisionManifest(manifest), first);
    assert.deepEqual(repository.getRevisionManifest('uip_storage_v2', 1), first);

    assert.throws(() => repository.insertOrVerifyRevisionManifest({ ...manifest, specObjectHash: htmlHash }), (error: any) => (
      error?.code === 'UI_PREVIEW_STORAGE_MANIFEST_CONFLICT'
    ));

    assert.throws(() => database.prepare(`
      INSERT INTO ui_preview_revision_manifests (
        preview_id, revision, html_object_hash, css_object_hash, js_object_hash, spec_object_hash, created_at
      ) VALUES ('invalid-preview', 1, ?, ?, ?, ?, ?)
    `).run('G'.repeat(64), cssHash, jsHash, specHash, createdAt), /CHECK constraint failed/i);
  } finally {
    database.close();
  }
});

test('artifact mapping is immutable per logical artifact id and accepts screenshot objects only', () => {
  const { database } = createDatabase('artifact');
  try {
    const repository = createUiPreviewObjectMetadataRepository(database as any);
    repository.insertOrVerifyObjectMetadata({ objectHash: htmlHash, kind: 'source', codec: 'br', rawBytes: 10, storedBytes: 8, createdAt });
    repository.insertOrVerifyObjectMetadata({ objectHash: screenshotHash, kind: 'screenshot', codec: 'identity', rawBytes: 200, storedBytes: 200, createdAt });
    repository.insertOrVerifyObjectMetadata({ objectHash: otherScreenshotHash, kind: 'screenshot', codec: 'br', rawBytes: 200, storedBytes: 150, createdAt });

    assert.throws(() => repository.bindArtifactObject({ artifactId: 'legacy-artifact-source', objectHash: htmlHash, createdAt }), (error: any) => (
      error?.code === 'UI_PREVIEW_STORAGE_ARTIFACT_KIND_INVALID'
    ));

    const first = repository.bindArtifactObject({ artifactId: 'uisa_existing_123', objectHash: screenshotHash, createdAt });
    assert.deepEqual(repository.bindArtifactObject({ artifactId: 'uisa_existing_123', objectHash: screenshotHash, createdAt }), first);
    assert.deepEqual(repository.getArtifactObject('uisa_existing_123'), first);
    assert.throws(() => repository.bindArtifactObject({ artifactId: 'uisa_existing_123', objectHash: otherScreenshotHash, createdAt }), (error: any) => (
      error?.code === 'UI_PREVIEW_STORAGE_ARTIFACT_CONFLICT'
    ));
  } finally {
    database.close();
  }
});

test('metadata, manifests, and artifact mappings survive database close and reopen', () => {
  const { database, filePath } = createDatabase('reopen');
  seedRevision(database);
  const repository = createUiPreviewObjectMetadataRepository(database as any);
  insertSourceObjects(repository);
  repository.insertOrVerifyObjectMetadata({ objectHash: screenshotHash, kind: 'screenshot', codec: 'identity', rawBytes: 200, storedBytes: 200, createdAt });
  repository.insertOrVerifyRevisionManifest({
    previewId: 'uip_storage_v2', revision: 1,
    htmlObjectHash: htmlHash, cssObjectHash: cssHash, jsObjectHash: jsHash, specObjectHash: specHash,
    createdAt,
  });
  repository.bindArtifactObject({ artifactId: 'uisa_reopen', objectHash: screenshotHash, createdAt });
  database.close();

  const reopened = openIsolatedDatabase(filePath);
  try {
    const reopenedRepository = createUiPreviewObjectMetadataRepository(reopened as any);
    assert.equal(reopenedRepository.getObjectMetadata(htmlHash)?.codec, 'br');
    assert.equal(reopenedRepository.getRevisionManifest('uip_storage_v2', 1)?.specObjectHash, specHash);
    assert.equal(reopenedRepository.getArtifactObject('uisa_reopen')?.objectHash, screenshotHash);
  } finally {
    reopened.close();
  }
});
