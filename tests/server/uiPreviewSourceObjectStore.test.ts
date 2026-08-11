import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { createUiPreviewSourceObjectStore } from '../../src/server/services/uiPreviewSourceObjectStore.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-source-cas-'));
}

function sha256(bytes: Uint8Array) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('deduplicates exact raw bytes and hashes before Brotli compression', async (t) => {
  const rootDir = tempRoot();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createUiPreviewSourceObjectStore({ rootDir });
  const raw = Buffer.from('<main>same content</main>', 'utf8');

  const first = await store.write(raw);
  const second = await store.write(raw);

  assert.equal(first.objectHash, sha256(raw));
  assert.equal(second.objectHash, first.objectHash);
  assert.equal(first.absolutePath, second.absolutePath);
  assert.equal(first.rawByteLength, raw.byteLength);
  assert.ok(first.storedByteLength > 0);
  assert.equal(second.rawByteLength, raw.byteLength);
  assert.equal(fs.readdirSync(path.dirname(first.absolutePath)).filter((name) => name.endsWith('.br')).length, 1);
  assert.equal(path.basename(first.absolutePath), `${first.objectHash}.br`);
  assert.equal(path.basename(path.dirname(first.absolutePath)), first.objectHash.slice(0, 2));
});

test('different raw bytes get different objects and Unicode round-trips byte-for-byte', async (t) => {
  const rootDir = tempRoot();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createUiPreviewSourceObjectStore({ rootDir });
  const thai = Buffer.from('สวัสดี 🌏\nline two', 'utf8');
  const different = Buffer.from('สวัสดี 🌏\nline three', 'utf8');

  const a = await store.write(thai);
  const b = await store.write(different);
  const read = await store.read(a.objectHash);

  assert.notEqual(a.objectHash, b.objectHash);
  assert.deepEqual(read.bytes, thai);
  assert.equal(read.objectHash, a.objectHash);
  assert.equal(read.rawByteLength, thai.byteLength);
  assert.equal(read.storedByteLength, fs.statSync(a.absolutePath).size);
});

test('concurrent duplicate writers converge on one final object and clean temp files', async (t) => {
  const rootDir = tempRoot();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createUiPreviewSourceObjectStore({ rootDir });
  const raw = Buffer.from('x'.repeat(64 * 1024), 'utf8');

  const results = await Promise.all(Array.from({ length: 12 }, () => store.write(raw)));
  const hashes = new Set(results.map((result) => result.objectHash));
  const paths = new Set(results.map((result) => result.absolutePath));

  assert.equal(hashes.size, 1);
  assert.equal(paths.size, 1);
  const objectPath = results[0].absolutePath;
  assert.equal(fs.readdirSync(path.dirname(objectPath)).filter((name) => name.endsWith('.br')).length, 1);
  const leftovers = fs.readdirSync(path.dirname(objectPath)).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.deepEqual((await store.read(results[0].objectHash)).bytes, raw);
});

test('rejects invalid hashes without allowing path traversal', async (t) => {
  const rootDir = tempRoot();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createUiPreviewSourceObjectStore({ rootDir });

  for (const invalid of ['../outside', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}/x`, '']) {
    assert.throws(() => store.resolveObjectPath(invalid), /invalid.*hash/i);
    await assert.rejects(() => store.read(invalid), /invalid.*hash/i);
  }
});

test('enforces caller-configurable raw and stored byte bounds', async (t) => {
  const rootDir = tempRoot();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const tinyRawStore = createUiPreviewSourceObjectStore({ rootDir: path.join(rootDir, 'raw'), maxRawBytes: 4 });
  await assert.rejects(() => tinyRawStore.write(Buffer.from('12345')), /raw.*size|raw.*limit/i);

  const tinyStoredStore = createUiPreviewSourceObjectStore({ rootDir: path.join(rootDir, 'stored'), maxStoredBytes: 1 });
  await assert.rejects(() => tinyStoredStore.write(Buffer.from('content that cannot fit in one stored byte')), /stored.*size|stored.*limit/i);

  const readRoot = path.join(rootDir, 'read');
  const writer = createUiPreviewSourceObjectStore({ rootDir: readRoot });
  const record = await writer.write(Buffer.from('read bound payload'));
  const boundedReader = createUiPreviewSourceObjectStore({ rootDir: readRoot, maxStoredBytes: 1 });
  await assert.rejects(() => boundedReader.read(record.objectHash), /stored.*size|stored.*limit/i);
});

test('fails closed on corrupt or hash-mismatched stored objects', async (t) => {
  const rootDir = tempRoot();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createUiPreviewSourceObjectStore({ rootDir });
  const original = Buffer.from('original source bytes');
  const record = await store.write(original);

  fs.writeFileSync(record.absolutePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  await assert.rejects(() => store.read(record.objectHash));

  const other = Buffer.from('different but valid Brotli payload');
  fs.writeFileSync(record.absolutePath, brotliCompressSync(other));
  await assert.rejects(() => store.read(record.objectHash), /hash.*mismatch|integrity/i);
});
