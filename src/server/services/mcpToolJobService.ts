import { createHash, randomUUID } from 'crypto';
import type { AppState } from '../types';
import { createJob, updateJobStatus, appendJobLog, writeJobResult, getJob, readJobLog, readJobResult, listRecentJobs, startBackgroundJobCleanup, claimJob, heartbeatJob, requestJobCancellation, transitionJobStatus, listRecoverableJobs, setJobRecoveryClassification, requeueJobForRecovery, getDurableJobMetrics, type McpToolJob } from '../repositories/mcpToolJobRepository';
import { createApiError, normalizeUnknownError } from './api';
import { resolveProjectResourceIdentity, resolveProjectRoot } from './localFileService';
import { isDevFlowRestartPending, readDevFlowRestartState } from '../../lib/devFlowRestart';
import { getRepoRevisionForRoot } from './repoRevisionService';
import { getProjectCommandExecutionIdentity } from './projectCommandService';
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
  type JobKind,
  type JobCostClass,
  type ResourceAccessMode,
  type SchedulerQueueEntry,
} from './mcpToolJobScheduler';
import { getBuiltinToolJobRecoveryPolicy, runBuiltinToolJob } from './mcpToolJobRunnerRegistry';
import { recoveryPolicyForJobStatus, type ToolRecoveryPolicy } from './toolRecoveryPolicy.js';

type Logger = { stdout: (data: string) => void; stderr: (data: string) => void };
type AsyncRunner = (
  state: AppState,
  args: any,
  logger: Logger,
  setCancelFn: (fn: () => void) => void,
  transitionAccess: (accessMode: ResourceAccessMode) => void,
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
  executionMs: number;
  responseHandoffMs: number;
};

interface QueueEntry extends SchedulerQueueEntry {
  state: AppState;
  singleFlightKey?: string;
  waitTelemetry: QueueWaitTelemetry;
  phaseTelemetry: JobPhaseTelemetryState;
}

const queue: QueueEntry[] = [];
const activeJobs = new Map<string, { entry: QueueEntry; cancelFn?: () => void }>();
const testRunners = new Map<string, AsyncRunner>();
const jobWaiters = new Map<string, Set<(status: ReturnType<typeof getToolJobStatus>) => void>>();
const singleFlightLeaders = new Map<string, string>();
const singleFlightFollowers = new Map<string, Set<string>>();
const followerToLeader = new Map<string, string>();
let singleFlightHits = 0;
const MAX_RECENT_QUEUE_WAITS = 200;
const recentQueueWaitTelemetry: FinalizedQueueWaitTelemetry[] = [];
const MAX_JOB_PHASE_TELEMETRY = 500;
const jobPhaseTelemetryById = new Map<string, JobPhaseTelemetryState>();
const JOB_LEASE_MS = 30_000;
const JOB_HEARTBEAT_MS = 10_000;
const JOB_WORKER_ID = `devflow-${process.pid}-${randomUUID().slice(0, 8)}`;

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
  const queueEnd = state.executionStartedAt ?? state.queueCompletedAt ?? now;
  const queueWaitMs = Math.max(0, queueEnd - state.enqueuedAt);
  const rawWorkspaceWaitMs = wait?.workspaceLockWaitMs ?? state.workspaceLockWaitMs;
  const workspaceLockWaitMs = Math.min(queueWaitMs, Math.max(0, rawWorkspaceWaitMs));
  const rawCapacityWaitMs = wait?.capacityWaitMs ?? state.capacityWaitMs;
  const capacityWaitMs = Math.min(Math.max(0, queueWaitMs - workspaceLockWaitMs), Math.max(0, rawCapacityWaitMs));
  const executionMs = state.executionStartedAt
    ? Math.max(0, (state.executionCompletedAt ?? now) - state.executionStartedAt)
    : 0;
  return {
    admissionWaitMs: Math.max(0, state.admissionWaitMs),
    queueWaitMs,
    workspaceLockWaitMs,
    capacityWaitMs,
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

function singleFlightKeyFor(state: AppState, toolName: string, args: any, kind: JobKind, resourceKey: string) {
  const enabled = kind === 'repo-read'
    ? args?.singleFlight !== false
    : kind === 'repo-command' && toolName === 'run_project_command' && args?.singleFlight !== false;
  if (!enabled || (!resourceKey.startsWith('repo:') && !resourceKey.startsWith('workspace:')) || resourceKey === 'repo:unknown') return null;

  if (kind === 'repo-command' && toolName === 'run_project_command') {
    try {
      const executionIdentity = getProjectCommandExecutionIdentity(state, args);
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

  return new Promise<ReturnType<typeof getToolJobStatus>>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (status: ReturnType<typeof getToolJobStatus>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const waiters = jobWaiters.get(jobId);
      waiters?.delete(finish);
      if (waiters?.size === 0) jobWaiters.delete(jobId);
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
  const schedulerProfile = getSchedulerProfile(state, job.toolName, job.args, kind);
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
    enqueuedAt,
    schedulerPriority: getSchedulerPriority(job.toolName, job.args, schedulerProfile.accessMode),
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

export function initMcpToolJobs(state?: AppState) {
  const summary = { resumable: 0, retryable: 0, interrupted: 0 };
  let queuedRecoveredWork = false;

  for (const job of listRecoverableJobs()) {
    if (job.status === 'queued') {
      const classified = setJobRecoveryClassification(job.jobId, 'resumable');
      if (!classified) continue;
      summary.resumable += 1;
      if (state) queuedRecoveredWork = enqueueRecoveredJob(state, classified) || queuedRecoveredWork;
      continue;
    }

    if (getBuiltinToolJobRecoveryPolicy(job.toolName) === 'retryable') {
      const requeued = requeueJobForRecovery(job.jobId);
      if (!requeued) continue;
      appendJobLog(job.jobId, 'stderr', '\n[Job Recovery] Previous worker lease expired; retrying safe job after restart.\n');
      summary.retryable += 1;
      if (state) queuedRecoveredWork = enqueueRecoveredJob(state, requeued) || queuedRecoveredWork;
      continue;
    }

    const interrupted = transitionJobStatus(job.jobId, ['running'], {
      status: 'failed',
      failureSummary: 'Server restarted before this job completed; automatic retry is unsafe.',
      recoveryClassification: 'interrupted',
    });
    if (interrupted) {
      appendJobLog(job.jobId, 'stderr', '\n[Job Interrupted] Server restarted; this job is not safe to retry automatically.\n');
      summary.interrupted += 1;
    }
  }

  if (queuedRecoveredWork) setImmediate(processQueue);
  if (summary.interrupted > 0) console.log(`[mcp-tool-job] Marked ${summary.interrupted} stale unsafe jobs as interrupted on startup.`);
  startBackgroundJobCleanup();
  return summary;
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
  return {
    ...job,
    queuePosition: position >= 0 ? position + 1 : 0,
    ...(phaseState ? { phaseTimings: getJobPhaseTimings(phaseState, entry) } : {}),
    ...(entry ? {
      accessMode: entry.accessMode,
      costClass: entry.costClass,
      queueAgeMs: position >= 0 ? Math.max(0, Date.now() - entry.enqueuedAt) : 0,
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
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancelled before start.\n');
    finalizeSingleFlight(cancelledEntry);
    notifyJobWaiters(jobId);
    return true;
  }

  const active = activeJobs.get(jobId);
  if (active) {
    active.cancelFn?.();
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancellation requested.\n');
    notifyJobWaiters(jobId);
    return true;
  }

  notifyJobWaiters(jobId);
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

  const resourceKey = resolveAdmissionResourceKey(state, args, kind);
  const schedulerProfile = getSchedulerProfile(state, toolName, args, kind);
  const singleFlightKey = singleFlightKeyFor(state, toolName, args, kind, resourceKey);
  if (singleFlightKey) {
    const leaderJobId = singleFlightLeaders.get(singleFlightKey);
    const leaderStatus = leaderJobId ? getJob(leaderJobId) : null;
    if (leaderJobId && leaderStatus && !isTerminalStatus(leaderStatus.status)) {
      const followerJobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
      createJob(followerJobId, toolName, args, resourceKey);
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

  const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const job = createJob(jobId, toolName, args, resourceKey);
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
    args,
    accessMode: schedulerProfile.accessMode,
    costClass: schedulerProfile.costClass,
    enqueuedAt,
    schedulerPriority: getSchedulerPriority(toolName, args, schedulerProfile.accessMode),
    singleFlightKey: singleFlightKey || undefined,
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

function setJobActiveContext(jobId: string, cancelFn: () => void) {
  const active = activeJobs.get(jobId);
  if (active) {
    active.cancelFn = cancelFn;
  }
}

function transitionJobAccess(jobId: string, nextAccessMode: ResourceAccessMode) {
  const active = activeJobs.get(jobId);
  if (!active) throw new Error(`Cannot transition scheduler access for inactive job ${jobId}.`);

  const entry = active.entry;
  const changed = transitionScheduledResource(entry, nextAccessMode);
  if (!changed) return;
  appendJobLog(jobId, 'stdout', '[Scheduler] Access downgraded write -> verify.\n');
  setImmediate(processQueue);
}

async function startJob(entry: QueueEntry) {
  const claimed = claimJob(entry.jobId, JOB_WORKER_ID, JOB_LEASE_MS);
  if (!claimed) {
    finalizeSingleFlight(entry);
    setImmediate(processQueue);
    return;
  }

  incrementScheduledResource(entry);
  if (!entry.phaseTelemetry.executionStartedAt) entry.phaseTelemetry.executionStartedAt = Date.now();
  activeJobs.set(entry.jobId, { entry });
  const heartbeat = setInterval(() => {
    const renewed = heartbeatJob(entry.jobId, JOB_WORKER_ID, JOB_LEASE_MS);
    if (!renewed) activeJobs.get(entry.jobId)?.cancelFn?.();
  }, JOB_HEARTBEAT_MS);
  heartbeat.unref();

  const logger = {
    stdout: (data: string) => appendJobLog(entry.jobId, 'stdout', data),
    stderr: (data: string) => appendJobLog(entry.jobId, 'stderr', data),
  };

  try {
    let result: any;
    const testRunner = testRunners.get(entry.toolName);

    if (testRunner) {
      result = await testRunner(
        entry.state,
        entry.args,
        logger,
        (cancelFn) => setJobActiveContext(entry.jobId, cancelFn),
        (accessMode) => transitionJobAccess(entry.jobId, accessMode),
      );
    } else {
      result = await runBuiltinToolJob(
        { toolName: entry.toolName, state: entry.state, args: entry.args },
        {
          logger,
          setCancelFn: (cancelFn) => setJobActiveContext(entry.jobId, cancelFn),
          transitionAccess: (accessMode) => transitionJobAccess(entry.jobId, accessMode),
        },
      );
    }
    entry.phaseTelemetry.executionCompletedAt = Date.now();

    const currentStatus = getJob(entry.jobId)?.status;
    if (currentStatus === 'cancelled' || currentStatus === 'timed_out') {
      // Persisted cancellation/timeout wins over a late worker result.
    } else if (isTimedOutResult(result)) {
      writeJobResult(entry.jobId, result);
      transitionJobStatus(entry.jobId, ['running'], { status: 'timed_out', failureSummary: 'Job timed out.' }, { workerId: JOB_WORKER_ID });
      logger.stderr(`\n[Job Timed Out]\n`);
    } else {
      writeJobResult(entry.jobId, result);
      transitionJobStatus(entry.jobId, ['running'], { status: 'succeeded' }, { workerId: JOB_WORKER_ID });
    }
  } catch (error: any) {
    if (!entry.phaseTelemetry.executionCompletedAt) entry.phaseTelemetry.executionCompletedAt = Date.now();
    const currentStatus = getJob(entry.jobId)?.status;
    const normalizedError = normalizeUnknownError(error).error;
    const failureSummary = summarizeError(error);
    if (currentStatus === 'cancelled') {
      writeJobResult(entry.jobId, {
        ok: false,
        status: 'cancelled',
        code: 'JOB_CANCELLED',
        message: 'Job was cancelled before completion.',
        error: normalizedError,
      });
    } else if (error.name === 'AbortError' || error.message.includes('ETIMEDOUT') || error.code === 'ETIMEDOUT') {
      writeJobResult(entry.jobId, {
        ok: false,
        status: 'timed_out',
        code: normalizedError.code || 'JOB_TIMED_OUT',
        message: normalizedError.message || failureSummary,
        error: normalizedError,
      });
      transitionJobStatus(entry.jobId, ['running'], { status: 'timed_out', failureSummary }, { workerId: JOB_WORKER_ID });
      logger.stderr(`\n[Job Timed Out]`);
    } else {
      writeJobResult(entry.jobId, {
        ok: false,
        status: 'failed',
        code: normalizedError.code || 'JOB_FAILED',
        message: normalizedError.message || failureSummary,
        error: normalizedError,
      });
      transitionJobStatus(entry.jobId, ['running'], { status: 'failed', failureSummary }, { workerId: JOB_WORKER_ID });
      logger.stderr(`\n[Job Failed] ${error.message}\n${error.stack || ''}`);
    }
  } finally {
    clearInterval(heartbeat);
    if (!entry.phaseTelemetry.executionCompletedAt) entry.phaseTelemetry.executionCompletedAt = Date.now();
    const waitSnapshot = finalizedQueueWaitRecord(entry, entry.phaseTelemetry.executionStartedAt ?? Date.now());
    entry.phaseTelemetry.workspaceLockWaitMs = waitSnapshot.workspaceLockWaitMs;
    entry.phaseTelemetry.capacityWaitMs = waitSnapshot.capacityWaitMs;
    entry.phaseTelemetry.blockerReasons = { ...waitSnapshot.blockerReasons };
    entry.phaseTelemetry.responseHandoffMs = Math.max(0, Date.now() - entry.phaseTelemetry.executionCompletedAt);
    entry.phaseTelemetry.finalized = true;
    rememberJobPhaseTelemetry(entry.phaseTelemetry);
    decrementScheduledResource(entry);
    activeJobs.delete(entry.jobId);
    finalizeSingleFlight(entry);
    setImmediate(processQueue);
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
}

export function __setToolJobTestRunner(toolName: string, runner: AsyncRunner | null) {
  if (runner) {
    testRunners.set(toolName, runner);
  } else {
    testRunners.delete(toolName);
  }
}
