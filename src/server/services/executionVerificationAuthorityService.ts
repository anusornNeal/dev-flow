import crypto from 'node:crypto';
import path from 'node:path';
import { withDbTransaction } from '../../db/index.js';
import {
  listExecutionSessionEvidence,
  saveExecutionSessionEvidence,
  updateExecutionSessionRecord,
  type ExecutionSessionEvidenceRecord,
  type ExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import { getJob } from '../repositories/mcpToolJobRepository.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import { getExecutionOwnershipState } from './executionOwnedRevisionService.js';
import { getExecutionSessionOwnershipEpoch } from './executionOwnershipEpochService.js';
import {
  assertExecutionSessionActive,
  executionSessionError,
  readExecutionStringMetadata,
  requireExecutionSession,
} from './executionSessionPolicyPrimitives.js';
import { getRepoRevisionForRoot } from './repoRevisionService.js';
import {
  buildVerificationCoverageIdentity,
  createVerificationBatch,
  MAX_VERIFICATION_BATCH_CHECKS,
  type VerificationBatchResultStatus,
  type VerificationCoverageIdentity,
} from './verificationBatchService.js';

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
  | 'EXECUTION_VERIFICATION_BATCH_SUPERSEDED'
  | 'EXECUTION_VERIFICATION_RECOVERY_BATCH_REQUIRED'
  | 'EXECUTION_VERIFICATION_REJECTED';

export type ExecutionVerificationBatchStatus = 'pending' | 'complete' | 'failed' | 'stale' | 'blocked' | 'superseded';

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
  blocked: string[];
  status: ExecutionVerificationBatchStatus;
  canComplete: boolean;
  createdAt: string;
  supersededByBatchId?: string;
  supersessionReason?: string;
  supersededAt?: string;
  updatedAt: string;
};

function requireRepoRoot(repoRoot?: string) {
  if (!repoRoot) throw executionSessionError('EXECUTION_SESSION_REPO_ROOT_REQUIRED', 'repoRoot is required for execution ownership provenance.');
  return path.resolve(repoRoot);
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

export function captureExecutionVerificationProvenance(id: string, options: { repoRoot: string }) {
  const ownership = getExecutionOwnershipState(id, { repoRoot: options.repoRoot });
  return {
    repoRevision: ownership.repoRevision,
    ownedFingerprint: ownership.ownedFingerprint,
    ownedPaths: ownership.ownedFiles.map((entry) => entry.path),
  };
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
  if (!batchId || !ownershipEpochId || !repoRevision || !ownedFingerprint || !['pending', 'complete', 'failed', 'stale', 'blocked', 'superseded'].includes(status)) return null;
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
    blocked: Array.isArray(metadata.blocked) ? metadata.blocked.map(String) : [],
    status,
    canComplete: metadata.canComplete === true,
    ...(typeof metadata.supersededByBatchId === 'string' && metadata.supersededByBatchId.trim() ? { supersededByBatchId: metadata.supersededByBatchId.trim() } : {}),
    ...(typeof metadata.supersessionReason === 'string' && metadata.supersessionReason.trim() ? { supersessionReason: metadata.supersessionReason.trim() } : {}),
    ...(typeof metadata.supersededAt === 'string' && metadata.supersededAt.trim() ? { supersededAt: metadata.supersededAt.trim() } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function getExecutionVerificationBatchState(id: string) {
  requireExecutionSession(id);
  return listExecutionSessionEvidence(id)
    .filter((entry) => entry.kind === 'verification-batch')
    .map(executionVerificationBatchStateFromEvidence)
    .filter((entry): entry is ExecutionVerificationBatchState => Boolean(entry))
    .at(-1) || null;
}

export function getExecutionVerificationBatchStateById(id: string, batchIdValue: string) {
  requireExecutionSession(id);
  const batchId = String(batchIdValue || '').trim();
  if (!batchId) return null;
  return listExecutionSessionEvidence(id)
    .filter((entry) => entry.kind === 'verification-batch')
    .map(executionVerificationBatchStateFromEvidence)
    .find((entry) => entry?.batchId === batchId) || null;
}

export function getExecutionVerificationBatchLiveOperations(id: string, batchIdValue: string) {
  requireExecutionSession(id);
  const batchId = String(batchIdValue || '').trim();
  if (!batchId) return [] as Array<{ operationId: string; status: 'accepted' | 'running'; jobStatus: string }>;
  const checkpoint = getLatestExecutionCheckpoint(id);
  return (checkpoint?.pendingOperations || []).flatMap((entry) => {
    const job = getJob(entry.operationId);
    const jobBatchId = String(job?.args?.verificationBatch?.id || '').trim();
    const executionSessionId = String(job?.args?.__executionJobBinding?.executionSessionId || '').trim();
    if (!job || jobBatchId !== batchId || executionSessionId !== id) return [];
    return [{ operationId: entry.operationId, status: entry.status, jobStatus: job.status }];
  });
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
    contextHandle: requireExecutionSession(id).contextHandle,
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
      blocked: state.blocked,
      status: state.status,
      canComplete: state.canComplete,
      supersededByBatchId: state.supersededByBatchId || null,
      supersessionReason: state.supersessionReason || null,
      supersededAt: state.supersededAt || null,
    },
    createdAt: existing?.createdAt || state.createdAt,
    updatedAt: state.updatedAt,
  });
}

function invalidateExecutionVerificationBindingsForBatch(id: string, batchId: string, nowIso: string) {
  for (const entry of listExecutionSessionEvidence(id)) {
    if (entry.kind !== 'verification-binding' || readExecutionStringMetadata(entry.metadata || {}, 'invalidatedAt')) continue;
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
  const status: ExecutionVerificationBatchStatus = snapshot.pending.length > 0
    ? 'pending'
    : snapshot.stale.length > 0
      ? 'stale'
      : snapshot.blocked.length > 0
        ? 'blocked'
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
    blocked: [...snapshot.blocked],
    status,
    canComplete: snapshot.canComplete,
    updatedAt,
  };
}

export function invalidateExecutionVerificationAuthorityForOwnedRevisionReconciliation(id: string, reconciliationId: string, nowIso: string) {
  for (const entry of listExecutionSessionEvidence(id)) {
    if (entry.kind !== 'verification-binding' || readExecutionStringMetadata(entry.metadata || {}, 'invalidatedAt')) continue;
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
    const staleResults = Object.fromEntries(batch.requiredChecks.map((checkId) => [checkId, 'stale' as VerificationBatchResultStatus]));
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
    supersedesBatchId?: string;
    supersessionReason?: string;
  },
) {
  const session = requireExecutionSession(id);
  assertExecutionSessionActive(session);
  const root = requireRepoRoot(input.repoRoot);
  const batchId = String(input.batchId || '').trim();
  if (!batchId || batchId.length > 160) throw executionSessionError('EXECUTION_VERIFICATION_BATCH_ID_REQUIRED', 'A bounded verification batch id is required.');
  const requiredChecks = normalizeExecutionVerificationBatchChecks(input.requiredChecks);
  const checkId = String(input.checkId || '').trim();
  if (!requiredChecks.includes(checkId)) throw executionSessionError('EXECUTION_VERIFICATION_BATCH_CHECK_NOT_REQUIRED', `Verification check '${checkId}' is not declared by batch '${batchId}'.`);
  if (input.status !== 'passed' && input.status !== 'failed' && input.status !== 'stale' && input.status !== 'blocked') {
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_STATUS_INVALID', 'Verification batch result status must be passed, failed, stale, or blocked.');
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
  const historical = getExecutionVerificationBatchStateById(id, batchId);
  if (historical && latest?.batchId !== batchId) {
    if (historical.status === 'superseded') {
      return {
        authoritative: false,
        idempotent: true,
        state: historical,
        reasonCode: 'EXECUTION_VERIFICATION_BATCH_SUPERSEDED' as TaskExecutionVerificationBindingReason,
        verificationFresh: ownership.verificationFresh,
        sessionId: id,
        repoRevision: ownership.repoRevision,
        ownedFingerprint: ownership.ownedFingerprint,
      };
    }
    throw executionSessionError('EXECUTION_VERIFICATION_BATCH_TERMINAL', `Verification batch '${batchId}' is historical and terminal (${historical.status}); its identity cannot be reused.`);
  }
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
  let supersededPrior: ExecutionVerificationBatchState | null = null;
  if (!existing && latest?.status === 'pending' && latest.repoRevision === ownership.repoRevision && latest.ownedFingerprint === ownership.ownedFingerprint) {
    const supersedesBatchId = String(input.supersedesBatchId || '').trim();
    const supersessionReason = String(input.supersessionReason || '').trim();
    if (supersedesBatchId !== latest.batchId) {
      throw executionSessionError('EXECUTION_VERIFICATION_BATCH_ACTIVE', `Verification batch '${latest.batchId}' is still pending. Continue it or explicitly supersede it before '${batchId}' can start.`, {
        batchId: latest.batchId,
        nextAction: 'start-replacement-verification-batch',
        requiredSupersedesBatchId: latest.batchId,
      });
    }
    if (supersessionReason.length < 10 || supersessionReason.length > 500) {
      throw executionSessionError('EXECUTION_VERIFICATION_BATCH_SUPERSESSION_REASON_REQUIRED', 'Verification batch supersession requires an audit reason between 10 and 500 characters.');
    }
    const liveOperations = getExecutionVerificationBatchLiveOperations(id, latest.batchId);
    if (liveOperations.length > 0) {
      throw executionSessionError('EXECUTION_VERIFICATION_BATCH_LIVE_MEMBERS', `Verification batch '${latest.batchId}' still has live durable member operations and cannot be superseded yet.`, {
        batchId: latest.batchId,
        liveOperations,
      });
    }
    supersededPrior = {
      ...latest,
      status: 'superseded',
      canComplete: false,
      supersededByBatchId: batchId,
      supersessionReason,
      supersededAt: nowIso,
      updatedAt: nowIso,
    };
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
  const state = buildExecutionVerificationBatchState({
    batchId,
    ownershipEpochId,
    repoRevision: capturedRepoRevision,
    ownedFingerprint: capturedOwnedFingerprint,
    requiredChecks,
    createdAt,
  }, results, memberCandidates, nowIso);
  withDbTransaction(() => {
    if (supersededPrior) persistExecutionVerificationBatchState(id, supersededPrior);
    if (!existing) invalidateExecutionVerificationBindingsForBatch(id, batchId, nowIso);
    persistExecutionVerificationBatchState(id, state);
  });

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

export function recordExecutionVerificationEvidence(id: string, verification: unknown[], options: RecordExecutionVerificationOptions) {
  const session = requireExecutionSession(id);
  assertExecutionSessionActive(session);
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
  requireExecutionSession(id);
  const binding = listExecutionSessionEvidence(id)
    .filter((entry) => entry.kind === 'verification-binding' && !readExecutionStringMetadata(entry.metadata || {}, 'invalidatedAt'))
    .at(-1);
  if (!binding) return null;
  const rawCoverage = Array.isArray(binding.metadata?.verificationCoverage) ? binding.metadata.verificationCoverage : [];
  const coverage = rawCoverage
    .map((entry) => buildVerificationCoverageIdentity(entry))
    .filter((entry): entry is VerificationCoverageIdentity => Boolean(entry));
  return {
    bindingId: binding.id,
    policy: readExecutionStringMetadata(binding.metadata || {}, 'verificationPolicy') || 'legacy',
    ownedFingerprint: readExecutionStringMetadata(binding.metadata || {}, 'ownedFingerprint') || null,
    recordedAt: readExecutionStringMetadata(binding.metadata || {}, 'recordedAt') || binding.updatedAt,
    coverage,
    coveredCommands: Array.from(new Set(coverage.map((entry) => entry.command))),
  };
}
