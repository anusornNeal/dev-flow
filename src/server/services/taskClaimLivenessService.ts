import type { TaskClaim } from '../../types.js';
import { getExecutionSessionById, listExecutionSessionsForWorkspace } from '../repositories/executionSessionRepository.js';
import { getTaskByIdentifier, saveTask } from '../repositories/taskRepository.js';
import { getJob, listRecentJobs } from '../repositories/mcpToolJobRepository.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import { getExecutionSessionOwnershipEpoch } from './executionOwnershipEpochService.js';

export const DEFAULT_TASK_CLAIM_LIVENESS_MS = 30 * 60 * 1000;
const MIN_TASK_CLAIM_LIVENESS_MS = 60_000;
const MAX_TASK_CLAIM_LIVENESS_MS = 6 * 60 * 60_000;

export type TaskClaimLivenessState = 'absent' | 'malformed' | 'retention-expired' | 'live' | 'stale-recoverable';

export type TaskClaimLivenessProjection = {
  state: TaskClaimLivenessState;
  live: boolean;
  retained: boolean;
  migrationDerived: boolean;
  workspaceId: string | null;
  ownershipEpochId: string | null;
  retentionExpiresAt: string | null;
  lastMeaningfulActivityAt: string | null;
  livenessExpiresAt: string | null;
  livenessWindowMs: number;
  source: string | null;
  activeExecutionSessionIds: string[];
  pendingOperationIds: string[];
  activeJobIds: string[];
  protectedByDurableWork: boolean;
};

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function dateMs(value: unknown) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function boundedWindowMs(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_TASK_CLAIM_LIVENESS_MS;
  return Math.max(MIN_TASK_CLAIM_LIVENESS_MS, Math.min(MAX_TASK_CLAIM_LIVENESS_MS, Math.floor(numeric)));
}

export function getTaskClaimLivenessWindowMs() {
  return boundedWindowMs(process.env.DEVFLOW_TASK_CLAIM_LIVENESS_MS);
}

function latestIso(values: unknown[]) {
  let latestMs = Number.NaN;
  let latest: string | null = null;
  for (const value of values) {
    const supplied = clean(value);
    const parsed = Date.parse(supplied);
    if (!supplied || !Number.isFinite(parsed)) continue;
    if (!Number.isFinite(latestMs) || parsed > latestMs) {
      latestMs = parsed;
      latest = supplied;
    }
  }
  return { value: latest, ms: latestMs };
}

function matchingActiveExecutions(claim: TaskClaim) {
  const workspaceId = clean(claim.workspaceId);
  const ownershipEpochId = clean(claim.ownershipEpochId);
  if (!workspaceId) return [];
  return listExecutionSessionsForWorkspace(workspaceId)
    .filter((entry) => entry.status === 'active')
    .filter((entry) => {
      const executionEpoch = getExecutionSessionOwnershipEpoch(entry.id).ownershipEpochId;
      return !ownershipEpochId || !executionEpoch || executionEpoch === ownershipEpochId;
    });
}

function pendingDurableWork(sessionIds: string[]) {
  const pendingOperationIds = new Set<string>();
  const activeJobIds = new Set<string>();
  for (const sessionId of sessionIds) {
    const checkpoint = getLatestExecutionCheckpoint(sessionId);
    for (const entry of checkpoint?.pendingOperations || []) {
      if (entry.status !== 'accepted' && entry.status !== 'running') continue;
      const operationId = clean(entry.operationId);
      if (!operationId) continue;
      const job = getJob(operationId);
      if (!job || job.status === 'queued' || job.status === 'running') {
        pendingOperationIds.add(operationId);
        if (job?.jobId) activeJobIds.add(job.jobId);
      }
    }
  }
  return { pendingOperationIds, activeJobIds };
}

function independentlyBoundActiveJobs(sessionIds: string[]) {
  if (sessionIds.length === 0) return [] as string[];
  const expected = new Set(sessionIds);
  return listRecentJobs(200)
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .filter((job) => expected.has(clean(job.args?.__executionJobBinding?.executionSessionId)))
    .map((job) => job.jobId)
    .filter(Boolean)
    .slice(0, 20);
}

export function createTaskClaimLiveness(now = new Date(), source = 'claim'): NonNullable<TaskClaim['liveness']> {
  const windowMs = getTaskClaimLivenessWindowMs();
  return {
    lastActivityAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + windowMs).toISOString(),
    windowMs,
    source,
  };
}

export function touchTaskClaimLiveness(claim: TaskClaim, now = new Date(), source = 'owned-activity'): TaskClaim {
  return { ...claim, liveness: createTaskClaimLiveness(now, source) };
}

export function resolveTaskClaimLiveness(claimValue: unknown, now = new Date()): TaskClaimLivenessProjection {
  const nowMs = now.getTime();
  const empty = (state: TaskClaimLivenessState, extras: Partial<TaskClaimLivenessProjection> = {}): TaskClaimLivenessProjection => ({
    state,
    live: false,
    retained: false,
    migrationDerived: false,
    workspaceId: null,
    ownershipEpochId: null,
    retentionExpiresAt: null,
    lastMeaningfulActivityAt: null,
    livenessExpiresAt: null,
    livenessWindowMs: getTaskClaimLivenessWindowMs(),
    source: null,
    activeExecutionSessionIds: [],
    pendingOperationIds: [],
    activeJobIds: [],
    protectedByDurableWork: false,
    ...extras,
  });

  if (claimValue == null) return empty('absent');
  if (typeof claimValue !== 'object' || Array.isArray(claimValue)) return empty('malformed');
  const claim = claimValue as TaskClaim;
  const workspaceId = clean(claim.workspaceId);
  const sessionIdHash = clean(claim.sessionIdHash);
  const retentionExpiresAt = clean(claim.expiresAt);
  const retentionExpiresAtMs = dateMs(retentionExpiresAt);
  const ownershipEpochId = clean(claim.ownershipEpochId) || null;
  if (!workspaceId || !sessionIdHash || !retentionExpiresAt || !Number.isFinite(retentionExpiresAtMs)) {
    return empty('malformed', { workspaceId: workspaceId || null, ownershipEpochId, retentionExpiresAt: retentionExpiresAt || null });
  }
  if (retentionExpiresAtMs <= nowMs) {
    return empty('retention-expired', { retained: false, workspaceId, ownershipEpochId, retentionExpiresAt });
  }

  const executions = matchingActiveExecutions(claim);
  const sessionIds = executions.map((entry) => entry.id);
  const explicit = claim.liveness && typeof claim.liveness === 'object' ? claim.liveness : null;
  const windowMs = boundedWindowMs(explicit?.windowMs ?? getTaskClaimLivenessWindowMs());
  const activity = latestIso([
    explicit?.lastActivityAt,
    ...executions.map((entry) => entry.updatedAt),
    claim.claimedAt,
  ]);
  const explicitExpiryMs = dateMs(explicit?.expiresAt);
  const derivedExpiryMs = Number.isFinite(activity.ms) ? activity.ms + windowMs : Number.NaN;
  const livenessExpiresAtMs = Number.isFinite(explicitExpiryMs)
    ? (Number.isFinite(derivedExpiryMs) ? Math.max(explicitExpiryMs, derivedExpiryMs) : explicitExpiryMs)
    : derivedExpiryMs;
  const livenessExpiresAt = Number.isFinite(livenessExpiresAtMs) ? new Date(livenessExpiresAtMs).toISOString() : null;
  const migrationDerived = !explicit || !clean(explicit.expiresAt) || !clean(explicit.lastActivityAt);
  const pending = pendingDurableWork(sessionIds);
  const independentlyActive = pending.pendingOperationIds.size === 0 && Number.isFinite(livenessExpiresAtMs) && livenessExpiresAtMs <= nowMs
    ? independentlyBoundActiveJobs(sessionIds)
    : [];
  for (const jobId of independentlyActive) pending.activeJobIds.add(jobId);
  const protectedByDurableWork = pending.pendingOperationIds.size > 0 || pending.activeJobIds.size > 0;
  const live = protectedByDurableWork || (Number.isFinite(livenessExpiresAtMs) && livenessExpiresAtMs > nowMs);

  return {
    state: live ? 'live' : 'stale-recoverable',
    live,
    retained: true,
    migrationDerived,
    workspaceId,
    ownershipEpochId,
    retentionExpiresAt,
    lastMeaningfulActivityAt: activity.value,
    livenessExpiresAt,
    livenessWindowMs: windowMs,
    source: clean(explicit?.source) || (migrationDerived ? 'legacy-derived' : 'persisted'),
    activeExecutionSessionIds: sessionIds.slice(0, 20),
    pendingOperationIds: [...pending.pendingOperationIds].slice(0, 20),
    activeJobIds: [...pending.activeJobIds].slice(0, 20),
    protectedByDurableWork,
  };
}

export function touchTaskClaimLivenessForExecution(sessionIdValue: string, now = new Date(), source = 'execution-activity') {
  const sessionId = clean(sessionIdValue);
  const session = sessionId ? getExecutionSessionById(sessionId) : null;
  if (!session?.taskId || !session.workspaceId || session.status !== 'active') return null;
  const task = getTaskByIdentifier(session.taskId, 'full');
  if (!task?.claim || clean(task.claim.workspaceId) !== clean(session.workspaceId)) return null;
  const claimEpoch = clean(task.claim.ownershipEpochId);
  const executionEpoch = getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId;
  if (claimEpoch && executionEpoch && claimEpoch !== executionEpoch) return null;
  const retentionExpiresAtMs = dateMs(task.claim.expiresAt);
  if (!Number.isFinite(retentionExpiresAtMs) || retentionExpiresAtMs <= now.getTime()) return null;
  const claim = touchTaskClaimLiveness(task.claim, now, source);
  saveTask({ ...task, claim, updatedAt: now.toISOString() });
  return claim.liveness || null;
}
