import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createExecutionSessionRecord,
  getExecutionSessionById,
  listExecutionSessionEvidence,
  listExecutionSessionsForWorkspace,
  markExpiredExecutionSessions,
  replaceExecutionSessionEvidenceStaleness,
  saveExecutionSessionEvidence,
  updateExecutionSessionRecord,
  type ExecutionSessionEvidenceRecord,
  type ExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import { getTask } from '../repositories/taskRepository.js';
import { getFileRevision, resolveSafePath } from './localFileService.js';
import { buildRepoEvidenceIdentity, getRepoRevisionForRoot } from './repoRevisionService.js';

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

export interface CreateExecutionSessionInput {
  projectId: string;
  taskId?: string | null;
  workspaceId?: string | null;
  branch?: string | null;
  repoRoot?: string;
  contextHandle?: string | null;
  ttlMs?: number;
  now?: Date;
}

export interface ExecutionSessionEvidenceInput {
  kind: string;
  evidenceId?: string;
  path?: string | null;
  repoRevision?: string | null;
  fileRevision?: string | null;
  revisionIdentity?: string | null;
  contextHandle?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ExecutionSessionProgressPatch {
  contextHandle?: string | null;
  changedFiles?: string[];
  verification?: unknown[];
  branch?: string | null;
  repoRevision?: string | null;
}

export interface RecordExecutionOwnedChangesOptions {
  repoRoot: string;
  source: string;
  now?: Date;
}

export interface ExecutionOwnershipState {
  sessionId: string;
  repoRevision: string;
  ownedFiles: Array<{
    path: string;
    acquisitionFileRevision: string;
    knownFileRevision: string;
    currentFileRevision: string;
    source: string;
    acquiredAt?: string;
    observedAt?: string;
    drifted: boolean;
  }>;
  ownedChanges: string[];
  unrelatedChanges: string[];
  scopeDrift: string[];
  ownershipDrift: Array<{ path: string; knownFileRevision: string; currentFileRevision: string }>;
  verificationFresh: boolean | null;
  verificationRecordedAt?: string;
}

function executionSessionError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function requireSession(id: string) {
  const session = getExecutionSessionById(id);
  if (!session) throw executionSessionError('EXECUTION_SESSION_NOT_FOUND', `Execution session '${id}' was not found.`);
  return session;
}

function assertActive(session: ExecutionSessionRecord) {
  if (session.status !== 'active') {
    throw executionSessionError('EXECUTION_SESSION_TERMINAL', `Execution session '${session.id}' is terminal (${session.status}) and cannot mutate as active.`);
  }
}

function normalizeWorkspaceIdentity(value?: string | null) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const looksLikeWindowsPath = /^[a-zA-Z]:[\\/]/.test(normalized) || normalized.startsWith('\\\\');
  if (path.isAbsolute(normalized) || looksLikeWindowsPath) {
    throw executionSessionError('EXECUTION_SESSION_WORKSPACE_ID_INVALID', 'Workspace identity must be an opaque logical id, not a raw filesystem path.');
  }
  return normalized;
}

function normalizeEvidencePath(value?: string | null) {
  if (value == null || String(value).trim() === '') return null;
  const normalized = String(value).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw executionSessionError('EXECUTION_SESSION_EVIDENCE_PATH_INVALID', 'Evidence paths must be repository-relative paths.');
  }
  return normalized;
}

function normalizeStringList(values?: string[]) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim().replace(/\\/g, '/')).filter(Boolean))].sort();
}

function requireRepoRoot(repoRoot?: string) {
  if (!repoRoot) throw executionSessionError('EXECUTION_SESSION_REPO_ROOT_REQUIRED', 'repoRoot is required for execution ownership provenance.');
  return path.resolve(repoRoot);
}

function currentOwnedFileRevision(root: string, relativePath: string) {
  try {
    const fullPath = resolveSafePath(root, relativePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return 'missing';
    return getFileRevision(fullPath).token;
  } catch {
    return 'missing';
  }
}

function ownedRevisionFingerprint(entries: Array<{ path: string; revision: string }>) {
  const digest = crypto.createHash('sha256');
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(entry.path);
    digest.update('\0');
    digest.update(entry.revision);
    digest.update('\0');
  }
  return digest.digest('hex').slice(0, 32);
}

function readStringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' && value ? value : undefined;
}

function boundedTtlMs(value?: number) {
  const ttl = Number(value ?? DEFAULT_SESSION_TTL_MS);
  if (!Number.isFinite(ttl)) return DEFAULT_SESSION_TTL_MS;
  return Math.max(1, Math.min(MAX_SESSION_TTL_MS, Math.floor(ttl)));
}

function evidenceId(sessionId: string, input: { kind: string; path: string | null; contextHandle: string | null }) {
  const digest = crypto.createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(input.kind)
    .update('\0')
    .update(input.path || '')
    .update('\0')
    .update(input.contextHandle || '')
    .digest('hex')
    .slice(0, 24);
  return `evidence-${digest}`;
}

function sessionSnapshot(session: ExecutionSessionRecord) {
  return { ...session };
}

export function createExecutionSession(input: CreateExecutionSessionInput) {
  const projectId = String(input.projectId || '').trim();
  if (!projectId) throw executionSessionError('EXECUTION_SESSION_PROJECT_REQUIRED', 'projectId is required for an execution session.');
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const workspaceId = normalizeWorkspaceIdentity(input.workspaceId);
  let repoRevision: ReturnType<typeof getRepoRevisionForRoot> | null = null;
  if (input.repoRoot) repoRevision = getRepoRevisionForRoot(path.resolve(input.repoRoot));

  return createExecutionSessionRecord({
    id: `exec-${randomUUID()}`,
    projectId,
    taskId: input.taskId ? String(input.taskId) : null,
    workspaceId,
    branch: input.branch ? String(input.branch) : repoRevision?.branch || null,
    baseRevision: repoRevision?.head || null,
    repoRevision: repoRevision?.token || null,
    status: 'active',
    contextHandle: input.contextHandle ? String(input.contextHandle) : null,
    changedFiles: [],
    verification: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: new Date(now.getTime() + boundedTtlMs(input.ttlMs)).toISOString(),
    endedAt: null,
  });
}

export function getExecutionSessionState(id: string) {
  const session = requireSession(id);
  return {
    session: sessionSnapshot(session),
    evidence: listExecutionSessionEvidence(id),
  };
}

export function updateExecutionSessionProgress(id: string, patch: ExecutionSessionProgressPatch) {
  const session = requireSession(id);
  assertActive(session);
  const updated = updateExecutionSessionRecord(id, {
    contextHandle: Object.prototype.hasOwnProperty.call(patch, 'contextHandle') ? patch.contextHandle || null : session.contextHandle,
    changedFiles: Array.isArray(patch.changedFiles) ? normalizeStringList(patch.changedFiles) : session.changedFiles,
    verification: Array.isArray(patch.verification) ? patch.verification : session.verification,
    branch: Object.prototype.hasOwnProperty.call(patch, 'branch') ? patch.branch || null : session.branch,
    repoRevision: Object.prototype.hasOwnProperty.call(patch, 'repoRevision') ? patch.repoRevision || null : session.repoRevision,
    updatedAt: new Date().toISOString(),
  });
  return updated!;
}

export function recordExecutionSessionEvidence(
  id: string,
  entries: ExecutionSessionEvidenceInput[],
  options: { repoRoot?: string; now?: Date } = {},
) {
  const session = requireSession(id);
  assertActive(session);
  const now = options.now || new Date();
  const nowIso = now.toISOString();
  const root = options.repoRoot ? path.resolve(options.repoRoot) : null;
  const currentRepo = root ? getRepoRevisionForRoot(root) : null;
  const saved: ExecutionSessionEvidenceRecord[] = [];

  for (const entry of entries) {
    const kind = String(entry.kind || '').trim();
    if (!kind) throw executionSessionError('EXECUTION_SESSION_EVIDENCE_KIND_REQUIRED', 'Evidence kind is required.');
    const evidencePath = normalizeEvidencePath(entry.path);
    const contextHandle = entry.contextHandle ? String(entry.contextHandle) : session.contextHandle;
    let fileRevision = entry.fileRevision ? String(entry.fileRevision) : null;
    if (evidencePath && root) {
      const fullPath = resolveSafePath(root, evidencePath);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) fileRevision = getFileRevision(fullPath).token;
      else fileRevision = 'missing';
    }
    if (kind === 'file' && evidencePath && !fileRevision) {
      throw executionSessionError('EXECUTION_SESSION_FILE_REVISION_REQUIRED', `File evidence '${evidencePath}' requires a revision or repoRoot.`);
    }
    const repoRevision = entry.repoRevision ? String(entry.repoRevision) : currentRepo?.token || session.repoRevision;
    const revisionIdentity = entry.revisionIdentity
      ? String(entry.revisionIdentity)
      : evidencePath
        ? buildRepoEvidenceIdentity({ repoRevision, filePath: evidencePath, fileRevision })
        : repoRevision;
    saved.push(saveExecutionSessionEvidence({
      id: entry.evidenceId ? String(entry.evidenceId) : evidenceId(id, { kind, path: evidencePath, contextHandle }),
      sessionId: id,
      kind,
      path: evidencePath,
      repoRevision,
      fileRevision,
      revisionIdentity,
      contextHandle,
      stale: false,
      metadata: entry.metadata || {},
      createdAt: nowIso,
      updatedAt: nowIso,
    }));
  }

  if (currentRepo) {
    updateExecutionSessionRecord(id, {
      repoRevision: currentRepo.token,
      branch: session.branch || currentRepo.branch,
      updatedAt: nowIso,
    });
  }
  return saved;
}

export function getActiveTaskExecutionSessionForWorkspace(workspaceId: string) {
  const normalized = normalizeWorkspaceIdentity(workspaceId);
  if (!normalized) return null;
  const active = listExecutionSessionsForWorkspace(normalized)
    .filter((entry) => entry.status === 'active' && Boolean(entry.taskId));
  if (active.length > 1) {
    throw executionSessionError(
      'EXECUTION_SESSION_WORKSPACE_AMBIGUOUS',
      `Workspace '${normalized}' has multiple active task execution sessions.`,
    );
  }
  return active[0] || null;
}

export function recordExecutionOwnedChanges(
  id: string,
  paths: string[],
  options: RecordExecutionOwnedChangesOptions,
) {
  const session = requireSession(id);
  assertActive(session);
  const root = requireRepoRoot(options.repoRoot);
  const nowIso = (options.now || new Date()).toISOString();
  const source = String(options.source || '').trim();
  if (!source) throw executionSessionError('EXECUTION_OWNERSHIP_SOURCE_REQUIRED', 'Execution ownership source is required.');
  const repo = getRepoRevisionForRoot(root);
  const existing = new Map(
    listExecutionSessionEvidence(id)
      .filter((entry) => entry.kind === 'owned-change' && entry.path)
      .map((entry) => [entry.path!, entry] as const),
  );
  const ownedPaths = normalizeStringList(paths)
    .map((entry) => normalizeEvidencePath(entry))
    .filter((entry): entry is string => Boolean(entry));

  for (const ownedPath of ownedPaths) {
    const currentFileRevision = currentOwnedFileRevision(root, ownedPath);
    const prior = existing.get(ownedPath);
    const priorMetadata = prior?.metadata || {};
    const acquisitionFileRevision = readStringMetadata(priorMetadata, 'acquisitionFileRevision') || prior?.fileRevision || currentFileRevision;
    const acquisitionRepoRevision = readStringMetadata(priorMetadata, 'acquisitionRepoRevision') || prior?.repoRevision || repo.token;
    const acquiredAt = readStringMetadata(priorMetadata, 'acquiredAt') || prior?.createdAt || nowIso;
    saveExecutionSessionEvidence({
      id: evidenceId(id, { kind: 'owned-change', path: ownedPath, contextHandle: session.contextHandle }),
      sessionId: id,
      kind: 'owned-change',
      path: ownedPath,
      repoRevision: repo.token,
      fileRevision: currentFileRevision,
      revisionIdentity: buildRepoEvidenceIdentity({ repoRevision: repo.token, filePath: ownedPath, fileRevision: currentFileRevision }),
      contextHandle: session.contextHandle,
      stale: false,
      metadata: {
        ...priorMetadata,
        executionSource: source,
        acquisitionFileRevision,
        acquisitionRepoRevision,
        acquiredAt,
        knownFileRevision: currentFileRevision,
        observedAt: nowIso,
      },
      createdAt: prior?.createdAt || nowIso,
      updatedAt: nowIso,
    });
  }

  updateExecutionSessionRecord(id, {
    changedFiles: normalizeStringList([...session.changedFiles, ...ownedPaths]),
    repoRevision: repo.token,
    updatedAt: nowIso,
  });
  return getExecutionOwnershipState(id, { repoRoot: root });
}

export function getExecutionOwnershipState(
  id: string,
  options: { repoRoot: string; expectedPaths?: string[] },
): ExecutionOwnershipState {
  const session = requireSession(id);
  const root = requireRepoRoot(options.repoRoot);
  const repo = getRepoRevisionForRoot(root);
  const evidence = listExecutionSessionEvidence(id);
  const ownedEvidence = evidence.filter((entry) => entry.kind === 'owned-change' && entry.path);
  const ownedFiles = ownedEvidence.map((entry) => {
    const metadata = entry.metadata || {};
    const currentFileRevision = currentOwnedFileRevision(root, entry.path!);
    const knownFileRevision = readStringMetadata(metadata, 'knownFileRevision') || entry.fileRevision || 'missing';
    return {
      path: entry.path!,
      acquisitionFileRevision: readStringMetadata(metadata, 'acquisitionFileRevision') || entry.fileRevision || 'missing',
      knownFileRevision,
      currentFileRevision,
      source: readStringMetadata(metadata, 'executionSource') || 'unknown',
      acquiredAt: readStringMetadata(metadata, 'acquiredAt'),
      observedAt: readStringMetadata(metadata, 'observedAt'),
      drifted: currentFileRevision !== knownFileRevision,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  const ownedPathSet = new Set(ownedFiles.map((entry) => entry.path));
  const changedPaths = normalizeStringList(repo.changedFiles.map((entry) => entry.workingPath));
  const ownedChanges = changedPaths.filter((entry) => ownedPathSet.has(entry));
  const unrelatedChanges = changedPaths.filter((entry) => !ownedPathSet.has(entry));
  const task = session.taskId ? getTask(session.taskId) : undefined;
  const taskScope = Array.isArray(task?.targetFiles) ? task.targetFiles : [];
  const expectedScope = new Set(normalizeStringList([...(options.expectedPaths || taskScope), ...ownedFiles.map((entry) => entry.path)]));
  const scopeDrift = expectedScope.size > 0 ? changedPaths.filter((entry) => !expectedScope.has(entry)) : [];
  const currentOwnedFingerprint = ownedRevisionFingerprint(
    ownedFiles.map((entry) => ({ path: entry.path, revision: entry.currentFileRevision })),
  );
  const verificationBinding = evidence.filter((entry) => entry.kind === 'verification-binding').at(-1);
  const boundFingerprint = verificationBinding ? readStringMetadata(verificationBinding.metadata || {}, 'ownedFingerprint') : undefined;
  const verificationFresh = session.verification.length === 0
    ? null
    : Boolean(boundFingerprint) && boundFingerprint === currentOwnedFingerprint;

  return {
    sessionId: id,
    repoRevision: repo.token,
    ownedFiles,
    ownedChanges,
    unrelatedChanges,
    scopeDrift,
    ownershipDrift: ownedFiles
      .filter((entry) => entry.drifted)
      .map((entry) => ({ path: entry.path, knownFileRevision: entry.knownFileRevision, currentFileRevision: entry.currentFileRevision })),
    verificationFresh,
    verificationRecordedAt: verificationBinding ? readStringMetadata(verificationBinding.metadata || {}, 'recordedAt') : undefined,
  };
}

export function recordExecutionVerificationEvidence(
  id: string,
  verification: unknown[],
  options: { repoRoot: string; now?: Date },
) {
  const session = requireSession(id);
  assertActive(session);
  const root = requireRepoRoot(options.repoRoot);
  const nowIso = (options.now || new Date()).toISOString();
  const repo = getRepoRevisionForRoot(root);
  const ownership = getExecutionOwnershipState(id, { repoRoot: root });
  const ownedFingerprint = ownedRevisionFingerprint(
    ownership.ownedFiles.map((entry) => ({ path: entry.path, revision: entry.currentFileRevision })),
  );
  const binding = saveExecutionSessionEvidence({
    id: evidenceId(id, { kind: 'verification-binding', path: null, contextHandle: session.contextHandle }),
    sessionId: id,
    kind: 'verification-binding',
    path: null,
    repoRevision: null,
    fileRevision: null,
    revisionIdentity: ownedFingerprint,
    contextHandle: session.contextHandle,
    stale: false,
    metadata: {
      ownedFingerprint,
      ownedPaths: ownership.ownedFiles.map((entry) => entry.path),
      recordedAt: nowIso,
      checkCount: Array.isArray(verification) ? verification.length : 0,
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const updated = updateExecutionSessionRecord(id, {
    verification: Array.isArray(verification) ? verification : [],
    repoRevision: repo.token,
    updatedAt: nowIso,
  })!;
  return { session: updated, binding, ownership: getExecutionOwnershipState(id, { repoRoot: root }) };
}

function currentEvidenceStaleness(entry: ExecutionSessionEvidenceRecord, root: string, repoRevision: string) {
  if (entry.path && entry.fileRevision) {
    try {
      const fullPath = resolveSafePath(root, entry.path);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return true;
      const current = getFileRevision(fullPath);
      return entry.fileRevision !== current.token && entry.fileRevision !== current.sha256;
    } catch {
      return true;
    }
  }
  if (entry.repoRevision) return entry.repoRevision !== repoRevision;
  return false;
}

export function resumeExecutionSession(
  id: string,
  options: { repoRoot?: string; workspaceId?: string | null; now?: Date } = {},
) {
  const now = options.now || new Date();
  const nowIso = now.toISOString();
  markExpiredExecutionSessions(nowIso);
  const session = requireSession(id);
  if (session.status !== 'active') {
    const evidence = listExecutionSessionEvidence(id);
    return {
      resumable: false as const,
      reason: 'SESSION_TERMINAL' as const,
      session,
      evidence,
      staleEvidence: evidence.filter((entry) => entry.stale),
      reusableEvidence: evidence.filter((entry) => !entry.stale),
    };
  }

  const requestedWorkspaceId = normalizeWorkspaceIdentity(options.workspaceId);
  if (requestedWorkspaceId && session.workspaceId && requestedWorkspaceId !== session.workspaceId) {
    const evidence = listExecutionSessionEvidence(id);
    return {
      resumable: false as const,
      reason: 'WORKSPACE_MISMATCH' as const,
      session,
      evidence,
      staleEvidence: evidence.filter((entry) => entry.stale),
      reusableEvidence: evidence.filter((entry) => !entry.stale),
    };
  }

  let evidence = listExecutionSessionEvidence(id);
  let currentRepoRevision = session.repoRevision;
  let currentBranch = session.branch;
  if (options.repoRoot) {
    const root = path.resolve(options.repoRoot);
    const currentRepo = getRepoRevisionForRoot(root);
    currentRepoRevision = currentRepo.token;
    currentBranch = currentRepo.branch;
    evidence = replaceExecutionSessionEvidenceStaleness(
      id,
      evidence.map((entry) => ({ id: entry.id, stale: currentEvidenceStaleness(entry, root, currentRepo.token) })),
      nowIso,
    );
    updateExecutionSessionRecord(id, {
      repoRevision: currentRepo.token,
      branch: session.branch || currentRepo.branch,
      updatedAt: nowIso,
    });
  }

  const refreshed = requireSession(id);
  return {
    resumable: true as const,
    reason: null,
    session: refreshed,
    currentRepoRevision,
    currentBranch,
    evidence,
    staleEvidence: evidence.filter((entry) => entry.stale),
    reusableEvidence: evidence.filter((entry) => !entry.stale),
  };
}

export function completeExecutionSession(id: string, patch: Pick<ExecutionSessionProgressPatch, 'changedFiles' | 'verification' | 'contextHandle'> = {}) {
  const session = requireSession(id);
  assertActive(session);
  const nowIso = new Date().toISOString();
  return updateExecutionSessionRecord(id, {
    status: 'completed',
    contextHandle: Object.prototype.hasOwnProperty.call(patch, 'contextHandle') ? patch.contextHandle || null : session.contextHandle,
    changedFiles: Array.isArray(patch.changedFiles) ? normalizeStringList(patch.changedFiles) : session.changedFiles,
    verification: Array.isArray(patch.verification) ? patch.verification : session.verification,
    updatedAt: nowIso,
    endedAt: nowIso,
  })!;
}

export function cancelExecutionSession(id: string) {
  const session = requireSession(id);
  assertActive(session);
  const nowIso = new Date().toISOString();
  return updateExecutionSessionRecord(id, { status: 'cancelled', updatedAt: nowIso, endedAt: nowIso })!;
}

export function expireExecutionSession(id: string) {
  const session = requireSession(id);
  assertActive(session);
  const nowIso = new Date().toISOString();
  return updateExecutionSessionRecord(id, { status: 'expired', updatedAt: nowIso, endedAt: nowIso })!;
}

export function pruneExpiredExecutionSessions(now = new Date()) {
  return markExpiredExecutionSessions(now.toISOString());
}
