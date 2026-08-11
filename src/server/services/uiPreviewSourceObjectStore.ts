import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, type BrotliOptions } from 'node:zlib';
import { getDevFlowDataDir } from '../../lib/devFlowPaths.js';

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);
const OBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface UiPreviewSourceObjectRecord {
  objectHash: string;
  absolutePath: string;
  rawByteLength: number;
  storedByteLength: number;
  reused: boolean;
}

export interface UiPreviewSourceObjectReadResult {
  objectHash: string;
  absolutePath: string;
  bytes: Buffer;
  rawByteLength: number;
  storedByteLength: number;
}

export interface UiPreviewSourceObjectStore {
  rootDir: string;
  write(raw: string | Uint8Array): Promise<UiPreviewSourceObjectRecord>;
  read(objectHash: string): Promise<UiPreviewSourceObjectReadResult>;
  resolveObjectPath(objectHash: string): string;
}

export interface UiPreviewSourceObjectStoreOptions {
  rootDir?: string;
  maxRawBytes?: number;
  maxStoredBytes?: number;
  brotliOptions?: BrotliOptions;
}

function normalizeLimit(value: number | undefined, label: string) {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`UI preview source object ${label} limit must be a non-negative safe integer.`);
  }
  return value;
}

function assertWithinLimit(size: number, limit: number, label: 'raw' | 'stored') {
  if (size > limit) {
    throw new Error(`UI preview source object ${label} size ${size} exceeds configured ${label} limit of ${limit} bytes.`);
  }
}

function hashRawBytes(bytes: Uint8Array) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function asRawBytes(input: string | Uint8Array) {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
}

async function existingSize(absolutePath: string) {
  try {
    return (await fs.promises.stat(absolutePath)).size;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function createUiPreviewSourceObjectStore(
  options: UiPreviewSourceObjectStoreOptions = {},
): UiPreviewSourceObjectStore {
  const rootDir = path.resolve(options.rootDir ?? path.join(getDevFlowDataDir(), 'ui-preview-objects', 'source'));
  const maxRawBytes = normalizeLimit(options.maxRawBytes, 'raw');
  const maxStoredBytes = normalizeLimit(options.maxStoredBytes, 'stored');
  const brotliOptions = options.brotliOptions;

  function resolveObjectPath(objectHash: string) {
    if (!OBJECT_HASH_PATTERN.test(objectHash)) {
      throw new Error('Invalid UI preview source object hash. Expected lowercase SHA-256 hex.');
    }
    return path.join(rootDir, objectHash.slice(0, 2), `${objectHash}.br`);
  }

  async function write(input: string | Uint8Array): Promise<UiPreviewSourceObjectRecord> {
    const raw = asRawBytes(input);
    assertWithinLimit(raw.byteLength, maxRawBytes, 'raw');

    const objectHash = hashRawBytes(raw);
    const absolutePath = resolveObjectPath(objectHash);
    const priorSize = await existingSize(absolutePath);
    if (priorSize !== null) {
      assertWithinLimit(priorSize, maxStoredBytes, 'stored');
      return {
        objectHash,
        absolutePath,
        rawByteLength: raw.byteLength,
        storedByteLength: priorSize,
        reused: true,
      };
    }

    const compressed = Buffer.from(await brotliCompressAsync(raw, brotliOptions));
    assertWithinLimit(compressed.byteLength, maxStoredBytes, 'stored');

    const objectDir = path.dirname(absolutePath);
    await fs.promises.mkdir(objectDir, { recursive: true });

    const racedSize = await existingSize(absolutePath);
    if (racedSize !== null) {
      assertWithinLimit(racedSize, maxStoredBytes, 'stored');
      return {
        objectHash,
        absolutePath,
        rawByteLength: raw.byteLength,
        storedByteLength: racedSize,
        reused: true,
      };
    }

    const tempPath = path.join(
      objectDir,
      `${objectHash}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    );
    let reused = false;

    try {
      await fs.promises.writeFile(tempPath, compressed, { flag: 'wx' });
      try {
        await fs.promises.rename(tempPath, absolutePath);
      } catch (error) {
        const finalSize = await existingSize(absolutePath);
        if (finalSize === null) throw error;
        assertWithinLimit(finalSize, maxStoredBytes, 'stored');
        reused = true;
      }
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }

    const storedByteLength = await existingSize(absolutePath);
    if (storedByteLength === null) {
      throw new Error('UI preview source object atomic write completed without a final object.');
    }
    assertWithinLimit(storedByteLength, maxStoredBytes, 'stored');

    return {
      objectHash,
      absolutePath,
      rawByteLength: raw.byteLength,
      storedByteLength,
      reused,
    };
  }

  async function read(objectHash: string): Promise<UiPreviewSourceObjectReadResult> {
    const absolutePath = resolveObjectPath(objectHash);
    const stat = await fs.promises.stat(absolutePath);
    assertWithinLimit(stat.size, maxStoredBytes, 'stored');

    const stored = await fs.promises.readFile(absolutePath);
    assertWithinLimit(stored.byteLength, maxStoredBytes, 'stored');

    const raw = Buffer.from(await brotliDecompressAsync(stored));
    assertWithinLimit(raw.byteLength, maxRawBytes, 'raw');

    const actualHash = hashRawBytes(raw);
    if (actualHash !== objectHash) {
      throw new Error(`UI preview source object integrity hash mismatch for ${objectHash}.`);
    }

    return {
      objectHash,
      absolutePath,
      bytes: raw,
      rawByteLength: raw.byteLength,
      storedByteLength: stored.byteLength,
    };
  }

  return { rootDir, write, read, resolveObjectPath };
}
