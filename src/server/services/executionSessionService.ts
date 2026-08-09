import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createExecutionSessionRecord,
  getExecutionSessionById,
  listExecutionSessionEvidence,
  markExpiredExecutionSessions,
  replaceExecutionSessionEvidenceStaleness,
  saveExecutionSessionEvidence,
  updateExecutionSessionRecord,
  type ExecutionSessionEvidenceRecord,
  type ExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
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
      id: evidenceId(id, { kind, path: evidencePath, contextHandle }),
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

function currentEvidenceStaleness(entry: ExecutionSessionEvidenceRecord, root: string, repoRevision: string) {
  if (entry.kind === 'file' && entry.path) {
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
