import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDevFlowDataDir } from '../../lib/devFlowPaths.js';

const OBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface UiPreviewScreenshotObjectRecord {
  objectHash: string;
  absolutePath: string;
  byteLength: number;
}

export interface UiPreviewScreenshotCasStore {
  rootDir: string;
  screenshotRootDir: string;
  writePng(bytes: Uint8Array): Promise<UiPreviewScreenshotObjectRecord>;
  resolveObjectPath(objectHash: string): string;
  readPng(objectHash: string): Promise<Buffer>;
}

function assertPng(bytes: Buffer) {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error('UI preview screenshot object must be a PNG.');
  }
}

function hashPng(bytes: Buffer) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertObjectHash(objectHash: string) {
  if (!OBJECT_HASH_PATTERN.test(objectHash)) {
    throw new Error('Invalid UI preview screenshot object hash.');
  }
}

function assertContained(rootDir: string, candidatePath: string) {
  const relative = path.relative(rootDir, candidatePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('UI preview screenshot object path escapes the configured CAS root.');
  }
}

async function readVerifiedObject(absolutePath: string, expectedHash: string) {
  const bytes = await fs.promises.readFile(absolutePath);
  assertPng(bytes);
  if (hashPng(bytes) !== expectedHash) {
    throw new Error('Stored UI preview screenshot object hash does not match its content.');
  }
  return bytes;
}

export function createUiPreviewScreenshotCasStore(
  options: { rootDir?: string } = {},
): UiPreviewScreenshotCasStore {
  const rootDir = path.resolve(options.rootDir ?? path.join(getDevFlowDataDir(), 'ui-preview-objects'));
  const screenshotRootDir = path.resolve(rootDir, 'screenshot');
  assertContained(rootDir, screenshotRootDir);

  function resolveObjectPath(objectHash: string) {
    assertObjectHash(objectHash);
    const shardDir = path.resolve(screenshotRootDir, objectHash.slice(0, 2));
    const absolutePath = path.resolve(shardDir, `${objectHash}.png`);
    assertContained(screenshotRootDir, shardDir);
    assertContained(screenshotRootDir, absolutePath);
    return absolutePath;
  }

  async function writePng(input: Uint8Array): Promise<UiPreviewScreenshotObjectRecord> {
    const bytes = Buffer.from(input);
    assertPng(bytes);

    const objectHash = hashPng(bytes);
    const absolutePath = resolveObjectPath(objectHash);
    const shardDir = path.dirname(absolutePath);
    await fs.promises.mkdir(shardDir, { recursive: true });

    try {
      const existing = await readVerifiedObject(absolutePath, objectHash);
      return { objectHash, absolutePath, byteLength: existing.byteLength };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') throw error;
    }

    const tempPath = path.join(
      shardDir,
      `${objectHash}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    );
    assertContained(screenshotRootDir, tempPath);

    try {
      await fs.promises.writeFile(tempPath, bytes, { flag: 'wx' });
      try {
        await fs.promises.rename(tempPath, absolutePath);
      } catch (error) {
        try {
          await readVerifiedObject(absolutePath, objectHash);
        } catch (existingError) {
          if ((existingError as NodeJS.ErrnoException)?.code === 'ENOENT') throw error;
          throw existingError;
        }
      }
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }

    return { objectHash, absolutePath, byteLength: bytes.byteLength };
  }

  async function readPng(objectHash: string) {
    const absolutePath = resolveObjectPath(objectHash);
    return readVerifiedObject(absolutePath, objectHash);
  }

  return { rootDir, screenshotRootDir, writePng, resolveObjectPath, readPng };
}
