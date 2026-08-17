import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createUiPreviewStorageIntegrityService,
  type UiPreviewStorageIntegrityObject,
} from '../../src/server/services/uiPreviewStorageIntegrityService.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function hash(bytes: Uint8Array) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function object(bytes: Uint8Array, overrides: Partial<UiPreviewStorageIntegrityObject> = {}): UiPreviewStorageIntegrityObject {
  return {
    objectHash: hash(bytes),
    kind: 'source',
    codec: 'br',
    rawBytes: bytes.byteLength,
    storedBytes: Math.max(1, bytes.byteLength - 1),
    ...overrides,
  };
}

test('healthy metadata, manifests, artifacts, and physical bytes produce no issues', async () => {
  const sourceBytes = Buffer.from('<main>healthy</main>');
  const screenshotBytes = PNG;
  const source = object(sourceBytes);
  const screenshot = object(screenshotBytes, { kind: 'screenshot', codec: 'identity', storedBytes: screenshotBytes.byteLength });
  const physical = new Map([
    [source.objectHash, { bytes: sourceBytes, storedByteLength: source.storedBytes }],
    [screenshot.objectHash, { bytes: screenshotBytes, storedByteLength: screenshot.storedBytes }],
  ]);
  const service = createUiPreviewStorageIntegrityService({
    readObject: async (objectHash) => physical.get(objectHash) ?? null,
  });

  const result = await service.scan({
    objects: [source, screenshot],
    manifests: [{
      previewId: 'uip_healthy', revision: 1,
      htmlObjectHash: source.objectHash, cssObjectHash: source.objectHash,
      jsObjectHash: source.objectHash, specObjectHash: source.objectHash,
    }],
    artifacts: [{ artifactId: 'uisa_healthy', objectHash: screenshot.objectHash }],
  });

  assert.deepEqual(result.issues, []);
  assert.equal(result.summary.issueCount, 0);
  assert.equal(result.summary.scannedObjects, 2);
  assert.equal(result.summary.scannedManifests, 1);
  assert.equal(result.summary.scannedArtifacts, 1);
  assert.deepEqual(result.summary.truncated, { objects: false, manifests: false, artifacts: false });
});

test('validates canonical workspace manifests without misclassifying legacy manifests', async () => {
  const workspaceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    title: 'Workspace',
    screens: [
      { screenId: 'overview', name: 'Overview', html: '<main>one</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'Overview' } } },
      { screenId: 'details', name: 'Details', html: '<main>two</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'Details' } } },
    ],
    defaultScreenId: 'overview',
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  }));
  const workspace = object(workspaceBytes);
  const healthy = createUiPreviewStorageIntegrityService({
    readObject: async (objectHash) => objectHash === workspace.objectHash
      ? { bytes: workspaceBytes, storedByteLength: workspace.storedBytes }
      : null,
  });
  const healthyResult = await healthy.scan({
    objects: [workspace],
    manifests: [{ previewId: 'uip_workspace', revision: 1, workspaceObjectHash: workspace.objectHash }],
  });
  assert.deepEqual(healthyResult.issues, []);

  const malformedBytes = Buffer.from('{"schemaVersion":1}');
  const malformed = object(malformedBytes);
  const malformedResult = await createUiPreviewStorageIntegrityService({
    readObject: async () => ({ bytes: malformedBytes, storedByteLength: malformed.storedBytes }),
  }).scan({
    objects: [malformed],
    manifests: [{ previewId: 'uip_bad_workspace', revision: 2, workspaceObjectHash: malformed.objectHash }],
  });
  assert.ok(malformedResult.issues.some((issue) => issue.code === 'WORKSPACE_MANIFEST_INVALID'));

  const missingHash = 'f'.repeat(64);
  const missingResult = await healthy.scan({
    objects: [workspace],
    manifests: [{ previewId: 'uip_missing_workspace', revision: 3, workspaceObjectHash: missingHash }],
  });
  assert.ok(missingResult.issues.some((issue) => issue.code === 'WORKSPACE_MANIFEST_OBJECT_MISSING'));

  const wrongKind = { ...workspace, kind: 'screenshot' as const, codec: 'identity' as const, storedBytes: workspaceBytes.byteLength };
  const wrongKindResult = await createUiPreviewStorageIntegrityService({
    readObject: async () => ({ bytes: workspaceBytes, storedByteLength: workspaceBytes.byteLength }),
  }).scan({
    objects: [wrongKind],
    manifests: [{ previewId: 'uip_wrong_kind_workspace', revision: 4, workspaceObjectHash: wrongKind.objectHash }],
  });
  assert.ok(wrongKindResult.issues.some((issue) => issue.code === 'WORKSPACE_MANIFEST_WRONG_KIND'));
});

test('reports physical missing, hash, raw size, stored size, kind, codec, and PNG issues distinctly', async () => {
  const good = Buffer.from('good');
  const wrong = Buffer.from('wrong');
  const invalidPng = Buffer.from('not-a-png');
  const missing = object(Buffer.from('missing'));
  const hashMismatch = object(good);
  const rawSize = object(good, { objectHash: 'a'.repeat(64), rawBytes: 999 });
  const storedSize = object(good, { objectHash: 'b'.repeat(64), storedBytes: 999 });
  const badKind = object(good, { objectHash: 'c'.repeat(64), kind: 'other' as any });
  const badCodec = object(good, { objectHash: 'd'.repeat(64), codec: 'zip' as any });
  const badPng = object(invalidPng, { kind: 'screenshot', codec: 'identity' });
  const reads = new Map<string, { bytes: Uint8Array; storedByteLength?: number }>([
    [hashMismatch.objectHash, { bytes: wrong, storedByteLength: hashMismatch.storedBytes }],
    [rawSize.objectHash, { bytes: good, storedByteLength: rawSize.storedBytes }],
    [storedSize.objectHash, { bytes: good, storedByteLength: 1 }],
    [badKind.objectHash, { bytes: good, storedByteLength: badKind.storedBytes }],
    [badCodec.objectHash, { bytes: good, storedByteLength: badCodec.storedBytes }],
    [badPng.objectHash, { bytes: invalidPng, storedByteLength: badPng.storedBytes }],
  ]);
  const service = createUiPreviewStorageIntegrityService({ readObject: async (objectHash) => reads.get(objectHash) ?? null });

  const result = await service.scan({ objects: [missing, hashMismatch, rawSize, storedSize, badKind, badCodec, badPng] });
  const codes = new Set(result.issues.map((issue) => issue.code));

  for (const code of [
    'OBJECT_MISSING', 'OBJECT_HASH_MISMATCH', 'OBJECT_RAW_SIZE_MISMATCH', 'OBJECT_STORED_SIZE_MISMATCH',
    'OBJECT_INVALID_KIND', 'OBJECT_INVALID_CODEC', 'SCREENSHOT_INVALID_PNG',
  ]) assert.equal(codes.has(code as any), true, code);
});

test('reports dangling manifest components and bad artifact mappings', async () => {
  const sourceBytes = Buffer.from('source');
  const screenshotBytes = PNG;
  const source = object(sourceBytes);
  const screenshot = object(screenshotBytes, { kind: 'screenshot', codec: 'identity', storedBytes: screenshotBytes.byteLength });
  const missingHash = 'f'.repeat(64);
  const service = createUiPreviewStorageIntegrityService({
    readObject: async (objectHash) => objectHash === source.objectHash
      ? { bytes: sourceBytes, storedByteLength: source.storedBytes }
      : objectHash === screenshot.objectHash
        ? { bytes: screenshotBytes, storedByteLength: screenshot.storedBytes }
        : null,
  });

  const result = await service.scan({
    objects: [source, screenshot],
    manifests: [{
      previewId: 'uip_bad_manifest', revision: 2,
      htmlObjectHash: source.objectHash, cssObjectHash: missingHash,
      jsObjectHash: source.objectHash, specObjectHash: source.objectHash,
    }],
    artifacts: [
      { artifactId: 'uisa_missing', objectHash: missingHash },
      { artifactId: 'uisa_wrong_kind', objectHash: source.objectHash },
    ],
  });

  assert.ok(result.issues.some((issue) => issue.code === 'MANIFEST_OBJECT_MISSING' && issue.component === 'css'));
  assert.ok(result.issues.some((issue) => issue.code === 'ARTIFACT_OBJECT_MISSING' && issue.artifactId === 'uisa_missing'));
  assert.ok(result.issues.some((issue) => issue.code === 'ARTIFACT_WRONG_KIND' && issue.artifactId === 'uisa_wrong_kind'));
});

test('reports invalid/conflicting identities and bounds each input collection without mutation', async () => {
  const bytes = Buffer.from('identity');
  const base = object(bytes);
  const conflicting = { ...base, kind: 'screenshot' as const, codec: 'identity' as const };
  const invalidHash = { ...base, objectHash: '../not-a-hash' };
  let reads = 0;
  const service = createUiPreviewStorageIntegrityService({
    readObject: async () => { reads += 1; return { bytes, storedByteLength: base.storedBytes }; },
  });
  const objects = [base, conflicting, invalidHash, object(Buffer.from('extra'))];
  const frozen = JSON.stringify(objects);

  const result = await service.scan({ objects }, { maxObjects: 3, maxManifests: 0, maxArtifacts: 0 });

  assert.ok(result.issues.some((issue) => issue.code === 'OBJECT_IDENTITY_CONFLICT'));
  assert.ok(result.issues.some((issue) => issue.code === 'OBJECT_INVALID_HASH'));
  assert.equal(result.summary.scannedObjects, 3);
  assert.equal(result.summary.truncated.objects, true);
  assert.ok(reads <= 2, 'invalid/conflicting identities should not force extra physical reads');
  assert.equal(JSON.stringify(objects), frozen, 'scanner must not mutate caller inputs');
});
