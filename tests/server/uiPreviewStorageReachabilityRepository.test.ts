import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openIsolatedDatabase } from '../../src/db/index.js';
import { createUiPreviewStorageReachabilityRepository } from '../../src/server/repositories/uiPreviewStorageReachabilityRepository.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-reachability-'));
const hash = (char: string) => char.repeat(64);

function createDatabase(name: string) {
  const filePath = path.join(tempRoot, `${name}.sqlite`);
  try { fs.rmSync(filePath, { force: true }); } catch {}
  const database = openIsolatedDatabase(filePath);
  database.exec(`
    CREATE TABLE ui_preview_revision_manifests (
      preview_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      html_object_hash TEXT NOT NULL,
      css_object_hash TEXT NOT NULL,
      js_object_hash TEXT NOT NULL,
      spec_object_hash TEXT NOT NULL
    );
    CREATE TABLE ui_preview_artifact_objects (
      artifact_id TEXT PRIMARY KEY,
      object_hash TEXT NOT NULL
    );
    CREATE TABLE task_ui_evidence (
      evidence_id TEXT PRIMARY KEY,
      screenshot_artifact_id TEXT,
      current INTEGER NOT NULL DEFAULT 0
    );
  `);
  return database;
}

function insertManifest(database: any, input: {
  previewId: string;
  revision: number;
  html: string;
  css: string;
  js: string;
  spec: string;
}) {
  database.prepare(`
    INSERT INTO ui_preview_revision_manifests (
      preview_id, revision, html_object_hash, css_object_hash, js_object_hash, spec_object_hash
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.previewId, input.revision, input.html, input.css, input.js, input.spec);
}

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

test('roots every retained manifest revision, deduplicates component reuse, and sorts hashes deterministically', () => {
  const database = createDatabase('manifests');
  try {
    insertManifest(database, {
      previewId: 'uip-history', revision: 1,
      html: hash('1'), css: hash('2'), js: hash('3'), spec: hash('4'),
    });
    insertManifest(database, {
      previewId: 'uip-history', revision: 2,
      html: hash('1'), css: hash('5'), js: hash('6'), spec: hash('7'),
    });
    insertManifest(database, {
      previewId: 'uip-other', revision: 1,
      html: hash('2'), css: hash('5'), js: hash('6'), spec: hash('7'),
    });

    const repository = createUiPreviewStorageReachabilityRepository(database as any);
    const result = repository.collectReachableObjectHashes();

    assert.deepEqual(result.objectHashes, [
      hash('1'), hash('2'), hash('3'), hash('4'), hash('5'), hash('6'), hash('7'),
    ]);
    assert.deepEqual(result.counts, { source: 7, screenshot: 0, total: 7 });
  } finally {
    database.close();
  }
});

test('roots screenshots only through retained task evidence, including superseded evidence history', () => {
  const database = createDatabase('evidence');
  try {
    database.prepare('INSERT INTO ui_preview_artifact_objects (artifact_id, object_hash) VALUES (?, ?)').run('artifact-old', hash('8'));
    database.prepare('INSERT INTO ui_preview_artifact_objects (artifact_id, object_hash) VALUES (?, ?)').run('artifact-current', hash('9'));
    database.prepare('INSERT INTO ui_preview_artifact_objects (artifact_id, object_hash) VALUES (?, ?)').run('artifact-unreferenced', hash('a'));

    database.prepare('INSERT INTO task_ui_evidence (evidence_id, screenshot_artifact_id, current) VALUES (?, ?, ?)').run('evidence-old', 'artifact-old', 0);
    database.prepare('INSERT INTO task_ui_evidence (evidence_id, screenshot_artifact_id, current) VALUES (?, ?, ?)').run('evidence-current', 'artifact-current', 1);
    database.prepare('INSERT INTO task_ui_evidence (evidence_id, screenshot_artifact_id, current) VALUES (?, ?, ?)').run('evidence-duplicate', 'artifact-old', 0);

    const repository = createUiPreviewStorageReachabilityRepository(database as any);
    const result = repository.collectReachableObjectHashes();

    assert.deepEqual(result.objectHashes, [hash('8'), hash('9')]);
    assert.deepEqual(result.counts, { source: 0, screenshot: 2, total: 2 });
  } finally {
    database.close();
  }
});

test('deduplicates a hash across source and screenshot categories while preserving category counts', () => {
  const database = createDatabase('cross-category');
  try {
    insertManifest(database, {
      previewId: 'uip-shared', revision: 1,
      html: hash('1'), css: hash('2'), js: hash('3'), spec: hash('4'),
    });
    database.prepare('INSERT INTO ui_preview_artifact_objects (artifact_id, object_hash) VALUES (?, ?)').run('artifact-shared', hash('1'));
    database.prepare('INSERT INTO task_ui_evidence (evidence_id, screenshot_artifact_id, current) VALUES (?, ?, 1)').run('evidence-shared', 'artifact-shared');

    const result = createUiPreviewStorageReachabilityRepository(database as any).collectReachableObjectHashes();
    assert.deepEqual(result.objectHashes, [hash('1'), hash('2'), hash('3'), hash('4')]);
    assert.deepEqual(result.counts, { source: 4, screenshot: 1, total: 4 });
  } finally {
    database.close();
  }
});

test('fails closed when any persisted reachable source or screenshot hash is invalid', async (t) => {
  await t.test('source manifest', () => {
    const database = createDatabase('invalid-source');
    try {
      insertManifest(database, {
        previewId: 'uip-invalid', revision: 1,
        html: 'NOT-A-HASH', css: hash('b'), js: hash('c'), spec: hash('d'),
      });
      assert.throws(
        () => createUiPreviewStorageReachabilityRepository(database as any).collectReachableObjectHashes(),
        (error: any) => error?.code === 'UI_PREVIEW_STORAGE_REACHABILITY_INVALID_HASH',
      );
    } finally {
      database.close();
    }
  });

  await t.test('referenced screenshot mapping', () => {
    const database = createDatabase('invalid-screenshot');
    try {
      database.prepare('INSERT INTO ui_preview_artifact_objects (artifact_id, object_hash) VALUES (?, ?)').run('artifact-invalid', '../escape');
      database.prepare('INSERT INTO task_ui_evidence (evidence_id, screenshot_artifact_id, current) VALUES (?, ?, 1)').run('evidence-invalid', 'artifact-invalid');
      assert.throws(
        () => createUiPreviewStorageReachabilityRepository(database as any).collectReachableObjectHashes(),
        (error: any) => error?.code === 'UI_PREVIEW_STORAGE_REACHABILITY_INVALID_HASH',
      );
    } finally {
      database.close();
    }
  });
});
