import crypto from 'node:crypto';
import {
  getExecutionSessionById,
  listExecutionSessionEvidence,
  saveExecutionSessionEvidence,
  type ExecutionLifecycleStage,
  type ExecutionSessionEvidenceRecord,
  type ExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import { publishServerEvent } from './serverEventService.js';

const MAX_PENDING_OPERATIONS = 8;
const MAX_CONTEXT_LINEAGE = 6;
const MAX_WORK_ITEMS = 24;
const MAX_DECISIONS = 16;
const MAX_CHANGED_FILES = 80;
const MAX_VERIFICATION_REFS = 16;
const MAX_TEXT = 500;

export interface ExecutionPendingOperationReference {
  operationId: string;
  evidenceId: string;
  kind: string;
  status: 'accepted' | 'running';
  observedAt: string;
}

export interface ExecutionVerificationReference {
  name: string | null;
  status: string | null;
  evidenceId: string | null;
  candidateId: string | null;
  executionKey: string | null;
}

export interface ExecutionCheckpointSnapshot {
  id: string;
  executionSessionId: string;
  updatedAt: string;
  stage: ExecutionLifecycleStage;
  transitionEvidenceId: string | null;
  reasonCode: string | null;
  sourceRepoRevision: string | null;
  contextHandle: string | null;
  contextHandleLineage: string[];
  changedFiles: string[];
  verificationReferences: ExecutionVerificationReference[];
  pendingOperations: ExecutionPendingOperationReference[];
  completedWork: string[];
  pendingNextWork: string[];
  decisions: string[];
  blockers: string[];
}

export interface AutomaticCheckpointTransition {
  id: string;
  metadata?: Record<string, unknown>;
}

function compact(value: unknown, max = MAX_TEXT) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function compactList(values: unknown, maxItems: number) {
  if (!Array.isArray(values)) return [] as string[];
  return [...new Set(values.map((value) => compact(value)).filter((value): value is string => Boolean(value)))].slice(0, maxItems);
}

function checkpointEvidenceId(sessionId: string) {
  return `checkpoint-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`;
}

function checkpointFromEvidence(entry: ExecutionSessionEvidenceRecord | null | undefined): ExecutionCheckpointSnapshot | null {
  if (!entry || entry.kind !== 'checkpoint') return null;
  const snapshot = entry.metadata?.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const typed = snapshot as ExecutionCheckpointSnapshot;
  if (!typed.id || !typed.executionSessionId || !typed.stage) return null;
  return typed;
}

export function getLatestExecutionCheckpoint(sessionId: string) {
  const id = checkpointEvidenceId(sessionId);
  const evidence = listExecutionSessionEvidence(sessionId).find((entry) => entry.id === id)
    || [...listExecutionSessionEvidence(sessionId)].reverse().find((entry) => entry.kind === 'checkpoint');
  return checkpointFromEvidence(evidence);
}

export function compactVerificationReferences(verification: unknown[]): ExecutionVerificationReference[] {
  if (!Array.isArray(verification)) return [];
  return verification.slice(0, MAX_VERIFICATION_REFS).map((entry: any) => ({
    name: compact(entry?.name, 160),
    status: compact(entry?.status, 80),
    evidenceId: compact(entry?.evidenceId || entry?.id, 200),
    candidateId: compact(entry?.candidateId, 200),
    executionKey: compact(entry?.executionKey, 200),
  }));
}

function requireSession(sessionId: string) {
  const session = getExecutionSessionById(sessionId);
  if (!session) {
    const error = new Error(`Execution session '${sessionId}' was not found.`) as Error & { code?: string };
    error.code = 'EXECUTION_SESSION_NOT_FOUND';
    throw error;
  }
  return session;
}

function requireActiveSession(sessionId: string) {
  const session = requireSession(sessionId);
  if (session.status !== 'active') {
    const error = new Error(`Execution session '${sessionId}' is terminal (${session.status}).`) as Error & { code?: string };
    error.code = 'EXECUTION_SESSION_TERMINAL';
    throw error;
  }
  return session;
}

function contextLineage(previous: ExecutionCheckpointSnapshot | null, session: ExecutionSessionRecord) {
  const values = [...(previous?.contextHandleLineage || [])];
  if (session.contextHandle && values.at(-1) !== session.contextHandle) values.push(session.contextHandle);
  return values.slice(-MAX_CONTEXT_LINEAGE);
}

function baseSnapshot(session: ExecutionSessionRecord, previous: ExecutionCheckpointSnapshot | null, nowIso: string): ExecutionCheckpointSnapshot {
  return {
    id: checkpointEvidenceId(session.id),
    executionSessionId: session.id,
    updatedAt: nowIso,
    stage: session.lifecycle.stage,
    transitionEvidenceId: previous?.transitionEvidenceId || session.lifecycle.lastTransition?.evidenceId || null,
    reasonCode: previous?.reasonCode || session.lifecycle.lastTransition?.reasonCode || null,
    sourceRepoRevision: session.repoRevision,
    contextHandle: session.contextHandle,
    contextHandleLineage: contextLineage(previous, session),
    changedFiles: [...new Set(session.changedFiles)].slice(0, MAX_CHANGED_FILES),
    verificationReferences: compactVerificationReferences(session.verification),
    pendingOperations: [...(previous?.pendingOperations || [])].slice(-MAX_PENDING_OPERATIONS),
    completedWork: [...(previous?.completedWork || [])].slice(0, MAX_WORK_ITEMS),
    pendingNextWork: [...(previous?.pendingNextWork || [])].slice(0, MAX_WORK_ITEMS),
    decisions: [...(previous?.decisions || [])].slice(0, MAX_DECISIONS),
    blockers: [...(previous?.blockers || [])].slice(0, MAX_DECISIONS),
  };
}

function persistCheckpoint(
  session: ExecutionSessionRecord,
  snapshot: ExecutionCheckpointSnapshot,
  nowIso: string,
  eventReason: string | null,
) {
  saveExecutionSessionEvidence({
    id: snapshot.id,
    sessionId: session.id,
    kind: 'checkpoint',
    path: null,
    repoRevision: null,
    fileRevision: null,
    revisionIdentity: snapshot.transitionEvidenceId || snapshot.pendingOperations.at(-1)?.operationId || session.id,
    contextHandle: session.contextHandle,
    stale: false,
    metadata: { snapshot },
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  if (eventReason) {
    publishServerEvent('execution.changed', {
      projectId: session.projectId,
      entityId: session.id,
      status: snapshot.stage,
      reason: eventReason,
    });
  }
  return snapshot;
}

export function recordAutomaticExecutionCheckpoint(
  sessionId: string,
  transition: AutomaticCheckpointTransition,
  now = new Date(),
  options: { publishEvent?: boolean } = {},
) {
  const session = requireActiveSession(sessionId);
  const previous = getLatestExecutionCheckpoint(sessionId);
  const nowIso = now.toISOString();
  const snapshot = baseSnapshot(session, previous, nowIso);
  const operationId = compact(transition.metadata?.operationId, 200);
  snapshot.stage = session.lifecycle.stage;
  snapshot.transitionEvidenceId = transition.id;
  snapshot.reasonCode = compact(transition.metadata?.reasonCode, 160);
  snapshot.pendingOperations = snapshot.pendingOperations.filter((entry) => !operationId || entry.operationId !== operationId);
  return persistCheckpoint(
    session,
    snapshot,
    nowIso,
    options.publishEvent === false ? null : snapshot.reasonCode || 'lifecycle-transition',
  );
}

export function recordExecutionPendingOperationReference(
  sessionId: string,
  input: { operationId: string; evidenceId: string; kind: string; status: 'accepted' | 'running' },
  now = new Date(),
) {
  const session = requireActiveSession(sessionId);
  const operationId = compact(input.operationId, 200);
  const evidenceId = compact(input.evidenceId, 200);
  const kind = compact(input.kind, 120);
  if (!operationId || !evidenceId || !kind) return getLatestExecutionCheckpoint(sessionId);
  const previous = getLatestExecutionCheckpoint(sessionId);
  const nowIso = now.toISOString();
  const snapshot = baseSnapshot(session, previous, nowIso);
  const next: ExecutionPendingOperationReference = { operationId, evidenceId, kind, status: input.status, observedAt: nowIso };
  snapshot.pendingOperations = [
    ...snapshot.pendingOperations.filter((entry) => entry.operationId !== operationId),
    next,
  ].slice(-MAX_PENDING_OPERATIONS);
  return persistCheckpoint(session, snapshot, nowIso, `pending-operation-${input.status}`);
}

export function reconcileExecutionPendingOperationReference(
  sessionId: string,
  operationIdValue: string,
  now = new Date(),
) {
  const operationId = compact(operationIdValue, 200);
  if (!operationId) return getLatestExecutionCheckpoint(sessionId);
  const session = requireSession(sessionId);
  const previous = getLatestExecutionCheckpoint(sessionId);
  if (!previous?.pendingOperations.some((entry) => entry.operationId === operationId)) return previous;
  const nowIso = now.toISOString();
  const snapshot = baseSnapshot(session, previous, nowIso);
  snapshot.pendingOperations = snapshot.pendingOperations.filter((entry) => entry.operationId !== operationId);
  return persistCheckpoint(session, snapshot, nowIso, 'pending-operation-reconciled');
}

export function enrichExecutionCheckpointFromHandoff(
  sessionId: string,
  input: { completedWork?: string[]; pendingNextWork?: string[]; decisions?: string[]; blockers?: string[] },
  now = new Date(),
) {
  const session = requireActiveSession(sessionId);
  const previous = getLatestExecutionCheckpoint(sessionId);
  const nowIso = now.toISOString();
  const snapshot = baseSnapshot(session, previous, nowIso);
  snapshot.completedWork = compactList(input.completedWork, MAX_WORK_ITEMS);
  snapshot.pendingNextWork = compactList(input.pendingNextWork, MAX_WORK_ITEMS);
  snapshot.decisions = compactList(input.decisions, MAX_DECISIONS);
  snapshot.blockers = compactList(input.blockers, MAX_DECISIONS);
  return persistCheckpoint(session, snapshot, nowIso, 'handoff-checkpoint-updated');
}
