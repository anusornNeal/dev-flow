import db from '../../db/index.js';

export type UiPreviewObjectKind = 'source' | 'screenshot';
export type UiPreviewObjectCodec = 'br' | 'identity';

type DatabaseLike = any;

export interface UiPreviewObjectMetadata {
  objectHash: string;
  kind: UiPreviewObjectKind;
  codec: UiPreviewObjectCodec;
  rawBytes: number;
  storedBytes: number;
  createdAt: string;
}

export interface InsertUiPreviewObjectMetadataInput {
  objectHash: string;
  kind: UiPreviewObjectKind;
  codec: UiPreviewObjectCodec;
  rawBytes: number;
  storedBytes: number;
  createdAt?: string;
}

export interface UiPreviewRevisionManifest {
  previewId: string;
  revision: number;
  htmlObjectHash: string;
  cssObjectHash: string;
  jsObjectHash: string;
  specObjectHash: string;
  createdAt: string;
}

export interface InsertUiPreviewRevisionManifestInput {
  previewId: string;
  revision: number;
  htmlObjectHash: string;
  cssObjectHash: string;
  jsObjectHash: string;
  specObjectHash: string;
  createdAt?: string;
}

export interface UiPreviewArtifactObjectMapping {
  artifactId: string;
  objectHash: string;
  createdAt: string;
}

export interface BindUiPreviewArtifactObjectInput {
  artifactId: string;
  objectHash: string;
  createdAt?: string;
}

export class UiPreviewStorageV2Error extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UiPreviewStorageV2Error';
    this.code = code;
  }
}

const OBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/;

function nowIso() {
  return new Date().toISOString();
}

function assertObjectHash(value: string, label = 'objectHash') {
  if (!OBJECT_HASH_PATTERN.test(value)) {
    throw new UiPreviewStorageV2Error(
      'UI_PREVIEW_STORAGE_INVALID_OBJECT_HASH',
      `${label} must be exactly 64 lowercase hexadecimal characters.`,
    );
  }
}

function parseObjectMetadata(row: any): UiPreviewObjectMetadata | null {
  if (!row) return null;
  return {
    objectHash: row.object_hash,
    kind: row.kind,
    codec: row.codec,
    rawBytes: Number(row.raw_bytes),
    storedBytes: Number(row.stored_bytes),
    createdAt: row.created_at,
  };
}

function parseRevisionManifest(row: any): UiPreviewRevisionManifest | null {
  if (!row) return null;
  return {
    previewId: row.preview_id,
    revision: Number(row.revision),
    htmlObjectHash: row.html_object_hash,
    cssObjectHash: row.css_object_hash,
    jsObjectHash: row.js_object_hash,
    specObjectHash: row.spec_object_hash,
    createdAt: row.created_at,
  };
}

function parseArtifactMapping(row: any): UiPreviewArtifactObjectMapping | null {
  if (!row) return null;
  return {
    artifactId: row.artifact_id,
    objectHash: row.object_hash,
    createdAt: row.created_at,
  };
}

function sameObjectMetadata(existing: UiPreviewObjectMetadata, input: InsertUiPreviewObjectMetadataInput) {
  return existing.objectHash === input.objectHash
    && existing.kind === input.kind
    && existing.codec === input.codec
    && existing.rawBytes === input.rawBytes
    && existing.storedBytes === input.storedBytes
    && (input.createdAt === undefined || existing.createdAt === input.createdAt);
}

function sameManifest(existing: UiPreviewRevisionManifest, input: InsertUiPreviewRevisionManifestInput) {
  return existing.previewId === input.previewId
    && existing.revision === input.revision
    && existing.htmlObjectHash === input.htmlObjectHash
    && existing.cssObjectHash === input.cssObjectHash
    && existing.jsObjectHash === input.jsObjectHash
    && existing.specObjectHash === input.specObjectHash
    && (input.createdAt === undefined || existing.createdAt === input.createdAt);
}

export function createUiPreviewObjectMetadataRepository(database: DatabaseLike = db) {
  function getObjectMetadata(objectHash: string) {
    return parseObjectMetadata(database.prepare(`
      SELECT object_hash, kind, codec, raw_bytes, stored_bytes, created_at
      FROM ui_preview_objects
      WHERE object_hash = ?
    `).get(objectHash));
  }

  function insertOrVerifyObjectMetadata(input: InsertUiPreviewObjectMetadataInput) {
    assertObjectHash(input.objectHash);
    const work = () => {
      const existing = getObjectMetadata(input.objectHash);
      if (existing) {
        if (!sameObjectMetadata(existing, input)) {
          throw new UiPreviewStorageV2Error(
            'UI_PREVIEW_STORAGE_OBJECT_METADATA_CONFLICT',
            `Object metadata for ${input.objectHash} conflicts with the immutable stored value.`,
          );
        }
        return existing;
      }

      const createdAt = input.createdAt || nowIso();
      database.prepare(`
        INSERT INTO ui_preview_objects (
          object_hash, kind, codec, raw_bytes, stored_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.objectHash,
        input.kind,
        input.codec,
        input.rawBytes,
        input.storedBytes,
        createdAt,
      );
      return getObjectMetadata(input.objectHash)!;
    };
    return database.transaction(work)();
  }

  function getRevisionManifest(previewId: string, revision: number) {
    return parseRevisionManifest(database.prepare(`
      SELECT
        preview_id, revision, html_object_hash, css_object_hash,
        js_object_hash, spec_object_hash, created_at
      FROM ui_preview_revision_manifests
      WHERE preview_id = ? AND revision = ?
    `).get(previewId, revision));
  }

  function insertOrVerifyRevisionManifest(input: InsertUiPreviewRevisionManifestInput) {
    assertObjectHash(input.htmlObjectHash, 'htmlObjectHash');
    assertObjectHash(input.cssObjectHash, 'cssObjectHash');
    assertObjectHash(input.jsObjectHash, 'jsObjectHash');
    assertObjectHash(input.specObjectHash, 'specObjectHash');

    const work = () => {
      const existing = getRevisionManifest(input.previewId, input.revision);
      if (existing) {
        if (!sameManifest(existing, input)) {
          throw new UiPreviewStorageV2Error(
            'UI_PREVIEW_STORAGE_MANIFEST_CONFLICT',
            `Manifest for ${input.previewId} revision ${input.revision} conflicts with the immutable stored value.`,
          );
        }
        return existing;
      }

      const createdAt = input.createdAt || nowIso();
      database.prepare(`
        INSERT INTO ui_preview_revision_manifests (
          preview_id, revision, html_object_hash, css_object_hash,
          js_object_hash, spec_object_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.previewId,
        input.revision,
        input.htmlObjectHash,
        input.cssObjectHash,
        input.jsObjectHash,
        input.specObjectHash,
        createdAt,
      );
      return getRevisionManifest(input.previewId, input.revision)!;
    };
    return database.transaction(work)();
  }

  function getArtifactObject(artifactId: string) {
    return parseArtifactMapping(database.prepare(`
      SELECT artifact_id, object_hash, created_at
      FROM ui_preview_artifact_objects
      WHERE artifact_id = ?
    `).get(artifactId));
  }

  function bindArtifactObject(input: BindUiPreviewArtifactObjectInput) {
    assertObjectHash(input.objectHash);
    const work = () => {
      const existing = getArtifactObject(input.artifactId);
      if (existing) {
        if (existing.objectHash !== input.objectHash || (input.createdAt !== undefined && existing.createdAt !== input.createdAt)) {
          throw new UiPreviewStorageV2Error(
            'UI_PREVIEW_STORAGE_ARTIFACT_CONFLICT',
            `Artifact ${input.artifactId} is already bound to a different immutable object mapping.`,
          );
        }
        return existing;
      }

      const object = getObjectMetadata(input.objectHash);
      if (!object) {
        throw new UiPreviewStorageV2Error(
          'UI_PREVIEW_STORAGE_OBJECT_NOT_FOUND',
          `Object metadata ${input.objectHash} must exist before binding an artifact.`,
        );
      }
      if (object.kind !== 'screenshot') {
        throw new UiPreviewStorageV2Error(
          'UI_PREVIEW_STORAGE_ARTIFACT_KIND_INVALID',
          `Artifact ${input.artifactId} can only reference an object with screenshot kind.`,
        );
      }

      const createdAt = input.createdAt || nowIso();
      database.prepare(`
        INSERT INTO ui_preview_artifact_objects (artifact_id, object_hash, created_at)
        VALUES (?, ?, ?)
      `).run(input.artifactId, input.objectHash, createdAt);
      return getArtifactObject(input.artifactId)!;
    };
    return database.transaction(work)();
  }

  return {
    getObjectMetadata,
    insertOrVerifyObjectMetadata,
    getRevisionManifest,
    insertOrVerifyRevisionManifest,
    getArtifactObject,
    bindArtifactObject,
  };
}
