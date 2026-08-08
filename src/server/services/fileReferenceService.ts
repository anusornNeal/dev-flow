import fs from 'node:fs';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import type { AppState } from '../types';
import { createApiError } from './api';
import { findProjectByIdentifier } from './taskService';

const DEFAULT_REF_TTL_MS = 10 * 60_000;
const MIN_REF_TTL_MS = 1_000;
const MAX_REF_TTL_MS = 15 * 60_000;
const MAX_REFS = 256;

export type FileReferenceRevision = {
  token: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  modifiedAt: string;
};

type StoredFileReference = {
  fileRef: string;
  projectIdentity: string;
  canonicalRoot: string;
  canonicalTargetPath: string;
  filePath: string;
  revision: FileReferenceRevision;
  createdAtMs: number;
  expiresAtMs: number;
};

export type IssuedFileReference = {
  fileRef: string;
  createdAt: string;
  expiresAt: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ResolvedFileReference = {
  fileRef: string;
  projectIdentity: string;
  root: string;
  targetPath: string;
  filePath: string;
  revision: FileReferenceRevision;
  createdAt: string;
  expiresAt: string;
};

type IssueFileReferenceInput = {
  root: string;
  targetPath: string;
  filePath: string;
  revision: FileReferenceRevision;
  ttlMs?: number;
  nowMs?: number;
};

type ResolveOptions = { nowMs?: number };

const references = new Map<string, StoredFileReference>();

function realPath(existingPath: string) {
  const native = (fs.realpathSync as typeof fs.realpathSync & { native?: typeof fs.realpathSync }).native;
  return native ? native(existingPath) : fs.realpathSync(existingPath);
}

function pathKey(value: string) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertCanonicalContainment(canonicalRoot: string, canonicalTarget: string) {
  const relative = path.relative(canonicalRoot, canonicalTarget);
  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapes) {
    throw createApiError(403, 'UNSAFE_PATH', 'Resolved file target escapes the canonical project root.', {
      retryable: false,
      details: { guidance: 'Re-read a file that resolves inside the project root before preparing the edit.' },
    });
  }
}

function buildRevision(targetPath: string): FileReferenceRevision {
  const stat = fs.statSync(targetPath);
  if (!stat.isFile()) {
    throw createApiError(400, 'INVALID_ARGS', 'fileRef targets must be regular files.');
  }
  const content = fs.readFileSync(targetPath);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  return {
    token: `${stat.size}:${Math.trunc(stat.mtimeMs)}:${sha256.slice(0, 16)}`,
    sha256,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function clampTtl(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_REF_TTL_MS;
  return Math.max(MIN_REF_TTL_MS, Math.min(MAX_REF_TTL_MS, Math.floor(parsed)));
}

function projectFor(state: AppState, args: Record<string, any>) {
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  const projectName = typeof args.projectName === 'string' ? args.projectName.trim().toLowerCase() : '';
  const localPath = typeof args.localPath === 'string' ? args.localPath.trim() : '';
  const cachedProjects = Array.isArray((state as any)?.projectsCache) ? (state as any).projectsCache : [];
  const cached = cachedProjects.find((project: any) => {
    if (projectId && project.id === projectId) return true;
    if (projectName && String(project.name || '').trim().toLowerCase() === projectName) return true;
    if (localPath && project.localPath && pathKey(project.localPath) === pathKey(localPath)) return true;
    return false;
  });
  if (cached) return cached;

  return findProjectByIdentifier(state, {
    projectId: projectId || undefined,
    projectName: projectName || undefined,
    repo: typeof args.repo === 'string' ? args.repo.trim() : undefined,
    repoUrl: typeof args.repoUrl === 'string' ? args.repoUrl.trim() : undefined,
    localPath: localPath || undefined,
  });
}

function resolveRequestedIdentity(state: AppState, args: Record<string, any>, fallbackRoot?: string) {
  const project = projectFor(state, args);
  const rawRoot = project?.localPath || (typeof args.localPath === 'string' ? args.localPath.trim() : '') || fallbackRoot || '';
  if (!rawRoot || !fs.existsSync(rawRoot)) {
    const requested = args.projectId || args.projectName || args.repo || args.repoUrl || args.localPath || 'project';
    throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${requested}' was not found for fileRef resolution.`, { affectedId: String(requested) });
  }
  const canonicalRoot = realPath(rawRoot);
  return {
    canonicalRoot,
    projectIdentity: project?.id || `root:${pathKey(canonicalRoot)}`,
  };
}

function staleError(filePath: string, reason: string) {
  return createApiError(409, 'EDIT_REF_STALE', `File reference for '${filePath}' is stale: ${reason}`, {
    retryable: false,
    affectedId: filePath,
    details: { guidance: 'Re-read the file with includeFileRef=true and prepare a new compact edit. Do not retry the same fileRef.' },
  });
}

function pruneForCapacity(nowMs: number) {
  for (const [id, entry] of references) {
    if (entry.expiresAtMs <= nowMs) references.delete(id);
  }
  while (references.size >= MAX_REFS) {
    const oldest = references.keys().next().value;
    if (!oldest) break;
    references.delete(oldest);
  }
}

export function clearFileReferences() {
  const count = references.size;
  references.clear();
  return count;
}

export function getFileReferenceStats() {
  return {
    entries: references.size,
    maxEntries: MAX_REFS,
    defaultTtlMs: DEFAULT_REF_TTL_MS,
    maxTtlMs: MAX_REF_TTL_MS,
  };
}

export function issueFileRef(state: AppState, args: Record<string, any>, input: IssueFileReferenceInput): IssuedFileReference {
  const nowMs = input.nowMs ?? Date.now();
  const canonicalRoot = realPath(input.root);
  const canonicalTargetPath = realPath(input.targetPath);
  assertCanonicalContainment(canonicalRoot, canonicalTargetPath);

  const identity = resolveRequestedIdentity(state, args, input.root);
  if (pathKey(identity.canonicalRoot) !== pathKey(canonicalRoot)) {
    throw createApiError(409, 'EDIT_REF_PROJECT_MISMATCH', 'Resolved project root does not match the fileRef source root.', {
      retryable: false,
      details: { guidance: 'Re-read the file from the intended project before preparing the edit.' },
    });
  }

  const currentRevision = buildRevision(canonicalTargetPath);
  if (currentRevision.sha256 !== input.revision.sha256) {
    throw staleError(input.filePath, 'content changed while issuing the reference.');
  }

  pruneForCapacity(nowMs);
  const ttlMs = clampTtl(input.ttlMs);
  const fileRef = `file-ref-${randomUUID()}`;
  const entry: StoredFileReference = {
    fileRef,
    projectIdentity: identity.projectIdentity,
    canonicalRoot,
    canonicalTargetPath,
    filePath: input.filePath.replace(/\\/g, '/'),
    revision: currentRevision,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  };
  references.set(fileRef, entry);

  return {
    fileRef,
    createdAt: new Date(entry.createdAtMs).toISOString(),
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
    createdAtMs: entry.createdAtMs,
    expiresAtMs: entry.expiresAtMs,
  };
}

export function resolveFileRef(
  state: AppState,
  args: Record<string, any>,
  fileRef: string,
  options: ResolveOptions = {},
): ResolvedFileReference {
  const normalizedRef = String(fileRef || '').trim();
  if (!normalizedRef) {
    throw createApiError(400, 'EDIT_REF_NOT_FOUND', 'fileRef is required.', {
      retryable: false,
      details: { guidance: 'Re-read the target file with includeFileRef=true.' },
    });
  }

  const entry = references.get(normalizedRef);
  if (!entry) {
    throw createApiError(404, 'EDIT_REF_NOT_FOUND', `File reference '${normalizedRef}' was not found.`, {
      retryable: false,
      details: { guidance: 'The reference may have expired, been pruned, or disappeared after restart. Re-read the file and prepare again.' },
    });
  }

  const nowMs = options.nowMs ?? Date.now();
  if (nowMs >= entry.expiresAtMs) {
    references.delete(normalizedRef);
    throw createApiError(410, 'EDIT_REF_EXPIRED', `File reference '${normalizedRef}' expired. Re-read the file and prepare again.`, {
      retryable: false,
      affectedId: entry.filePath,
      details: { guidance: 'Re-read the file with includeFileRef=true and prepare a new compact edit. Do not retry the same fileRef.' },
    });
  }

  const identity = resolveRequestedIdentity(state, args);
  if (identity.projectIdentity !== entry.projectIdentity || pathKey(identity.canonicalRoot) !== pathKey(entry.canonicalRoot)) {
    throw createApiError(409, 'EDIT_REF_PROJECT_MISMATCH', `File reference '${normalizedRef}' belongs to a different project.`, {
      retryable: false,
      affectedId: entry.filePath,
      details: { guidance: 'Re-read the file from the intended project before preparing the edit.' },
    });
  }

  if (!fs.existsSync(entry.canonicalTargetPath)) {
    throw staleError(entry.filePath, 'target file is missing.');
  }

  let currentCanonicalTarget: string;
  try {
    currentCanonicalTarget = realPath(entry.canonicalTargetPath);
  } catch {
    throw staleError(entry.filePath, 'target path can no longer be resolved.');
  }
  assertCanonicalContainment(identity.canonicalRoot, currentCanonicalTarget);
  if (pathKey(currentCanonicalTarget) !== pathKey(entry.canonicalTargetPath)) {
    throw staleError(entry.filePath, 'canonical target changed.');
  }

  const currentRevision = buildRevision(currentCanonicalTarget);
  if (currentRevision.sha256 !== entry.revision.sha256) {
    throw staleError(entry.filePath, 'file content changed after it was read.');
  }

  return {
    fileRef: entry.fileRef,
    projectIdentity: entry.projectIdentity,
    root: entry.canonicalRoot,
    targetPath: entry.canonicalTargetPath,
    filePath: entry.filePath,
    revision: { ...entry.revision },
    createdAt: new Date(entry.createdAtMs).toISOString(),
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
  };
}
