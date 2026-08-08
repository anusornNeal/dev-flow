import { createHash, randomUUID } from 'crypto';
import type { AppState } from '../types';
import { createJob, updateJobStatus, appendJobLog, writeJobResult, getJob, readJobLog, readJobResult, listInterruptedJobs, listRecentJobs, startBackgroundJobCleanup } from '../repositories/mcpToolJobRepository';
import { createApiError, normalizeUnknownError } from './api';
import { resolveProjectRoot } from './localFileService';
import { isDevFlowRestartPending, readDevFlowRestartState } from '../../lib/devFlowRestart';
import { getRepoRevisionForRoot } from './repoRevisionService';
import { getProjectCommandExecutionIdentity } from './projectCommandService';
import {
  buildQueueEntryDiagnostics,
  decrementScheduledResource,
  getActiveResourceSnapshot,
  getBlockerForQueueEntry,
  getSchedulerProfile,
  incrementScheduledResource,
  transitionScheduledResource,
  type JobKind,
  type JobCostClass,
  type ResourceAccessMode,
  type SchedulerQueueEntry,
} from './mcpToolJobScheduler';
import { runBuiltinToolJob } from './mcpToolJobRunnerRegistry';

type Logger = { stdout: (data: string) => void; stderr: (data: string) => void };
type AsyncRunner = (
  state: AppState,
  args: any,
  logger: Logger,
  setCancelFn: (fn: () => void) => void,
  transitionAccess: (accessMode: ResourceAccessMode) => void,
) => Promise<any>;

interface QueueEntry extends SchedulerQueueEntry {
  state: AppState;
  singleFlightKey?: string;
}

const queue: QueueEntry[] = [];
const activeJobs = new Map<string, { entry: QueueEntry; cancelFn?: () => void }>();
const testRunners = new Map<string, AsyncRunner>();
const jobWaiters = new Map<string, Set<(status: ReturnType<typeof getToolJobStatus>) => void>>();
const singleFlightLeaders = new Map<string, string>();
const singleFlightFollowers = new Map<string, Set<string>>();
const followerToLeader = new Map<string, string>();
let singleFlightHits = 0;

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
  if (!enabled || !resourceKey.startsWith('repo:') || resourceKey === 'repo:unknown') return null;

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

function getNextAction(status: string) {
  if (status === 'queued' || status === 'running') {
    return 'Poll get_tool_job_status or get_tool_job_log; call cancel_tool_job to stop the job.';
  }
  if (status === 'succeeded') {
    return 'Call get_tool_job_result to read the completed result.';
  }
  if (status === 'timed_out') {
    return 'Read get_tool_job_log/get_tool_job_result, then retry with a higher timeout or narrower scope.';
  }
  if (status === 'failed') {
    return 'Read get_tool_job_log/get_tool_job_result, fix the reported issue, then retry the tool call.';
  }
  if (status === 'cancelled') {
    return 'The job was cancelled; retry the original tool call if the work is still needed.';
  }
  return 'Inspect job status, logs, and result.';
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
    metrics: {
      completedJobs: terminalJobs.length,
      failedJobs: failedJobs.length,
      averageWaitMs: average(waitSamples),
      averageRunMs: average(runSamples),
      singleFlightHits,
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

export function initMcpToolJobs() {
  const interrupted = listInterruptedJobs();
  if (interrupted.length > 0) {
    console.log(`[mcp-tool-job] Marked ${interrupted.length} stale jobs as failed on startup.`);
  }
  startBackgroundJobCleanup();
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
  return {
    ...job,
    queuePosition: position >= 0 ? position + 1 : 0,
    ...(entry ? {
      accessMode: entry.accessMode,
      costClass: entry.costClass,
      queueAgeMs: position >= 0 ? Math.max(0, Date.now() - entry.enqueuedAt) : 0,
    } : {}),
    ...(blocker || {}),
    lastLog: getLastLog(jobId),
    nextAction: getNextAction(job.status)
  };
}

export function cancelToolJob(jobId: string) {
  const leaderJobId = followerToLeader.get(jobId);
  if (leaderJobId) {
    followerToLeader.delete(jobId);
    singleFlightFollowers.get(leaderJobId)?.delete(jobId);
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancelled single-flight follower without cancelling shared execution.\n');
    updateJobStatus(jobId, { status: 'cancelled', failureSummary: 'Cancelled single-flight follower.' });
    notifyJobWaiters(jobId);
    return true;
  }

  const qIdx = queue.findIndex(q => q.jobId === jobId);
  if (qIdx >= 0) {
    const [cancelledEntry] = queue.splice(qIdx, 1);
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancelled before start.\n');
    updateJobStatus(jobId, { status: 'cancelled', failureSummary: 'Cancelled before start.' });
    finalizeSingleFlight(cancelledEntry);
    notifyJobWaiters(jobId);
    return true;
  }
  
  const active = activeJobs.get(jobId);
  if (active) {
    if (active.cancelFn) {
      active.cancelFn();
    }
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancellation requested.\n');
    updateJobStatus(jobId, { status: 'cancelled', failureSummary: 'Cancellation requested.' });
    notifyJobWaiters(jobId);
    return true;
  }
  
  return false;
}

export function enqueueToolJob(state: AppState, toolName: string, args: any, kind: JobKind) {
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

  let resourceKey = 'global';
  if (kind !== 'skill-read') {
    try {
      const root = resolveProjectRoot(state, args);
      resourceKey = `repo:${root}`;
    } catch {
      resourceKey = `repo:unknown`;
    }
  } else {
    resourceKey = 'skill-cache';
  }

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

  const entry: QueueEntry = {
    jobId,
    resourceKey,
    kind,
    state,
    toolName,
    args,
    accessMode: schedulerProfile.accessMode,
    costClass: schedulerProfile.costClass,
    enqueuedAt: Date.now(),
    singleFlightKey: singleFlightKey || undefined,
  };
  if (singleFlightKey) singleFlightLeaders.set(singleFlightKey, jobId);

  queue.push(entry);
  
  // Try to process queue
  setImmediate(processQueue);

  return {
    jobId,
    status: job.status,
    queuePosition: queue.length,
    sharedWith: undefined as string | undefined,
    nextAction: 'Wait for job completion or inspect get_tool_job_status/get_tool_job_log; call cancel_tool_job to stop the job.'
  };
}

async function processQueue() {
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    if (getBlockerForQueueEntry(entry, index, queue, activeSchedulerEntries())) continue;

    queue.splice(index, 1);
    index -= 1;
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
  incrementScheduledResource(entry);
  activeJobs.set(entry.jobId, { entry });
  updateJobStatus(entry.jobId, { status: 'running' });

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

    // Check if cancelled during execution
    const currentStatus = getJob(entry.jobId)?.status;
    if (currentStatus === 'cancelled' || currentStatus === 'timed_out') {
      // Don't overwrite cancelled/timed_out status
    } else if (isTimedOutResult(result)) {
      writeJobResult(entry.jobId, result);
      updateJobStatus(entry.jobId, { status: 'timed_out', failureSummary: 'Job timed out.' });
      logger.stderr(`\n[Job Timed Out]\n`);
    } else {
      writeJobResult(entry.jobId, result);
      updateJobStatus(entry.jobId, { status: 'succeeded' });
    }
  } catch (error: any) {
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
      updateJobStatus(entry.jobId, { status: 'timed_out', failureSummary });
      logger.stderr(`\n[Job Timed Out]`);
    } else {
      writeJobResult(entry.jobId, {
        ok: false,
        status: 'failed',
        code: normalizedError.code || 'JOB_FAILED',
        message: normalizedError.message || failureSummary,
        error: normalizedError,
      });
      updateJobStatus(entry.jobId, { status: 'failed', failureSummary });
      logger.stderr(`\n[Job Failed] ${error.message}\n${error.stack || ''}`);
    }
  } finally {
    decrementScheduledResource(entry);
    activeJobs.delete(entry.jobId);
    finalizeSingleFlight(entry);
    
    // Process queue to see if anything else can start
    setImmediate(processQueue);
  }
}

export function getJobMetrics() {
  const queueMetrics = getQueueMetrics();
  return {
    queueDepth: queue.length,
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
    recentJobs: queueMetrics.recentJobs
  };
}

export function __setToolJobTestRunner(toolName: string, runner: AsyncRunner | null) {
  if (runner) {
    testRunners.set(toolName, runner);
  } else {
    testRunners.delete(toolName);
  }
}
