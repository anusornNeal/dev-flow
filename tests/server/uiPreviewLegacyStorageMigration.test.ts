import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createUiPreviewLegacyStorageMigration,
  type LegacyUiPreviewRevisionRecord,
  type PreparedUiPreviewLegacyRevision,
} from '../../src/server/services/uiPreviewLegacyStorageMigration.js';

type Row = LegacyUiPreviewRevisionRecord & {
  html: string;
  css: string;
  js: string;
  spec: string;
};

type Manifest = {
  rowId: string;
  objectKeys: string[];
};

const encoder = new TextEncoder();

function row(id: string): Row {
  return {
    rowId: id,
    previewId: `uip_${id}`,
    revision: 1,
    html: `<main>${id}</main>`,
    css: `.${id}{display:block}`,
    js: `console.log('${id}')`,
    spec: `{"schemaVersion":1,"summary":{"screen":"${id}"}}`,
  };
}

function prepared(input: Row): PreparedUiPreviewLegacyRevision<Manifest> {
  const objectKeys = ['html', 'css', 'js', 'spec'].map((component) => `${input.rowId}/${component}`);
  return {
    objects: [
      { key: objectKeys[0], bytes: encoder.encode(input.html) },
      { key: objectKeys[1], bytes: encoder.encode(input.css) },
      { key: objectKeys[2], bytes: encoder.encode(input.js) },
      { key: objectKeys[3], bytes: encoder.encode(input.spec) },
    ],
    manifest: { rowId: input.rowId, objectKeys },
  };
}

function createHarness(rows: Row[]) {
  const objects = new Map<string, Uint8Array>();
  const manifests = new Map<string, Manifest>();
  const migrated = new Set<string>();
  const readableLegacy = new Set(rows.map((item) => item.rowId));
  const events: string[] = [];
  const manifestInsertCount = new Map<string, number>();
  const listCalls: Array<{ cursor: string | null; limit: number }> = [];
  let writeFailure: null | { key: string; persistFirst: boolean } = null;
  let manifestFailure: null | { rowId: string; persistFirst: boolean } = null;
  let verifyFailureRow: string | null = null;
  let markFailureRow: string | null = null;

  const migration = createUiPreviewLegacyStorageMigration<Row, Manifest>({
    listLegacyRevisions: async ({ cursor, limit }) => {
      listCalls.push({ cursor, limit });
      const start = cursor ? Number(cursor) : 0;
      const page = rows.slice(start, start + limit);
      const next = start + page.length;
      return {
        rows: page,
        nextCursor: next < rows.length ? String(next) : null,
      };
    },
    isRowMigrated: async (input) => migrated.has(input.rowId),
    prepareRevision: async (input) => {
      events.push(`prepare:${input.rowId}`);
      return prepared(input);
    },
    writeObject: async ({ row, object }) => {
      events.push(`write:${row.rowId}:${object.key}`);
      if (writeFailure?.key === object.key) {
        const failure = writeFailure;
        writeFailure = null;
        if (failure.persistFirst) objects.set(object.key, object.bytes);
        throw new Error(`write failed:${object.key}`);
      }
      objects.set(object.key, object.bytes);
    },
    findManifest: async (input) => manifests.get(input.rowId) ?? null,
    insertManifest: async ({ row: input, manifest }) => {
      events.push(`manifest:${input.rowId}`);
      manifestInsertCount.set(input.rowId, (manifestInsertCount.get(input.rowId) ?? 0) + 1);
      if (manifestFailure?.rowId === input.rowId) {
        const failure = manifestFailure;
        manifestFailure = null;
        if (failure.persistFirst) manifests.set(input.rowId, manifest);
        throw new Error(`manifest failed:${input.rowId}`);
      }
      assert.equal(manifests.has(input.rowId), false, 'logical manifest must not be inserted twice');
      manifests.set(input.rowId, manifest);
      return manifest;
    },
    verifyObjects: async ({ row: input, manifest }) => {
      events.push(`verify:${input.rowId}`);
      if (verifyFailureRow === input.rowId) {
        verifyFailureRow = null;
        throw new Error(`verify failed:${input.rowId}`);
      }
      for (const key of manifest.objectKeys) assert.equal(objects.has(key), true, `missing ${key}`);
    },
    markRowMigrated: async ({ row: input }) => {
      events.push(`mark:${input.rowId}`);
      if (markFailureRow === input.rowId) {
        markFailureRow = null;
        throw new Error(`mark failed:${input.rowId}`);
      }
      migrated.add(input.rowId);
      readableLegacy.delete(input.rowId);
    },
  });

  return {
    migration,
    objects,
    manifests,
    migrated,
    readableLegacy,
    events,
    manifestInsertCount,
    listCalls,
    failWrite(key: string, persistFirst = false) { writeFailure = { key, persistFirst }; },
    failManifest(rowId: string, persistFirst = false) { manifestFailure = { rowId, persistFirst }; },
    failVerify(rowId: string) { verifyFailureRow = rowId; },
    failMark(rowId: string) { markFailureRow = rowId; },
  };
}

test('writes exact prepared bytes, persists one manifest, verifies it, then clears legacy last', async () => {
  const source = row('r1');
  const harness = createHarness([source]);

  const result = await harness.migration.migrateBatch({ limit: 10 });

  assert.deepEqual(result, {
    scanned: 1,
    migrated: 1,
    replayed: 0,
    nextCursor: null,
    done: true,
  });
  const expected = prepared(source);
  for (const object of expected.objects) {
    assert.deepEqual(harness.objects.get(object.key), object.bytes);
  }
  assert.deepEqual(harness.events, [
    'prepare:r1',
    'write:r1:r1/html',
    'write:r1:r1/css',
    'write:r1:r1/js',
    'write:r1:r1/spec',
    'manifest:r1',
    'verify:r1',
    'mark:r1',
  ]);
  assert.equal(harness.readableLegacy.has('r1'), false);
});

test('object, manifest, verification, and final-mark failures preserve legacy and safely converge on retry', async (t) => {
  for (const scenario of ['object', 'manifest', 'verify', 'mark'] as const) {
    await t.test(scenario, async () => {
      const source = row(`retry-${scenario}`);
      const harness = createHarness([source]);
      if (scenario === 'object') harness.failWrite(`${source.rowId}/css`, true);
      if (scenario === 'manifest') harness.failManifest(source.rowId, true);
      if (scenario === 'verify') harness.failVerify(source.rowId);
      if (scenario === 'mark') harness.failMark(source.rowId);

      await assert.rejects(harness.migration.migrateBatch({ limit: 1 }));
      assert.equal(harness.readableLegacy.has(source.rowId), true, `${scenario} must leave legacy readable`);
      assert.equal(harness.migrated.has(source.rowId), false);

      const recovered = await harness.migration.migrateBatch({ limit: 1 });
      assert.equal(recovered.migrated, 1);
      assert.equal(harness.readableLegacy.has(source.rowId), false);
      assert.equal(harness.manifests.size, 1);
      assert.ok((harness.manifestInsertCount.get(source.rowId) ?? 0) <= 1 || scenario === 'manifest');
      if (scenario === 'manifest') {
        assert.equal(harness.manifestInsertCount.get(source.rowId), 1, 'persisted manifest must be discovered instead of inserted again');
      }
    });
  }
});

test('reprocessing an already migrated row is a replay with no storage or clearing side effects', async () => {
  const source = row('done');
  const harness = createHarness([source]);
  await harness.migration.migrateBatch({ limit: 1 });
  harness.events.length = 0;

  const replay = await harness.migration.migrateBatch({ limit: 1 });

  assert.deepEqual(replay, {
    scanned: 1,
    migrated: 0,
    replayed: 1,
    nextCursor: null,
    done: true,
  });
  assert.deepEqual(harness.events, []);
  assert.equal(harness.manifests.size, 1);
});

test('processes only the requested bounded batch and returns an opaque resumable cursor', async () => {
  const harness = createHarness([row('a'), row('b'), row('c')]);

  const first = await harness.migration.migrateBatch({ cursor: null, limit: 2 });
  assert.deepEqual(first, { scanned: 2, migrated: 2, replayed: 0, nextCursor: '2', done: false });
  assert.deepEqual(harness.listCalls, [{ cursor: null, limit: 2 }]);

  const second = await harness.migration.migrateBatch({ cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second, { scanned: 1, migrated: 1, replayed: 0, nextCursor: null, done: true });
  assert.deepEqual(harness.listCalls, [
    { cursor: null, limit: 2 },
    { cursor: '2', limit: 2 },
  ]);
});
