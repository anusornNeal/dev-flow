import crypto from 'node:crypto';
import { withDbTransaction } from '../../db/index.js';
import { getProject } from '../repositories/projectRepository.js';
import { getTask, getTasksByProjectId } from '../repositories/taskRepository.js';
import {
  getExecutionSessionEvidenceById,
  listExecutionSessionsForTask,
  listExecutionSessionsForWorkspace,
  queryExecutionSessions,
  saveExecutionSessionEvidence,
  type ExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import { createApiError } from './api.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import { cancelExecutionSession, recordExecutionReconciliationEvidence } from './executionSessionService.js';
import { classifyLifecycleLiveWorkAuthority } from './lifecycleAuthorityService.js';

export type EmergencyOrphanCleanupMode = 'dry-run' | 'apply';

export interface EmergencyOrphanCleanupInput {
  projectId: string;
  operationId: string;
  mode: EmergencyOrphanCleanupMode;
  actorLabel: string;
  reason: string;
  limit?: number;
}

export type EmergencyOrphanCleanupReasonCode =
  | 'SAFE_ORPHAN'
  | 'TASK_ID_MISSING'
  | 'WORKSPACE_ID_MISSING'
  | 'TASK_NOT_FOUND'
  | 'TASK_PROJECT_MISMATCH'
  | 'MALFORMED_CLAIM'
  | 'CLAIM_WORKSPACE_MISMATCH'
  | 'ACTIVE_CLAIM'
  | 'PENDING_OPERATION'
  | 'MULTIPLE_ACTIVE_TASK_EXECUTIONS'
  | 'MULTIPLE_ACTIVE_WORKSPACE_EXECUTIONS'
  | 'RECOVERABLE_WIP'
  | 'INVALID_WORKSPACE_AUTHORITY'
  | 'AMBIGUOUS_AUTHORITY'
  | 'TERMINAL_HISTORY';

export interface EmergencyOrphanCleanupCandidate {
  executionSessionId: string;
  taskId: string | null;
  workspaceId: string | null;
  classification: 'safe' | 'skipped';
  reasonCode: EmergencyOrphanCleanupReasonCode;
  reason: string;
  pendingOperationIds: string[];
  activeTaskExecutionIds: string[];
  activeWorkspaceExecutionIds: string[];
}

export interface EmergencyOrphanCleanupResult {
  projectId: string;
  operationId: string;
  mode: EmergencyOrphanCleanupMode;
  actorLabel: string;
  reason: string;
  limit: number;
  replayed: boolean;
  beforeActiveCount: number;
  afterActiveCount: number;
  scannedCount: number;
  safeCount: number;
  skippedCount: number;
  cancelledCount: number;
  truncated: boolean;
  candidates: EmergencyOrphanCleanupCandidate[];
}

let faultAfterForTests: number | null = null;

export function __setEmergencyOrphanCleanupFaultAfterForTests(value: number | null) {
  faultAfterForTests = value == null ? null : Math.max(1, Math.floor(value));
}

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function boundedLimit(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(100, Math.floor(numeric))) : 100;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function requestFingerprint(input: Required<Pick<EmergencyOrphanCleanupInput, 'projectId' | 'operationId' | 'mode' | 'actorLabel' | 'reason'>> & { limit: number }) {
  return crypto.createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function operationEvidenceId(projectId: string, operationId: string) {
  const digest = crypto.createHash('sha256').update(projectId).update('|').update(operationId).digest('hex').slice(0, 32);
  return `emergency-orphan-cleanup-op-${digest}`;
}

function activeClaimState(task: any, workspaceId: string, nowMs: number): { code: 'none' | 'active' | 'malformed' | 'workspace-mismatch' } {
  const claim = task?.claim;
  if (claim == null) return { code: 'none' };
  if (typeof claim !== 'object' || Array.isArray(claim)) return { code: 'malformed' };
  const sessionIdHash = clean((claim as any).sessionIdHash, 200);
  const claimWorkspaceId = clean((claim as any).workspaceId, 200);
  const expiresAt = clean((claim as any).expiresAt, 100);
  const expiresAtMs = Date.parse(expiresAt);
  if (!sessionIdHash || !claimWorkspaceId || !expiresAt || !Number.isFinite(expiresAtMs)) return { code: 'malformed' };
  if (claimWorkspaceId !== workspaceId) return { code: 'workspace-mismatch' };
  return expiresAtMs > nowMs ? { code: 'active' } : { code: 'none' };
}

function skipped(
  session: ExecutionSessionRecord,
  reasonCode: Exclude<EmergencyOrphanCleanupReasonCode, 'SAFE_ORPHAN'>,
  reason: string,
  extras: Partial<Pick<EmergencyOrphanCleanupCandidate, 'pendingOperationIds' | 'activeTaskExecutionIds' | 'activeWorkspaceExecutionIds'>> = {},
): EmergencyOrphanCleanupCandidate {
  return {
    executionSessionId: session.id,
    taskId: session.taskId,
    workspaceId: session.workspaceId,
    classification: 'skipped',
    reasonCode,
    reason,
    pendingOperationIds: extras.pendingOperationIds || [],
    activeTaskExecutionIds: extras.activeTaskExecutionIds || [],
    activeWorkspaceExecutionIds: extras.activeWorkspaceExecutionIds || [],
  };
}

function classifySession(
  session: ExecutionSessionRecord,
  projectId: string,
  projectTasks: Map<string, any>,
  nowMs: number,
): EmergencyOrphanCleanupCandidate {
  if (!session.taskId) return skipped(session, 'TASK_ID_MISSING', 'Active execution has no task identity.');
  if (!session.workspaceId) return skipped(session, 'WORKSPACE_ID_MISSING', 'Active execution has no workspace identity.');

  let task = projectTasks.get(session.taskId);
  if (!task) {
    const globalTask = getTask(session.taskId);
    if (globalTask && globalTask.projectId !== projectId) {
      return skipped(session, 'TASK_PROJECT_MISMATCH', 'Execution task belongs to a different project.');
    }
    return skipped(session, 'TASK_NOT_FOUND', 'Execution task identity no longer resolves.');
  }
  if (task.projectId !== projectId || session.projectId !== projectId) {
    return skipped(session, 'TASK_PROJECT_MISMATCH', 'Execution/task project identity does not match the requested project.');
  }

  const claimState = activeClaimState(task, session.workspaceId, nowMs);
  if (claimState.code === 'malformed') return skipped(session, 'MALFORMED_CLAIM', 'Task claim exists but cannot be proven inactive from a complete claim identity.');
  if (claimState.code === 'workspace-mismatch') return skipped(session, 'CLAIM_WORKSPACE_MISMATCH', 'Persisted task claim points at a different workspace.');
  if (claimState.code === 'active') return skipped(session, 'ACTIVE_CLAIM', 'Task still has a live claim and cannot be treated as orphaned.');

  const authority = classifyLifecycleLiveWorkAuthority(task.id, { workspaceId: session.workspaceId, now: new Date(nowMs) });
  const activeTaskExecutionIds = authority.execution.activeSessionIds;
  const activeWorkspaceExecutionIds = authority.workspaces.some((entry) => entry.workspaceId === session.workspaceId)
    ? listExecutionSessionsForWorkspace(session.workspaceId).filter((entry) => entry.status === 'active').map((entry) => entry.id).slice(0, 20)
    : [];

  if (authority.classification === 'safe-orphan') {
    return {
      executionSessionId: session.id,
      taskId: session.taskId,
      workspaceId: session.workspaceId,
      classification: 'safe',
      reasonCode: 'SAFE_ORPHAN',
      reason: 'Canonical live-work authority classified this unique claimless execution as a safe orphan.',
      pendingOperationIds: [],
      activeTaskExecutionIds,
      activeWorkspaceExecutionIds,
    };
  }
  if (authority.classification === 'live-durable-operation') {
    return skipped(session, 'PENDING_OPERATION', 'Canonical authority found accepted/running durable work.', {
      pendingOperationIds: authority.durableOperations.operationIds,
      activeTaskExecutionIds,
      activeWorkspaceExecutionIds,
    });
  }
  if (authority.classification === 'live-authoritative') {
    return skipped(session, 'ACTIVE_CLAIM', 'Canonical authority found live claim/execution ownership.', { activeTaskExecutionIds, activeWorkspaceExecutionIds });
  }
  if (authority.classification === 'recoverable-wip') {
    return skipped(session, 'RECOVERABLE_WIP', 'Canonical authority found recoverable workspace WIP that must be preserved.', { activeTaskExecutionIds, activeWorkspaceExecutionIds });
  }
  if (authority.classification === 'invalid-workspace-authority') {
    return skipped(session, 'INVALID_WORKSPACE_AUTHORITY', 'Canonical authority could not prove the managed workspace root/identity.', { activeTaskExecutionIds, activeWorkspaceExecutionIds });
  }
  if (authority.classification === 'cross-project-conflict') {
    if (authority.hardReasonCodes.includes('WORKSPACE_ACTIVE_TASK_CONFLICT') || authority.hardReasonCodes.includes('WORKSPACE_TASK_IDENTITY_MISMATCH')) {
      return skipped(session, 'MULTIPLE_ACTIVE_WORKSPACE_EXECUTIONS', 'Canonical authority found conflicting task identity in the managed workspace.', { activeTaskExecutionIds, activeWorkspaceExecutionIds });
    }
    return skipped(session, 'TASK_PROJECT_MISMATCH', 'Canonical authority found a cross-project identity conflict.', { activeTaskExecutionIds, activeWorkspaceExecutionIds });
  }
  if (authority.classification === 'ambiguous-authority') {
    if (authority.hardReasonCodes.includes('MULTIPLE_ACTIVE_EXECUTIONS')) {
      return skipped(session, 'MULTIPLE_ACTIVE_TASK_EXECUTIONS', 'Canonical authority found multiple active executions for the task.', { activeTaskExecutionIds, activeWorkspaceExecutionIds });
    }
    if (authority.hardReasonCodes.includes('MULTIPLE_ACTIVE_EXECUTIONS_FOR_WORKSPACE') || authority.hardReasonCodes.includes('WORKSPACE_ACTIVE_TASK_CONFLICT')) {
      return skipped(session, 'MULTIPLE_ACTIVE_WORKSPACE_EXECUTIONS', 'Canonical authority found conflicting active execution ownership for the workspace.', { activeTaskExecutionIds, activeWorkspaceExecutionIds });
    }
    return skipped(session, 'AMBIGUOUS_AUTHORITY', 'Canonical authority could not prove one safe orphan identity.', { activeTaskExecutionIds, activeWorkspaceExecutionIds });
  }
  return skipped(session, 'TERMINAL_HISTORY', 'Canonical authority classified the execution as terminal history rather than a safe orphan.', { activeTaskExecutionIds, activeWorkspaceExecutionIds });
}

function normalizedInput(input: EmergencyOrphanCleanupInput) {
  const projectId = clean(input?.projectId, 200);
  const operationId = clean(input?.operationId, 200);
  const mode = input?.mode === 'apply' ? 'apply' : input?.mode === 'dry-run' ? 'dry-run' : null;
  const actorLabel = clean(input?.actorLabel, 100);
  const reason = clean(input?.reason, 500);
  const limit = boundedLimit(input?.limit);
  if (!projectId) throw createApiError(400, 'PROJECT_ID_REQUIRED', 'projectId is required for emergency orphan cleanup.');
  if (!operationId) throw createApiError(400, 'EMERGENCY_ORPHAN_CLEANUP_OPERATION_ID_REQUIRED', 'operationId is required for idempotent orphan cleanup.');
  if (!mode) throw createApiError(400, 'EMERGENCY_ORPHAN_CLEANUP_MODE_INVALID', "mode must be 'dry-run' or 'apply'.");
  if (!actorLabel) throw createApiError(400, 'EMERGENCY_ORPHAN_CLEANUP_ACTOR_REQUIRED', 'actorLabel is required for emergency orphan cleanup.');
  if (!reason) throw createApiError(400, 'EMERGENCY_ORPHAN_CLEANUP_REASON_REQUIRED', 'Operator reason is required for emergency orphan cleanup.');
  if (!getProject(projectId)) throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${projectId}' was not found.`, { affectedId: projectId });
  return { projectId, operationId, mode, actorLabel, reason, limit } as const;
}

function replayResult(normalized: ReturnType<typeof normalizedInput>): EmergencyOrphanCleanupResult | null {
  if (normalized.mode !== 'apply') return null;
  const evidence = getExecutionSessionEvidenceById(operationEvidenceId(normalized.projectId, normalized.operationId));
  if (!evidence || evidence.kind !== 'emergency-orphan-cleanup-operation') return null;
  const expectedFingerprint = requestFingerprint(normalized);
  const actualFingerprint = clean(evidence.metadata?.requestFingerprint, 200);
  if (!actualFingerprint || actualFingerprint !== expectedFingerprint) {
    throw createApiError(409, 'EMERGENCY_ORPHAN_CLEANUP_OPERATION_CONFLICT', 'operationId was already used for a different orphan-cleanup request.', { affectedId: normalized.operationId });
  }
  const stored = evidence.metadata?.result;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw createApiError(409, 'EMERGENCY_ORPHAN_CLEANUP_OPERATION_INCOMPLETE', 'Existing orphan-cleanup operation evidence is incomplete and cannot be replayed safely.', { affectedId: normalized.operationId });
  }
  return { ...(stored as EmergencyOrphanCleanupResult), replayed: true };
}

const MAX_CLASSIFICATION_SCAN = 100;

function classifyProject(normalized: ReturnType<typeof normalizedInput>) {
  const tasks = new Map(getTasksByProjectId(normalized.projectId).map((task) => [String(task.id), task]));
  const nowMs = Date.now();
  const candidates: EmergencyOrphanCleanupCandidate[] = [];
  let beforeActiveCount = 0;
  let offset = 0;
  let safeCount = 0;

  while (offset < MAX_CLASSIFICATION_SCAN && safeCount < normalized.limit) {
    const pageLimit = Math.max(1, Math.min(normalized.limit, MAX_CLASSIFICATION_SCAN - offset));
    const page = queryExecutionSessions({ projectId: normalized.projectId, status: 'active', limit: pageLimit, offset });
    if (offset === 0) beforeActiveCount = page.total;
    if (page.sessions.length === 0) break;
    for (const session of page.sessions) {
      const candidate = classifySession(session, normalized.projectId, tasks, nowMs);
      candidates.push(candidate);
      if (candidate.classification === 'safe') safeCount += 1;
      if (safeCount >= normalized.limit) break;
    }
    offset += page.sessions.length;
    if (offset >= page.total) break;
  }

  return {
    beforeActiveCount,
    scannedCount: candidates.length,
    safeCount,
    skippedCount: candidates.length - safeCount,
    truncated: candidates.length < beforeActiveCount,
    candidates,
  };
}

function buildResult(
  normalized: ReturnType<typeof normalizedInput>,
  classification: ReturnType<typeof classifyProject>,
  cancelledCount: number,
  afterActiveCount: number,
  replayed = false,
): EmergencyOrphanCleanupResult {
  return {
    projectId: normalized.projectId,
    operationId: normalized.operationId,
    mode: normalized.mode,
    actorLabel: normalized.actorLabel,
    reason: normalized.reason,
    limit: normalized.limit,
    replayed,
    beforeActiveCount: classification.beforeActiveCount,
    afterActiveCount,
    scannedCount: classification.scannedCount,
    safeCount: classification.safeCount,
    skippedCount: classification.skippedCount,
    cancelledCount,
    truncated: classification.truncated,
    candidates: classification.candidates,
  };
}

export function cleanupOrphanExecutions(input: EmergencyOrphanCleanupInput): EmergencyOrphanCleanupResult {
  const normalized = normalizedInput(input);
  const replay = replayResult(normalized);
  if (replay) return replay;

  if (normalized.mode === 'dry-run') {
    const classification = classifyProject(normalized);
    return buildResult(normalized, classification, 0, classification.beforeActiveCount);
  }

  return withDbTransaction(() => {
    const replayInsideTransaction = replayResult(normalized);
    if (replayInsideTransaction) return replayInsideTransaction;

    const classification = classifyProject(normalized);
    let cancelledCount = 0;
    for (const candidate of classification.candidates) {
      if (candidate.classification !== 'safe') continue;
      cancelExecutionSession(candidate.executionSessionId);
      cancelledCount += 1;
      recordExecutionReconciliationEvidence(candidate.executionSessionId, 'emergency-orphan-cleanup', {
        operationId: normalized.operationId,
        projectId: normalized.projectId,
        actorLabel: normalized.actorLabel,
        reason: normalized.reason,
        workspaceId: candidate.workspaceId,
        beforeActiveCount: classification.beforeActiveCount,
      });
      if (faultAfterForTests !== null && cancelledCount >= faultAfterForTests) {
        throw new Error(`Injected emergency orphan cleanup fault after ${cancelledCount} cancellation(s).`);
      }
    }

    const afterActiveCount = queryExecutionSessions({ projectId: normalized.projectId, status: 'active', limit: 1 }).total;
    const result = buildResult(normalized, classification, cancelledCount, afterActiveCount);

    const anchorSessionId = classification.candidates[0]?.executionSessionId
      || queryExecutionSessions({ projectId: normalized.projectId, limit: 1 }).sessions[0]?.id
      || null;
    if (anchorSessionId) {
      const nowIso = new Date().toISOString();
      saveExecutionSessionEvidence({
        id: operationEvidenceId(normalized.projectId, normalized.operationId),
        sessionId: anchorSessionId,
        kind: 'emergency-orphan-cleanup-operation',
        path: null,
        repoRevision: null,
        fileRevision: null,
        revisionIdentity: normalized.operationId,
        contextHandle: null,
        stale: false,
        metadata: {
          operationId: normalized.operationId,
          projectId: normalized.projectId,
          actorLabel: normalized.actorLabel,
          reason: normalized.reason,
          requestFingerprint: requestFingerprint(normalized),
          frozenExecutionSessionIds: classification.candidates.map((entry) => entry.executionSessionId),
          result,
        },
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }

    return result;
  });
}
