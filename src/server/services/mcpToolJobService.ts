import { createHash, randomUUID } from 'crypto';
import type { AppState } from '../types';
import { createJob, updateJobStatus, appendJobLog, writeJobResult, getJob, readJobLog, readJobResult, listRecentJobs, startBackgroundJobCleanup, claimJob, heartbeatJob, requestJobCancellation, transitionJobStatus, listRecoverableJobs, setJobRecoveryClassification, requeueJobForRecovery, getDurableJobMetrics, markJobConsumerAttached, markJobConsumerDetached, type McpToolJob, type JobLeaseGuard } from '../repositories/mcpToolJobRepository';
import { createApiError, normalizeUnknownError } from './api';
import { resolveProjectResourceIdentity, resolveProjectRoot } from './localFileService';
import { isDevFlowRestartPending, readDevFlowRestartState } from '../../lib/devFlowRestart';
import { getRepoRevisionForRoot } from './repoRevisionService';
import { getProjectCommandAdmissionPreflight, getProjectCommandExecutionIdentity, prepareProjectCommandVerificationCandidateAsync, type ProjectCommandExecutionIdentity } from './projectCommandService';
import { releaseVerificationCandidate, releaseVerificationCandidateAsync } from './verificationCandidateService';
import { getToolDefinitionByName } from '../contracts/devflowContract';
import {
  buildQueueEntryDiagnostics,
  decrementScheduledResource,
  getActiveResourceSnapshot,
  getBlockerForQueueEntry,
  getSchedulerProfile,
  getSchedulerPriority,
  getSchedulerCapacitySnapshot,
  selectNextRunnableQueueIndex,
  incrementScheduledResource,
  transitionScheduledResource,
  tryAcquireVerificationProcessPermit,
  releaseVerificationProcessPermit,
  scopeVerificationResources,
  type VerificationProcessPermit,
  type VerificationProcessPermitRequest,
  type JobKind,
  type JobCostClass,
  type ResourceAccessMode,
  type SchedulerQueueEntry,
} from './mcpToolJobScheduler';
import { getBuiltinToolJobRecoveryPolicy, runBuiltinToolJob } from './mcpToolJobRunnerRegistry';
import { recoveryPolicyForJobStatus, type ToolRecoveryPolicy } from './toolRecoveryPolicy.js';

type Logger = { stdout: (data: string) => void; stderr: (data: string) => void };
type VerificationPermitDemand = Omit<VerificationProcessPermitRequest, 'jobId'>;
type VerificationExecutionLease = {
  runWithPermit: <T>(request: VerificationPermitDemand, run: () => Promise<T>) => Promise<T>;
  dispose: () => void;
};
type TransitionAccessResult = void | VerificationExecutionLease | Promise<void | VerificationExecutionLease>;
type AsyncRunner = (
  state: AppState,
  args: any,
  logger: Logger,
  setCancelFn: (fn: () => void) => void,
  transitionAccess: (accessMode: ResourceAccessMode, request?: VerificationPermitDemand) => TransitionAccessResult,
) => Promise<any>;

type QueueWaitType = 'workspace_lock' | 'capacity';

type QueueWaitTelemetry = {
  lastObservedAt: number;
  currentWaitType?: QueueWaitType;
  lastBlockReason?: string;
  workspaceLockWaitMs: number;
  capacityWaitMs: number;
  blockerReasons: Record<string, number>;
  finalized?: boolean;
};

type FinalizedQueueWaitTelemetry = {
  jobId: string;
  resourceScope: 'workspace' | 'shared-repo' | 'other';
  workspaceLockWaitMs: number;
  capacityWaitMs: number;
  blockerReasons: Record<string, number>;
};

type JobPhaseTelemetryState = {
  jobId: string;
  resourceScope: FinalizedQueueWaitTelemetry['resourceScope'];
  admissionWaitMs: number;
  enqueuedAt: number;
  queueCompletedAt?: number;
  candidatePreparationStartedAt?: number;
  candidatePreparationCompletedAt?: number;
  executionStartedAt?: number;
  executionCompletedAt?: number;
  responseHandoffMs: number;
  workspaceLockWaitMs: number;
  capacityWaitMs: number;
  blockerReasons: Record<string, number>;
  finalized?: boolean;
};

type JobPhaseTimings = {
  admissionWaitMs: number;
  queueWaitMs: number;
  workspaceLockWaitMs: number;
  capacityWaitMs: number;
  candidatePreparationMs: number;
  executionMs: number;
  responseHandoffMs: number;
};

type VerificationQueuePolicy = {
  seriesKey?: string;
  candidateKey?: string;
  required: boolean;
  projectKey: string;
  resourceBacklogLimit: number;
  projectBacklogLimit: number;
};

type JobSupersession = {
  candidateKey?: string;
  supersededByCandidateKey: string;
  cooperativeCancellationRequested: boolean;
  recordedAt: number;
};

interface QueueEntry extends SchedulerQueueEntry {
  state: AppState;
  singleFlightKey?: string;
  verification?: VerificationQueuePolicy;
  waitTelemetry: QueueWaitTelemetry;
  phaseTelemetry: JobPhaseTelemetryState;
}

const queue: QueueEntry[] = [];
const activeJobs = new Map<string, { entry: QueueEntry; cancelFn?: () => void; leaseGeneration: number }>();
const releasedSchedulerLeases = new Set<string>();
const testRunners = new Map<string, AsyncRunner>();
const jobWaiters = new Map<string, Set<(status: ReturnType<typeof getToolJobStatus>) => void>>();
const schedulerCapacityWaiters = new Set<() => void>();
const singleFlightLeaders = new Map<string, string>();
const singleFlightFollowers = new Map<string, Set<string>>();
const followerToLeader = new Map<string, string>();
const jobSupersessionById = new Map<string, JobSupersession>();
let singleFlightHits = 0;
let supersededQueuedJobs = 0;
let cooperativeSupersedeCancellations = 0;
let verificationBackpressureRejections = 0;
const MAX_RECENT_QUEUE_WAITS = 200;
const recentQueueWaitTelemetry: FinalizedQueueWaitTelemetry[] = [];
const MAX_JOB_PHASE_TELEMETRY = 500;
const MAX_JOB_SUPERSESSION_RECORDS = 500;
const DEFAULT_VERIFICATION_BACKLOG_PER_RESOURCE = 3;
const DEFAULT_VERIFICATION_BACKLOG_PER_PROJECT = 12;
const jobPhaseTelemetryById = new Map<string, JobPhaseTelemetryState>();
const JOB_LEASE_MS = 30_000;
const JOB_HEARTBEAT_MS = 10_000;
const JOB_RECOVERY_SWEEP_MS = 5_000;
const JOB_WORKER_ID = `devflow-${process.pid}-${randomUUID().slice(0, 8)}`;
let durableRecoveryTimer: NodeJS.Timeout | undefined;
let durableRecoveryState: AppState | undefined;

function resourceScopeFor(resourceKey: string): FinalizedQueueWaitTelemetry['resourceScope'] {
  if (resourceKey.startsWith('workspace:')) return 'workspace';
  if (resourceKey.startsWith('repo:')) return 'shared-repo';
  return 'other';
}

function advanceQueueWaitTelemetry(entry: QueueEntry, blocker: { waitType?: string; blockReason?: string } | null, now = Date.now()) {
  const telemetry = entry.waitTelemetry;
  const elapsed = Math.max(0, now - telemetry.lastObservedAt);
  if (telemetry.currentWaitType === 'workspace_lock') telemetry.workspaceLockWaitMs += elapsed;
  if (telemetry.currentWaitType === 'capacity') telemetry.capacityWaitMs += elapsed;
  telemetry.lastObservedAt = now;
  const nextWaitType: QueueWaitType | undefined = blocker?.waitType === 'workspace_lock' || blocker?.waitType === 'capacity' ? blocker.waitType : undefined;
  if (blocker?.blockReason && blocker.blockReason !== telemetry.lastBlockReason) {
    telemetry.blockerReasons[blocker.blockReason] = (telemetry.blockerReasons[blocker.blockReason] || 0) + 1;
  }
  telemetry.currentWaitType = nextWaitType;
  telemetry.lastBlockReason = blocker?.blockReason;
}

function finalizedQueueWaitRecord(entry: QueueEntry, now = Date.now()): FinalizedQueueWaitTelemetry {
  const telemetry = entry.waitTelemetry;
  let workspaceLockWaitMs = telemetry.workspaceLockWaitMs;
  let capacityWaitMs = telemetry.capacityWaitMs;
  const elapsed = Math.max(0, now - telemetry.lastObservedAt);
  if (telemetry.currentWaitType === 'workspace_lock') workspaceLockWaitMs += elapsed;
  if (telemetry.currentWaitType === 'capacity') capacityWaitMs += elapsed;
  return { jobId: entry.jobId, resourceScope: resourceScopeFor(entry.resourceKey), workspaceLockWaitMs, capacityWaitMs, blockerReasons: { ...telemetry.blockerReasons } };
}

function finalizeQueueWaitTelemetry(entry: QueueEntry, now = Date.now()) {
  if (entry.waitTelemetry.finalized) return;
  advanceQueueWaitTelemetry(entry, null, now);
  entry.waitTelemetry.finalized = true;
  const finalized = finalizedQueueWaitRecord(entry, now);
  entry.phaseTelemetry.queueCompletedAt = now;
  entry.phaseTelemetry.workspaceLockWaitMs = finalized.workspaceLockWaitMs;
  entry.phaseTelemetry.capacityWaitMs = finalized.capacityWaitMs;
  entry.phaseTelemetry.blockerReasons = { ...finalized.blockerReasons };
  rememberJobPhaseTelemetry(entry.phaseTelemetry);
  recentQueueWaitTelemetry.push(finalized);
  if (recentQueueWaitTelemetry.length > MAX_RECENT_QUEUE_WAITS) recentQueueWaitTelemetry.splice(0, recentQueueWaitTelemetry.length - MAX_RECENT_QUEUE_WAITS);
}

function rememberJobPhaseTelemetry(state: JobPhaseTelemetryState) {
  jobPhaseTelemetryById.delete(state.jobId);
  jobPhaseTelemetryById.set(state.jobId, state);
  while (jobPhaseTelemetryById.size > MAX_JOB_PHASE_TELEMETRY) {
    const oldest = jobPhaseTelemetryById.keys().next().value as string | undefined;
    if (!oldest) break;
    jobPhaseTelemetryById.delete(oldest);
  }
}

function getJobPhaseTimings(state: JobPhaseTelemetryState, entry?: QueueEntry, now = Date.now()): JobPhaseTimings {
  const wait = entry ? finalizedQueueWaitRecord(entry, now) : null;
  const queueEnd = state.queueCompletedAt ?? state.candidatePreparationStartedAt ?? state.executionStartedAt ?? now;
  const queueWaitMs = Math.max(0, queueEnd - state.enqueuedAt);
  const rawWorkspaceWaitMs = wait?.workspaceLockWaitMs ?? state.workspaceLockWaitMs;
  const workspaceLockWaitMs = Math.min(queueWaitMs, Math.max(0, rawWorkspaceWaitMs));
  const rawCapacityWaitMs = wait?.capacityWaitMs ?? state.capacityWaitMs;
  const capacityWaitMs = Math.min(Math.max(0, queueWaitMs - workspaceLockWaitMs), Math.max(0, rawCapacityWaitMs));
  const candidatePreparationMs = state.candidatePreparationStartedAt
    ? Math.max(0, (state.candidatePreparationCompletedAt ?? state.executionStartedAt ?? now) - state.candidatePreparationStartedAt)
    : 0;
  const executionMs = state.executionStartedAt
    ? Math.max(0, (state.executionCompletedAt ?? now) - state.executionStartedAt)
    : 0;
  return {
    admissionWaitMs: Math.max(0, state.admissionWaitMs),
    queueWaitMs,
    workspaceLockWaitMs,
    capacityWaitMs,
    candidatePreparationMs,
    executionMs,
    responseHandoffMs: Math.max(0, state.responseHandoffMs),
  };
}

function summarizeJobPhaseTelemetry() {
  const now = Date.now();
  const queuedById = new Map(queue.map((entry) => [entry.jobId, entry]));
  const activeById = new Map(Array.from(activeJobs.entries(), ([jobId, value]) => [jobId, value.entry]));
  const timings = Array.from(jobPhaseTelemetryById.values()).map((state) => getJobPhaseTimings(state, queuedById.get(state.jobId) || activeById.get(state.jobId), now));
  const summary = (values: number[]) => ({
    count: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
  });
  return {
    admissionWait: summary(timings.map((entry) => entry.admissionWaitMs)),
    queueWait: summary(timings.map((entry) => entry.queueWaitMs)),
    workspaceLockWait: summary(timings.map((entry) => entry.workspaceLockWaitMs).filter((value) => value > 0)),
    capacityWait: summary(timings.map((entry) => entry.capacityWaitMs).filter((value) => value > 0)),
    candidatePreparation: summary(timings.map((entry) => entry.candidatePreparationMs).filter((value) => value > 0)),
    execution: summary(timings.map((entry) => entry.executionMs)),
    responseHandoff: summary(timings.map((entry) => entry.responseHandoffMs)),
  };
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeQueueWaitTelemetry() {
  const now = Date.now();
  const records = [...recentQueueWaitTelemetry, ...queue.map((entry) => finalizedQueueWaitRecord(entry, now))];
  const workspaceSamples = records.map((record) => record.workspaceLockWaitMs).filter((value) => value > 0);
  const capacitySamples = records.map((record) => record.capacityWaitMs).filter((value) => value > 0);
  const blockerReasons: Record<string, number> = {};
  for (const record of records) for (const [reason, count] of Object.entries(record.blockerReasons)) blockerReasons[reason] = (blockerReasons[reason] || 0) + count;
  const summary = (samples: number[]) => ({ count: samples.length, totalMs: samples.reduce((sum, value) => sum + value, 0), p50Ms: percentile(samples, 50), p95Ms: percentile(samples, 95) });
  return { workspaceLockWait: summary(workspaceSamples), capacityWait: summary(capacitySamples), blockerReasons };
}

function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizedOptionalString(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function boundedBacklogLimit(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(numeric)));
}

function hasExplicitVerificationPolicy(args: any) {
  return Boolean(
    normalizedOptionalString(args?.verificationSeriesKey)
    || normalizedOptionalString(args?.verificationCandidateKey)
    || args?.verificationRequired === true
    || args?.reviewRequired === true
    || args?.requiredVerification === true
    || args?.verificationBacklogLimit !== undefined
    || args?.verificationWorkspaceBacklogLimit !== undefined
    || args?.verificationProjectBacklogLimit !== undefined
  );
}

function verificationPolicyFor(args: any, accessMode: ResourceAccessMode, resourceKey: string): VerificationQueuePolicy | undefined {
  if (accessMode !== 'verify') return undefined;
  const sharedLimit = boundedBacklogLimit(args?.verificationBacklogLimit, DEFAULT_VERIFICATION_BACKLOG_PER_RESOURCE);
  const projectId = normalizedOptionalString(args?.projectId);
  return {
    seriesKey: normalizedOptionalString(args?.verificationSeriesKey),
    candidateKey: normalizedOptionalString(args?.verificationCandidateKey),
    required: args?.verificationRequired === true || args?.reviewRequired === true || args?.requiredVerification === true,
    projectKey: projectId ? `project:${projectId}` : resourceKey,
    resourceBacklogLimit: boundedBacklogLimit(args?.verificationWorkspaceBacklogLimit, sharedLimit),
    projectBacklogLimit: boundedBacklogLimit(args?.verificationProjectBacklogLimit, Math.max(sharedLimit, DEFAULT_VERIFICATION_BACKLOG_PER_PROJECT)),
  };
}

function rememberJobSupersession(jobId: string, supersession: JobSupersession) {
  jobSupersessionById.delete(jobId);
  jobSupersessionById.set(jobId, supersession);
  while (jobSupersessionById.size > MAX_JOB_SUPERSESSION_RECORDS) {
    const oldest = jobSupersessionById.keys().next().value as string | undefined;
    if (!oldest) break;
    jobSupersessionById.delete(oldest);
  }
}

function hasLiveSharedConsumer(jobId: string) {
  return (singleFlightFollowers.get(jobId)?.size || 0) > 0;
}

function canSupersedeVerification(entry: QueueEntry) {
  return entry.accessMode === 'verify' && entry.verification?.required !== true && !hasLiveSharedConsumer(entry.jobId);
}

function supersededJobResult(entry: QueueEntry, supersededByCandidateKey: string) {
  return {
    ok: false,
    status: 'cancelled',
    code: 'JOB_SUPERSEDED',
    message: `Verification candidate ${entry.verification?.candidateKey || 'unknown'} was superseded by ${supersededByCandidateKey}.`,
    verificationCandidateKey: entry.verification?.candidateKey,
    supersededByCandidateKey,
    authoritative: false,
  };
}

function recordSupersession(entry: QueueEntry, supersededByCandidateKey: string, cooperativeCancellationRequested: boolean) {
  rememberJobSupersession(entry.jobId, {
    candidateKey: entry.verification?.candidateKey,
    supersededByCandidateKey,
    cooperativeCancellationRequested,
    recordedAt: Date.now(),
  });
}

function supersedeObsoleteVerification(policy: VerificationQueuePolicy) {
  if (!policy.seriesKey || !policy.candidateKey) return;

  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const entry = queue[index];
    if (entry.verification?.seriesKey !== policy.seriesKey || entry.verification?.candidateKey === policy.candidateKey) continue;
    if (!canSupersedeVerification(entry)) continue;
    queue.splice(index, 1);
    recordSupersession(entry, policy.candidateKey, false);
    requestJobCancellation(entry.jobId, `Verification superseded by candidate ${policy.candidateKey}.`);
    writeJobResult(entry.jobId, supersededJobResult(entry, policy.candidateKey));
    finalizeQueueWaitTelemetry(entry);
    void releaseVerificationCandidateForArgsAsync(entry.args).catch(() => {});
    appendJobLog(entry.jobId, 'stderr', `\n[Verification Superseded] Replaced by candidate ${policy.candidateKey}.\n`);
    finalizeSingleFlight(entry);
    notifyJobWaiters(entry.jobId);
    supersededQueuedJobs += 1;
  }

  for (const active of activeJobs.values()) {
    const entry = active.entry;
    if (entry.verification?.seriesKey !== policy.seriesKey || entry.verification?.candidateKey === policy.candidateKey) continue;
    if (!canSupersedeVerification(entry)) continue;
    const canCancel = typeof active.cancelFn === 'function' && entry.args?.allowSupersedeRunning !== false;
    recordSupersession(entry, policy.candidateKey, canCancel);
    appendJobLog(entry.jobId, 'stderr', `\n[Verification Superseded] Newer candidate ${policy.candidateKey} is authoritative.\n`);
    if (canCancel) {
      requestJobCancellation(entry.jobId, `Verification superseded by candidate ${policy.candidateKey}.`);
      writeJobResult(entry.jobId, supersededJobResult(entry, policy.candidateKey));
      active.cancelFn?.();
      cooperativeSupersedeCancellations += 1;
    }
  }
}

function enforceVerificationBackpressure(policy: VerificationQueuePolicy, resourceKey: string) {
  const queuedVerification = queue.filter((entry) => entry.accessMode === 'verify');
  const resourceQueued = queuedVerification.filter((entry) => entry.resourceKey === resourceKey).length;
  const projectQueued = queuedVerification.filter((entry) => entry.verification?.projectKey === policy.projectKey).length;
  if (resourceQueued < policy.resourceBacklogLimit && projectQueued < policy.projectBacklogLimit) return;
  verificationBackpressureRejections += 1;
  throw createApiError(429, 'VERIFICATION_BACKPRESSURE', 'Verification backlog limit reached; retry after older verification completes or is superseded.', {
    retryable: true,
    details: {
      resourceQueued,
      resourceBacklogLimit: policy.resourceBacklogLimit,
      projectQueued,
      projectBacklogLimit: policy.projectBacklogLimit,
      requiredVerification: policy.required,
    },
  });
}

function isTerminalStatus(status?: string) {
  return status === 'succeeded' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
}

function notifyJobWaiters(jobId: string) {
  const status = getToolJobStatus(jobId);
  if (!status || !isTerminalStatus(status.status)) return;
  const waiters = jobWaiters.get(jobId);
  if (!waiters) return;
  jobWaiters.delete(jobId);
  for (const resolve of waiters) resolve(status);
}

function verificationCandidateIdForArgs(args: any) {
  const candidateId = args?.__verificationCandidate?.candidateId;
  return typeof candidateId === 'string' && candidateId.trim() ? candidateId.trim() : '';
}

function releaseVerificationCandidateForArgs(args: any) {
  const candidateId = verificationCandidateIdForArgs(args);
  return candidateId ? releaseVerificationCandidate(candidateId) : false;
}

async function releaseVerificationCandidateForArgsAsync(args: any) {
  const candidateId = verificationCandidateIdForArgs(args);
  return candidateId ? await releaseVerificationCandidateAsync(candidateId) : false;
}

function projectCommandAdmissionIdentityForArgs(args: any): ProjectCommandExecutionIdentity | null {
  const raw = args?.__projectCommandAdmissionIdentity;
  if (!raw || typeof raw !== 'object') return null;
  if (!/^[a-f0-9]{64}$/i.test(String(raw.key || ''))) return null;
  if (!String(raw.repoRevision || '').trim() || !String(raw.lineageToken || '').trim() || !String(raw.semanticKey || '').trim() || !String(raw.command || '').trim()) return null;
  return {
    key: String(raw.key),
    repoRevision: String(raw.repoRevision),
    lineageToken: String(raw.lineageToken),
    semanticKey: String(raw.semanticKey),
    command: String(raw.command),
    ...(raw.commandConfigFingerprint ? { commandConfigFingerprint: String(raw.commandConfigFingerprint) } : {}),
  };
}

function singleFlightKeyFor(state: AppState, toolName: string, args: any, kind: JobKind, resourceKey: string) {
  const enabled = kind === 'repo-read'
    ? args?.singleFlight !== false
    : kind === 'repo-command' && toolName === 'run_project_command' && args?.singleFlight !== false;
  if (!enabled || (!resourceKey.startsWith('repo:') && !resourceKey.startsWith('workspace:')) || resourceKey === 'repo:unknown') return null;

  if (kind === 'repo-command' && toolName === 'run_project_command') {
    try {
      const capturedExecutionKey = args?.__verificationCandidate?.executionIdentity?.key || projectCommandAdmissionIdentityForArgs(args)?.key;
      const executionIdentity = typeof capturedExecutionKey === 'string' && capturedExecutionKey.trim()
        ? { key: capturedExecutionKey.trim() }
        : getProjectCommandExecutionIdentity(state, args);
      if (!executionIdentity) return null;
      return createHash('sha256').update(stableStringify({ resourceKey, toolName, kind, executionKey: executionIdentity.key })).digest('hex');
    } catch {
      return null;
    }
  }

  let root: string;
  try {
    root = resolveProjectRoot(state, args);
  } catch {
    return null;
  }
  let repoRevision: string;
  try {
    repoRevision = getRepoRevisionForRoot(root).token;
  } catch {
    return null;
  }
  const normalizedArgs = { ...args };
  delete normalizedArgs.singleFlight;
  const raw = stableStringify({ resourceKey, repoRevision, toolName, kind, args: normalizedArgs });
  return createHash('sha256').update(raw).digest('hex');
}

function finalizeSingleFlight(entry: QueueEntry) {
  notifyJobWaiters(entry.jobId);
  const key = entry.singleFlightKey;
  if (!key || singleFlightLeaders.get(key) !== entry.jobId) return;
  singleFlightLeaders.delete(key);
  const followers = singleFlightFollowers.get(entry.jobId);
  singleFlightFollowers.delete(entry.jobId);
  if (!followers?.size) return;

  const leaderStatus = getJob(entry.jobId);
  const leaderResult = readJobResult(entry.jobId)?.result;
  for (const followerJobId of followers) {
    followerToLeader.delete(followerJobId);
    const followerStatus = getJob(followerJobId);
    if (!followerStatus || followerStatus.status === 'cancelled') {
      notifyJobWaiters(followerJobId);
      continue;
    }
    if (leaderResult !== null && leaderResult !== undefined) writeJobResult(followerJobId, leaderResult);
    updateJobStatus(followerJobId, {
      status: (leaderStatus?.status && isTerminalStatus(leaderStatus.status) ? leaderStatus.status : 'failed') as any,
      failureSummary: leaderStatus?.failureSummary,
    });
    appendJobLog(followerJobId, 'stdout', `\n[Single Flight] Shared result from ${entry.jobId}.\n`);
    notifyJobWaiters(followerJobId);
  }
}

export function waitForToolJob(jobId: string, waitMs = 20_000) {
  const current = getToolJobStatus(jobId);
  if (!current || isTerminalStatus(current.status)) return Promise.resolve(current);
  const boundedWaitMs = Math.max(0, Math.min(30_000, Number(waitMs) || 0));
  if (boundedWaitMs === 0) return Promise.resolve(current);

  markJobConsumerAttached(jobId);
  return new Promise<ReturnType<typeof getToolJobStatus>>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (status: ReturnType<typeof getToolJobStatus>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const waiters = jobWaiters.get(jobId);
      waiters?.delete(finish);
      const noLiveWaiters = !waiters || waiters.size === 0;
      if (noLiveWaiters) jobWaiters.delete(jobId);
      if (noLiveWaiters && status && !isTerminalStatus(status.status)) markJobConsumerDetached(jobId);
      resolve(status);
    };
    const waiters = jobWaiters.get(jobId) || new Set();
    waiters.add(finish);
    jobWaiters.set(jobId, waiters);
    timer = setTimeout(() => finish(getToolJobStatus(jobId)), boundedWaitMs);
    timer.unref?.();
  });
}

export async function waitForToolJobResultForRecovery(payload: Record<string, any>, _error: unknown, options: { waitMs: number }) {
  const jobId = String(payload?.jobId || '').trim();
  if (!jobId) return { ready: false };
  const status = await waitForToolJob(jobId, options.waitMs);
  if (!status || !isTerminalStatus(status.status)) return { ready: false };
  const persisted = readJobResult(jobId) as any;
  return { ready: true, value: persisted?.result ?? status };
}

export function getToolJobWaitGuidance(status: ReturnType<typeof getToolJobStatus>) {
  if (!status) {
    return {
      ready: false,
      nextPollAfterMs: 0,
      recommendedWaitMs: 0,
      nextAction: 'The job no longer exists. Do not keep polling this job id.',
    };
  }
  if (isTerminalStatus(status.status)) {
    return {
      ready: true,
      nextPollAfterMs: 0,
      recommendedWaitMs: 0,
      nextAction: `Read the terminal result for ${status.jobId} with get_tool_job_result.`,
    };
  }

  const queuePosition = Math.max(0, Number(status.queuePosition || 0));
  const nextPollAfterMs = status.status === 'queued'
    ? Math.min(10_000, 3_000 + Math.max(0, queuePosition - 1) * 1_000)
    : 2_000;
  return {
    ready: false,
    nextPollAfterMs,
    recommendedWaitMs: 30_000,
    nextAction: `Call get_tool_job_result for ${status.jobId} with waitMs=30000. Use get_tool_job_status/get_tool_job_log only for diagnostics.`,
  };
}

function activeSchedulerEntries(): SchedulerQueueEntry[] {
  return Array.from(activeJobs.values(), ({ entry }) => entry);
}

function isTimedOutResult(result: any) {
  return result && typeof result === 'object' && result.timedOut === true;
}

function summarizeError(error: any) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function getNextAction(status: string, recovery: ToolRecoveryPolicy | null) {
  if (status === 'queued' || status === 'running') {
    return recovery?.guidance || 'Wait for the existing job result; do not create a duplicate job.';
  }
  if (status === 'succeeded') {
    return 'Call get_tool_job_result to read the completed result.';
  }
  if (status === 'timed_out' || status === 'failed') {
    return recovery
      ? `Read get_tool_job_result for the terminal error. Recovery policy: ${recovery.guidance}`
      : 'Read get_tool_job_log/get_tool_job_result and change strategy explicitly; do not replay the same failed payload unchanged.';
  }
  if (status === 'cancelled') {
    return 'The job was cancelled; inspect why before deciding whether a changed tool call is still needed.';
  }
  return 'Inspect job status, logs, and result.';
}

function getTerminalJobErrorCode(jobId: string) {
  try {
    const persisted = readJobResult(jobId) as any;
    const result = persisted?.result;
    const code = result?.code || result?.error?.code;
    return typeof code === 'string' && code.trim() ? code.trim() : undefined;
  } catch {
    return undefined;
  }
}

function getLastLog(jobId: string) {
  const log = readJobLog(jobId, 'both').log;
  return log.length > 4000 ? log.slice(-4000) : log;
}

function buildJobSummary(job: ReturnType<typeof getJob>) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    toolName: job.toolName,
    status: job.status,
    resourceKey: job.resourceKey,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    waitMs: job.waitMs,
    durationMs: job.durationMs,
    failureSummary: job.failureSummary
  };
}

function getRecoveryJobKind(toolName: string): JobKind {
  const definition = getToolDefinitionByName(toolName);
  return (definition?.executionPolicy?.jobKind || 'repo-command') as JobKind;
}

function enqueueRecoveredJob(state: AppState, job: McpToolJob) {
  if (queue.some((entry) => entry.jobId === job.jobId) || activeJobs.has(job.jobId)) return false;
  const kind = getRecoveryJobKind(job.toolName);
  const schedulerProfile = getSchedulerProfile(state, job.toolName, job.args, kind, job.resourceKey);
  const recoveredSingleFlightKey = Array.from(singleFlightLeaders.entries()).find(([, leaderJobId]) => leaderJobId === job.jobId)?.[0];
  const parsedUpdatedAt = Date.parse(job.updatedAt);
  const enqueuedAt = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : Date.now();
  const phaseTelemetry: JobPhaseTelemetryState = {
    jobId: job.jobId,
    resourceScope: resourceScopeFor(job.resourceKey),
    admissionWaitMs: 0,
    enqueuedAt,
    responseHandoffMs: 0,
    workspaceLockWaitMs: 0,
    capacityWaitMs: 0,
    blockerReasons: {},
  };
  rememberJobPhaseTelemetry(phaseTelemetry);
  queue.push({
    jobId: job.jobId,
    resourceKey: job.resourceKey,
    kind,
    state,
    toolName: job.toolName,
    args: job.args,
    accessMode: schedulerProfile.accessMode,
    costClass: schedulerProfile.costClass,
    verificationClass: schedulerProfile.verificationClass,
    sharedResources: schedulerProfile.sharedResources,
    enqueuedAt,
    schedulerPriority: getSchedulerPriority(job.toolName, job.args, schedulerProfile.accessMode, schedulerProfile.verificationClass),
    singleFlightKey: recoveredSingleFlightKey,
    verification: verificationPolicyFor(job.args, schedulerProfile.accessMode, job.resourceKey),
    waitTelemetry: { lastObservedAt: Date.now(), workspaceLockWaitMs: 0, capacityWaitMs: 0, blockerReasons: {} },
    phaseTelemetry,
  });
  return true;
}

export function getQueueMetrics() {
  const activeJobsList = Array.from(activeJobs.values()).map(({ entry }) => ({
    jobId: entry.jobId,
    kind: entry.kind,
    resourceKey: entry.resourceKey,
    toolName: entry.toolName,
    accessMode: entry.accessMode,
    costClass: entry.costClass,
  }));
  const recentJobs = listRecentJobs(50);
  const durable = getDurableJobMetrics();
  const terminalJobs = recentJobs.filter(job => ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(job.status));
  const failedJobs = terminalJobs.filter(job => job.status === 'failed' || job.status === 'timed_out');
  const waitSamples = recentJobs.map(job => job.waitMs).filter((value): value is number => typeof value === 'number');
  const runSamples = recentJobs.map(job => job.durationMs).filter((value): value is number => typeof value === 'number');
  const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

  return {
    queueLength: queue.length,
    activeJobs: activeJobs.size,
    queue: queue.map((entry, index) => buildQueueEntryDiagnostics(entry, index, queue, activeSchedulerEntries())),
    active: activeJobsList,
    resources: getActiveResourceSnapshot(),
    capacity: getSchedulerCapacitySnapshot(),
    metrics: {
      completedJobs: terminalJobs.length,
      failedJobs: failedJobs.length,
      averageWaitMs: average(waitSamples),
      averageRunMs: average(runSamples),
      singleFlightHits,
      superseded: {
        queued: supersededQueuedJobs,
        cooperativeCancellationRequests: cooperativeSupersedeCancellations,
        tracked: jobSupersessionById.size,
      },
      backpressure: {
        rejections: verificationBackpressureRejections,
        defaultResourceLimit: DEFAULT_VERIFICATION_BACKLOG_PER_RESOURCE,
        defaultProjectLimit: DEFAULT_VERIFICATION_BACKLOG_PER_PROJECT,
      },
      waitTelemetry: summarizeQueueWaitTelemetry(),
      phaseTelemetry: summarizeJobPhaseTelemetry(),
      durable,
      failures: failedJobs.slice(0, 10).map(job => ({
        jobId: job.jobId,
        toolName: job.toolName,
        status: job.status,
        failureSummary: job.failureSummary || getLastLog(job.jobId).slice(-500)
      }))
    },
    recentJobs: recentJobs.map(buildJobSummary).filter(Boolean)
  };
}

function schedulerLeaseKey(jobId: string, leaseGeneration: number) {
  return `${jobId}:${leaseGeneration}`;
}

function notifySchedulerCapacityWaiters() {
  if (schedulerCapacityWaiters.size === 0) return;
  const waiters = Array.from(schedulerCapacityWaiters);
  schedulerCapacityWaiters.clear();
  for (const wake of waiters) wake();
}

function waitForSchedulerCapacityChange() {
  return new Promise<void>((resolve) => {
    schedulerCapacityWaiters.add(resolve);
  });
}

function releaseSchedulerLease(entry: QueueEntry, leaseGeneration: number) {
  const key = schedulerLeaseKey(entry.jobId, leaseGeneration);
  if (releasedSchedulerLeases.has(key)) return false;
  releasedSchedulerLeases.add(key);
  decrementScheduledResource(entry);
  notifySchedulerCapacityWaiters();
  return true;
}

function releaseStaleActiveLease(job: McpToolJob) {
  const active = activeJobs.get(job.jobId);
  if (!active || active.leaseGeneration !== job.leaseGeneration) return undefined;
  try {
    active.cancelFn?.();
  } catch {
    // Lease recovery must still release scheduler capacity if cooperative cancellation throws.
  }
  releaseSchedulerLease(active.entry, active.leaseGeneration);
  activeJobs.delete(job.jobId);
  return active;
}

function runDurableJobRecoveryPass(state?: AppState, nowMs = Date.now()) {
  const summary = { resumable: 0, retryable: 0, interrupted: 0 };
  let queuedRecoveredWork = false;

  for (const job of listRecoverableJobs(nowMs)) {
    if (followerToLeader.has(job.jobId)) continue;
    if (job.status === 'queued') {
      if (queue.some((entry) => entry.jobId === job.jobId) || activeJobs.has(job.jobId)) continue;
      const classified = setJobRecoveryClassification(job.jobId, 'resumable', nowMs);
      if (!classified) continue;
      summary.resumable += 1;
      if (state) queuedRecoveredWork = enqueueRecoveredJob(state, classified) || queuedRecoveredWork;
      continue;
    }

    const staleActive = releaseStaleActiveLease(job);
    if (getBuiltinToolJobRecoveryPolicy(job.toolName) === 'retryable') {
      const requeued = requeueJobForRecovery(job.jobId, nowMs);
      if (!requeued) continue;
      appendJobLog(job.jobId, 'stderr', '\n[Job Recovery] Previous worker lease expired; retrying retry-safe durable job.\n');
      summary.retryable += 1;
      if (state) queuedRecoveredWork = enqueueRecoveredJob(state, requeued) || queuedRecoveredWork;
      continue;
    }

    const interrupted = transitionJobStatus(job.jobId, ['running'], {
      status: 'failed',
      failureSummary: 'Worker lease expired before this job completed; automatic retry is unsafe.',
      recoveryClassification: 'interrupted',
    }, {
      workerId: job.leaseOwner,
      leaseGeneration: job.leaseGeneration,
      nowMs,
    });
    if (interrupted) {
      appendJobLog(job.jobId, 'stderr', '\n[Job Interrupted] Worker lease expired; this job is not safe to retry automatically.\n');
      releaseTerminalVerificationCandidate(interrupted);
      if (staleActive) finalizeSingleFlight(staleActive.entry);
      summary.interrupted += 1;
    }
  }

  if (queuedRecoveredWork) setImmediate(processQueue);
  return summary;
}

function startDurableJobRecoveryLoop(state?: AppState) {
  if (state) durableRecoveryState = state;
  if (durableRecoveryTimer) return;
  durableRecoveryTimer = setInterval(() => {
    if (durableRecoveryState) runDurableJobRecoveryPass(durableRecoveryState, Date.now());
  }, JOB_RECOVERY_SWEEP_MS);
  durableRecoveryTimer.unref?.();
}

export function initMcpToolJobs(state?: AppState) {
  if (state) durableRecoveryState = state;
  const summary = runDurableJobRecoveryPass(state, Date.now());
  if (summary.interrupted > 0) console.log(`[mcp-tool-job] Marked ${summary.interrupted} stale unsafe jobs as interrupted.`);
  startBackgroundJobCleanup();
  startDurableJobRecoveryLoop(state);
  return summary;
}

export function __runDurableJobRecoveryPassForTests(state?: AppState, nowMs = Date.now()) {
  return runDurableJobRecoveryPass(state, nowMs);
}

export function getToolJobStatus(jobId: string) {
  const job = getJob(jobId);
  if (!job) return null;
  const position = queue.findIndex(q => q.jobId === jobId);
  const leaderJobId = followerToLeader.get(jobId);
  const entry = position >= 0
    ? queue[position]
    : activeJobs.get(jobId)?.entry || (leaderJobId ? activeJobs.get(leaderJobId)?.entry : undefined);
  const blocker = position >= 0 && entry ? getBlockerForQueueEntry(entry, position, queue, activeSchedulerEntries()) : null;
  const errorCode = job.status === 'failed' || job.status === 'timed_out' ? getTerminalJobErrorCode(jobId) : undefined;
  const recovery = recoveryPolicyForJobStatus(job.status, errorCode);
  const phaseState = entry?.phaseTelemetry || jobPhaseTelemetryById.get(jobId);
  const verification = entry?.verification || (hasExplicitVerificationPolicy(job.args)
    ? verificationPolicyFor(job.args, 'verify', job.resourceKey)
    : undefined);
  const supersession = jobSupersessionById.get(jobId);
  return {
    ...job,
    queuePosition: position >= 0 ? position + 1 : 0,
    ...(phaseState ? { phaseTimings: getJobPhaseTimings(phaseState, entry) } : {}),
    ...(entry ? {
      accessMode: entry.accessMode,
      costClass: entry.costClass,
      queueAgeMs: position >= 0 ? Math.max(0, Date.now() - entry.enqueuedAt) : 0,
    } : {}),
    ...(verification ? {
      verificationCandidateKey: verification.candidateKey,
      verificationSeriesKey: verification.seriesKey,
      verificationRequired: verification.required,
    } : {}),
    ...(supersession ? {
      superseded: true,
      authoritative: false,
      supersededByCandidateKey: supersession.supersededByCandidateKey,
      cooperativeCancellationRequested: supersession.cooperativeCancellationRequested,
    } : {}),
    ...(blocker || {}),
    lastLog: getLastLog(jobId),
    ...(recovery ? { recovery } : {}),
    nextAction: getNextAction(job.status, recovery)
  };
}

export function cancelToolJob(jobId: string) {
  const leaderJobId = followerToLeader.get(jobId);
  const reason = leaderJobId ? 'Cancelled single-flight follower.' : activeJobs.has(jobId) ? 'Cancellation requested.' : 'Cancelled before start.';
  const persisted = requestJobCancellation(jobId, reason);
  if (!persisted) return false;

  if (leaderJobId) {
    followerToLeader.delete(jobId);
    singleFlightFollowers.get(leaderJobId)?.delete(jobId);
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancelled single-flight follower without cancelling shared execution.\n');
    notifyJobWaiters(jobId);
    return true;
  }

  const qIdx = queue.findIndex(q => q.jobId === jobId);
  if (qIdx >= 0) {
    const [cancelledEntry] = queue.splice(qIdx, 1);
    finalizeQueueWaitTelemetry(cancelledEntry);
    void releaseVerificationCandidateForArgsAsync(cancelledEntry.args).catch(() => {});
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancelled before start.\n');
    finalizeSingleFlight(cancelledEntry);
    notifyJobWaiters(jobId);
    return true;
  }

  const active = activeJobs.get(jobId);
  if (active) {
    active.cancelFn?.();
    notifySchedulerCapacityWaiters();
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancellation requested.\n');
    notifyJobWaiters(jobId);
    return true;
  }

  notifyJobWaiters(jobId);
  return true;
}

function releaseTerminalVerificationCandidate(job: Pick<McpToolJob, 'args'> | null | undefined) {
  const candidateId = verificationCandidateIdForArgs(job?.args);
  if (!candidateId) return false;
  void releaseVerificationCandidateAsync(candidateId).catch(() => {});
  return true;
}

function resolveAdmissionResourceKey(state: AppState, args: any, kind: JobKind) {
  if (kind === 'skill-read') return 'skill-cache';
  const workspaceId = typeof args?.workspaceId === 'string' ? args.workspaceId.trim() : '';
  if (workspaceId) {
    // Execution validates the workspace again. Admission only needs its stable opaque scheduler identity.
    return `workspace:${workspaceId}`;
  }
  try {
    return resolveProjectResourceIdentity(state, args);
  } catch {
    return 'repo:unknown';
  }
}

export function enqueueToolJob(state: AppState, toolName: string, args: any, kind: JobKind) {
  const admissionStartedAt = Date.now();
  const restartState = readDevFlowRestartState();
  if (isDevFlowRestartPending(restartState)) {
    throw createApiError(409, 'RESTART_IN_PROGRESS', 'New MCP tool jobs are blocked while DevFlow restart is pending.', {
      retryable: true,
      details: {
        ticket: restartState?.ticket,
        status: restartState?.status,
        nextAction: 'Reconnect after restart and retry the original tool call.',
      },
    });
  }

  let jobArgs = args;
  let admissionPreflight: ReturnType<typeof getProjectCommandAdmissionPreflight> | null = null;
  if (toolName === 'run_project_command' && kind === 'repo-command' && !testRunners.has(toolName) && !verificationCandidateIdForArgs(args)) {
    const cleanArgs = { ...args };
    delete cleanArgs.__projectCommandAdmissionIdentity;
    admissionPreflight = getProjectCommandAdmissionPreflight(state, cleanArgs);
    jobArgs = admissionPreflight.executionIdentity
      ? { ...cleanArgs, __projectCommandAdmissionIdentity: admissionPreflight.executionIdentity }
      : cleanArgs;
  }

  const resourceKey = resolveAdmissionResourceKey(state, jobArgs, kind);
  const schedulerProfile = getSchedulerProfile(state, toolName, jobArgs, kind, resourceKey);

  if (admissionPreflight?.cachedResult) {
    const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const verification = verificationPolicyFor(jobArgs, schedulerProfile.accessMode, resourceKey);
    if (verification) supersedeObsoleteVerification(verification);
    createJob(jobId, toolName, jobArgs, resourceKey);
    writeJobResult(jobId, admissionPreflight.cachedResult);
    transitionJobStatus(jobId, ['queued'], { status: 'succeeded' });
    const completedAt = Date.now();
    const phaseTelemetry: JobPhaseTelemetryState = {
      jobId,
      resourceScope: resourceScopeFor(resourceKey),
      admissionWaitMs: Math.max(0, completedAt - admissionStartedAt),
      enqueuedAt: completedAt,
      queueCompletedAt: completedAt,
      executionStartedAt: completedAt,
      executionCompletedAt: completedAt,
      responseHandoffMs: 0,
      workspaceLockWaitMs: 0,
      capacityWaitMs: 0,
      blockerReasons: {},
      finalized: true,
    };
    rememberJobPhaseTelemetry(phaseTelemetry);
    return {
      jobId,
      status: 'succeeded' as const,
      queuePosition: 0,
      sharedWith: undefined as string | undefined,
      handoffImmediately: false,
      cacheHit: true,
      accessMode: schedulerProfile.accessMode,
      costClass: schedulerProfile.costClass,
      nextAction: `Call get_tool_job_result for ${jobId} to read the cached result.`,
    };
  }

  const initialSingleFlightKey = singleFlightKeyFor(state, toolName, jobArgs, kind, resourceKey);
  if (initialSingleFlightKey) {
    const leaderJobId = singleFlightLeaders.get(initialSingleFlightKey);
    const leaderStatus = leaderJobId ? getJob(leaderJobId) : null;
    if (leaderJobId && leaderStatus && !isTerminalStatus(leaderStatus.status)) {
      const followerJobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
      createJob(followerJobId, toolName, jobArgs, resourceKey);
      updateJobStatus(followerJobId, { status: 'running' });
      appendJobLog(followerJobId, 'stdout', `[Single Flight] Following ${leaderJobId}.\n`);
      const followers = singleFlightFollowers.get(leaderJobId) || new Set<string>();
      followers.add(followerJobId);
      singleFlightFollowers.set(leaderJobId, followers);
      followerToLeader.set(followerJobId, leaderJobId);
      singleFlightHits += 1;
      return {
        jobId: followerJobId,
        status: 'running' as const,
        queuePosition: 0,
        sharedWith: leaderJobId,
        accessMode: schedulerProfile.accessMode,
        costClass: schedulerProfile.costClass,
        nextAction: 'Wait for the shared leader result; cancelling this follower does not cancel the leader.',
      };
    }
  }

  const singleFlightKey = singleFlightKeyFor(state, toolName, jobArgs, kind, resourceKey);

  const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let job;
  let verification: VerificationQueuePolicy | undefined;
  try {
    verification = verificationPolicyFor(jobArgs, schedulerProfile.accessMode, resourceKey);
    if (verification) {
      supersedeObsoleteVerification(verification);
      enforceVerificationBackpressure(verification, resourceKey);
    }
    job = createJob(jobId, toolName, jobArgs, resourceKey);
  } catch (error) {
    throw error;
  }
  const enqueuedAt = Date.now();
  const phaseTelemetry: JobPhaseTelemetryState = {
    jobId,
    resourceScope: resourceScopeFor(resourceKey),
    admissionWaitMs: Math.max(0, enqueuedAt - admissionStartedAt),
    enqueuedAt,
    responseHandoffMs: 0,
    workspaceLockWaitMs: 0,
    capacityWaitMs: 0,
    blockerReasons: {},
  };
  rememberJobPhaseTelemetry(phaseTelemetry);

  const entry: QueueEntry = {
    jobId,
    resourceKey,
    kind,
    state,
    toolName,
    args: jobArgs,
    accessMode: schedulerProfile.accessMode,
    costClass: schedulerProfile.costClass,
    verificationClass: schedulerProfile.verificationClass,
    sharedResources: schedulerProfile.sharedResources,
    enqueuedAt,
    schedulerPriority: getSchedulerPriority(toolName, jobArgs, schedulerProfile.accessMode, schedulerProfile.verificationClass),
    singleFlightKey: singleFlightKey || undefined,
    verification,
    waitTelemetry: { lastObservedAt: enqueuedAt, workspaceLockWaitMs: 0, capacityWaitMs: 0, blockerReasons: {} },
    phaseTelemetry,
  };
  if (singleFlightKey) singleFlightLeaders.set(singleFlightKey, jobId);

  queue.push(entry);
  const queuePosition = queue.length;
  const admissionBlocker = getBlockerForQueueEntry(entry, queuePosition - 1, queue, activeSchedulerEntries());
  const handoffImmediately = Boolean(admissionBlocker);
  if (admissionBlocker) advanceQueueWaitTelemetry(entry, admissionBlocker, Date.now());

  // Keep execution decoupled from admission so returning a durable handle never runs a long job inline.
  setImmediate(processQueue);

  return {
    jobId,
    status: job.status,
    queuePosition,
    sharedWith: undefined as string | undefined,
    handoffImmediately,
    ...(admissionBlocker || {}),
    nextAction: handoffImmediately
      ? `Call get_tool_job_result for ${jobId} with waitMs=30000; call cancel_tool_job to stop the job.`
      : 'Wait for job completion or inspect get_tool_job_status/get_tool_job_log; call cancel_tool_job to stop the job.'
  };
}

async function processQueue() {
  while (queue.length > 0) {
    const activeEntries = activeSchedulerEntries();
    const observedAt = Date.now();
    queue.forEach((entry, index) => advanceQueueWaitTelemetry(entry, getBlockerForQueueEntry(entry, index, queue, activeEntries), observedAt));
    const index = selectNextRunnableQueueIndex(queue, activeEntries);
    if (index < 0) break;
    const [entry] = queue.splice(index, 1);
    finalizeQueueWaitTelemetry(entry, observedAt);
    startJob(entry);
  }
}

function setJobActiveContext(jobId: string, cancelFn: () => void, leaseGeneration: number) {
  const active = activeJobs.get(jobId);
  if (active?.leaseGeneration === leaseGeneration) active.cancelFn = cancelFn;
}

function transitionAbortError(jobId: string) {
  const error = new Error(`Verification transition for ${jobId} was cancelled or lost its worker lease.`);
  error.name = 'AbortError';
  return error;
}

function assertActiveTransitionLease(jobId: string, leaseGeneration: number) {
  const active = activeJobs.get(jobId);
  const status = getJob(jobId)?.status;
  if (!active || active.leaseGeneration !== leaseGeneration || status === 'cancelled' || status === 'timed_out') {
    throw transitionAbortError(jobId);
  }
  return active.entry;
}

function scopedPermitRequest(entry: QueueEntry, request: VerificationPermitDemand): VerificationProcessPermitRequest {
  return {
    jobId: entry.jobId,
    verificationClass: request.verificationClass,
    sharedResources: scopeVerificationResources(entry.args, entry.resourceKey, request.sharedResources || []),
  };
}

async function acquireVerificationPermitForActiveJob(
  jobId: string,
  leaseGeneration: number,
  request: VerificationPermitDemand,
) {
  let loggedWait = false;
  while (true) {
    const entry = assertActiveTransitionLease(jobId, leaseGeneration);
    const reservation = tryAcquireVerificationProcessPermit(scopedPermitRequest(entry, request));
    if (reservation.permit) return reservation.permit;

    if (!loggedWait) {
      appendJobLog(jobId, 'stdout', `[Scheduler] Waiting for verification capacity (${reservation.blocker?.blockReason || 'capacity'}).\n`, { workerId: JOB_WORKER_ID, leaseGeneration });
      loggedWait = true;
    }
    const waitStartedAt = Date.now();
    await waitForSchedulerCapacityChange();
    const waitedMs = Math.max(0, Date.now() - waitStartedAt);
    entry.waitTelemetry.capacityWaitMs += waitedMs;
    if (reservation.blocker?.blockReason) {
      entry.waitTelemetry.blockerReasons[reservation.blocker.blockReason] = (entry.waitTelemetry.blockerReasons[reservation.blocker.blockReason] || 0) + 1;
    }
  }
}

function createVerificationExecutionLease(
  entry: QueueEntry,
  leaseGeneration: number,
  initialPermit: VerificationProcessPermit,
): VerificationExecutionLease {
  let reservedPermit: VerificationProcessPermit | undefined = initialPermit;
  let disposed = false;

  const releasePermit = (permit: VerificationProcessPermit) => {
    if (entry.verificationPermitId === permit.id) entry.verificationPermitId = undefined;
    if (releaseVerificationProcessPermit(permit)) notifySchedulerCapacityWaiters();
  };

  return {
    runWithPermit: async <T>(request: VerificationPermitDemand, run: () => Promise<T>) => {
      if (disposed) throw transitionAbortError(entry.jobId);
      assertActiveTransitionLease(entry.jobId, leaseGeneration);
      const permit = reservedPermit || await acquireVerificationPermitForActiveJob(entry.jobId, leaseGeneration, request);
      reservedPermit = undefined;
      try {
        assertActiveTransitionLease(entry.jobId, leaseGeneration);
        return await run();
      } finally {
        releasePermit(permit);
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (reservedPermit) {
        releasePermit(reservedPermit);
        reservedPermit = undefined;
      }
    },
  };
}

async function transitionJobAccess(
  jobId: string,
  nextAccessMode: ResourceAccessMode,
  leaseGeneration: number,
  request: VerificationPermitDemand = {},
): Promise<void | VerificationExecutionLease> {
  const entry = assertActiveTransitionLease(jobId, leaseGeneration);
  if (entry.accessMode === nextAccessMode) return;

  const permit = await acquireVerificationPermitForActiveJob(jobId, leaseGeneration, request);
  try {
    const changed = transitionScheduledResource(entry, nextAccessMode, permit);
    if (!changed) {
      releaseVerificationProcessPermit(permit);
      notifySchedulerCapacityWaiters();
      return;
    }
  } catch (error) {
    releaseVerificationProcessPermit(permit);
    notifySchedulerCapacityWaiters();
    throw error;
  }
  appendJobLog(jobId, 'stdout', '[Scheduler] Access downgraded write -> verify with reserved process capacity.\n', { workerId: JOB_WORKER_ID, leaseGeneration });
  setImmediate(processQueue);
  return createVerificationExecutionLease(entry, leaseGeneration, permit);
}

async function prepareVerificationCandidateForActiveJob(entry: QueueEntry, leaseGeneration: number, leaseGuard: JobLeaseGuard) {
  if (entry.toolName !== 'run_project_command' || entry.kind !== 'repo-command' || testRunners.has(entry.toolName) || verificationCandidateIdForArgs(entry.args)) return;
  const expectedExecutionKey = projectCommandAdmissionIdentityForArgs(entry.args)?.key;
  const controller = new AbortController();
  setJobActiveContext(entry.jobId, () => controller.abort(), leaseGeneration);
  entry.phaseTelemetry.candidatePreparationStartedAt = Date.now();
  rememberJobPhaseTelemetry(entry.phaseTelemetry);
  try {
    const candidate = await prepareProjectCommandVerificationCandidateAsync(entry.state, entry.args, {
      expectedExecutionKey,
      signal: controller.signal,
    });
    if (!candidate) return;
    const nextArgs = { ...entry.args, __verificationCandidate: candidate };
    const persisted = transitionJobStatus(entry.jobId, ['running'], { args: nextArgs }, leaseGuard);
    if (!persisted) {
      await releaseVerificationCandidateAsync(candidate.candidateId).catch(() => {});
      throw transitionAbortError(entry.jobId);
    }
    entry.args = nextArgs;
  } finally {
    entry.phaseTelemetry.candidatePreparationCompletedAt = Date.now();
    rememberJobPhaseTelemetry(entry.phaseTelemetry);
  }
}

async function startJob(entry: QueueEntry) {
  const claimed = claimJob(entry.jobId, JOB_WORKER_ID, JOB_LEASE_MS);
  if (!claimed) {
    const persisted = getJob(entry.jobId);
    if (persisted && isTerminalStatus(persisted.status)) void releaseVerificationCandidateForArgsAsync(entry.args).catch(() => {});
    finalizeSingleFlight(entry);
    setImmediate(processQueue);
    return;
  }

  const leaseGeneration = claimed.leaseGeneration || 0;
  const leaseGuard: JobLeaseGuard = { workerId: JOB_WORKER_ID, leaseGeneration };
  incrementScheduledResource(entry);
  activeJobs.set(entry.jobId, { entry, leaseGeneration });
  const heartbeat = setInterval(() => {
    const active = activeJobs.get(entry.jobId);
    if (!active || active.leaseGeneration !== leaseGeneration) return;
    const renewed = heartbeatJob(entry.jobId, JOB_WORKER_ID, JOB_LEASE_MS, Date.now(), leaseGeneration);
    if (!renewed) {
      active.cancelFn?.();
      notifySchedulerCapacityWaiters();
    }
  }, JOB_HEARTBEAT_MS);
  heartbeat.unref();

  const logger = {
    stdout: (data: string) => appendJobLog(entry.jobId, 'stdout', data, leaseGuard),
    stderr: (data: string) => appendJobLog(entry.jobId, 'stderr', data, leaseGuard),
  };

  try {
    await prepareVerificationCandidateForActiveJob(entry, leaseGeneration, leaseGuard);
    if (!entry.phaseTelemetry.executionStartedAt) entry.phaseTelemetry.executionStartedAt = Date.now();
    rememberJobPhaseTelemetry(entry.phaseTelemetry);
    let result: any;
    const testRunner = testRunners.get(entry.toolName);

    if (testRunner) {
      result = await testRunner(
        entry.state,
        entry.args,
        logger,
        (cancelFn) => setJobActiveContext(entry.jobId, cancelFn, leaseGeneration),
        (accessMode, request) => transitionJobAccess(entry.jobId, accessMode, leaseGeneration, request),
      );
    } else {
      result = await runBuiltinToolJob(
        { toolName: entry.toolName, state: entry.state, args: entry.args },
        {
          logger,
          setCancelFn: (cancelFn) => setJobActiveContext(entry.jobId, cancelFn, leaseGeneration),
          transitionAccess: (accessMode, request) => transitionJobAccess(entry.jobId, accessMode, leaseGeneration, request),
        },
      );
    }
    entry.phaseTelemetry.executionCompletedAt = Date.now();

    const currentStatus = getJob(entry.jobId)?.status;
    if (currentStatus === 'cancelled' || currentStatus === 'timed_out') {
      // Persisted cancellation/timeout wins over a late worker result.
    } else if (isTimedOutResult(result)) {
      const wrote = writeJobResult(entry.jobId, result, leaseGuard);
      const transitioned = wrote
        ? transitionJobStatus(entry.jobId, ['running'], { status: 'timed_out', failureSummary: 'Job timed out.' }, leaseGuard)
        : null;
      if (transitioned) appendJobLog(entry.jobId, 'stderr', '\n[Job Timed Out]\n');
    } else {
      const wrote = writeJobResult(entry.jobId, result, leaseGuard);
      if (wrote) transitionJobStatus(entry.jobId, ['running'], { status: 'succeeded' }, leaseGuard);
    }
  } catch (error: any) {
    if (!entry.phaseTelemetry.executionCompletedAt) entry.phaseTelemetry.executionCompletedAt = Date.now();
    const currentStatus = getJob(entry.jobId)?.status;
    const normalizedError = normalizeUnknownError(error).error;
    const failureSummary = summarizeError(error);
    if (currentStatus === 'cancelled') {
      const supersession = jobSupersessionById.get(entry.jobId);
      const cancelledResult = supersession
        ? Object.assign(supersededJobResult(entry, supersession.supersededByCandidateKey), { error: normalizedError })
        : {
            ok: false,
            status: 'cancelled',
            code: 'JOB_CANCELLED',
            message: 'Job was cancelled before completion.',
            error: normalizedError,
          };
      const active = activeJobs.get(entry.jobId);
      if (active?.leaseGeneration === leaseGeneration) writeJobResult(entry.jobId, cancelledResult);
      else writeJobResult(entry.jobId, cancelledResult, leaseGuard);
    } else if (error.name === 'AbortError' || error.message.includes('ETIMEDOUT') || error.code === 'ETIMEDOUT') {
      const wrote = writeJobResult(entry.jobId, {
        ok: false,
        status: 'timed_out',
        code: normalizedError.code || 'JOB_TIMED_OUT',
        message: normalizedError.message || failureSummary,
        error: normalizedError,
      }, leaseGuard);
      const transitioned = wrote
        ? transitionJobStatus(entry.jobId, ['running'], { status: 'timed_out', failureSummary }, leaseGuard)
        : null;
      if (transitioned) appendJobLog(entry.jobId, 'stderr', '\n[Job Timed Out]\n');
    } else {
      const wrote = writeJobResult(entry.jobId, {
        ok: false,
        status: 'failed',
        code: normalizedError.code || 'JOB_FAILED',
        message: normalizedError.message || failureSummary,
        error: normalizedError,
      }, leaseGuard);
      const transitioned = wrote
        ? transitionJobStatus(entry.jobId, ['running'], { status: 'failed', failureSummary }, leaseGuard)
        : null;
      if (transitioned) appendJobLog(entry.jobId, 'stderr', `\n[Job Failed] ${error.message}\n${error.stack || ''}`);
    }
  } finally {
    clearInterval(heartbeat);
    const leaseKey = schedulerLeaseKey(entry.jobId, leaseGeneration);
    const leaseWasAlreadyReleased = releasedSchedulerLeases.has(leaseKey);
    if (!leaseWasAlreadyReleased) {
      if (!entry.phaseTelemetry.executionCompletedAt) entry.phaseTelemetry.executionCompletedAt = Date.now();
      const waitSnapshot = finalizedQueueWaitRecord(entry, entry.phaseTelemetry.queueCompletedAt ?? entry.phaseTelemetry.candidatePreparationStartedAt ?? entry.phaseTelemetry.executionStartedAt ?? Date.now());
      entry.phaseTelemetry.workspaceLockWaitMs = waitSnapshot.workspaceLockWaitMs;
      entry.phaseTelemetry.capacityWaitMs = waitSnapshot.capacityWaitMs;
      entry.phaseTelemetry.blockerReasons = { ...waitSnapshot.blockerReasons };
      entry.phaseTelemetry.responseHandoffMs = Math.max(0, Date.now() - entry.phaseTelemetry.executionCompletedAt);
      entry.phaseTelemetry.finalized = true;
      rememberJobPhaseTelemetry(entry.phaseTelemetry);
    }
    releaseSchedulerLease(entry, leaseGeneration);
    const active = activeJobs.get(entry.jobId);
    if (active?.leaseGeneration === leaseGeneration) {
      activeJobs.delete(entry.jobId);
      finalizeSingleFlight(entry);
    }
    releasedSchedulerLeases.delete(leaseKey);
    setImmediate(processQueue);
    await releaseVerificationCandidateForArgsAsync(entry.args).catch(() => {});
  }
}

export function getJobMetrics() {
  const queueMetrics = getQueueMetrics();
  return {
    queueDepth: queueMetrics.metrics.durable.queued,
    activeJobs: Array.from(activeJobs.entries()).map(([jobId, data]) => ({
      jobId,
      toolName: data.entry.toolName,
      resourceKey: data.entry.resourceKey,
      kind: data.entry.kind,
      accessMode: data.entry.accessMode,
      costClass: data.entry.costClass,
    })),
    activeResources: getActiveResourceSnapshot(),
    queuedJobs: queue.map((entry, index) => buildQueueEntryDiagnostics(entry, index, queue, activeSchedulerEntries())),
    metrics: queueMetrics.metrics,
    capacity: queueMetrics.capacity,
    recentJobs: queueMetrics.recentJobs
  };
}

export function __resetQueueWaitTelemetryForTests() {
  recentQueueWaitTelemetry.length = 0;
  jobPhaseTelemetryById.clear();
  jobSupersessionById.clear();
  supersededQueuedJobs = 0;
  cooperativeSupersedeCancellations = 0;
  verificationBackpressureRejections = 0;
}

export function __setToolJobTestRunner(toolName: string, runner: AsyncRunner | null) {
  if (runner) {
    testRunners.set(toolName, runner);
  } else {
    testRunners.delete(toolName);
  }
}
