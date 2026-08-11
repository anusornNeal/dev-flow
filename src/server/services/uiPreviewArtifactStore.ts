import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDevFlowDataDir } from '../../lib/devFlowPaths.js';
import { createUiPreviewObjectMetadataRepository } from '../repositories/uiPreviewObjectMetadataRepository.js';
import {
  createUiPreviewScreenshotCasStore,
  type UiPreviewScreenshotCasStore,
} from './uiPreviewScreenshotCasStore.js';

const ARTIFACT_ID_PATTERN = /^uisa_[a-f0-9]{32}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type MetadataRepositoryLike = ReturnType<typeof createUiPreviewObjectMetadataRepository>;

export interface UiPreviewArtifactRecord {
  artifactId: string;
  absolutePath: string;
  byteLength: number;
}

export interface UiPreviewArtifactStore {
  rootDir: string;
  writePng(bytes: Uint8Array): Promise<UiPreviewArtifactRecord>;
  resolveArtifactPath(artifactId: string): string;
}

export interface UiPreviewArtifactStoreOptions {
  rootDir?: string;
  casStore?: UiPreviewScreenshotCasStore;
  metadataRepository?: MetadataRepositoryLike;
}

function assertPng(bytes: Buffer) {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error('UI preview screenshot artifact must be a PNG.');
  }
}

function createArtifactId() {
  return `uisa_${crypto.randomBytes(16).toString('hex')}`;
}

async function writeLegacyArtifact(rootDir: string, bytes: Buffer): Promise<UiPreviewArtifactRecord> {
  await fs.promises.mkdir(rootDir, { recursive: true });
  let artifactId = createArtifactId();
  let absolutePath = path.join(rootDir, `${artifactId}.png`);
  while (fs.existsSync(absolutePath)) {
    artifactId = createArtifactId();
    absolutePath = path.join(rootDir, `${artifactId}.png`);
  }
  const tempPath = path.join(rootDir, `${artifactId}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(tempPath, bytes, { flag: 'wx' });
    await fs.promises.rename(tempPath, absolutePath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }
  return { artifactId, absolutePath, byteLength: bytes.byteLength };
}

export function createUiPreviewArtifactStore(options: UiPreviewArtifactStoreOptions = {}): UiPreviewArtifactStore {
  const rootDir = path.resolve(options.rootDir ?? path.join(getDevFlowDataDir(), 'ui-preview-artifacts'));
  const explicitLegacyRoot = Boolean(options.rootDir && !options.casStore && !options.metadataRepository);

  if (explicitLegacyRoot) {
    function resolveArtifactPath(artifactId: string) {
      if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new Error('Invalid UI preview artifact id.');
      return path.join(rootDir, `${artifactId}.png`);
    }
    async function writePng(input: Uint8Array) {
      const bytes = Buffer.from(input);
      assertPng(bytes);
      return writeLegacyArtifact(rootDir, bytes);
    }
    return { rootDir, writePng, resolveArtifactPath };
  }

  const casStore = options.casStore ?? createUiPreviewScreenshotCasStore();
  const metadataRepository = options.metadataRepository ?? createUiPreviewObjectMetadataRepository();

  function legacyArtifactPath(artifactId: string) {
    return path.join(rootDir, `${artifactId}.png`);
  }

  function resolveArtifactPath(artifactId: string) {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new Error('Invalid UI preview artifact id.');
    const mapping = metadataRepository.getArtifactObject(artifactId);
    return mapping ? casStore.resolveObjectPath(mapping.objectHash) : legacyArtifactPath(artifactId);
  }

  async function writePng(input: Uint8Array): Promise<UiPreviewArtifactRecord> {
    const bytes = Buffer.from(input);
    assertPng(bytes);
    const object = await casStore.writePng(bytes);
    metadataRepository.insertOrVerifyObjectMetadata({
      objectHash: object.objectHash,
      kind: 'screenshot',
      codec: 'identity',
      rawBytes: object.byteLength,
      storedBytes: object.byteLength,
    });

    let artifactId = createArtifactId();
    while (metadataRepository.getArtifactObject(artifactId) || fs.existsSync(legacyArtifactPath(artifactId))) {
      artifactId = createArtifactId();
    }
    metadataRepository.bindArtifactObject({ artifactId, objectHash: object.objectHash });
    return { artifactId, absolutePath: object.absolutePath, byteLength: object.byteLength };
  }

  return { rootDir, writePng, resolveArtifactPath };
}
