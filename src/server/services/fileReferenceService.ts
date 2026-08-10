import fs from 'node:fs';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import type { AppState } from '../types';
import { createApiError } from './api';
import { findProjectByIdentifier } from './taskService';
import { createOrReuseSessionWorkspace, resolveSessionWorkspace } from './sessionWorkspaceService';

const DEFAULT_REF_TTL_MS = 10 * 60_000;
const MIN_REF_TTL_MS = 1_000;
const MAX_REF_TTL_MS = 15 * 60_000;
const MAX_REFS = 256;
const MAX_RETIRED_REFS = 256;
const RETIRED_REF_TTL_MS = MAX_REF_TTL_MS;

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

type RetiredFileReference = {
  fileRef: string;
  projectIdentity: string;
  filePath: string;
  reason: 'expired' | 'evicted';
  retiredAtMs: number;
  forgetAtMs: number;
};

export type IssuedFileReference = {
  fileRef: string;
  createdAt: string;
  expiresAt: string;
  createdAtMs: number;
  expiresAtMs: number;
  reused: boolean;
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
const retiredReferences = new Map<string, RetiredFileReference>();
const lifecycleMetrics = {
  issuedCount: 0,
  reusedCount: 0,
  expiredCount: 0,
  evictedCount: 0,
};

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
  const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : '';
  if (workspaceId) {
    const workspace = resolveSessionWorkspace(workspaceId);
    if (!workspace) {
      throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
    }
    const requestedIdentifier = args.projectId || args.projectName || args.repo || args.repoUrl;
    if (requestedIdentifier && !project) {
      throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${requestedIdentifier}' was not found for fileRef resolution.`, { affectedId: String(requestedIdentifier) });
    }
    if (project && workspace.projectId !== project.id) {
      throw createApiError(409, 'WORKSPACE_PROJECT_MISMATCH', `Workspace '${workspaceId}' belongs to project '${workspace.projectId}', not '${project.id}'.`, {
        affectedId: workspaceId,
        details: { workspaceProjectId: workspace.projectId, requestedProjectId: project.id },
      });
    }
    return {
      canonicalRoot: realPath(workspace.root),
      projectIdentity: `workspace:${workspace.workspaceId}`,
    };
  }

  if (project) {
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    if (sessionId) {
      const workspace = createOrReuseSessionWorkspace(project, sessionId);
      return {
        canonicalRoot: realPath(workspace.root),
        projectIdentity: `workspace:${workspace.workspaceId}`,
      };
    }
  }

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

function recoveryDetails(action: 're-read' | 'select-project-and-re-read', guidance: string) {
  return {
    guidance,
    recovery: {
      action,
      nextTool: 'read_local_file',
      includeFileRef: true,
      retrySamePayload: false,
    },
  };
}

function staleError(filePath: string, reason: string) {
  return createApiError(409, 'EDIT_REF_STALE', `File reference for '${filePath}' is stale: ${reason}`, {
    retryable: false,
    affectedId: filePath,
    details: recoveryDetails('re-read', 'Re-read the file with includeFileRef=true and prepare a new compact edit. Do not retry the same fileRef.'),
  });
}

function pruneRetired(nowMs: number) {
  for (const [id, entry] of retiredReferences) {
    if (entry.forgetAtMs <= nowMs) retiredReferences.delete(id);
  }
  while (retiredReferences.size > MAX_RETIRED_REFS) {
    const oldest = retiredReferences.keys().next().value;
    if (!oldest) break;
    retiredReferences.delete(oldest);
  }
}

function retireReference(entry: StoredFileReference, reason: 'expired' | 'evicted', nowMs: number) {
  references.delete(entry.fileRef);
  retiredReferences.set(entry.fileRef, {
    fileRef: entry.fileRef,
    projectIdentity: entry.projectIdentity,
    filePath: entry.filePath,
    reason,
    retiredAtMs: nowMs,
    forgetAtMs: nowMs + RETIRED_REF_TTL_MS,
  });
  if (reason === 'expired') lifecycleMetrics.expiredCount += 1;
  else lifecycleMetrics.evictedCount += 1;
  pruneRetired(nowMs);
}

function pruneExpiredReferences(nowMs: number) {
  for (const entry of Array.from(references.values())) {
    if (entry.expiresAtMs <= nowMs) retireReference(entry, 'expired', nowMs);
  }
  pruneRetired(nowMs);
}

function pruneForCapacity(nowMs: number) {
  pruneExpiredReferences(nowMs);
  while (references.size >= MAX_REFS) {
    const oldest = references.values().next().value as StoredFileReference | undefined;
    if (!oldest) break;
    retireReference(oldest, 'evicted', nowMs);
  }
}

export function clearFileReferences() {
  const count = references.size + retiredReferences.size;
  references.clear();
  retiredReferences.clear();
  lifecycleMetrics.issuedCount = 0;
  lifecycleMetrics.reusedCount = 0;
  lifecycleMetrics.expiredCount = 0;
  lifecycleMetrics.evictedCount = 0;
  return count;
}

export function getFileReferenceStats() {
  return {
    entries: references.size,
    maxEntries: MAX_REFS,
    retiredEntries: retiredReferences.size,
    maxRetiredEntries: MAX_RETIRED_REFS,
    defaultTtlMs: DEFAULT_REF_TTL_MS,
    maxTtlMs: MAX_REF_TTL_MS,
    issuedCount: lifecycleMetrics.issuedCount,
    reusedCount: lifecycleMetrics.reusedCount,
    expiredCount: lifecycleMetrics.expiredCount,
    evictedCount: lifecycleMetrics.evictedCount,
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

  pruneExpiredReferences(nowMs);
  const ttlMs = clampTtl(input.ttlMs);
  const reusable = Array.from(references.values()).find((entry) =>
    entry.projectIdentity === identity.projectIdentity
    && pathKey(entry.canonicalRoot) === pathKey(canonicalRoot)
    && pathKey(entry.canonicalTargetPath) === pathKey(canonicalTargetPath)
    && entry.revision.sha256 === currentRevision.sha256
  );
  if (reusable) {
    reusable.expiresAtMs = Math.max(reusable.expiresAtMs, nowMs + ttlMs);
    references.delete(reusable.fileRef);
    references.set(reusable.fileRef, reusable);
    lifecycleMetrics.reusedCount += 1;
    return {
      fileRef: reusable.fileRef,
      createdAt: new Date(reusable.createdAtMs).toISOString(),
      expiresAt: new Date(reusable.expiresAtMs).toISOString(),
      createdAtMs: reusable.createdAtMs,
      expiresAtMs: reusable.expiresAtMs,
      reused: true,
    };
  }

  pruneForCapacity(nowMs);
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
  lifecycleMetrics.issuedCount += 1;

  return {
    fileRef,
    createdAt: new Date(entry.createdAtMs).toISOString(),
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
    createdAtMs: entry.createdAtMs,
    expiresAtMs: entry.expiresAtMs,
    reused: false,
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

  const nowMs = options.nowMs ?? Date.now();
  pruneRetired(nowMs);
  let entry = references.get(normalizedRef);
  if (entry && nowMs >= entry.expiresAtMs) {
    retireReference(entry, 'expired', nowMs);
    entry = undefined;
  }

  if (!entry) {
    const retired = retiredReferences.get(normalizedRef);
    if (retired) {
      const identity = resolveRequestedIdentity(state, args);
      if (identity.projectIdentity !== retired.projectIdentity) {
        throw createApiError(409, 'EDIT_REF_PROJECT_MISMATCH', `File reference '${normalizedRef}' belongs to a different project.`, {
          retryable: false,
          affectedId: retired.filePath,
          details: recoveryDetails('select-project-and-re-read', 'Select the intended project and re-read the file before preparing the edit.'),
        });
      }
      const code = retired.reason === 'expired' ? 'EDIT_REF_EXPIRED' : 'EDIT_REF_EVICTED';
      throw createApiError(410, code, `File reference '${normalizedRef}' was ${retired.reason}. Re-read the file and prepare again.`, {
        retryable: false,
        affectedId: retired.filePath,
        details: {
          ...recoveryDetails('re-read', 'Re-read the file with includeFileRef=true and prepare a new compact edit. Do not retry the same fileRef.'),
          retiredReason: retired.reason,
          retiredAt: new Date(retired.retiredAtMs).toISOString(),
        },
      });
    }
    throw createApiError(404, 'EDIT_REF_NOT_FOUND', `File reference '${normalizedRef}' was not found.`, {
      retryable: false,
      details: recoveryDetails('re-read', 'The reference is unknown or was lost after restart. Re-read the file and prepare again.'),
    });
  }

  const identity = resolveRequestedIdentity(state, args);
  if (identity.projectIdentity !== entry.projectIdentity || pathKey(identity.canonicalRoot) !== pathKey(entry.canonicalRoot)) {
    throw createApiError(409, 'EDIT_REF_PROJECT_MISMATCH', `File reference '${normalizedRef}' belongs to a different project.`, {
      retryable: false,
      affectedId: entry.filePath,
      details: recoveryDetails('select-project-and-re-read', 'Re-read the file from the intended project before preparing the edit.'),
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
