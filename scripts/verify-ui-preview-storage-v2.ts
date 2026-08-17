import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openIsolatedDatabase } from '../src/db/index.js';
import { DEVFLOW_MIGRATIONS } from '../src/db/migrations/index.js';
import { runMigrations } from '../src/db/migrations/runner.js';
import { createUiPreviewRepository } from '../src/server/repositories/uiPreviewRepository.js';
import { createUiPreviewObjectMetadataRepository } from '../src/server/repositories/uiPreviewObjectMetadataRepository.js';
import { createUiPreviewStorageReachabilityRepository } from '../src/server/repositories/uiPreviewStorageReachabilityRepository.js';
import { createUiPreviewArtifactStore } from '../src/server/services/uiPreviewArtifactStore.js';
import { runUiPreviewObjectGc } from '../src/server/services/uiPreviewObjectGcService.js';
import { createUiPreviewScreenshotCasStore } from '../src/server/services/uiPreviewScreenshotCasStore.js';
import { createUiPreviewSourceObjectStore } from '../src/server/services/uiPreviewSourceObjectStore.js';
import { createUiPreviewStorageIntegrityService } from '../src/server/services/uiPreviewStorageIntegrityService.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-storage-v2-'));
const dbPath = path.join(root, 'storage-v2.sqlite');
const sourceStore = createUiPreviewSourceObjectStore({ rootDir: path.join(root, 'objects', 'source') });
const screenshotStore = createUiPreviewScreenshotCasStore({ rootDir: path.join(root, 'objects') });
const spec = { schemaVersion: 1 as const, summary: { screen: 'Storage V2 verifier' } };
const viewport = { width: 1024, height: 768, deviceScaleFactor: 1 };

function openDatabase() {
  const database = openIsolatedDatabase(dbPath);
  runMigrations(database, [...DEVFLOW_MIGRATIONS]);
  return database;
}

let database = openDatabase();
try {
  let repository = createUiPreviewRepository({ database, sourceStore });
  repository.createPreview({
    id: 'uip_storage_v2_verify',
    taskId: null,
    title: 'Revision one',
    html: '<main>one</main>',
    css: 'main{display:block}',
    js: '',
    spec,
    viewport,
    contentHash: 'storage-v2-one',
  });
  repository.appendRevision({
    previewId: 'uip_storage_v2_verify',
    expectedRevision: 1,
    title: 'Revision two',
    html: '<main>two</main>',
    css: 'main{display:block}',
    js: '',
    spec,
    viewport,
    contentHash: 'storage-v2-two',
  });

  const workspaceScreens = [
    { screenId: 'overview', name: 'Overview', html: '<main>workspace overview</main>', css: '', js: '', spec: { schemaVersion: 1 as const, summary: { screen: 'Overview' } } },
    { screenId: 'details', name: 'Details', html: '<main>workspace details</main>', css: '.details{}', js: '', spec: { schemaVersion: 1 as const, summary: { screen: 'Details' } } },
  ];
  repository.createPreview({
    id: 'uip_storage_workspace_verify', taskId: null, title: 'Workspace verifier',
    html: workspaceScreens[0].html, css: workspaceScreens[0].css, js: workspaceScreens[0].js, spec: workspaceScreens[0].spec,
    screens: workspaceScreens, defaultScreenId: 'overview', viewport, contentHash: 'storage-workspace-one',
  });
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM ui_preview_workspace_revision_manifests WHERE preview_id = ?').get('uip_storage_workspace_verify') as any).count, 1);

  const legacyCreatedAt = '2026-01-01T00:00:00.000Z';
  database.prepare('INSERT INTO ui_previews (id, task_id, latest_revision, created_at, updated_at) VALUES (?, NULL, 1, ?, ?)')
    .run('uip_storage_v2_legacy', legacyCreatedAt, legacyCreatedAt);
  database.prepare(`INSERT INTO ui_preview_revisions
    (preview_id, revision, title, html, css, js, spec_json, viewport_json, content_hash, created_at)
    VALUES (?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'uip_storage_v2_legacy',
      '<main>legacy</main>',
      'body{margin:0}',
      '',
      JSON.stringify(spec),
      JSON.stringify(viewport),
      'storage-v2-legacy',
      legacyCreatedAt,
    );
  assert.deepEqual(repository.migrateLegacyRevisions(), { scanned: 1, migrated: 1 });
  assert.deepEqual(repository.migrateLegacyRevisions(), { scanned: 0, migrated: 0 });
  assert.equal(repository.getRevision('uip_storage_v2_legacy', 1)?.html, '<main>legacy</main>');

  database.close();
  database = openDatabase();
  repository = createUiPreviewRepository({ database, sourceStore });
  assert.equal(repository.getRevision('uip_storage_v2_verify', 1)?.html, '<main>one</main>');
  assert.equal(repository.getRevision('uip_storage_v2_verify', 2)?.html, '<main>two</main>');
  assert.deepEqual(repository.getRevision('uip_storage_v2_verify', 2)?.spec, spec);
  const reopenedWorkspace = repository.getRevision('uip_storage_workspace_verify', 1)!;
  assert.equal(reopenedWorkspace.defaultScreenId, 'overview');
  assert.deepEqual(reopenedWorkspace.screens, workspaceScreens);
  const workspaceManifest = database.prepare('SELECT workspace_object_hash FROM ui_preview_workspace_revision_manifests WHERE preview_id = ? AND revision = 1').get('uip_storage_workspace_verify') as any;
  assert.ok(workspaceManifest?.workspace_object_hash);


  const metadataRepository = createUiPreviewObjectMetadataRepository(database);
  const artifactStore = createUiPreviewArtifactStore({
    rootDir: path.join(root, 'legacy-artifacts'),
    casStore: screenshotStore,
    metadataRepository,
  });
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('storage-v2-screenshot'),
  ]);
  const screenshot = await artifactStore.writePng(png);
  const screenshotMapping = metadataRepository.getArtifactObject(screenshot.artifactId)!;
  assert.ok(screenshotMapping);
  assert.equal(artifactStore.resolveArtifactPath(screenshot.artifactId), screenshot.absolutePath);

  database.prepare('INSERT OR IGNORE INTO tasks (id, title, status) VALUES (?, ?, ?)')
    .run('task_storage_v2_verify', 'Storage V2 verifier', 'todo');
  repository.bindPreviewToTask('uip_storage_v2_verify', 'task_storage_v2_verify');
  database.prepare(`INSERT INTO task_ui_evidence
    (evidence_id, task_id, preview_id, frozen_revision, frozen_spec_json, screenshot_artifact_id,
     screenshot_width, screenshot_height, screenshot_sha256, is_current, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(
      'uie_storage_v2_verify',
      'task_storage_v2_verify',
      'uip_storage_v2_verify',
      2,
      JSON.stringify(spec),
      screenshot.artifactId,
      viewport.width,
      viewport.height,
      screenshotMapping.objectHash,
      '2026-08-11T00:00:00.000Z',
    );

  const orphan = await sourceStore.write('orphan-storage-v2-object');
  metadataRepository.insertOrVerifyObjectMetadata({
    objectHash: orphan.objectHash,
    kind: 'source',
    codec: 'br',
    rawBytes: orphan.rawByteLength,
    storedBytes: orphan.storedByteLength,
  });
  database.prepare('UPDATE ui_preview_objects SET created_at = ? WHERE object_hash = ?')
    .run('2000-01-01T00:00:00.000Z', orphan.objectHash);

  const reachability = createUiPreviewStorageReachabilityRepository(database).collectReachableObjectHashes();
  assert.ok(reachability.objectHashes.includes(screenshotMapping.objectHash));
  assert.ok(reachability.objectHashes.includes(String(workspaceManifest.workspace_object_hash)));
  assert.ok(!reachability.objectHashes.includes(orphan.objectHash));

  const objectRows = database.prepare(`
    SELECT object_hash, kind, codec, raw_bytes, stored_bytes, created_at
    FROM ui_preview_objects ORDER BY object_hash
  `).all() as any[];
  const inventory = objectRows.map((row) => ({
    objectHash: String(row.object_hash),
    createdAt: String(row.created_at),
    rawBytes: Number(row.raw_bytes),
    storedBytes: Number(row.stored_bytes),
  }));
  const gc = await runUiPreviewObjectGc({
    roots: reachability.objectHashes,
    inventory,
    now: () => '2026-08-11T12:00:00.000Z',
    gracePeriodMs: 24 * 60 * 60 * 1000,
    apply: false,
  });
  assert.deepEqual(gc.plan.deletable, [orphan.objectHash]);
  assert.ok(!gc.plan.deletable.includes(screenshotMapping.objectHash));

  const objects = objectRows.map((row) => ({
    objectHash: String(row.object_hash),
    kind: row.kind,
    codec: row.codec,
    rawBytes: Number(row.raw_bytes),
    storedBytes: Number(row.stored_bytes),
  }));
  const legacyManifests = (database.prepare(`
    SELECT preview_id, revision, html_object_hash, css_object_hash, js_object_hash, spec_object_hash
    FROM ui_preview_revision_manifests ORDER BY preview_id, revision
  `).all() as any[]).map((row) => ({
    previewId: String(row.preview_id),
    revision: Number(row.revision),
    htmlObjectHash: String(row.html_object_hash),
    cssObjectHash: String(row.css_object_hash),
    jsObjectHash: String(row.js_object_hash),
    specObjectHash: String(row.spec_object_hash),
  }));
  const workspaceManifests = (database.prepare(`
    SELECT preview_id, revision, workspace_object_hash
    FROM ui_preview_workspace_revision_manifests ORDER BY preview_id, revision
  `).all() as any[]).map((row) => ({
    previewId: String(row.preview_id),
    revision: Number(row.revision),
    workspaceObjectHash: String(row.workspace_object_hash),
  }));
  const manifests = [...legacyManifests, ...workspaceManifests];
  const artifacts = (database.prepare('SELECT artifact_id, object_hash FROM ui_preview_artifact_objects').all() as any[])
    .map((row) => ({ artifactId: String(row.artifact_id), objectHash: String(row.object_hash) }));

  async function readPhysical(objectHash: string, metadata: any) {
    try {
      if (metadata.kind === 'screenshot') {
        const bytes = await screenshotStore.readPng(objectHash);
        return { bytes, storedByteLength: bytes.byteLength };
      }
      const source = await sourceStore.read(objectHash);
      return { bytes: source.bytes, storedByteLength: source.storedByteLength };
    } catch {
      return null;
    }
  }

  const integrity = createUiPreviewStorageIntegrityService({ readObject: readPhysical });
  const cleanScan = await integrity.scan({ objects, manifests, artifacts });
  assert.equal(cleanScan.summary.issueCount, 0);

  const firstSourceHash = legacyManifests[0].htmlObjectHash;
  const corruptScan = await createUiPreviewStorageIntegrityService({
    readObject: async (objectHash, metadata) => {
      const physical = await readPhysical(objectHash, metadata);
      if (!physical || objectHash !== firstSourceHash) return physical;
      const corrupted = Buffer.from(physical.bytes);
      corrupted[0] = corrupted[0] ^ 0xff;
      return { ...physical, bytes: corrupted };
    },
  }).scan({ objects, manifests, artifacts });
  assert.ok(corruptScan.issues.some((issue) => issue.code === 'OBJECT_HASH_MISMATCH'));

  console.log(JSON.stringify({
    ok: true,
    sourceObjectCount: objects.filter((item) => item.kind === 'source').length,
    screenshotObjectCount: objects.filter((item) => item.kind === 'screenshot').length,
    manifestCount: manifests.length,
    reachableObjectCount: reachability.counts.total,
    gcDeletableCount: gc.plan.deletable.length,
    cleanIntegrityIssues: cleanScan.summary.issueCount,
    corruptionDetected: true,
  }));
} finally {
  try { database.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
