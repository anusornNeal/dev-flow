import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createExecutionSessionRecord,
  listExecutionSessionEvidence,
  markExpiredExecutionSessions,
  markExpiredExecutionSessionsForTaskWorkspace,
  replaceExecutionSessionEvidenceStaleness,
  saveExecutionSessionEvidence,
  updateExecutionSessionRecord,
  type ExecutionSessionEvidenceRecord,
  type ExecutionLifecycleStage,
  type ExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import { withDbTransaction } from '../../db/index.js';
import { getFileRevision, resolveSafePath } from './localFileService.js';
import { getRepoRevisionForRoot } from './repoRevisionService.js';
import {
  recordAutomaticExecutionCheckpoint,
  recordExecutionPendingOperationReference,
} from './executionCheckpointService.js';
import { publishServerEvent } from './serverEventService.js';
import {
  normalizeExecutionOwnershipEpochId,
  saveExecutionOwnershipEpochEvidence,
} from './executionOwnershipEpochService.js';
import {
  assertExecutionSessionActive,
  executionSessionError,
  requireExecutionSession,
} from './executionSessionPolicyPrimitives.js';

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const EXECUTION_LIFECYCLE_TRANSITIONS: Readonly<Record<ExecutionLifecycleStage, readonly ExecutionLifecycleStage[]>> = Object.freeze({
  compatibility: ['created'],
  created: ['context-ready'],
  'context-ready': ['plan-recorded', 'implementing'],
  'plan-recorded': ['implementing'],
  implementing: ['verifying', 'repairing'],
  verifying: ['repairing', 'verification-infra-blocked', 'committed'],
  repairing: ['verifying', 'verification-infra-blocked'],
  'verification-infra-blocked': ['verifying', 'repairing', 'committed'],
  committed: ['finalized'],
  finalized: [],
});

export interface CreateExecutionSessionInput {
  projectId: string;
  taskId?: string | null;
  workspaceId?: string | null;
  branch?: string | null;
  repoRoot?: string;
  contextHandle?: string | null;
  ttlMs?: number;
  ownershipEpochId?: string | null;
  now?: Date;
}

export interface ExecutionSessionProgressPatch {
  contextHandle?: string | null;
  changedFiles?: string[];
  verification?: unknown[];
  branch?: string | null;
  repoRevision?: string | null;
}

export interface ExecutionLifecycleObservedEvidence {
  id: string;
  kind: string;
  status: 'completed' | 'accepted' | 'running' | 'failed' | 'cancelled';
  operationId?: string | null;
}

export interface ExecutionLifecycleTransitionInput {
  toStage: Exclude<ExecutionLifecycleStage, 'compatibility'>;
  reasonCode: string;
  evidence: ExecutionLifecycleObservedEvidence;
  now?: Date;
}

function normalizeStringList(values?: string[]) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim().replace(/\\/g, '/')).filter(Boolean))].sort();
}

export function normalizeExecutionWorkspaceIdentity(value?: string | null) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const looksLikeWindowsPath = /^[a-zA-Z]:[\\/]/.test(normalized) || normalized.startsWith('\\\\');
  if (path.isAbsolute(normalized) || looksLikeWindowsPath) {
    throw executionSessionError('EXECUTION_SESSION_WORKSPACE_ID_INVALID', 'Workspace identity must be an opaque logical id, not a raw filesystem path.');
  }
  return normalized;
}

function boundedTtlMs(value?: number) {
  const ttl = Number(value ?? DEFAULT_SESSION_TTL_MS);
  if (!Number.isFinite(ttl)) return DEFAULT_SESSION_TTL_MS;
  return Math.max(1, Math.min(MAX_SESSION_TTL_MS, Math.floor(ttl)));
}

function lifecycleTransitionEvidenceId(sessionId: string, originEvidenceId: string) {
  const digest = crypto.createHash('sha256').update(sessionId).update('|lifecycle|').update(originEvidenceId).digest('hex').slice(0, 24);
  return `lifecycle-${digest}`;
}

function lifecycleTransitionForOrigin(sessionId: string, originEvidenceId: string) {
  return listExecutionSessionEvidence(sessionId).find((entry) => entry.kind === 'lifecycle-transition' && entry.metadata?.originEvidenceId === originEvidenceId) || null;
}

function sessionSnapshot(session: ExecutionSessionRecord) {
  return { ...session };
}

function publishExecutionSessionChanged(session: ExecutionSessionRecord, reason: string) {
  publishServerEvent('execution.changed', {
    projectId: session.projectId,
    entityId: session.id,
    status: session.status === 'active' ? session.lifecycle.stage : session.status,
    reason,
  });
}

export function createExecutionSession(input: CreateExecutionSessionInput) {
  const projectId = String(input.projectId || '').trim();
  if (!projectId) throw executionSessionError('EXECUTION_SESSION_PROJECT_REQUIRED', 'projectId is required for an execution session.');
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const workspaceId = normalizeExecutionWorkspaceIdentity(input.workspaceId);
  const ownershipEpochId = normalizeExecutionOwnershipEpochId(input.ownershipEpochId);
  let repoRevision: ReturnType<typeof getRepoRevisionForRoot> | null = null;
  if (input.repoRoot) repoRevision = getRepoRevisionForRoot(path.resolve(input.repoRoot));
  const sessionId = `exec-${randomUUID()}`;
  const originEvidenceId = `session-created:${sessionId}`;

  withDbTransaction(() => {
    createExecutionSessionRecord({
      id: sessionId,
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
    saveExecutionSessionEvidence({
      id: lifecycleTransitionEvidenceId(sessionId, originEvidenceId),
      sessionId,
      kind: 'lifecycle-transition',
      path: null,
      repoRevision: null,
      fileRevision: null,
      revisionIdentity: originEvidenceId,
      contextHandle: input.contextHandle ? String(input.contextHandle) : null,
      stale: false,
      metadata: { fromStage: 'compatibility', toStage: 'created', reasonCode: 'session-created', originEvidenceId, operationId: null, evidenceKind: 'session-created', evidenceStatus: 'completed', sequence: 1, observedAt: nowIso },
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    if (ownershipEpochId) saveExecutionOwnershipEpochEvidence(sessionId, ownershipEpochId, nowIso);
  });
  const created = requireExecutionSession(sessionId);
  publishExecutionSessionChanged(created, 'session-created');
  return created;
}

export function getExecutionSessionState(id: string) {
  const session = requireExecutionSession(id);
  return {
    session: sessionSnapshot(session),
    evidence: listExecutionSessionEvidence(id),
  };
}

export function recordExecutionLifecycleTransition(id: string, input: ExecutionLifecycleTransitionInput) {
  const rawToStage = String(input?.toStage || '').trim();
  const reasonCode = String(input?.reasonCode || '').trim();
  const originEvidenceId = String(input?.evidence?.id || '').trim();
  const evidenceKind = String(input?.evidence?.kind || '').trim();
  const evidenceStatus = input?.evidence?.status;
  const operationId = input?.evidence?.operationId ? String(input.evidence.operationId) : null;
  if (!rawToStage || rawToStage === 'compatibility') throw executionSessionError('EXECUTION_LIFECYCLE_STAGE_REQUIRED', 'A concrete observable lifecycle target stage is required.');
  const toStage = rawToStage as ExecutionLifecycleTransitionInput['toStage'];
  if (!reasonCode) throw executionSessionError('EXECUTION_LIFECYCLE_REASON_REQUIRED', 'Lifecycle transition reasonCode is required.');
  if (!originEvidenceId || !evidenceKind) throw executionSessionError('EXECUTION_LIFECYCLE_EVIDENCE_REQUIRED', 'Lifecycle transitions require authoritative evidence id and kind.');
  if (evidenceStatus !== 'completed') {
    if ((evidenceStatus === 'accepted' || evidenceStatus === 'running') && operationId) {
      recordExecutionPendingOperationReference(id, {
        operationId,
        evidenceId: originEvidenceId,
        kind: evidenceKind,
        status: evidenceStatus,
      }, input.now || new Date());
    }
    throw executionSessionError('EXECUTION_LIFECYCLE_EVIDENCE_NOT_TERMINAL', `Lifecycle evidence '${originEvidenceId}' is ${String(evidenceStatus || 'unknown')}; only completed observable work may advance execution stage.`, {
      evidenceId: originEvidenceId, evidenceKind, evidenceStatus: evidenceStatus || null, requestedStage: toStage,
    });
  }

  const now = input.now || new Date();
  const nowIso = now.toISOString();
  let result!: { session: ExecutionSessionRecord; transition: ExecutionSessionEvidenceRecord; changed: boolean; idempotent: boolean };
  withDbTransaction(() => {
    const session = requireExecutionSession(id);
    assertExecutionSessionActive(session);
    const duplicate = lifecycleTransitionForOrigin(id, originEvidenceId);
    if (duplicate) {
      const metadata = duplicate.metadata || {};
      const same = metadata.toStage === toStage && metadata.reasonCode === reasonCode && metadata.evidenceKind === evidenceKind && (metadata.operationId || null) === operationId;
      if (!same) throw executionSessionError('EXECUTION_LIFECYCLE_IDEMPOTENCY_CONFLICT', `Lifecycle evidence '${originEvidenceId}' was already reconciled to a different transition.`, { evidenceId: originEvidenceId, existing: metadata, requested: { toStage, reasonCode, evidenceKind, operationId } });
      result = { session, transition: duplicate, changed: false, idempotent: true };
      return;
    }

    const fromStage = session.lifecycle.stage;
    const allowed = EXECUTION_LIFECYCLE_TRANSITIONS[fromStage] || [];
    if (!allowed.includes(toStage)) throw executionSessionError('EXECUTION_LIFECYCLE_TRANSITION_BLOCKED', `Lifecycle transition ${fromStage} -> ${toStage} is not allowed.`, { fromStage, toStage, allowedStages: allowed, reasonCode, evidenceId: originEvidenceId });
    const transition = saveExecutionSessionEvidence({
      id: lifecycleTransitionEvidenceId(id, originEvidenceId), sessionId: id, kind: 'lifecycle-transition', path: null,
      repoRevision: null, fileRevision: null, revisionIdentity: operationId || originEvidenceId, contextHandle: session.contextHandle, stale: false,
      metadata: { fromStage, toStage, reasonCode, originEvidenceId, operationId, evidenceKind, evidenceStatus: 'completed', sequence: (session.lifecycle.lastTransition?.sequence || 0) + 1, observedAt: nowIso },
      createdAt: nowIso, updatedAt: nowIso,
    });
    updateExecutionSessionRecord(id, { updatedAt: nowIso });
    const refreshed = requireExecutionSession(id);
    recordAutomaticExecutionCheckpoint(id, transition, now, { publishEvent: false });
    result = { session: refreshed, transition, changed: true, idempotent: false };
  });
  if (!result.idempotent) publishExecutionSessionChanged(result.session, reasonCode);
  return result;
}

export function updateExecutionSessionProgress(id: string, patch: ExecutionSessionProgressPatch) {
  const session = requireExecutionSession(id);
  assertExecutionSessionActive(session);
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
  const session = requireExecutionSession(id);
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

  const requestedWorkspaceId = normalizeExecutionWorkspaceIdentity(options.workspaceId);
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

  const refreshed = requireExecutionSession(id);
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
  const session = requireExecutionSession(id);
  assertExecutionSessionActive(session);
  const nowIso = new Date().toISOString();
  const updated = updateExecutionSessionRecord(id, {
    status: 'completed',
    contextHandle: Object.prototype.hasOwnProperty.call(patch, 'contextHandle') ? patch.contextHandle || null : session.contextHandle,
    changedFiles: Array.isArray(patch.changedFiles) ? normalizeStringList(patch.changedFiles) : session.changedFiles,
    verification: Array.isArray(patch.verification) ? patch.verification : session.verification,
    updatedAt: nowIso,
    endedAt: nowIso,
  })!;
  publishExecutionSessionChanged(updated, 'session-completed');
  return updated;
}

export function recordExecutionReconciliationEvidence(
  id: string,
  reasonCodeValue: string,
  metadata: Record<string, unknown> = {},
  now = new Date(),
) {
  const session = requireExecutionSession(id);
  const reasonCode = String(reasonCodeValue || '').trim().slice(0, 160);
  if (!reasonCode) throw executionSessionError('EXECUTION_RECONCILIATION_REASON_REQUIRED', 'reasonCode is required for execution reconciliation evidence.');
  const nowIso = now.toISOString();
  const digest = crypto.createHash('sha256').update(session.id).update('|reconciliation|').update(reasonCode).digest('hex').slice(0, 24);
  return saveExecutionSessionEvidence({
    id: `reconciliation-${digest}`,
    sessionId: session.id,
    kind: 'lifecycle-reconciliation',
    path: null,
    repoRevision: session.repoRevision,
    fileRevision: null,
    revisionIdentity: reasonCode,
    contextHandle: session.contextHandle,
    stale: false,
    metadata: { ...metadata, reasonCode, status: session.status, taskId: session.taskId, workspaceId: session.workspaceId },
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

export function expireExecutionSessionsForTaskWorkspace(taskId: string, workspaceId: string, now = new Date()) {
  const expiredIds = markExpiredExecutionSessionsForTaskWorkspace(taskId, workspaceId, now.toISOString());
  return expiredIds.map((id) => {
    const session = requireExecutionSession(id);
    recordExecutionReconciliationEvidence(id, 'scoped-expiry', { expiresAt: session.expiresAt }, now);
    publishExecutionSessionChanged(session, 'session-expired');
    return session;
  });
}

export function cancelExecutionSession(id: string) {
  const session = requireExecutionSession(id);
  assertExecutionSessionActive(session);
  const nowIso = new Date().toISOString();
  const updated = updateExecutionSessionRecord(id, { status: 'cancelled', updatedAt: nowIso, endedAt: nowIso })!;
  publishExecutionSessionChanged(updated, 'session-cancelled');
  return updated;
}

export function expireExecutionSession(id: string) {
  const session = requireExecutionSession(id);
  assertExecutionSessionActive(session);
  const nowIso = new Date().toISOString();
  const updated = updateExecutionSessionRecord(id, { status: 'expired', updatedAt: nowIso, endedAt: nowIso })!;
  publishExecutionSessionChanged(updated, 'session-expired');
  return updated;
}

export function pruneExpiredExecutionSessions(now = new Date()) {
  const expiredCount = markExpiredExecutionSessions(now.toISOString());
  if (expiredCount > 0) {
    publishServerEvent('execution.changed', { status: 'expired', reason: 'expired-session-prune' });
  }
  return expiredCount;
}
