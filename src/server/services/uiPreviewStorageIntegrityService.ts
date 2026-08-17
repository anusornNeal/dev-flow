import crypto from 'node:crypto';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_LIMIT = 1_000;

export type UiPreviewStorageObjectKind = 'source' | 'screenshot';
export type UiPreviewStorageObjectCodec = 'br' | 'identity';

export interface UiPreviewStorageIntegrityObject {
  objectHash: string;
  kind: UiPreviewStorageObjectKind;
  codec: UiPreviewStorageObjectCodec;
  rawBytes?: number;
  storedBytes?: number;
}

export type UiPreviewStorageIntegrityManifest =
  | {
      previewId: string;
      revision: number;
      htmlObjectHash: string;
      cssObjectHash: string;
      jsObjectHash: string;
      specObjectHash: string;
      workspaceObjectHash?: never;
    }
  | {
      previewId: string;
      revision: number;
      workspaceObjectHash: string;
      htmlObjectHash?: never;
      cssObjectHash?: never;
      jsObjectHash?: never;
      specObjectHash?: never;
    };

export interface UiPreviewStorageIntegrityArtifact {
  artifactId: string;
  objectHash: string;
}

export interface UiPreviewStoragePhysicalObject {
  bytes: Uint8Array;
  storedByteLength?: number;
}

export type UiPreviewStorageIntegrityIssueCode =
  | 'OBJECT_INVALID_HASH'
  | 'OBJECT_IDENTITY_CONFLICT'
  | 'OBJECT_INVALID_KIND'
  | 'OBJECT_INVALID_CODEC'
  | 'OBJECT_MISSING'
  | 'OBJECT_HASH_MISMATCH'
  | 'OBJECT_RAW_SIZE_MISMATCH'
  | 'OBJECT_STORED_SIZE_MISMATCH'
  | 'SCREENSHOT_INVALID_PNG'
  | 'MANIFEST_OBJECT_MISSING'
  | 'WORKSPACE_MANIFEST_OBJECT_MISSING'
  | 'WORKSPACE_MANIFEST_WRONG_KIND'
  | 'WORKSPACE_MANIFEST_INVALID'
  | 'ARTIFACT_OBJECT_MISSING'
  | 'ARTIFACT_WRONG_KIND';

export interface UiPreviewStorageIntegrityIssue {
  code: UiPreviewStorageIntegrityIssueCode;
  message: string;
  objectHash?: string;
  previewId?: string;
  revision?: number;
  component?: 'html' | 'css' | 'js' | 'spec' | 'workspace';
  artifactId?: string;
}

export interface UiPreviewStorageIntegrityInput {
  objects?: readonly UiPreviewStorageIntegrityObject[];
  manifests?: readonly UiPreviewStorageIntegrityManifest[];
  artifacts?: readonly UiPreviewStorageIntegrityArtifact[];
}

export interface UiPreviewStorageIntegrityScanOptions {
  maxObjects?: number;
  maxManifests?: number;
  maxArtifacts?: number;
}

export interface UiPreviewStorageIntegrityResult {
  issues: UiPreviewStorageIntegrityIssue[];
  summary: {
    scannedObjects: number;
    scannedManifests: number;
    scannedArtifacts: number;
    issueCount: number;
    issuesByCode: Partial<Record<UiPreviewStorageIntegrityIssueCode, number>>;
    truncated: {
      objects: boolean;
      manifests: boolean;
      artifacts: boolean;
    };
  };
}

export interface UiPreviewStorageIntegrityService {
  scan(
    input: UiPreviewStorageIntegrityInput,
    options?: UiPreviewStorageIntegrityScanOptions,
  ): Promise<UiPreviewStorageIntegrityResult>;
}

export interface UiPreviewStorageIntegrityDependencies {
  readObject(
    objectHash: string,
    metadata: UiPreviewStorageIntegrityObject,
  ): Promise<UiPreviewStoragePhysicalObject | null> | UiPreviewStoragePhysicalObject | null;
}

function hashBytes(bytes: Uint8Array) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isPng(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  return buffer.byteLength >= PNG_SIGNATURE.byteLength
    && buffer.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE);
}

function normalizeLimit(value: number | undefined, label: string) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`UI preview integrity ${label} limit must be a non-negative safe integer.`);
  }
  return value;
}

function sameIdentity(a: UiPreviewStorageIntegrityObject, b: UiPreviewStorageIntegrityObject) {
  return a.objectHash === b.objectHash
    && a.kind === b.kind
    && a.codec === b.codec
    && a.rawBytes === b.rawBytes
    && a.storedBytes === b.storedBytes;
}

function addIssue(issues: UiPreviewStorageIntegrityIssue[], issue: UiPreviewStorageIntegrityIssue) {
  issues.push(issue);
}

function isValidWorkspaceObject(bytes: Uint8Array) {
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== 1
    || !(parsed.title === null || typeof parsed.title === 'string')
    || !Array.isArray(parsed.screens) || parsed.screens.length === 0
    || typeof parsed.defaultScreenId !== 'string') {
    return false;
  }
  const ids = new Set<string>();
  for (const screen of parsed.screens) {
    if (!screen || typeof screen !== 'object' || Array.isArray(screen)
      || typeof screen.screenId !== 'string' || !screen.screenId || ids.has(screen.screenId)
      || typeof screen.name !== 'string' || !screen.name.trim()
      || typeof screen.html !== 'string' || typeof screen.css !== 'string' || typeof screen.js !== 'string'
      || !screen.spec || typeof screen.spec !== 'object' || Array.isArray(screen.spec)
      || screen.spec.schemaVersion !== 1
      || !screen.spec.summary || typeof screen.spec.summary !== 'object'
      || typeof screen.spec.summary.screen !== 'string' || !screen.spec.summary.screen.trim()) {
      return false;
    }
    ids.add(screen.screenId);
  }
  const viewport = parsed.viewport;
  return ids.has(parsed.defaultScreenId)
    && viewport && typeof viewport === 'object' && !Array.isArray(viewport)
    && Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && Number.isFinite(viewport.deviceScaleFactor);
}

export function createUiPreviewStorageIntegrityService(
  dependencies: UiPreviewStorageIntegrityDependencies,
): UiPreviewStorageIntegrityService {
  if (!dependencies || typeof dependencies.readObject !== 'function') {
    throw new Error('UI preview storage integrity scanner requires a readObject dependency.');
  }

  async function scan(
    input: UiPreviewStorageIntegrityInput,
    options: UiPreviewStorageIntegrityScanOptions = {},
  ): Promise<UiPreviewStorageIntegrityResult> {
    const allObjects = Array.isArray(input?.objects) ? input.objects : [];
    const allManifests = Array.isArray(input?.manifests) ? input.manifests : [];
    const allArtifacts = Array.isArray(input?.artifacts) ? input.artifacts : [];
    const maxObjects = normalizeLimit(options.maxObjects, 'object');
    const maxManifests = normalizeLimit(options.maxManifests, 'manifest');
    const maxArtifacts = normalizeLimit(options.maxArtifacts, 'artifact');
    const objects = allObjects.slice(0, maxObjects);
    const manifests = allManifests.slice(0, maxManifests);
    const artifacts = allArtifacts.slice(0, maxArtifacts);
    const issues: UiPreviewStorageIntegrityIssue[] = [];
    const metadataByHash = new Map<string, UiPreviewStorageIntegrityObject>();
    const physicalBytesByHash = new Map<string, Uint8Array>();

    for (const metadata of objects) {
      const objectHash = String(metadata?.objectHash ?? '');
      if (!HASH_PATTERN.test(objectHash)) {
        addIssue(issues, {
          code: 'OBJECT_INVALID_HASH',
          objectHash,
          message: `Object identity '${objectHash}' is not lowercase SHA-256 hex.`,
        });
        continue;
      }

      const existing = metadataByHash.get(objectHash);
      if (existing) {
        if (!sameIdentity(existing, metadata)) {
          addIssue(issues, {
            code: 'OBJECT_IDENTITY_CONFLICT',
            objectHash,
            message: `Object '${objectHash}' has conflicting metadata identities.`,
          });
        }
        continue;
      }
      metadataByHash.set(objectHash, metadata);

      if (metadata.kind !== 'source' && metadata.kind !== 'screenshot') {
        addIssue(issues, {
          code: 'OBJECT_INVALID_KIND',
          objectHash,
          message: `Object '${objectHash}' has invalid kind '${String(metadata.kind)}'.`,
        });
      }
      if (metadata.codec !== 'br' && metadata.codec !== 'identity') {
        addIssue(issues, {
          code: 'OBJECT_INVALID_CODEC',
          objectHash,
          message: `Object '${objectHash}' has invalid codec '${String(metadata.codec)}'.`,
        });
      }

      const physical = await dependencies.readObject(objectHash, metadata);
      if (!physical) {
        addIssue(issues, {
          code: 'OBJECT_MISSING',
          objectHash,
          message: `Object '${objectHash}' is missing from physical storage.`,
        });
        continue;
      }

      const bytes = Buffer.from(physical.bytes);
      physicalBytesByHash.set(objectHash, bytes);
      const actualHash = hashBytes(bytes);
      if (actualHash !== objectHash) {
        addIssue(issues, {
          code: 'OBJECT_HASH_MISMATCH',
          objectHash,
          message: `Object '${objectHash}' raw SHA-256 is '${actualHash}'.`,
        });
      }
      if (metadata.rawBytes !== undefined && metadata.rawBytes !== bytes.byteLength) {
        addIssue(issues, {
          code: 'OBJECT_RAW_SIZE_MISMATCH',
          objectHash,
          message: `Object '${objectHash}' raw size is ${bytes.byteLength}, metadata says ${metadata.rawBytes}.`,
        });
      }
      if (
        metadata.storedBytes !== undefined
        && physical.storedByteLength !== undefined
        && metadata.storedBytes !== physical.storedByteLength
      ) {
        addIssue(issues, {
          code: 'OBJECT_STORED_SIZE_MISMATCH',
          objectHash,
          message: `Object '${objectHash}' stored size is ${physical.storedByteLength}, metadata says ${metadata.storedBytes}.`,
        });
      }
      if (metadata.kind === 'screenshot' && !isPng(bytes)) {
        addIssue(issues, {
          code: 'SCREENSHOT_INVALID_PNG',
          objectHash,
          message: `Screenshot object '${objectHash}' does not have a PNG signature.`,
        });
      }
    }

    const manifestComponents = [
      ['html', 'htmlObjectHash'],
      ['css', 'cssObjectHash'],
      ['js', 'jsObjectHash'],
      ['spec', 'specObjectHash'],
    ] as const;
    for (const manifest of manifests) {
      if (Object.prototype.hasOwnProperty.call(manifest, 'workspaceObjectHash')) {
        const objectHash = String(manifest.workspaceObjectHash || '');
        const metadata = metadataByHash.get(objectHash);
        if (!metadata) {
          addIssue(issues, { code: 'WORKSPACE_MANIFEST_OBJECT_MISSING', previewId: manifest.previewId, revision: manifest.revision, component: 'workspace', objectHash, message: 'Workspace manifest object is missing from metadata.' });
          continue;
        }
        if (metadata.kind !== 'source') {
          addIssue(issues, { code: 'WORKSPACE_MANIFEST_WRONG_KIND', previewId: manifest.previewId, revision: manifest.revision, component: 'workspace', objectHash, message: 'Workspace manifest must reference a source object.' });
          continue;
        }
        const workspaceBytes = physicalBytesByHash.get(objectHash);
        if (workspaceBytes && !isValidWorkspaceObject(workspaceBytes)) {
          addIssue(issues, { code: 'WORKSPACE_MANIFEST_INVALID', previewId: manifest.previewId, revision: manifest.revision, component: 'workspace', objectHash, message: 'Workspace manifest references malformed workspace source.' });
        }
        continue;
      }
      for (const [component, field] of manifestComponents) {
        const objectHash = String(manifest[field] ?? '');
        if (!metadataByHash.has(objectHash)) {
          addIssue(issues, {
            code: 'MANIFEST_OBJECT_MISSING',
            previewId: manifest.previewId,
            revision: manifest.revision,
            component,
            objectHash,
            message: `Manifest ${manifest.previewId}@${manifest.revision} ${component} object '${objectHash}' is missing from metadata.`,
          });
        }
      }
    }

    for (const artifact of artifacts) {
      const metadata = metadataByHash.get(artifact.objectHash);
      if (!metadata) {
        addIssue(issues, {
          code: 'ARTIFACT_OBJECT_MISSING',
          artifactId: artifact.artifactId,
          objectHash: artifact.objectHash,
          message: `Artifact '${artifact.artifactId}' references missing object '${artifact.objectHash}'.`,
        });
        continue;
      }
      if (metadata.kind !== 'screenshot') {
        addIssue(issues, {
          code: 'ARTIFACT_WRONG_KIND',
          artifactId: artifact.artifactId,
          objectHash: artifact.objectHash,
          message: `Artifact '${artifact.artifactId}' references '${artifact.objectHash}' with kind '${String(metadata.kind)}'.`,
        });
      }
    }

    const issuesByCode: Partial<Record<UiPreviewStorageIntegrityIssueCode, number>> = {};
    for (const issue of issues) {
      issuesByCode[issue.code] = (issuesByCode[issue.code] ?? 0) + 1;
    }

    return {
      issues,
      summary: {
        scannedObjects: objects.length,
        scannedManifests: manifests.length,
        scannedArtifacts: artifacts.length,
        issueCount: issues.length,
        issuesByCode,
        truncated: {
          objects: allObjects.length > objects.length,
          manifests: allManifests.length > manifests.length,
          artifacts: allArtifacts.length > artifacts.length,
        },
      },
    };
  }

  return { scan };
}
