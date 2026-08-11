import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDevFlowDataDir } from '../../lib/devFlowPaths.js';

const ARTIFACT_ID_PATTERN = /^uisa_[a-f0-9]{32}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function assertPng(bytes: Buffer) {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error('UI preview screenshot artifact must be a PNG.');
  }
}

function createArtifactId() {
  return `uisa_${crypto.randomBytes(16).toString('hex')}`;
}

export function createUiPreviewArtifactStore(options: { rootDir?: string } = {}): UiPreviewArtifactStore {
  const rootDir = path.resolve(options.rootDir ?? path.join(getDevFlowDataDir(), 'ui-preview-artifacts'));

  function resolveArtifactPath(artifactId: string) {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      throw new Error('Invalid UI preview artifact id.');
    }
    return path.join(rootDir, `${artifactId}.png`);
  }

  async function writePng(input: Uint8Array): Promise<UiPreviewArtifactRecord> {
    const bytes = Buffer.from(input);
    assertPng(bytes);
    await fs.promises.mkdir(rootDir, { recursive: true });

    let artifactId = createArtifactId();
    let absolutePath = resolveArtifactPath(artifactId);
    while (fs.existsSync(absolutePath)) {
      artifactId = createArtifactId();
      absolutePath = resolveArtifactPath(artifactId);
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

  return { rootDir, writePng, resolveArtifactPath };
}
