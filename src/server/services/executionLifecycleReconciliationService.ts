import crypto from 'node:crypto';
import { withDbTransaction } from '../../db/index.js';
import {
  getExecutionSessionById,
  listExecutionSessionEvidence,
  saveExecutionSessionEvidence,
  updateExecutionSessionRecord,
  type ExecutionLifecycleStage,
  type ExecutionSessionEvidenceRecord,
  type ExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import {
  recordAutomaticExecutionCheckpoint,
  recordExecutionPendingOperationReference,
} from './executionCheckpointService.js';

export interface ExecutionLifecycleObservedEvidence {
  id: string;
  kind: string;
  status: 'completed' | 'accepted' | 'running' | 'failed' | 'cancelled';
  operationId?: string | null;
}

export interface ExecutionLifecycleReconciliationInput {
  toStage: Exclude<ExecutionLifecycleStage, 'compatibility'>;
  reasonCode: string;
  evidence: ExecutionLifecycleObservedEvidence;
  now?: Date;
}

function lifecycleError(code: string, message: string, details?: unknown) {
  const error = new Error(message) as Error & { code?: string; details?: unknown };
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function requireSession(id: string) {
  const session = getExecutionSessionById(id);
  if (!session) throw lifecycleError('EXECUTION_SESSION_NOT_FOUND', `Execution session '${id}' was not found.`);
  return session;
}

function assertActive(session: ExecutionSessionRecord) {
  if (session.status !== 'active') {
    throw lifecycleError('EXECUTION_SESSION_TERMINAL', `Execution session '${session.id}' is terminal (${session.status}) and cannot reconcile active lifecycle state.`);
  }
}

function stageReconciliationEvidenceId(sessionId: string, originEvidenceId: string) {
  const digest = crypto.createHash('sha256')
    .update(sessionId)
    .update('|lifecycle-stage-reconciliation|')
    .update(originEvidenceId)
    .digest('hex')
    .slice(0, 24);
  return `lifecycle-stage-reconciliation-${digest}`;
}

function lifecycleObservationForOrigin(sessionId: string, originEvidenceId: string) {
  return listExecutionSessionEvidence(sessionId).find((entry) =>
    entry.kind === 'lifecycle-transition'
    && entry.metadata?.originEvidenceId === originEvidenceId,
  ) || null;
}

export function reconcileExecutionLifecycleStage(id: string, input: ExecutionLifecycleReconciliationInput) {
  const rawToStage = String(input?.toStage || '').trim();
  const reasonCode = String(input?.reasonCode || '').trim();
  const originEvidenceId = String(input?.evidence?.id || '').trim();
  const evidenceKind = String(input?.evidence?.kind || '').trim();
  const evidenceStatus = input?.evidence?.status;
  const operationId = input?.evidence?.operationId ? String(input.evidence.operationId) : null;

  if (!rawToStage || rawToStage === 'compatibility') {
    throw lifecycleError('EXECUTION_LIFECYCLE_STAGE_REQUIRED', 'A concrete observable lifecycle target stage is required.');
  }
  const toStage = rawToStage as ExecutionLifecycleReconciliationInput['toStage'];
  if (!reasonCode) throw lifecycleError('EXECUTION_LIFECYCLE_REASON_REQUIRED', 'Lifecycle reconciliation reasonCode is required.');
  if (!originEvidenceId || !evidenceKind) {
    throw lifecycleError('EXECUTION_LIFECYCLE_EVIDENCE_REQUIRED', 'Lifecycle reconciliation requires authoritative evidence id and kind.');
  }
  if (evidenceStatus !== 'completed') {
    if ((evidenceStatus === 'accepted' || evidenceStatus === 'running') && operationId) {
      recordExecutionPendingOperationReference(id, {
        operationId,
        evidenceId: originEvidenceId,
        kind: evidenceKind,
        status: evidenceStatus,
      }, input.now || new Date());
    }
    throw lifecycleError('EXECUTION_LIFECYCLE_EVIDENCE_NOT_TERMINAL', `Lifecycle evidence '${originEvidenceId}' is ${String(evidenceStatus || 'unknown')}; only completed observable work may reconcile execution stage.`, {
      evidenceId: originEvidenceId,
      evidenceKind,
      evidenceStatus: evidenceStatus || null,
      requestedStage: toStage,
    });
  }

  const now = input.now || new Date();
  const nowIso = now.toISOString();
  let result!: {
    session: ExecutionSessionRecord;
    reconciliation: ExecutionSessionEvidenceRecord;
    changed: boolean;
    idempotent: boolean;
  };

  withDbTransaction(() => {
    const session = requireSession(id);
    assertActive(session);
    const duplicate = lifecycleObservationForOrigin(id, originEvidenceId);
    if (duplicate) {
      const metadata = duplicate.metadata || {};
      const same = metadata.toStage === toStage
        && metadata.reasonCode === reasonCode
        && metadata.evidenceKind === evidenceKind
        && (metadata.operationId || null) === operationId;
      if (!same) {
        throw lifecycleError('EXECUTION_LIFECYCLE_IDEMPOTENCY_CONFLICT', `Lifecycle evidence '${originEvidenceId}' was already reconciled to a different observed stage.`, {
          evidenceId: originEvidenceId,
          existing: metadata,
          requested: { toStage, reasonCode, evidenceKind, operationId },
        });
      }
      result = { session, reconciliation: duplicate, changed: false, idempotent: true };
      return;
    }

    const fromStage = session.lifecycle.stage;
    const reconciliation = saveExecutionSessionEvidence({
      id: stageReconciliationEvidenceId(id, originEvidenceId),
      sessionId: id,
      kind: 'lifecycle-transition',
      path: null,
      repoRevision: session.repoRevision,
      fileRevision: null,
      revisionIdentity: operationId || originEvidenceId,
      contextHandle: session.contextHandle,
      stale: false,
      metadata: {
        fromStage,
        toStage,
        reasonCode,
        originEvidenceId,
        operationId,
        evidenceKind,
        evidenceStatus: 'completed',
        sequence: (session.lifecycle.lastTransition?.sequence || 0) + 1,
        observedAt: nowIso,
        directReconciliation: true,
        skippedStageValidation: true,
      },
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    updateExecutionSessionRecord(id, { updatedAt: nowIso });
    const refreshed = requireSession(id);
    recordAutomaticExecutionCheckpoint(id, reconciliation, now);
    result = {
      session: refreshed,
      reconciliation,
      changed: fromStage !== toStage,
      idempotent: false,
    };
  });

  return result;
}
