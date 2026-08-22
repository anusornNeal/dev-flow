// DVF-0685: reusable verification coverage is keyed to relevant inputs, not repo lineage alone.
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createExecutionSessionRecord,
  getExecutionSessionById,
  listExecutionSessionEvidence,
  listExecutionSessionsForWorkspace,
  queryExecutionSessions,
  markExpiredExecutionSessions,
  markExpiredExecutionSessionsForTaskWorkspace,
  replaceExecutionSessionEvidenceStaleness,
  saveExecutionSessionEvidence,
  updateExecutionSessionRecord,
  type ExecutionSessionEvidenceRecord,
  type ExecutionLifecycleStage,
  type ExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import { getTask, getTaskByIdentifier } from '../repositories/taskRepository.js';
import { getProjects, normalizeProjectNameAlias, normalizeProjectRepoIdentity } from '../repositories/projectRepository.js';
import { getFileRevision, resolveSafePath } from './localFileService.js';
import { buildRepoAffectedInputIdentity, buildRepoEvidenceIdentity, getRepoRevisionForRoot } from './repoRevisionService.js';
import { withDbTransaction } from '../../db/index.js';
import { resolveSessionWorkspace } from './sessionWorkspaceService.js';
import { createApiError } from './api.js';
import {
  recordAutomaticExecutionCheckpoint,
  recordExecutionPendingOperationReference,
} from './executionCheckpointService.js';
import {
  buildVerificationCoverageIdentity,
  createVerificationBatch,
  MAX_VERIFICATION_BATCH_CHECKS,
  type VerificationBatchResultStatus,
  type VerificationCoverageIdentity,
} from './verificationBatchService.js';

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

export type TaskMutationOwnershipStrategy = 'transactional-owned' | 'plan-only-exempt';
const TASK_MUTATION_OWNERSHIP_STRATEGIES: Readonly<Record<string, TaskMutationOwnershipStrategy>> = Object.freeze({
  write_local_file: 'transactional-owned',
  safe_edit_local_file: 'transactional-owned',
  edit_local_files_batch: 'transactional-owned',
  apply_prepared_edit_plan: 'transactional-owned',
  apply_prepared_edit: 'transactional-owned',
  apply_patch: 'transactional-owned',
  delete_local_path: 'transactional-owned',
  move_local_path: 'transactional-owned',
  apply_and_verify: 'transactional-owned',
  prepare_edit_plan: 'plan-only-exempt',
  prepare_compact_edit: 'plan-only-exempt',
});

export function getTaskMutationOwnershipStrategy(toolName: string) {
  return TASK_MUTATION_OWNERSHIP_STRATEGIES[String(toolName || '').trim()] || null;
}

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

export interface RecordExecutionOwnedChangesOptions {
  repoRoot: string;
  source: string;
  now?: Date;
  metadata?: Record<string, unknown>;
  metadataByPath?: Record<string, Record<string, unknown>>;
}

export type ExecutionOwnedRevisionReconciliationFile = {
  path: string;
  expectedKnownRevision: string;
  expectedCurrentRevision: string;
};

export interface ExecutionVerificationProvenance {
  policy: 'checks-passed' | 'no-checks-required' | 'operator-break-glass';
  expectedRepoRevision?: string;
  expectedOwnedFingerprint?: string;
  candidateId?: string;
  candidateRepoRevision?: string;
  executionKey?: string;
  coverage?: VerificationCoverageIdentity[];
}

export interface RecordExecutionVerificationOptions {
  repoRoot: string;
  now?: Date;
  provenance?: ExecutionVerificationProvenance;
}

export type TaskExecutionVerificationBindingReason =
  | 'EXECUTION_VERIFICATION_AUTHORITATIVE'
  | 'EXECUTION_VERIFICATION_RESULT_NOT_SUCCEEDED'
  | 'EXECUTION_VERIFICATION_TASK_BINDING_MISSING'
  | 'EXECUTION_VERIFICATION_PROVENANCE_REQUIRED'
  | 'EXECUTION_VERIFICATION_CANDIDATE_REQUIRED'
  | 'EXECUTION_VERIFICATION_REPO_REVISION_STALE'
  | 'EXECUTION_VERIFICATION_CANDIDATE_STALE'
  | 'EXECUTION_VERIFICATION_FINGERPRINT_STALE'
  | 'EXECUTION_VERIFICATION_BINDING_NOT_FRESH'
  | 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE'
  | 'EXECUTION_VERIFICATION_BATCH_FAILED'
  | 'EXECUTION_VERIFICATION_BATCH_STALE'
  | 'EXECUTION_VERIFICATION_RECOVERY_BATCH_REQUIRED'
  | 'EXECUTION_VERIFICATION_REJECTED';

export interface TaskExecutionVerificationBindingOutcome {
  authoritative: boolean;
  reasonCode: TaskExecutionVerificationBindingReason;
  verificationFresh: boolean | null;
  sessionId?: string;
  repoRevision?: string;
  ownedFingerprint?: string;
  errorCode?: string;
  message?: string;
  details?: unknown;
  session?: ExecutionSessionRecord;
  binding?: ExecutionSessionEvidenceRecord;
  ownership?: ExecutionOwnershipState;
}

export type ExecutionVerificationBatchStatus = 'pending' | 'complete' | 'failed' | 'stale';

export type ExecutionVerificationBatchMemberCandidate = {
  candidateId: string;
  repoRevision: string;
  executionKey: string;
  coverage?: VerificationCoverageIdentity;
};

export type ExecutionVerificationBatchState = {
  batchId: string;
  ownershipEpochId: string;
  repoRevision: string;
  ownedFingerprint: string;
  requiredChecks: string[];
  results: Record<string, VerificationBatchResultStatus>;
  memberCandidates: Record<string, ExecutionVerificationBatchMemberCandidate>;
  pending: string[];
  passed: string[];
  failed: string[];
  stale: string[];
  status: ExecutionVerificationBatchStatus;
  canComplete: boolean;
  createdAt: string;
  updatedAt: string;
};

export interface ExecutionOwnershipState {
  sessionId: string;
  repoRevision: string;
  ownedFingerprint: string;
  ownedFiles: Array<{
    path: string;
    acquisitionFileRevision: string;
    knownFileRevision: string;
    currentFileRevision: string;
    observedFileRevision: string;
    source: string;
    acquiredAt?: string;
    observedAt?: string;
    drifted: boolean;
  }>;
  ownedChanges: string[];
  unrelatedChanges: string[];
  scopeDrift: string[];
  ownershipDrift: Array<{ path: string; knownFileRevision: string; currentFileRevision: string }>;
  verifiedOwnershipDrift: Array<{ path: string; knownFileRevision: string; currentFileRevision: string }>;
  verificationFresh: boolean | null;
  verificationRecordedAt?: string;
}

function executionSessionError(code: string, message: string, details?: unknown) {
  const error = new Error(message) as Error & { code?: string; details?: unknown };
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function taskMutationError(status: number, code: string, message: string, details?: unknown) {
  return createApiError(status, code, message, { details });
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

function ownedRevisionContentIdentity(revision: string) {
  const normalized = String(revision || '').trim();
  if (!normalized || normalized === 'missing') return normalized || 'missing';
  const parts = normalized.split(':');
  if (parts.length < 3) return normalized;
  return `${parts[0]}:${parts[parts.length - 1]}`;
}

function sameOwnedContentRevision(left: string, right: string) {
  return ownedRevisionContentIdentity(left) === ownedRevisionContentIdentity(right);
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

function lifecycleTransitionEvidenceId(sessionId: string, originEvidenceId: string) {
  const digest = crypto.createHash('sha256').update(sessionId).update('|lifecycle|').update(originEvidenceId).digest('hex').slice(0, 24);
  return `lifecycle-${digest}`;
}

function normalizeOwnershipEpochId(value?: string | null) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (normalized.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw executionSessionError('EXECUTION_OWNERSHIP_EPOCH_INVALID', 'Execution ownership epoch must be a bounded opaque identifier.');
  }
  return normalized;
}

function ownershipEpochEvidenceId(sessionId: string) {
  const digest = crypto.createHash('sha256').update(sessionId).update('|ownership-epoch|').digest('hex').slice(0, 24);
  return `ownership-${digest}`;
}

function saveExecutionOwnershipEpochEvidence(sessionId: string, ownershipEpochId: string, nowIso: string) {
  return saveExecutionSessionEvidence({
    id: ownershipEpochEvidenceId(sessionId),
    sessionId,
    kind: 'ownership-epoch',
    path: null,
    repoRevision: null,
    fileRevision: null,
    revisionIdentity: ownershipEpochId,
    contextHandle: null,
    stale: false,
    metadata: { ownershipEpochId },
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

function lifecycleTransitionForOrigin(sessionId: string, originEvidenceId: string) {
  return listExecutionSessionEvidence(sessionId).find((entry) => entry.kind === 'lifecycle-transition' && entry.metadata?.originEvidenceId === originEvidenceId) || null;
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
  const ownershipEpochId = normalizeOwnershipEpochId(input.ownershipEpochId);
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
  return requireSession(sessionId);
}

export function getExecutionSessionOwnershipEpoch(id: string) {
  const session = requireSession(id);
  const evidence = listExecutionSessionEvidence(id).find((entry) => entry.kind === 'ownership-epoch') || null;
  const ownershipEpochId = evidence ? normalizeOwnershipEpochId(readStringMetadata(evidence.metadata || {}, 'ownershipEpochId') || evidence.revisionIdentity) : null;
  return { sessionId: session.id, ownershipEpochId, evidence };
}

export function bindExecutionSessionOwnershipEpoch(id: string, ownershipEpochIdValue: string, now = new Date()) {
  const session = requireSession(id);
  assertActive(session);
  const ownershipEpochId = normalizeOwnershipEpochId(ownershipEpochIdValue);
  if (!ownershipEpochId) throw executionSessionError('EXECUTION_OWNERSHIP_EPOCH_REQUIRED', 'ownershipEpochId is required to bind execution ownership.');
  const existing = getExecutionSessionOwnershipEpoch(id);
  if (existing.ownershipEpochId && existing.ownershipEpochId !== ownershipEpochId) {
    throw executionSessionError('EXECUTION_OWNERSHIP_EPOCH_CONFLICT', `Execution session '${id}' is already bound to a different ownership epoch.`, {
      sessionId: id,
      existingOwnershipEpochId: existing.ownershipEpochId,
      requestedOwnershipEpochId: ownershipEpochId,
    });
  }
  if (existing.ownershipEpochId === ownershipEpochId) return existing;
  const nowIso = now.toISOString();
  const evidence = saveExecutionOwnershipEpochEvidence(id, ownershipEpochId, nowIso);
  updateExecutionSessionRecord(id, { updatedAt: nowIso });
  return { sessionId: id, ownershipEpochId, evidence };
}

export function getExecutionSessionState(id: string) {
  const session = requireSession(id);
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
    const session = requireSession(id);
    assertActive(session);
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
    const refreshed = requireSession(id);
    recordAutomaticExecutionCheckpoint(id, transition, now);
    result = { session: refreshed, transition, changed: true, idempotent: false };
  });
  return result;
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

function normalizeClaimScopePath(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function effectiveTaskClaimScope(task: any, workspaceId: string) {
  const claim = task?.claim;
  const expiresAtMs = Date.parse(String(claim?.expiresAt || ''));
  const activeClaim = Boolean(
    claim?.workspaceId === workspaceId
    && Number.isFinite(expiresAtMs)
    && expiresAtMs > Date.now(),
  );
  if (!activeClaim) {
    throw taskMutationError(409, 'TASK_MUTATION_ACTIVE_CLAIM_REQUIRED', `Task '${task?.displayId || task?.id || '<unknown>'}' has no active claim for workspace '${workspaceId}'.`);
  }
  return new Set<string>([
    ...(Array.isArray(task?.targetFiles) ? task.targetFiles : []),
    ...(Array.isArray((claim as any)?.reservedPaths) ? (claim as any).reservedPaths : []),
  ].map(normalizeClaimScopePath).filter(Boolean));
}

function resolveTaskMutationProjectId(args: Record<string, any>) {
  const directProjectId = String(args?.projectId || '').trim();
  if (directProjectId) return directProjectId;
  const projectName = normalizeProjectNameAlias(args?.projectName);
  const repoIdentity = normalizeProjectRepoIdentity(args?.repo || args?.repoUrl);
  const requestedLocalPath = String(args?.localPath || '').trim();
  const localPathKey = requestedLocalPath ? path.resolve(requestedLocalPath).replace(/\\/g, '/').toLowerCase() : '';
  const matches = getProjects().filter((project: any) => {
    if (projectName && normalizeProjectNameAlias(project?.name) !== projectName) return false;
    if (repoIdentity && normalizeProjectRepoIdentity(project?.repoUrl) !== repoIdentity) return false;
    if (localPathKey) {
      const projectPath = String(project?.localPath || '').trim();
      if (!projectPath || path.resolve(projectPath).replace(/\\/g, '/').toLowerCase() !== localPathKey) return false;
    }
    return Boolean(projectName || repoIdentity || localPathKey);
  });
  return matches.length === 1 ? String(matches[0].id || '').trim() || null : null;
}

export function assertTaskMutationWorkspaceBinding(args: Record<string, any>) {
  const workspaceId = String(args?.workspaceId || '').trim();
  if (workspaceId) return null;
  const capturedBinding = args?.__executionJobBinding && typeof args.__executionJobBinding === 'object'
    ? args.__executionJobBinding as Record<string, unknown>
    : null;
  const capturedWorkspaceId = String(capturedBinding?.workspaceId || '').trim();
  if (capturedWorkspaceId) {
    throw taskMutationError(409, 'TASK_MUTATION_WORKSPACE_REQUIRED', 'Task-owned mutation lost its managed workspace binding and cannot fall back to the shared project checkout.', {
      workspaceId: capturedWorkspaceId,
      taskId: String(capturedBinding?.taskId || '').trim() || null,
      executionSessionId: String(capturedBinding?.executionSessionId || '').trim() || null,
    });
  }
  const projectId = resolveTaskMutationProjectId(args);
  if (!projectId) return null;
  const active = queryExecutionSessions({ projectId, status: 'active', limit: 100 }).sessions
    .filter((entry) => Boolean(entry.taskId && entry.workspaceId));
  if (active.length === 0) return null;
  throw taskMutationError(409, 'TASK_MUTATION_WORKSPACE_REQUIRED', `Project '${projectId}' has active task execution authority; mutation must target the authoritative managed workspace instead of the shared checkout.`, {
    projectId,
    executionSessionIds: active.map((entry) => entry.id),
    taskIds: [...new Set(active.map((entry) => entry.taskId).filter(Boolean))],
    workspaceIds: [...new Set(active.map((entry) => entry.workspaceId).filter(Boolean))],
    nextAction: 'Retry the mutation with the task claim workspaceId. Explicit project-root mutation is allowed only when no active task execution authority exists.',
  });
}

export function getTaskExecutionMutationBinding(args: Record<string, any>) {
  const workspaceId = String(args?.workspaceId || '').trim();
  if (!workspaceId) {
    assertTaskMutationWorkspaceBinding(args);
    return null;
  }
  const workspace = resolveSessionWorkspace(workspaceId);
  if (!workspace) {
    throw taskMutationError(404, 'TASK_MUTATION_WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found for task-bound mutation.`);
  }
  const session = getActiveTaskExecutionSessionForWorkspace(workspaceId);
  const task = workspace.taskDisplayId
    ? getTaskByIdentifier(workspace.taskDisplayId, 'full')
    : session?.taskId
      ? getTask(session.taskId)
      : undefined;
  const taskBound = Boolean(workspace.taskDisplayId || task?.claim?.workspaceId === workspaceId || session?.taskId);
  if (!taskBound) return null;
  if (!session?.taskId) {
    throw taskMutationError(409, 'TASK_MUTATION_EXECUTION_REQUIRED', `Task-bound workspace '${workspaceId}' has no unique active execution session.`);
  }
  if (!task) {
    throw taskMutationError(404, 'TASK_MUTATION_TASK_NOT_FOUND', `Task for workspace '${workspaceId}' was not found.`);
  }
  if (session.taskId !== task.id || session.projectId !== workspace.projectId || task.projectId !== workspace.projectId) {
    throw taskMutationError(409, 'TASK_MUTATION_BINDING_MISMATCH', `Task, execution session, and workspace '${workspaceId}' do not share one authoritative binding.`);
  }
  const capturedJobBinding = args?.__executionJobBinding && typeof args.__executionJobBinding === 'object'
    ? args.__executionJobBinding as Record<string, unknown>
    : null;
  if (capturedJobBinding) {
    const capturedExecutionSessionId = String(capturedJobBinding.executionSessionId || '').trim();
    const capturedTaskId = String(capturedJobBinding.taskId || '').trim();
    const capturedWorkspaceId = String(capturedJobBinding.workspaceId || '').trim();
    const capturedProjectId = String(capturedJobBinding.projectId || '').trim();
    const operationId = String(capturedJobBinding.operationId || '').trim();
    if (!capturedExecutionSessionId || !capturedTaskId || !capturedWorkspaceId || !capturedProjectId || !operationId) {
      throw taskMutationError(409, 'TASK_MUTATION_EXECUTION_BINDING_INVALID', 'Durable job execution binding is incomplete and cannot authorize task mutation.');
    }
    if (
      capturedExecutionSessionId !== session.id
      || capturedTaskId !== task.id
      || capturedWorkspaceId !== workspaceId
      || capturedProjectId !== workspace.projectId
    ) {
      throw taskMutationError(409, 'TASK_MUTATION_EXECUTION_FENCED', `Durable operation '${operationId}' is bound to an obsolete task execution and cannot transfer authority to the current execution.`, {
        operationId,
        capturedExecutionSessionId,
        currentExecutionSessionId: session.id,
        workspaceId,
        taskId: task.id,
      });
    }
  }
  if (task.claim?.workspaceId && task.claim.workspaceId !== workspaceId) {
    throw taskMutationError(409, 'TASK_MUTATION_CLAIM_MISMATCH', `Task '${task.displayId || task.id}' is claimed by a different workspace.`);
  }
  const claimedScope = effectiveTaskClaimScope(task, workspaceId);
  return { workspaceId, workspace, session, task, claimedScope };
}

export function recordTaskExecutionContextReady(
  args: Record<string, any>,
  input: { contextHandle: string; repoRevision?: string | null; contextPlanIdentity?: string | null },
) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) return null;

  const contextHandle = String(input?.contextHandle || '').trim();
  if (!contextHandle) {
    throw taskMutationError(409, 'TASK_CONTEXT_HANDLE_REQUIRED', `Task '${binding.task.displayId || binding.task.id}' context evidence requires a context handle.`);
  }

  const repoRevision = String(input?.repoRevision || binding.session.repoRevision || '').trim() || null;
  updateExecutionSessionProgress(binding.session.id, { contextHandle, repoRevision });
  recordExecutionSessionEvidence(binding.session.id, [{
    evidenceId: `context-bundle:${contextHandle}`,
    kind: 'context-bundle',
    repoRevision,
    revisionIdentity: repoRevision || contextHandle,
    contextHandle,
    metadata: {
      source: 'repo-context-bundle',
      ...(input?.contextPlanIdentity ? { contextPlanIdentity: String(input.contextPlanIdentity) } : {}),
    },
  }], { repoRoot: binding.workspace.root });

  const current = getActiveTaskExecutionSessionForWorkspace(binding.workspaceId);
  if (current?.lifecycle.stage === 'created') {
    recordExecutionLifecycleTransition(binding.session.id, {
      toStage: 'context-ready',
      reasonCode: 'task-context-acquired',
      evidence: {
        id: `context-ready:${contextHandle}`,
        kind: 'context-bundle',
        status: 'completed',
      },
    });
  }
  return getActiveTaskExecutionSessionForWorkspace(binding.workspaceId);
}

export function authorizeTaskExecutionMutationPaths(args: Record<string, any>, paths: string[]) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) return null;
  const normalizedPaths = Array.from(new Set((paths || []).map(normalizeClaimScopePath).filter(Boolean)));
  const outOfScope = normalizedPaths.filter((entry) => !binding.claimedScope.has(entry));
  if (outOfScope.length > 0) {
    throw taskMutationError(
      409,
      'TASK_SCOPE_EXPANSION_REQUIRED',
      `Task '${binding.task.displayId || binding.task.id}' must expand its claimed scope before mutating: ${outOfScope.join(', ')}`,
      {
        outOfScope,
        effectiveScope: [...binding.claimedScope].sort(),
        workspaceId: binding.workspaceId,
      },
    );
  }
  return { ...binding, normalizedPaths };
}

export function recordTaskExecutionMutationPaths(
  args: Record<string, any>,
  paths: string[],
  source: string,
) {
  const binding = authorizeTaskExecutionMutationPaths(args, paths);
  if (!binding) return null;
  return recordExecutionOwnedChanges(binding.session.id, paths, {
    repoRoot: binding.workspace.root,
    source,
  });
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

  withDbTransaction(() => {
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
          ...(options.metadata || {}),
          ...(options.metadataByPath?.[ownedPath] || {}),
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
    const observedFileRevision = currentOwnedFileRevision(root, entry.path!);
    const knownFileRevision = readStringMetadata(metadata, 'knownFileRevision') || entry.fileRevision || 'missing';
    const contentEquivalent = sameOwnedContentRevision(observedFileRevision, knownFileRevision);
    const currentFileRevision = contentEquivalent ? knownFileRevision : observedFileRevision;
    return {
      path: entry.path!,
      acquisitionFileRevision: readStringMetadata(metadata, 'acquisitionFileRevision') || entry.fileRevision || 'missing',
      knownFileRevision,
      currentFileRevision,
      observedFileRevision,
      source: readStringMetadata(metadata, 'executionSource') || 'unknown',
      acquiredAt: readStringMetadata(metadata, 'acquiredAt'),
      observedAt: readStringMetadata(metadata, 'observedAt'),
      drifted: !contentEquivalent,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  const ownedPathSet = new Set(ownedFiles.map((entry) => entry.path));
  const changedPaths = normalizeStringList(repo.changedFiles.map((entry) => entry.workingPath));
  const ownedChanges = changedPaths.filter((entry) => ownedPathSet.has(entry));
  const unrelatedChanges = changedPaths.filter((entry) => !ownedPathSet.has(entry));
  const task = session.taskId ? getTask(session.taskId) : undefined;
  const taskScope = [
    ...(Array.isArray(task?.targetFiles) ? task.targetFiles : []),
    ...(Array.isArray((task?.claim as any)?.reservedPaths) ? (task!.claim as any).reservedPaths : []),
  ];
  const expectedScope = new Set(
    normalizeStringList(options.expectedPaths || taskScope)
      .map(normalizeClaimScopePath)
      .filter(Boolean),
  );
  const scopeDrift = expectedScope.size > 0
    ? changedPaths.filter((entry) => !expectedScope.has(normalizeClaimScopePath(entry)))
    : [];
  const currentOwnedFingerprint = ownedRevisionFingerprint(
    ownedFiles.map((entry) => ({ path: entry.path, revision: entry.currentFileRevision })),
  );
  const verificationBinding = evidence
    .filter((entry) => entry.kind === 'verification-binding' && !readStringMetadata(entry.metadata || {}, 'invalidatedAt'))
    .at(-1);
  const boundFingerprint = verificationBinding ? readStringMetadata(verificationBinding.metadata || {}, 'ownedFingerprint') : undefined;
  const verificationPolicy = verificationBinding
    ? readStringMetadata(verificationBinding.metadata || {}, 'verificationPolicy')
    : undefined;
  const verificationFresh = verificationBinding
    ? Boolean(boundFingerprint)
      && boundFingerprint === currentOwnedFingerprint
      && (session.verification.length > 0 || verificationPolicy === 'no-checks-required' || verificationPolicy === 'operator-break-glass')
    : session.verification.length === 0
      ? null
      : false;
  const ownershipDrift = ownedFiles
    .filter((entry) => entry.drifted)
    .map((entry) => ({ path: entry.path, knownFileRevision: entry.knownFileRevision, currentFileRevision: entry.currentFileRevision }));
  const verifiedOwnershipDrift = verificationFresh === true ? ownershipDrift : [];

  return {
    sessionId: id,
    repoRevision: repo.token,
    ownedFingerprint: currentOwnedFingerprint,
    ownedFiles,
    ownedChanges,
    unrelatedChanges,
    scopeDrift,
    ownershipDrift,
    verifiedOwnershipDrift,
    verificationFresh,
    verificationRecordedAt: verificationBinding ? readStringMetadata(verificationBinding.metadata || {}, 'recordedAt') : undefined,
  };
}

export function adoptExecutionOwnedChanges(
  id: string,
  files: Array<{ path: string; expectedRevision: string }>,
  options: { repoRoot: string; reason: string; now?: Date },
) {
  const session = requireSession(id);
  assertActive(session);
  const root = requireRepoRoot(options.repoRoot);
  const reason = String(options.reason || '').trim();
  if (reason.length < 10) {
    throw executionSessionError('EXECUTION_ADOPTION_REASON_REQUIRED', 'Legacy ownership adoption requires an audit reason of at least 10 characters.');
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > 100) {
    throw executionSessionError('EXECUTION_ADOPTION_FILES_REQUIRED', 'Legacy ownership adoption requires 1-100 explicit path+expectedRevision entries.');
  }

  const ownership = getExecutionOwnershipState(id, { repoRoot: root });
  const unrelated = new Set(ownership.unrelatedChanges);
  const normalized = files.map((entry) => {
    const ownedPath = normalizeEvidencePath(entry?.path);
    if (!ownedPath) {
      throw executionSessionError('EXECUTION_ADOPTION_PATH_REQUIRED', 'Legacy ownership adoption requires an explicit repository-relative path.');
    }
    const expectedRevision = String(entry?.expectedRevision || '').trim();
    if (!expectedRevision) {
      throw executionSessionError('EXECUTION_ADOPTION_REVISION_REQUIRED', `Expected revision is required for '${ownedPath}'.`);
    }
    if (!unrelated.has(ownedPath)) {
      throw executionSessionError('EXECUTION_ADOPTION_NOT_UNOWNED_DIRTY', `Path '${ownedPath}' is not a current dirty/unowned workspace path.`);
    }
    const currentRevision = currentOwnedFileRevision(root, ownedPath);
    if (currentRevision !== expectedRevision) {
      throw executionSessionError('EXECUTION_ADOPTION_REVISION_MISMATCH', `Path '${ownedPath}' changed since adoption evidence was captured.`);
    }
    return { path: ownedPath, expectedRevision, currentRevision };
  });
  if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) {
    throw executionSessionError('EXECUTION_ADOPTION_DUPLICATE_PATH', 'Legacy ownership adoption paths must be unique.');
  }

  const adoptedAt = (options.now || new Date()).toISOString();
  const metadataByPath = Object.fromEntries(normalized.map((entry) => [entry.path, {
    adoptionReason: reason,
    adoptionExpectedRevision: entry.expectedRevision,
    adoptedAt,
    adoptionMode: 'explicit-legacy-recovery',
  }]));
  const result = recordExecutionOwnedChanges(id, normalized.map((entry) => entry.path), {
    repoRoot: root,
    source: 'legacy-adoption',
    now: options.now,
    metadataByPath,
  });
  return {
    sessionId: id,
    adoptedPaths: normalized.map((entry) => entry.path),
    reason,
    ownership: result,
  };
}

export function adoptTaskExecutionOwnedChanges(args: Record<string, any>) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) {
    throw executionSessionError('EXECUTION_ADOPTION_TASK_WORKSPACE_REQUIRED', 'Legacy ownership adoption requires a task-bound managed workspace.');
  }
  const requestedTaskId = String(args?.taskId || '').trim();
  if (requestedTaskId && requestedTaskId !== binding.task.id && requestedTaskId !== binding.task.displayId) {
    throw executionSessionError('EXECUTION_ADOPTION_TASK_MISMATCH', 'Requested task does not own the selected execution workspace.');
  }
  const files = Array.isArray(args.files) ? args.files : [];
  authorizeTaskExecutionMutationPaths(args, files.map((entry: any) => entry?.path));
  try {
    return adoptExecutionOwnedChanges(binding.session.id, files, {
      repoRoot: binding.workspace.root,
      reason: String(args.reason || ''),
    });
  } catch (error: any) {
    if (error?.code) {
      throw taskMutationError(409, String(error.code), error instanceof Error ? error.message : String(error), error?.details);
    }
    throw error;
  }
}

function ownedRevisionReconciliationId(
  sessionId: string,
  files: ExecutionOwnedRevisionReconciliationFile[],
  reason: string,
  provenance: string,
) {
  const digest = crypto.createHash('sha256')
    .update(sessionId)
    .update('|owned-revision-reconciliation|')
    .update(JSON.stringify(files))
    .update('|')
    .update(reason)
    .update('|')
    .update(provenance)
    .digest('hex')
    .slice(0, 24);
  return `owned-revision-reconciliation-${digest}`;
}

function invalidateExecutionVerificationAuthorityForOwnedRevisionReconciliation(
  id: string,
  reconciliationId: string,
  nowIso: string,
) {
  for (const entry of listExecutionSessionEvidence(id)) {
    if (entry.kind !== 'verification-binding' || readStringMetadata(entry.metadata || {}, 'invalidatedAt')) continue;
    saveExecutionSessionEvidence({
      id: entry.id,
      sessionId: entry.sessionId,
      kind: entry.kind,
      path: entry.path,
      repoRevision: entry.repoRevision,
      fileRevision: entry.fileRevision,
      revisionIdentity: entry.revisionIdentity,
      contextHandle: entry.contextHandle,
      stale: true,
      metadata: {
        ...(entry.metadata || {}),
        invalidatedAt: nowIso,
        invalidationReason: 'owned-revision-reconciled',
        invalidatedByReconciliationId: reconciliationId,
        authoritative: false,
      },
      createdAt: entry.createdAt,
      updatedAt: nowIso,
    });
  }

  const batch = getExecutionVerificationBatchState(id);
  if (batch && (batch.status === 'pending' || batch.status === 'complete')) {
    const staleResults = Object.fromEntries(
      batch.requiredChecks.map((checkId) => [checkId, 'stale' as VerificationBatchResultStatus]),
    );
    const staleState = buildExecutionVerificationBatchState({
      batchId: batch.batchId,
      ownershipEpochId: batch.ownershipEpochId,
      repoRevision: batch.repoRevision,
      ownedFingerprint: batch.ownedFingerprint,
      requiredChecks: batch.requiredChecks,
      createdAt: batch.createdAt,
    }, staleResults, batch.memberCandidates, nowIso);
    persistExecutionVerificationBatchState(id, staleState);
  }
}

export function reconcileExecutionOwnedRevisionDrift(
  id: string,
  files: ExecutionOwnedRevisionReconciliationFile[],
  options: { repoRoot: string; reason: string; provenance: string; now?: Date },
) {
  const session = requireSession(id);
  assertActive(session);
  const root = requireRepoRoot(options.repoRoot);
  const reason = String(options.reason || '').trim();
  const provenance = String(options.provenance || '').trim();
  if (reason.length < 10 || reason.length > 500) {
    throw executionSessionError('EXECUTION_RECONCILIATION_REASON_REQUIRED', 'Owned revision reconciliation requires an audit reason between 10 and 500 characters.');
  }
  if (provenance.length < 3 || provenance.length > 240) {
    throw executionSessionError('EXECUTION_RECONCILIATION_PROVENANCE_REQUIRED', 'Owned revision reconciliation requires bounded provenance between 3 and 240 characters.');
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > 100) {
    throw executionSessionError('EXECUTION_RECONCILIATION_FILES_REQUIRED', 'Owned revision reconciliation requires 1-100 explicit revision-guarded files.');
  }

  const normalized = files.map((entry) => {
    const ownedPath = normalizeEvidencePath(entry?.path);
    if (!ownedPath) {
      throw executionSessionError('EXECUTION_RECONCILIATION_PATH_REQUIRED', 'Owned revision reconciliation requires an explicit repository-relative path.');
    }
    const expectedKnownRevision = String(entry?.expectedKnownRevision || '').trim();
    const expectedCurrentRevision = String(entry?.expectedCurrentRevision || '').trim();
    if (!expectedKnownRevision || !expectedCurrentRevision) {
      throw executionSessionError('EXECUTION_RECONCILIATION_REVISION_REQUIRED', `Owned revision reconciliation requires prior/current revision guards for '${ownedPath}'.`);
    }
    return { path: ownedPath, expectedKnownRevision, expectedCurrentRevision };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) {
    throw executionSessionError('EXECUTION_RECONCILIATION_DUPLICATE_PATH', 'Owned revision reconciliation paths must be unique.');
  }

  const ownership = getExecutionOwnershipState(id, { repoRoot: root });
  const ownedStateByPath = new Map(ownership.ownedFiles.map((entry) => [entry.path, entry] as const));
  const ownedEvidenceByPath = new Map(
    listExecutionSessionEvidence(id)
      .filter((entry) => entry.kind === 'owned-change' && entry.path)
      .map((entry) => [entry.path!, entry] as const),
  );
  const reconciliationId = ownedRevisionReconciliationId(id, normalized, reason, provenance);
  const replayFlags = normalized.map((entry) => {
    const evidence = ownedEvidenceByPath.get(entry.path);
    const state = ownedStateByPath.get(entry.path);
    if (!evidence || !state) return false;
    return readStringMetadata(evidence.metadata || {}, 'ownedRevisionReconciliationId') === reconciliationId
      && state.knownFileRevision === entry.expectedCurrentRevision
      && currentOwnedFileRevision(root, entry.path) === entry.expectedCurrentRevision;
  });
  if (replayFlags.every(Boolean)) {
    return {
      sessionId: id,
      reconciliationId,
      reconciledPaths: normalized.map((entry) => entry.path),
      reason,
      provenance,
      idempotent: true,
      ownership: getExecutionOwnershipState(id, { repoRoot: root }),
    };
  }
  if (replayFlags.some(Boolean)) {
    throw executionSessionError('EXECUTION_RECONCILIATION_PARTIAL_REPLAY', 'Owned revision reconciliation request is only partially replayed and cannot be applied safely.');
  }

  for (const entry of normalized) {
    const state = ownedStateByPath.get(entry.path);
    const evidence = ownedEvidenceByPath.get(entry.path);
    if (!state || !evidence) {
      throw executionSessionError('EXECUTION_RECONCILIATION_NOT_OWNED', `Path '${entry.path}' is not owned by the selected execution session.`);
    }
    if (state.knownFileRevision !== entry.expectedKnownRevision) {
      throw executionSessionError('EXECUTION_RECONCILIATION_PRIOR_REVISION_MISMATCH', `Path '${entry.path}' prior owned revision no longer matches reconciliation evidence.`);
    }
    const currentRevision = currentOwnedFileRevision(root, entry.path);
    if (currentRevision !== entry.expectedCurrentRevision) {
      throw executionSessionError('EXECUTION_RECONCILIATION_CURRENT_REVISION_MISMATCH', `Path '${entry.path}' current revision changed since reconciliation evidence was captured.`);
    }
    if (!state.drifted) {
      throw executionSessionError('EXECUTION_RECONCILIATION_NOT_DRIFTED', `Path '${entry.path}' is already aligned with its known owned revision.`);
    }
  }

  const nowIso = (options.now || new Date()).toISOString();
  const repo = getRepoRevisionForRoot(root);
  withDbTransaction(() => {
    for (const entry of normalized) {
      const currentRevision = currentOwnedFileRevision(root, entry.path);
      if (currentRevision !== entry.expectedCurrentRevision) {
        throw executionSessionError('EXECUTION_RECONCILIATION_CURRENT_REVISION_MISMATCH', `Path '${entry.path}' changed while reconciliation was being applied.`);
      }
    }
    for (const entry of normalized) {
      const prior = ownedEvidenceByPath.get(entry.path)!;
      const priorMetadata = prior.metadata || {};
      saveExecutionSessionEvidence({
        id: prior.id,
        sessionId: id,
        kind: 'owned-change',
        path: entry.path,
        repoRevision: repo.token,
        fileRevision: entry.expectedCurrentRevision,
        revisionIdentity: buildRepoEvidenceIdentity({ repoRevision: repo.token, filePath: entry.path, fileRevision: entry.expectedCurrentRevision }),
        contextHandle: session.contextHandle,
        stale: false,
        metadata: {
          ...priorMetadata,
          executionSource: 'owned-revision-reconciliation',
          knownFileRevision: entry.expectedCurrentRevision,
          observedAt: nowIso,
          ownedRevisionReconciliationId: reconciliationId,
          reconciliationExpectedKnownRevision: entry.expectedKnownRevision,
          reconciliationExpectedCurrentRevision: entry.expectedCurrentRevision,
          reconciliationReason: reason,
          reconciliationProvenance: provenance,
          reconciledAt: nowIso,
        },
        createdAt: prior.createdAt,
        updatedAt: nowIso,
      });
    }
    updateExecutionSessionRecord(id, { repoRevision: repo.token, updatedAt: nowIso });
    invalidateExecutionVerificationAuthorityForOwnedRevisionReconciliation(id, reconciliationId, nowIso);
  });

  return {
    sessionId: id,
    reconciliationId,
    reconciledPaths: normalized.map((entry) => entry.path),
    reason,
    provenance,
    idempotent: false,
    ownership: getExecutionOwnershipState(id, { repoRoot: root }),
  };
}

export function reconcileTaskExecutionOwnedRevisionDrift(args: Record<string, any>) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) {
    throw executionSessionError('EXECUTION_RECONCILIATION_TASK_WORKSPACE_REQUIRED', 'Owned revision reconciliation requires a task-bound managed workspace.');
  }
  const requestedTaskId = String(args?.taskId || '').trim();
  if (!requestedTaskId) {
    throw executionSessionError('EXECUTION_RECONCILIATION_TASK_REQUIRED', 'Owned revision reconciliation requires the exact owning task id.');
  }
  if (requestedTaskId !== binding.task.id && requestedTaskId !== binding.task.displayId) {
    throw executionSessionError('EXECUTION_RECONCILIATION_TASK_MISMATCH', 'Requested task does not own the selected execution workspace.');
  }
  const requestedExecutionSessionId = String(args?.executionSessionId || '').trim();
  if (!requestedExecutionSessionId) {
    throw executionSessionError('EXECUTION_RECONCILIATION_EXECUTION_REQUIRED', 'Owned revision reconciliation requires the exact active executionSessionId.');
  }
  if (requestedExecutionSessionId !== binding.session.id) {
    throw executionSessionError('EXECUTION_RECONCILIATION_EXECUTION_MISMATCH', 'Requested execution session does not own the selected task workspace.');
  }
  const files = Array.isArray(args.files) ? args.files : [];
  authorizeTaskExecutionMutationPaths(args, files.map((entry: any) => entry?.path));
  try {
    return reconcileExecutionOwnedRevisionDrift(binding.session.id, files, {
      repoRoot: binding.workspace.root,
      reason: String(args.reason || ''),
      provenance: String(args.provenance || ''),
    });
  } catch (error: any) {
    if (error?.code) {
      throw taskMutationError(409, String(error.code), error instanceof Error ? error.message : String(error), error?.details);
    }
    throw error;
  }
}

export function captureExecutionVerificationProvenance(
  id: string,
  options: { repoRoot: string },
) {
  const ownership = getExecutionOwnershipState(id, { repoRoot: options.repoRoot });
  return {
    repoRevision: ownership.repoRevision,
    ownedFingerprint: ownership.ownedFingerprint,
    ownedPaths: ownership.ownedFiles.map((entry) => entry.path),
  };
}

function lifecycleVerificationCoverageIdentity(
  value: any,
  root: string,
  ownedPaths: string[] | undefined,
) {
  if (!value || typeof value !== 'object') return null;
  const paths = Array.isArray(value.affectedInputPaths) ? value.affectedInputPaths.filter(Boolean).map(String) : [];
  if (paths.length > 0 || !ownedPaths?.length) return buildVerificationCoverageIdentity(value);
  const repo = getRepoRevisionForRoot(root);
  const affected = buildRepoAffectedInputIdentity(root, repo, ownedPaths);
  return buildVerificationCoverageIdentity({
    ...value,
    affectedInputFingerprint: affected.fingerprint,
    affectedInputPaths: affected.paths,
  });
}

function normalizeExecutionVerificationBatchChecks(values: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_VERIFICATION_BATCH_CHECKS) {
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_CHECKS_REQUIRED', `Verification batch requires 1-${MAX_VERIFICATION_BATCH_CHECKS} declared checks.`);
  }
  const checks = values.map((value) => String(value || '').trim());
  if (checks.some((value) => !value || value.length > 200)) {
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_CHECK_INVALID', 'Verification batch check ids must be non-empty and bounded.');
  }
  if (new Set(checks).size !== checks.length) {
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_CHECK_DUPLICATE', 'Verification batch required checks must be unique.');
  }
  return checks;
}

function normalizeExecutionVerificationBatchCandidate(value: any): ExecutionVerificationBatchMemberCandidate {
  const candidateId = String(value?.candidateId || '').trim();
  const repoRevision = String(value?.repoRevision || '').trim();
  const executionKey = String(value?.executionKey || '').trim();
  if (!candidateId || !repoRevision || !executionKey) {
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_CANDIDATE_REQUIRED', 'Verification batch members require candidateId, repoRevision, and executionKey.');
  }
  const coverage = buildVerificationCoverageIdentity(value?.coverage);
  return { candidateId, repoRevision, executionKey, ...(coverage ? { coverage } : {}) };
}

function executionVerificationBatchEvidenceId(sessionId: string, batchId: string) {
  const digest = crypto.createHash('sha256').update(sessionId).update('|verification-batch|').update(batchId).digest('hex').slice(0, 24);
  return `verification-batch-${digest}`;
}

function executionVerificationBatchStateFromEvidence(entry: ExecutionSessionEvidenceRecord): ExecutionVerificationBatchState | null {
  if (entry.kind !== 'verification-batch') return null;
  const metadata = entry.metadata || {};
  const batchId = String(metadata.batchId || '').trim();
  const ownershipEpochId = String(metadata.ownershipEpochId || '').trim();
  const repoRevision = String(metadata.repoRevision || '').trim();
  const ownedFingerprint = String(metadata.ownedFingerprint || '').trim();
  const status = String(metadata.status || '') as ExecutionVerificationBatchStatus;
  if (!batchId || !ownershipEpochId || !repoRevision || !ownedFingerprint || !['pending', 'complete', 'failed', 'stale'].includes(status)) return null;
  const requiredChecks = Array.isArray(metadata.requiredChecks) ? metadata.requiredChecks.map(String) : [];
  const results = metadata.results && typeof metadata.results === 'object' && !Array.isArray(metadata.results)
    ? { ...(metadata.results as Record<string, VerificationBatchResultStatus>) }
    : {};
  const memberCandidates = metadata.memberCandidates && typeof metadata.memberCandidates === 'object' && !Array.isArray(metadata.memberCandidates)
    ? { ...(metadata.memberCandidates as Record<string, ExecutionVerificationBatchMemberCandidate>) }
    : {};
  return {
    batchId,
    ownershipEpochId,
    repoRevision,
    ownedFingerprint,
    requiredChecks,
    results,
    memberCandidates,
    pending: Array.isArray(metadata.pending) ? metadata.pending.map(String) : [],
    passed: Array.isArray(metadata.passed) ? metadata.passed.map(String) : [],
    failed: Array.isArray(metadata.failed) ? metadata.failed.map(String) : [],
    stale: Array.isArray(metadata.stale) ? metadata.stale.map(String) : [],
    status,
    canComplete: metadata.canComplete === true,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function getExecutionVerificationBatchState(id: string) {
  requireSession(id);
  return listExecutionSessionEvidence(id)
    .filter((entry) => entry.kind === 'verification-batch')
    .map(executionVerificationBatchStateFromEvidence)
    .filter((entry): entry is ExecutionVerificationBatchState => Boolean(entry))
    .at(-1) || null;
}

function persistExecutionVerificationBatchState(id: string, state: ExecutionVerificationBatchState) {
  const evidenceIdValue = executionVerificationBatchEvidenceId(id, state.batchId);
  const existing = listExecutionSessionEvidence(id).find((entry) => entry.id === evidenceIdValue);
  return saveExecutionSessionEvidence({
    id: evidenceIdValue,
    sessionId: id,
    kind: 'verification-batch',
    path: null,
    repoRevision: state.repoRevision,
    fileRevision: null,
    revisionIdentity: state.ownedFingerprint,
    contextHandle: requireSession(id).contextHandle,
    stale: state.status === 'stale',
    metadata: {
      batchId: state.batchId,
      ownershipEpochId: state.ownershipEpochId,
      repoRevision: state.repoRevision,
      ownedFingerprint: state.ownedFingerprint,
      requiredChecks: state.requiredChecks,
      results: state.results,
      memberCandidates: state.memberCandidates,
      pending: state.pending,
      passed: state.passed,
      failed: state.failed,
      stale: state.stale,
      status: state.status,
      canComplete: state.canComplete,
    },
    createdAt: existing?.createdAt || state.createdAt,
    updatedAt: state.updatedAt,
  });
}

function invalidateExecutionVerificationBindingsForBatch(id: string, batchId: string, nowIso: string) {
  for (const entry of listExecutionSessionEvidence(id)) {
    if (entry.kind !== 'verification-binding' || readStringMetadata(entry.metadata || {}, 'invalidatedAt')) continue;
    saveExecutionSessionEvidence({
      id: entry.id,
      sessionId: entry.sessionId,
      kind: entry.kind,
      path: entry.path,
      repoRevision: entry.repoRevision,
      fileRevision: entry.fileRevision,
      revisionIdentity: entry.revisionIdentity,
      contextHandle: entry.contextHandle,
      stale: entry.stale,
      metadata: {
        ...(entry.metadata || {}),
        invalidatedAt: nowIso,
        invalidationReason: 'verification-batch-started',
        invalidatedByBatchId: batchId,
        authoritative: false,
      },
      createdAt: entry.createdAt,
      updatedAt: nowIso,
    });
  }
}

function buildExecutionVerificationBatchState(
  base: Pick<ExecutionVerificationBatchState, 'batchId' | 'ownershipEpochId' | 'repoRevision' | 'ownedFingerprint' | 'requiredChecks' | 'createdAt'>,
  results: Record<string, VerificationBatchResultStatus>,
  memberCandidates: Record<string, ExecutionVerificationBatchMemberCandidate>,
  updatedAt: string,
): ExecutionVerificationBatchState {
  const canonicalCandidate = {
    candidateId: `execution-batch:${base.batchId}`,
    repoRevision: base.repoRevision,
    executionKey: crypto.createHash('sha256')
      .update(base.ownershipEpochId)
      .update('|')
      .update(base.ownedFingerprint)
      .digest('hex'),
  };
  const canonical = createVerificationBatch(canonicalCandidate, base.requiredChecks);
  for (const checkId of base.requiredChecks) {
    const status = results[checkId];
    if (status) canonical.recordResult({ checkId, status, candidate: canonicalCandidate });
  }
  const snapshot = canonical.snapshot();
  const status: ExecutionVerificationBatchStatus = snapshot.stale.length > 0
    ? 'stale'
    : snapshot.failed.length > 0
      ? 'failed'
      : snapshot.canComplete
        ? 'complete'
        : 'pending';
  return {
    ...base,
    results: { ...snapshot.results },
    memberCandidates,
    pending: [...snapshot.pending],
    passed: [...snapshot.passed],
    failed: [...snapshot.failed],
    stale: [...snapshot.stale],
    status,
    canComplete: snapshot.canComplete,
    updatedAt,
  };
}

export function recordExecutionVerificationBatchResult(
  id: string,
  input: {
    repoRoot: string;
    batchId: string;
    requiredChecks: string[];
    checkId: string;
    status: VerificationBatchResultStatus;
    captured: { repoRevision: string; ownedFingerprint: string; ownedPaths?: string[] };
    memberCandidate: ExecutionVerificationBatchMemberCandidate;
    now?: Date;
  },
) {
  const session = requireSession(id);
  assertActive(session);
  const root = requireRepoRoot(input.repoRoot);
  const batchId = String(input.batchId || '').trim();
  if (!batchId || batchId.length > 160) throw executionSessionError('EXECUTION_VERIFICATION_BATCH_ID_REQUIRED', 'A bounded verification batch id is required.');
  const requiredChecks = normalizeExecutionVerificationBatchChecks(input.requiredChecks);
  const checkId = String(input.checkId || '').trim();
  if (!requiredChecks.includes(checkId)) throw executionSessionError('EXECUTION_VERIFICATION_BATCH_CHECK_NOT_REQUIRED', `Verification check '${checkId}' is not declared by batch '${batchId}'.`);
  if (input.status !== 'passed' && input.status !== 'failed' && input.status !== 'stale') {
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_STATUS_INVALID', 'Verification batch result status must be passed, failed, or stale.');
  }
  const capturedRepoRevision = String(input.captured?.repoRevision || '').trim();
  const capturedOwnedFingerprint = String(input.captured?.ownedFingerprint || '').trim();
  if (!capturedRepoRevision || !capturedOwnedFingerprint) {
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_PROVENANCE_REQUIRED', 'Verification batch requires captured repo revision and owned fingerprint.');
  }
  const ownershipEpochId = String(getExecutionSessionOwnershipEpoch(id).ownershipEpochId || '').trim();
  if (!ownershipEpochId) throw executionSessionError('EXECUTION_VERIFICATION_BATCH_OWNERSHIP_EPOCH_REQUIRED', 'Verification batch requires an authoritative execution ownership epoch.');
  const memberCandidate = normalizeExecutionVerificationBatchCandidate(input.memberCandidate);
  if (memberCandidate.repoRevision !== capturedRepoRevision) {
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_CANDIDATE_MISMATCH', 'Verification batch member candidate revision does not match the frozen batch revision.');
  }

  const ownership = getExecutionOwnershipState(id, { repoRoot: root });
  const nowIso = (input.now || new Date()).toISOString();
  const latest = getExecutionVerificationBatchState(id);
  const existing = latest?.batchId === batchId ? latest : null;
  if (ownership.repoRevision !== capturedRepoRevision || ownership.ownedFingerprint !== capturedOwnedFingerprint) {
    if (existing?.status === 'pending'
      && existing.ownershipEpochId === ownershipEpochId
      && existing.repoRevision === capturedRepoRevision
      && existing.ownedFingerprint === capturedOwnedFingerprint
      && JSON.stringify(existing.requiredChecks) === JSON.stringify(requiredChecks)) {
      const staleState = buildExecutionVerificationBatchState({
        batchId,
        ownershipEpochId,
        repoRevision: capturedRepoRevision,
        ownedFingerprint: capturedOwnedFingerprint,
        requiredChecks,
        createdAt: existing.createdAt,
      }, { ...existing.results, [checkId]: 'stale' }, { ...existing.memberCandidates, [checkId]: memberCandidate }, nowIso);
      persistExecutionVerificationBatchState(id, staleState);
      return {
        authoritative: false,
        idempotent: false,
        state: staleState,
        reasonCode: 'EXECUTION_VERIFICATION_BATCH_STALE' as TaskExecutionVerificationBindingReason,
        verificationFresh: ownership.verificationFresh,
        sessionId: id,
        repoRevision: ownership.repoRevision,
        ownedFingerprint: ownership.ownedFingerprint,
      };
    }
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_STALE', 'Verification batch provenance no longer matches the live execution ownership revision.', {
      expectedRepoRevision: capturedRepoRevision,
      currentRepoRevision: ownership.repoRevision,
      expectedOwnedFingerprint: capturedOwnedFingerprint,
      currentOwnedFingerprint: ownership.ownedFingerprint,
    });
  }
  if (!existing && latest?.status === 'pending' && latest.repoRevision === ownership.repoRevision && latest.ownedFingerprint === ownership.ownedFingerprint) {
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_ACTIVE', `Verification batch '${latest.batchId}' is still pending and must complete or become stale before '${batchId}' can start.`);
  }
  if (existing) {
    if (existing.ownershipEpochId !== ownershipEpochId || existing.repoRevision !== capturedRepoRevision || existing.ownedFingerprint !== capturedOwnedFingerprint) {
      throw executionSessionError('EXECUTION_VERIFICATION_BATCH_IDENTITY_MISMATCH', `Verification batch '${batchId}' is bound to a different execution ownership identity.`);
    }
    if (JSON.stringify(existing.requiredChecks) !== JSON.stringify(requiredChecks)) {
      throw executionSessionError('EXECUTION_VERIFICATION_BATCH_REQUIRED_SET_CHANGED', `Verification batch '${batchId}' required checks are immutable after the first member result.`);
    }
    const priorStatus = existing.results[checkId];
    if (priorStatus) {
      const priorCandidate = existing.memberCandidates[checkId];
      if (priorStatus === input.status
        && priorCandidate?.candidateId === memberCandidate.candidateId
        && priorCandidate?.repoRevision === memberCandidate.repoRevision
        && priorCandidate?.executionKey === memberCandidate.executionKey) {
        return { authoritative: existing.canComplete, idempotent: true, state: existing, verificationFresh: getExecutionOwnershipState(id, { repoRoot: root }).verificationFresh };
      }
      throw executionSessionError('EXECUTION_VERIFICATION_BATCH_TERMINAL', `Verification batch '${batchId}' member '${checkId}' already has a terminal result and cannot be overwritten.`);
    }
    if (existing.status !== 'pending') {
      throw executionSessionError('EXECUTION_VERIFICATION_BATCH_TERMINAL', `Verification batch '${batchId}' is terminal (${existing.status}) and cannot accept additional results.`);
    }
  }

  const createdAt = existing?.createdAt || nowIso;
  const results = { ...(existing?.results || {}), [checkId]: input.status };
  const memberCandidates = { ...(existing?.memberCandidates || {}), [checkId]: memberCandidate };
  if (!existing) invalidateExecutionVerificationBindingsForBatch(id, batchId, nowIso);
  const state = buildExecutionVerificationBatchState({
    batchId,
    ownershipEpochId,
    repoRevision: capturedRepoRevision,
    ownedFingerprint: capturedOwnedFingerprint,
    requiredChecks,
    createdAt,
  }, results, memberCandidates, nowIso);
  persistExecutionVerificationBatchState(id, state);

  if (state.canComplete) {
    const executionKey = crypto.createHash('sha256')
      .update(batchId)
      .update('|')
      .update(requiredChecks.map((requiredCheck) => memberCandidates[requiredCheck]?.executionKey || '').join('|'))
      .digest('hex');
    const candidateId = `batch-${crypto.createHash('sha256').update(id).update('|').update(batchId).digest('hex').slice(0, 24)}`;
    const recorded = recordExecutionVerificationEvidence(id, requiredChecks.map((requiredCheck) => ({
      name: requiredCheck,
      command: requiredCheck,
      status: 'passed',
    })), {
      repoRoot: root,
      provenance: {
        policy: 'checks-passed',
        expectedRepoRevision: capturedRepoRevision,
        expectedOwnedFingerprint: capturedOwnedFingerprint,
        candidateId,
        candidateRepoRevision: capturedRepoRevision,
        executionKey,
        coverage: requiredChecks
          .map((requiredCheck) => memberCandidates[requiredCheck]?.coverage)
          .filter((entry): entry is VerificationCoverageIdentity => Boolean(entry)),
      },
    });
    return { authoritative: recorded.ownership.verificationFresh === true, idempotent: false, state, verificationFresh: recorded.ownership.verificationFresh, ...recorded };
  }

  const reasonCode: TaskExecutionVerificationBindingReason = state.status === 'pending'
    ? 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE'
    : state.status === 'stale'
      ? 'EXECUTION_VERIFICATION_BATCH_STALE'
      : 'EXECUTION_VERIFICATION_BATCH_FAILED';
  return {
    authoritative: false,
    idempotent: false,
    state,
    reasonCode,
    verificationFresh: getExecutionOwnershipState(id, { repoRoot: root }).verificationFresh,
    sessionId: id,
    repoRevision: ownership.repoRevision,
    ownedFingerprint: ownership.ownedFingerprint,
  };
}

export function recordTaskExecutionVerificationResult(
  args: Record<string, any>,
  result: any,
  captured?: { repoRevision: string; ownedFingerprint: string; ownedPaths?: string[] } | null,
): TaskExecutionVerificationBindingOutcome {
  const batchRequest = args?.verificationBatch && typeof args.verificationBatch === 'object' && !Array.isArray(args.verificationBatch)
    ? args.verificationBatch as Record<string, unknown>
    : null;
  if (batchRequest) {
    const binding = getTaskExecutionMutationBinding(args);
    if (!binding) {
      return {
        authoritative: false,
        reasonCode: 'EXECUTION_VERIFICATION_TASK_BINDING_MISSING',
        verificationFresh: null,
        message: 'Sequential verification batch result is not bound to an active task execution workspace.',
      };
    }
    const ownership = getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root });
    const memberCandidate = result?.verificationCandidate;
    if (!captured?.repoRevision || !captured?.ownedFingerprint || !memberCandidate?.candidateId || !memberCandidate?.repoRevision || !memberCandidate?.executionKey) {
      return {
        authoritative: false,
        reasonCode: 'EXECUTION_VERIFICATION_CANDIDATE_REQUIRED',
        verificationFresh: ownership.verificationFresh,
        sessionId: binding.session.id,
        repoRevision: ownership.repoRevision,
        ownedFingerprint: ownership.ownedFingerprint,
        ownership,
        message: 'Sequential verification batch members require captured execution provenance and a verification candidate identity.',
      };
    }
    const memberStatus: VerificationBatchResultStatus = result?.verificationCandidate?.current === false
      ? 'stale'
      : (!result?.ok || result?.status !== 'succeeded')
        ? 'failed'
        : 'passed';
    try {
      const recorded = recordExecutionVerificationBatchResult(binding.session.id, {
        repoRoot: binding.workspace.root,
        batchId: String(batchRequest.id || ''),
        requiredChecks: Array.isArray(batchRequest.requiredChecks) ? batchRequest.requiredChecks.map(String) : [],
        checkId: String(batchRequest.checkId || args?.command || args?.preset || ''),
        status: memberStatus,
        captured,
        memberCandidate: {
          candidateId: String(memberCandidate.candidateId),
          repoRevision: String(memberCandidate.repoRevision),
          executionKey: String(memberCandidate.executionKey),
          coverage: lifecycleVerificationCoverageIdentity(
            (args as any)?.__verificationCandidate?.executionIdentity,
            binding.workspace.root,
            captured?.ownedPaths,
          ) || undefined,
        },
      });
      const refreshedOwnership = getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root });
      const reasonCode: TaskExecutionVerificationBindingReason = recorded.authoritative
        ? 'EXECUTION_VERIFICATION_AUTHORITATIVE'
        : (recorded.reasonCode || (recorded.state.status === 'pending'
          ? 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE'
          : recorded.state.status === 'stale'
            ? 'EXECUTION_VERIFICATION_BATCH_STALE'
            : 'EXECUTION_VERIFICATION_BATCH_FAILED'));
      return {
        authoritative: recorded.authoritative,
        reasonCode,
        verificationFresh: refreshedOwnership.verificationFresh,
        sessionId: binding.session.id,
        repoRevision: refreshedOwnership.repoRevision,
        ownedFingerprint: refreshedOwnership.ownedFingerprint,
        ownership: refreshedOwnership,
        details: { batch: recorded.state, idempotent: recorded.idempotent },
        message: recorded.authoritative
          ? 'All declared sequential verification checks passed on the frozen execution ownership revision.'
          : recorded.state.status === 'pending'
            ? `Verification batch '${recorded.state.batchId}' is incomplete; remaining checks: ${recorded.state.pending.join(', ')}.`
            : `Verification batch '${recorded.state.batchId}' is ${recorded.state.status} and cannot authorize commit.`,
      };
    } catch (error: any) {
      return {
        authoritative: false,
        reasonCode: error?.code === 'EXECUTION_VERIFICATION_BATCH_STALE'
          ? 'EXECUTION_VERIFICATION_BATCH_STALE'
          : 'EXECUTION_VERIFICATION_REJECTED',
        verificationFresh: getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root }).verificationFresh,
        sessionId: binding.session.id,
        repoRevision: ownership.repoRevision,
        ownedFingerprint: ownership.ownedFingerprint,
        ownership,
        errorCode: typeof error?.code === 'string' ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
        details: error?.details,
      };
    }
  }
  if (!result?.ok || result?.status !== 'succeeded') {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_RESULT_NOT_SUCCEEDED',
      verificationFresh: false,
      message: 'Verification result did not complete successfully and cannot become authoritative evidence.',
    };
  }

  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_TASK_BINDING_MISSING',
      verificationFresh: null,
      message: 'Verification result is not bound to an active task execution workspace.',
    };
  }

  const batchCandidate = result?.verificationBatch?.canComplete === true
    ? result.verificationBatch.candidate
    : null;
  const commandCandidate = result?.verificationCandidate?.current !== false
    ? result.verificationCandidate
    : null;
  const candidate = batchCandidate || commandCandidate;
  const explicitNoChecks = result?.verificationPolicy === 'no-checks-required';
  const ownership = getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root });
  const latestBatch = getExecutionVerificationBatchState(binding.session.id);
  if (latestBatch?.status === 'pending') {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      details: { batch: latestBatch },
      message: `Verification batch '${latestBatch.batchId}' is incomplete and must continue through its declared batch identity.`,
    };
  }
  if (latestBatch?.status === 'failed' || latestBatch?.status === 'stale') {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_RECOVERY_BATCH_REQUIRED',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      details: { batch: latestBatch },
      message: `Verification batch '${latestBatch.batchId}' is ${latestBatch.status}; diagnostic verification cannot supersede it. Start a fresh explicit verification recovery batch on the current execution ownership revision.`,
    };
  }

  if (explicitNoChecks && (!captured?.repoRevision || !captured?.ownedFingerprint)) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_PROVENANCE_REQUIRED',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      message: 'No-check-required verification must include the captured execution revision and owned fingerprint.',
    };
  }
  if (!explicitNoChecks && (!candidate?.candidateId || !candidate?.repoRevision || !candidate?.executionKey)) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_CANDIDATE_REQUIRED',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      message: 'Passed task-bound verification requires candidate id, candidate revision, and execution key.',
    };
  }

  const expectedRepoRevision = captured?.repoRevision || candidate?.repoRevision;
  if (expectedRepoRevision && expectedRepoRevision !== ownership.repoRevision) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_REPO_REVISION_STALE',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      details: { expectedRepoRevision, currentRepoRevision: ownership.repoRevision },
      message: 'Captured verification revision no longer matches the live execution workspace.',
    };
  }
  if (candidate?.repoRevision && candidate.repoRevision !== ownership.repoRevision) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_CANDIDATE_STALE',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      details: { candidateRepoRevision: candidate.repoRevision, currentRepoRevision: ownership.repoRevision },
      message: 'Verification candidate revision no longer matches the live execution workspace.',
    };
  }
  if (captured?.ownedFingerprint && captured.ownedFingerprint !== ownership.ownedFingerprint) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_FINGERPRINT_STALE',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      details: { expectedOwnedFingerprint: captured.ownedFingerprint, currentOwnedFingerprint: ownership.ownedFingerprint },
      message: 'Captured owned-file fingerprint no longer matches the live execution workspace.',
    };
  }

  const checks = explicitNoChecks
    ? []
    : batchCandidate
      ? (Array.isArray(result.verification)
        ? result.verification.map((entry: any) => ({
          name: String(entry?.command || 'verification'),
          command: String(entry?.command || 'verification'),
          status: entry?.ok === true ? 'passed' : 'failed',
        }))
        : [])
      : [{
        name: String(args?.command || args?.preset || 'run_project_command'),
        command: String(args?.command || args?.preset || 'run_project_command'),
        status: 'passed',
      }];
  const policy: ExecutionVerificationProvenance['policy'] = explicitNoChecks || checks.length === 0
    ? 'no-checks-required'
    : 'checks-passed';

  try {
    const recorded = recordExecutionVerificationEvidence(binding.session.id, checks, {
      repoRoot: binding.workspace.root,
      provenance: {
        policy,
        expectedRepoRevision,
        expectedOwnedFingerprint: captured?.ownedFingerprint,
        candidateId: candidate?.candidateId,
        candidateRepoRevision: candidate?.repoRevision,
        executionKey: candidate?.executionKey,
        coverage: checks.length > 0
          ? [lifecycleVerificationCoverageIdentity(
              (args as any)?.__verificationCandidate?.executionIdentity,
              binding.workspace.root,
              captured?.ownedPaths,
            )].filter((entry): entry is VerificationCoverageIdentity => Boolean(entry))
          : [],
      },
    });
    if (recorded.ownership.verificationFresh !== true) {
      return {
        authoritative: false,
        reasonCode: 'EXECUTION_VERIFICATION_BINDING_NOT_FRESH',
        verificationFresh: recorded.ownership.verificationFresh,
        sessionId: binding.session.id,
        repoRevision: recorded.ownership.repoRevision,
        ownedFingerprint: recorded.ownership.ownedFingerprint,
        ...recorded,
        message: 'Verification evidence was persisted but did not bind freshness to the current owned fingerprint.',
      };
    }
    return {
      authoritative: true,
      reasonCode: 'EXECUTION_VERIFICATION_AUTHORITATIVE',
      verificationFresh: true,
      sessionId: binding.session.id,
      repoRevision: recorded.ownership.repoRevision,
      ownedFingerprint: recorded.ownership.ownedFingerprint,
      ...recorded,
    };
  } catch (error: any) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_REJECTED',
      verificationFresh: getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root }).verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      errorCode: typeof error?.code === 'string' ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
      details: error?.details,
    };
  }
}

export function recordExecutionVerificationEvidence(
  id: string,
  verification: unknown[],
  options: RecordExecutionVerificationOptions,
) {
  const session = requireSession(id);
  assertActive(session);
  const root = requireRepoRoot(options.repoRoot);
  const nowIso = (options.now || new Date()).toISOString();
  const repo = getRepoRevisionForRoot(root);
  const ownership = getExecutionOwnershipState(id, { repoRoot: root });
  const ownedFingerprint = ownership.ownedFingerprint;
  const provenance = options.provenance;
  const normalizedVerification = Array.isArray(verification) ? verification : [];

  if (provenance) {
    if (provenance.expectedRepoRevision && provenance.expectedRepoRevision !== repo.token) {
      throw executionSessionError('EXECUTION_VERIFICATION_STALE', 'Verification repo revision no longer matches the live execution workspace.');
    }
    if (provenance.candidateRepoRevision && provenance.candidateRepoRevision !== repo.token) {
      throw executionSessionError('EXECUTION_VERIFICATION_STALE', 'Verification candidate revision no longer matches the live execution workspace.');
    }
    if (provenance.expectedOwnedFingerprint && provenance.expectedOwnedFingerprint !== ownedFingerprint) {
      throw executionSessionError('EXECUTION_VERIFICATION_STALE', 'Verification owned-file fingerprint no longer matches the live execution workspace.');
    }
    if (provenance.policy === 'checks-passed') {
      if (!provenance.candidateId || !provenance.candidateRepoRevision || !provenance.executionKey) {
        throw executionSessionError('EXECUTION_VERIFICATION_PROVENANCE_REQUIRED', 'Passed verification evidence requires candidate id, candidate revision, and execution key.');
      }
      if (normalizedVerification.length === 0) {
        throw executionSessionError('EXECUTION_VERIFICATION_CHECKS_REQUIRED', 'Passed verification evidence requires at least one completed check.');
      }
      const allPassed = normalizedVerification.every((entry: any) => entry?.status === 'passed' || entry?.status === 'succeeded' || entry?.ok === true);
      if (!allPassed) {
        throw executionSessionError('EXECUTION_VERIFICATION_INCOMPLETE', 'Verification evidence contains a failed, stale, timed-out, or incomplete check.');
      }
    } else if (provenance.policy === 'operator-break-glass') {
      if (!provenance.candidateId || !provenance.candidateRepoRevision || !provenance.executionKey) {
        throw executionSessionError('EXECUTION_VERIFICATION_PROVENANCE_REQUIRED', 'Operator break-glass verification requires candidate id, candidate revision, and execution key.');
      }
      if (normalizedVerification.length !== 0) {
        throw executionSessionError('EXECUTION_VERIFICATION_POLICY_INVALID', 'Operator break-glass verification authorization is explicit policy evidence and cannot impersonate executed checks.');
      }
    } else if (normalizedVerification.length !== 0) {
      throw executionSessionError('EXECUTION_VERIFICATION_POLICY_INVALID', 'No-check-required verification policy cannot include executed checks.');
    }
  }

  let binding!: ExecutionSessionEvidenceRecord;
  let updated!: ExecutionSessionRecord;
  withDbTransaction(() => {
    binding = saveExecutionSessionEvidence({
      id: evidenceId(id, {
        kind: 'verification-binding',
        path: provenance?.candidateId ? `candidate:${provenance.candidateId}` : null,
        contextHandle: session.contextHandle,
      }),
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
        checkCount: normalizedVerification.length,
        verificationPolicy: provenance?.policy || 'legacy',
        candidateId: provenance?.candidateId,
        candidateRepoRevision: provenance?.candidateRepoRevision,
        executionKey: provenance?.executionKey,
        expectedRepoRevision: provenance?.expectedRepoRevision,
        verificationCoverage: Array.isArray(provenance?.coverage) ? provenance.coverage : [],
      },
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    updated = updateExecutionSessionRecord(id, {
      verification: normalizedVerification,
      repoRevision: repo.token,
      updatedAt: nowIso,
    })!;
  });
  return { session: updated, binding, ownership: getExecutionOwnershipState(id, { repoRoot: root }) };
}

export function getExecutionVerificationCoverageEvidence(id: string) {
  requireSession(id);
  const binding = listExecutionSessionEvidence(id)
    .filter((entry) => entry.kind === 'verification-binding' && !readStringMetadata(entry.metadata || {}, 'invalidatedAt'))
    .at(-1);
  if (!binding) return null;
  const rawCoverage = Array.isArray(binding.metadata?.verificationCoverage) ? binding.metadata.verificationCoverage : [];
  const coverage = rawCoverage
    .map((entry) => buildVerificationCoverageIdentity(entry))
    .filter((entry): entry is VerificationCoverageIdentity => Boolean(entry));
  return {
    bindingId: binding.id,
    policy: readStringMetadata(binding.metadata || {}, 'verificationPolicy') || 'legacy',
    ownedFingerprint: readStringMetadata(binding.metadata || {}, 'ownedFingerprint') || null,
    recordedAt: readStringMetadata(binding.metadata || {}, 'recordedAt') || binding.updatedAt,
    coverage,
    coveredCommands: Array.from(new Set(coverage.map((entry) => entry.command))),
  };
}

export function invalidateTaskExecutionVerificationBinding(
  args: Record<string, any>,
  input: { candidateId: string; executionKey?: string; reason: string; now?: Date },
) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) {
    return {
      invalidated: false as const,
      reasonCode: 'EXECUTION_VERIFICATION_TASK_BINDING_MISSING' as const,
      ownership: null,
    };
  }
  const candidateId = String(input?.candidateId || '').trim();
  const executionKey = String(input?.executionKey || '').trim();
  if (!candidateId) {
    return {
      invalidated: false as const,
      reasonCode: 'EXECUTION_VERIFICATION_CANDIDATE_REQUIRED' as const,
      ownership: getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root }),
    };
  }
  const evidence = listExecutionSessionEvidence(binding.session.id);
  const matched = evidence
    .filter((entry) => entry.kind === 'verification-binding')
    .filter((entry) => readStringMetadata(entry.metadata || {}, 'candidateId') === candidateId)
    .filter((entry) => !executionKey || readStringMetadata(entry.metadata || {}, 'executionKey') === executionKey)
    .at(-1);
  if (!matched) {
    return {
      invalidated: false as const,
      reasonCode: 'EXECUTION_VERIFICATION_BINDING_NOT_FOUND' as const,
      ownership: getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root }),
    };
  }
  const existingInvalidatedAt = readStringMetadata(matched.metadata || {}, 'invalidatedAt');
  if (!existingInvalidatedAt) {
    const invalidatedAt = (input.now || new Date()).toISOString();
    saveExecutionSessionEvidence({
      id: matched.id,
      sessionId: matched.sessionId,
      kind: matched.kind,
      path: matched.path,
      repoRevision: matched.repoRevision,
      fileRevision: matched.fileRevision,
      revisionIdentity: matched.revisionIdentity,
      contextHandle: matched.contextHandle,
      stale: matched.stale,
      metadata: {
        ...(matched.metadata || {}),
        invalidatedAt,
        invalidationReason: String(input.reason || 'verification-result-fenced'),
        authoritative: false,
      },
      createdAt: matched.createdAt,
      updatedAt: invalidatedAt,
    });
  }
  return {
    invalidated: true as const,
    reasonCode: existingInvalidatedAt
      ? 'EXECUTION_VERIFICATION_BINDING_ALREADY_INVALIDATED' as const
      : 'EXECUTION_VERIFICATION_BINDING_INVALIDATED' as const,
    candidateId,
    ownership: getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root }),
  };
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

export function recordExecutionReconciliationEvidence(
  id: string,
  reasonCodeValue: string,
  metadata: Record<string, unknown> = {},
  now = new Date(),
) {
  const session = requireSession(id);
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
    const session = requireSession(id);
    recordExecutionReconciliationEvidence(id, 'scoped-expiry', { expiresAt: session.expiresAt }, now);
    return session;
  });
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
