import crypto from 'node:crypto';
import {
  listExecutionSessionEvidence,
  saveExecutionSessionEvidence,
  updateExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import {
  assertExecutionSessionActive,
  executionSessionError,
  readExecutionStringMetadata,
  requireExecutionSession,
} from './executionSessionPolicyPrimitives.js';

export function normalizeExecutionOwnershipEpochId(value?: string | null) {
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

export function saveExecutionOwnershipEpochEvidence(sessionId: string, ownershipEpochId: string, nowIso: string) {
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

export function getExecutionSessionOwnershipEpoch(id: string) {
  const session = requireExecutionSession(id);
  const evidence = listExecutionSessionEvidence(id).find((entry) => entry.kind === 'ownership-epoch') || null;
  const ownershipEpochId = evidence
    ? normalizeExecutionOwnershipEpochId(readExecutionStringMetadata(evidence.metadata || {}, 'ownershipEpochId') || evidence.revisionIdentity)
    : null;
  return { sessionId: session.id, ownershipEpochId, evidence };
}

export function bindExecutionSessionOwnershipEpoch(id: string, ownershipEpochIdValue: string, now = new Date()) {
  const session = requireExecutionSession(id);
  assertExecutionSessionActive(session);
  const ownershipEpochId = normalizeExecutionOwnershipEpochId(ownershipEpochIdValue);
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
