import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createExecutionSessionRecord,
  getExecutionSessionById,
  listExecutionSessionEvidence,
  listExecutionSessionsForWorkspace,
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
import { getFileRevision, resolveSafePath } from './localFileService.js';
import { buildRepoEvidenceIdentity, getRepoRevisionForRoot } from './repoRevisionService.js';
import { withDbTransaction } from '../../db/index.js';
import { resolveSessionWorkspace } from './sessionWorkspaceService.js';
import { createApiError } from './api.js';
import {
  recordAutomaticExecutionCheckpoint,
  recordExecutionPendingOperationReference,
} from './executionCheckpointService.js';

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const EXECUTION_LIFECYCLE_TRANSITIONS: Readonly<Record<ExecutionLifecycleStage, readonly ExecutionLifecycleStage[]>> = Object.freeze({
  compatibility: ['created'],
  created: ['context-ready'],
  'context-ready': ['plan-recorded', 'implementing'],
  'plan-recorded': ['implementing'],
  implementing: ['verifying'],
  verifying: ['repairing', 'committed'],
  repairing: ['verifying'],
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

export interface ExecutionVerificationProvenance {
  policy: 'checks-passed' | 'no-checks-required';
  expectedRepoRevision?: string;
  expectedOwnedFingerprint?: string;
  candidateId?: string;
  candidateRepoRevision?: string;
  executionKey?: string;
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

export function getTaskExecutionMutationBinding(args: Record<string, any>) {
  const workspaceId = String(args?.workspaceId || '').trim();
  if (!workspaceId) return null;
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
      && (session.verification.length > 0 || verificationPolicy === 'no-checks-required')
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

export function recordTaskExecutionVerificationResult(
  args: Record<string, any>,
  result: any,
  captured?: { repoRevision: string; ownedFingerprint: string; ownedPaths?: string[] } | null,
): TaskExecutionVerificationBindingOutcome {
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
