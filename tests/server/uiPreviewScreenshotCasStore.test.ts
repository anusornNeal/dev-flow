import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const storeModule = await import('../../src/server/services/uiPreviewScreenshotCasStore.js');
const { createUiPreviewScreenshotCasStore } = storeModule;

const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8]);

function sha256(bytes: Uint8Array) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-screenshot-cas-'));
}

function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursive(absolutePath) : [absolutePath];
  });
}

test('hashes exact PNG bytes into deterministic content-addressed paths and reads them back', async () => {
  const root = makeRoot();
  try {
    const store = createUiPreviewScreenshotCasStore({ rootDir: root });
    const expectedHash = sha256(PNG_A);
    const saved = await store.writePng(PNG_A);
    const expectedPath = path.join(path.resolve(root), 'screenshot', expectedHash.slice(0, 2), `${expectedHash}.png`);

    assert.equal(saved.objectHash, expectedHash);
    assert.equal(saved.absolutePath, expectedPath);
    assert.equal(saved.byteLength, PNG_A.byteLength);
    assert.deepEqual(fs.readFileSync(expectedPath), PNG_A);
    assert.equal(store.resolveObjectPath(expectedHash), expectedPath);
    assert.deepEqual(await store.readPng(expectedHash), PNG_A);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deduplicates repeated and concurrent identical writes while separating different PNG bytes', async () => {
  const root = makeRoot();
  try {
    const store = createUiPreviewScreenshotCasStore({ rootDir: root });
    const repeated = await Promise.all(Array.from({ length: 16 }, () => store.writePng(PNG_A)));
    const other = await store.writePng(PNG_B);

    assert.equal(new Set(repeated.map((item) => item.objectHash)).size, 1);
    assert.equal(new Set(repeated.map((item) => item.absolutePath)).size, 1);
    assert.notEqual(other.objectHash, repeated[0].objectHash);
    assert.notEqual(other.absolutePath, repeated[0].absolutePath);

    const pngFiles = listFilesRecursive(root).filter((filePath) => filePath.endsWith('.png'));
    assert.equal(pngFiles.length, 2);
    assert.equal(listFilesRecursive(root).some((filePath) => filePath.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects non-PNG input before creating a stored object', async () => {
  const root = makeRoot();
  try {
    const store = createUiPreviewScreenshotCasStore({ rootDir: root });
    await assert.rejects(store.writePng(Buffer.from('not-a-png')), /png/i);
    assert.deepEqual(listFilesRecursive(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects invalid object hashes and never resolves paths outside the screenshot CAS root', () => {
  const root = makeRoot();
  try {
    const store = createUiPreviewScreenshotCasStore({ rootDir: root });
    for (const invalidHash of ['../outside', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'zz'.repeat(32), 'uisa_1234']) {
      assert.throws(() => store.resolveObjectPath(invalidHash), /invalid.*hash/i, invalidHash);
    }

    const validHash = 'a'.repeat(64);
    const resolved = store.resolveObjectPath(validHash);
    const screenshotRoot = path.join(path.resolve(root), 'screenshot');
    assert.equal(path.relative(screenshotRoot, resolved).startsWith('..'), false);
    assert.equal(path.isAbsolute(path.relative(screenshotRoot, resolved)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleans temporary partial writes when finalization fails', async () => {
  const root = makeRoot();
  const originalRename = fs.promises.rename;
  try {
    const store = createUiPreviewScreenshotCasStore({ rootDir: root });
    fs.promises.rename = (async () => {
      const error = new Error('simulated rename failure') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }) as typeof fs.promises.rename;

    await assert.rejects(store.writePng(PNG_A), /simulated rename failure/);
    const files = listFilesRecursive(root);
    assert.equal(files.some((filePath) => filePath.endsWith('.tmp')), false);
    assert.equal(files.some((filePath) => filePath.endsWith('.png')), false);
  } finally {
    fs.promises.rename = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
