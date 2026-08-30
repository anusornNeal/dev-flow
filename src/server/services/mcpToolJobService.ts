import { createHash, randomUUID } from 'crypto';
import type { AppState } from '../types';
import { createJob, updateJobStatus, appendJobLog, writeJobResult, getJob, readJobLog, readJobResult, listRecentJobs, startBackgroundJobCleanup, claimJob, heartbeatJob, requestJobCancellation, transitionJobStatus, getDurableJobMetrics, markJobConsumerAttached, markJobConsumerDetached, markJobSuperseded, getLatestAcceptedGreenGeneration, type McpToolJob, type JobLeaseGuard } from '../repositories/mcpToolJobRepository';
import { createApiError, normalizeUnknownError } from './api';
import { resolveProjectResourceIdentity, resolveProjectRoot } from './localFileService';
import { isDevFlowRestartPending, readDevFlowRestartState } from '../../lib/devFlowRestart';
import { getRepoRevisionForRoot } from './repoRevisionService';
import { getProjectCommandAdmissionPreflight, getProjectCommandDurableExecutionBudgetMs, getProjectCommandExecutionIdentity, prepareProjectCommandVerificationCandidateAsync, type ProjectCommandExecutionIdentity } from './projectCommandService';
import { isVerificationCandidateCurrent } from './verificationCandidateService';
import { getToolDefinitionByName } from '../contracts/devflowContract';
import {
  buildQueueEntryDiagnostics,
  getActiveResourceSnapshot,
  getBlockerForQueueEntry,
  getSchedulerProfile,
  getSchedulerPriority,
  getSchedulerCapacitySnapshot,
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
import { resolveBuiltinToolJobBindingArgs, runBuiltinToolJob } from './mcpToolJobRunnerRegistry';
import { recoveryPolicyForJobStatus, type ToolRecoveryPolicy } from './toolRecoveryPolicy.js';
import {
  getExecutionOwnershipState,
  getTaskExecutionMutationBinding,
  invalidateTaskExecutionVerificationBinding,
} from './executionSessionService.js';
import {
  AUTONOMOUS_TAIL_TOOL_NAME,
  createAcceptedDurableToolJob,
  durableExecutionJobBinding,
  isTerminalJobStatus as isTerminalStatus,
  recordDurableExecutionPending,
  safelyReconcileTerminalDurableExecution,
} from './mcpToolJobTerminalLifecycleService';
import { createMcpToolJobQueueLifecycle, type QueueLifecycleEntry } from './mcpToolJobQueueLifecycleService';
import { getBoardLoopIntentForExecution } from './executionContinuationService.js';
import { runDurableJobRecoveryPass as runLeaseRecoveryPass } from './mcpToolJobLeaseRecoveryService';
import {
  releaseTerminalVerificationCandidate,
  releaseVerificationCandidateForArgsAsync,
  verificationCandidateIdForArgs,
} from './mcpToolJobVerificationLifecycleService';

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

function autonomousTailConfig(job: Pick<McpToolJob, 'args'> | null | undefined) {
  const raw = job?.args?.autonomousTail;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.enabled !== true) return null;
  const commitMessage = String(raw.commitMessage || '').trim();
  return commitMessage ? { commitMessage } : null;
}

function missingTerminalHandoff(verificationJob: McpToolJob, result: any) {
  if (!result?.ok || result?.status !== 'succeeded' || result?.verificationBinding?.authoritative !== true) return null;
  const binding = durableExecutionJobBinding(verificationJob);
  const executionSessionId = String(binding?.executionSessionId || '').trim();
  if (!binding || !executionSessionId) return null;
  const boardLoop = getBoardLoopIntentForExecution(executionSessionId);
  if (!boardLoop || boardLoop.status !== 'active') return null;
  if (autonomousTailConfig(verificationJob)) return null;
  return {
    required: true,
    code: 'TERMINAL_HANDOFF_REQUIRED',
    message: 'Active board-loop terminal verification requires autonomousTail.enabled=true and a non-empty reasoning-agent commitMessage.',
    retry: { tool: 'run_project_command', autonomousTail: { enabled: true, commitMessageRequired: true } },
  };
}

function existingAutonomousTailJob(triggerJobId: string) {
  return listRecentJobs(200).find((candidate) => (
    candidate.toolName === AUTONOMOUS_TAIL_TOOL_NAME
    && String(candidate.args?.triggerJobId || '').trim() === triggerJobId
  )) || null;
}

function maybeEnqueueAutonomousTail(state: AppState, verificationJob: McpToolJob | null | undefined, result: any) {
  if (!verificationJob || verificationJob.toolName !== 'run_project_command' || verificationJob.status !== 'succeeded') return null;
  if (!result?.ok || result?.status !== 'succeeded' || result?.verificationBinding?.authoritative !== true) return null;
  const binding = durableExecutionJobBinding(verificationJob);
  if (!binding) return null;
  const missingHandoff = missingTerminalHandoff(verificationJob, result);
  if (missingHandoff) {
    writeJobResult(verificationJob.jobId, { ...result, terminalHandoff: missingHandoff });
    appendJobLog(verificationJob.jobId, 'stderr', `\n[Autonomous Tail] ${missingHandoff.code}: ${missingHandoff.message}\n`);
    return null;
  }
  const config = autonomousTailConfig(verificationJob);
  if (!config) return null;
  const existing = existingAutonomousTailJob(verificationJob.jobId);
  if (existing) return existing;
  try {
    const accepted = enqueueToolJob(state, AUTONOMOUS_TAIL_TOOL_NAME, {
      projectId: binding.projectId,
      taskId: binding.taskId,
      workspaceId: binding.workspaceId,
      triggerJobId: verificationJob.jobId,
      commitMessage: config.commitMessage,
    }, 'repo-write');
    appendJobLog(verificationJob.jobId, 'stdout', `\n[Autonomous Tail] Accepted durable continuation ${accepted.jobId}.\n`);
    return getJob(accepted.jobId);
  } catch (error) {
    appendJobLog(verificationJob.jobId, 'stderr', `\n[Autonomous Tail] Continuation admission stopped: ${summarizeError(error)}\n`);
    return null;
  }
}

function reconcileAutonomousTailsAfterRestart(state?: AppState) {
  if (!state) return 0;
  let accepted = 0;
  for (const job of listRecentJobs(200)) {
    if (job.toolName !== 'run_project_command' || job.status !== 'succeeded' || !autonomousTailConfig(job)) continue;
    if (existingAutonomousTailJob(job.jobId)) continue;
    const stored = readJobResult(job.jobId)?.result;
    if (!stored) continue;
    if (maybeEnqueueAutonomousTail(state, job, stored)) accepted += 1;
  }
  return accepted;
}

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
  toolName: string;
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

type VerificationEvidenceIntent = 'red-required' | 'red-deferred' | 'green' | 'focused';
type VerificationWorkKind = 'behavioral' | 'review' | 'docs' | 'cleanup';

type VerificationQueuePolicy = {
  seriesKey?: string;
  candidateKey?: string;
  generation?: number;
  evidenceIntent?: VerificationEvidenceIntent;
  required: boolean;
  workKind: VerificationWorkKind;
  acceptedGreenGeneration?: number;
  lag?: number;
  lagWarnThreshold: number;
  lagBlockThreshold: number;
  projectKey: string;
  resourceBacklogLimit: number;
  projectBacklogLimit: number;
};

type SupersedingVerification = {
  candidateKey: string;
  generation?: number;
};

type JobSupersession = {
  candidateKey?: string;
  supersededByCandidateKey: string;
  supersededByGeneration?: number;
  cooperativeCancellationRequested: boolean;
  recordedAt: number;
};

type QueueEntry = QueueLifecycleEntry<AppState, VerificationQueuePolicy, JobPhaseTelemetryState>;

const queue: QueueEntry[] = [];
const activeJobs = new Map<string, { entry: QueueEntry; cancelFn?: () => unknown; closeLogs?: () => void; leaseGeneration: number }>();
const queueLifecycle = createMcpToolJobQueueLifecycle();

const testRunners = new Map<string, AsyncRunner>();
const jobWaiters = new Map<string, Set<(status: ReturnType<typeof getToolJobStatus>) => void>>();
const singleFlightLeaders = new Map<string, string>();
const singleFlightFollowers = new Map<string, Set<string>>();
const followerToLeader = new Map<string, string>();
const jobSupersessionById = new Map<string, JobSupersession>();
let singleFlightHits = 0;
let verificationCoalescingHits = 0;
let supersededQueuedJobs = 0;
let cooperativeSupersedeCancellations = 0;
let verificationBackpressureRejections = 0;
let verificationLagWarnings = 0;
let verificationLagBlocks = 0;
let maxVerificationLagObserved = 0;
const MAX_RECENT_QUEUE_WAITS = 200;
const recentQueueWaitTelemetry: FinalizedQueueWaitTelemetry[] = [];
const MAX_JOB_PHASE_TELEMETRY = 500;
const MAX_JOB_SUPERSESSION_RECORDS = 500;
const DEFAULT_VERIFICATION_BACKLOG_PER_RESOURCE = 3;
const DEFAULT_VERIFICATION_BACKLOG_PER_PROJECT = 12;
const DEFAULT_VERIFICATION_LAG_WARN_THRESHOLD = 2;
const DEFAULT_VERIFICATION_LAG_BLOCK_THRESHOLD = 4;
const jobPhaseTelemetryById = new Map<string, JobPhaseTelemetryState>();
const JOB_LEASE_MS = 30_000;
const JOB_HEARTBEAT_MS = 10_000;
const JOB_LOG_BATCH_BYTES = 32 * 1024;
const JOB_LOG_FLUSH_MS = 75;
// Durable completion must remain bounded even when process teardown never acknowledges cancellation.
const JOB_EXECUTION_DEADLINE_GRACE_MAX_MS = 5_000;
const JOB_EXECUTION_DEADLINE_GRACE_MIN_MS = 100;

function durableExecutionDeadlineDelayMs(entry: Pick<QueueEntry, 'toolName' | 'state' | 'args'>) {
  if (entry.toolName !== 'run_project_command') return null;
  try {
    const executionBudgetMs = Math.max(1, getProjectCommandDurableExecutionBudgetMs(entry.state, entry.args));
    const reconciliationGraceMs = Math.max(
      JOB_EXECUTION_DEADLINE_GRACE_MIN_MS,
      Math.min(JOB_EXECUTION_DEADLINE_GRACE_MAX_MS, Math.ceil(executionBudgetMs * 0.1)),
    );
    return { executionBudgetMs, reconciliationGraceMs, delayMs: executionBudgetMs + reconciliationGraceMs };
  } catch {
    const baseTimeoutMs = Number.isFinite(Number(entry.args?.timeoutMs))
      ? Math.max(1, Math.min(300_000, Number(entry.args.timeoutMs)))
      : 120_000;
    const retryBudgetMs = entry.args?.infrastructureRetryPolicy === 'resource-safe-once' && !entry.args?.recoveryProfile
      ? Math.min(300_000, Math.ceil(baseTimeoutMs * 1.25))
      : 0;
    const executionBudgetMs = baseTimeoutMs + retryBudgetMs;
    const reconciliationGraceMs = Math.max(
      JOB_EXECUTION_DEADLINE_GRACE_MIN_MS,
      Math.min(JOB_EXECUTION_DEADLINE_GRACE_MAX_MS, Math.ceil(executionBudgetMs * 0.1)),
    );
    return { executionBudgetMs, reconciliationGraceMs, delayMs: executionBudgetMs + reconciliationGraceMs };
  }
}

export const __getDurableExecutionDeadlineDelayMsForTests = durableExecutionDeadlineDelayMs;

function getLastActiveJobPhase(jobId: string) {
  const phase = jobPhaseTelemetryById.get(jobId);
  if (!phase) return 'execution';
  if (phase.executionStartedAt && !phase.executionCompletedAt) return 'execution';
  if (phase.candidatePreparationStartedAt && !phase.candidatePreparationCompletedAt) return 'candidate-preparation';
  if (!phase.queueCompletedAt) return 'queue';
  if (phase.executionCompletedAt && !phase.finalized) return 'response-handoff';
  return 'execution';
}

type DeadlineChildTerminationEvidence = {
  status: 'unavailable' | 'reported' | 'requested' | 'threw';
  attempted: boolean;
  terminated?: boolean;
  mode?: string;
  treeTermination?: boolean;
  terminationError?: string;
};

function cancelActiveJobForDeadline(active: { cancelFn?: () => unknown } | undefined): DeadlineChildTerminationEvidence {
  if (!active?.cancelFn) return { status: 'unavailable', attempted: false };
  try {
    const result = active.cancelFn();
    if (result && typeof result === 'object') {
      const reported = result as Record<string, unknown>;
      return {
        status: 'reported',
        attempted: reported.attempted !== false,
        ...(typeof reported.terminated === 'boolean' ? { terminated: reported.terminated } : {}),
        ...(typeof reported.mode === 'string' ? { mode: reported.mode } : {}),
        ...(typeof reported.treeTermination === 'boolean' ? { treeTermination: reported.treeTermination } : {}),
        ...(typeof reported.terminationError === 'string' && reported.terminationError ? { terminationError: reported.terminationError } : {}),
      };
    }
    return { status: 'requested', attempted: true };
  } catch (error) {
    return {
      status: 'threw',
      attempted: true,
      terminated: false,
      terminationError: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildExecutionDeadlineEvidence(
  jobId: string,
  deadline: { executionBudgetMs: number; reconciliationGraceMs: number; delayMs: number },
  args: Record<string, any>,
  childTermination: DeadlineChildTerminationEvidence = { status: 'unavailable', attempted: false },
) {
  return {
    executionBudgetMs: deadline.executionBudgetMs,
    reconciliationGraceMs: deadline.reconciliationGraceMs,
    totalDeadlineMs: deadline.delayMs,
    lastActivePhase: getLastActiveJobPhase(jobId),
    lastLog: getLastLog(jobId),
    childTermination,
    attempt: {
      retryAttempt: Number.isFinite(Number(args?.retryAttempt)) ? Math.max(0, Math.floor(Number(args.retryAttempt))) : 0,
      infrastructureRetryPolicy: args?.infrastructureRetryPolicy == null ? 'resource-safe-once' : String(args.infrastructureRetryPolicy),
      recoveryProfile: Boolean(args?.recoveryProfile),
    },
  };
}

type BufferedJobLogger = {
  logger: Logger;
  flush: () => void;
  close: () => void;
};

function createBufferedJobLogger(jobId: string, guard: JobLeaseGuard): BufferedJobLogger {
  let stdoutPending = '';
  let stderrPending = '';
  let stdoutPendingBytes = 0;
  let stderrPendingBytes = 0;
  let closed = false;

  const flushStream = (stream: 'stdout' | 'stderr') => {
    const data = stream === 'stdout' ? stdoutPending : stderrPending;
    if (!data) return;
    if (stream === 'stdout') {
      stdoutPending = '';
      stdoutPendingBytes = 0;
    } else {
      stderrPending = '';
      stderrPendingBytes = 0;
    }
    appendJobLog(jobId, stream, data, guard);
  };

  const flush = () => {
    flushStream('stdout');
    flushStream('stderr');
  };

  const append = (stream: 'stdout' | 'stderr', data: string) => {
    if (closed || !data) return;
    const bytes = Buffer.byteLength(data, 'utf8');
    if (stream === 'stdout') {
      stdoutPending += data;
      stdoutPendingBytes += bytes;
      if (stdoutPendingBytes >= JOB_LOG_BATCH_BYTES) flushStream('stdout');
    } else {
      stderrPending += data;
      stderrPendingBytes += bytes;
      if (stderrPendingBytes >= JOB_LOG_BATCH_BYTES) flushStream('stderr');
    }
  };

  const timer = setInterval(flush, JOB_LOG_FLUSH_MS);
  timer.unref();

  return {
    logger: {
      stdout: (data: string) => append('stdout', data),
      stderr: (data: string) => append('stderr', data),
    },
    flush,
    close: () => {
      if (closed) return;
      flush();
      closed = true;
      clearInterval(timer);
    },
  };
}
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
  const entries = Array.from(jobPhaseTelemetryById.values()).map((state) => ({
    toolName: state.toolName,
    timings: getJobPhaseTimings(state, queuedById.get(state.jobId) || activeById.get(state.jobId), now),
  }));
  const summary = (values: number[]) => ({
    count: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: values.length ? Math.max(...values) : 0,
  });
  const summarizeTimings = (timings: JobPhaseTimings[]) => ({
    admissionWait: summary(timings.map((entry) => entry.admissionWaitMs)),
    queueWait: summary(timings.map((entry) => entry.queueWaitMs)),
    workspaceLockWait: summary(timings.map((entry) => entry.workspaceLockWaitMs).filter((value) => value > 0)),
    capacityWait: summary(timings.map((entry) => entry.capacityWaitMs).filter((value) => value > 0)),
    candidatePreparation: summary(timings.map((entry) => entry.candidatePreparationMs).filter((value) => value > 0)),
    execution: summary(timings.map((entry) => entry.executionMs)),
    responseHandoff: summary(timings.map((entry) => entry.responseHandoffMs)),
  });
  const byTool: Record<string, ReturnType<typeof summarizeTimings>> = {};
  for (const toolName of new Set(entries.map((entry) => entry.toolName))) {
    byTool[toolName] = summarizeTimings(entries.filter((entry) => entry.toolName === toolName).map((entry) => entry.timings));
  }
  return { ...summarizeTimings(entries.map((entry) => entry.timings)), byTool };
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

function normalizedNonNegativeInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : undefined;
}

function boundedLagThreshold(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.floor(numeric)));
}

function verificationEvidenceIntentFor(value: unknown): VerificationEvidenceIntent | undefined {
  const normalized = normalizedOptionalString(value);
  return normalized === 'red-required' || normalized === 'red-deferred' || normalized === 'green' || normalized === 'focused'
    ? normalized
    : undefined;
}

function verificationWorkKindFor(value: unknown): VerificationWorkKind {
  const normalized = normalizedOptionalString(value);
  return normalized === 'review' || normalized === 'docs' || normalized === 'cleanup' ? normalized : 'behavioral';
}

function hasExplicitVerificationPolicy(args: any) {
  return Boolean(
    normalizedOptionalString(args?.verificationSeriesKey)
    || normalizedOptionalString(args?.verificationCandidateKey)
    || args?.verificationGeneration !== undefined
    || normalizedOptionalString(args?.verificationEvidenceIntent)
    || normalizedOptionalString(args?.verificationWorkKind)
    || args?.verificationRequired === true
    || args?.reviewRequired === true
    || args?.requiredVerification === true
    || args?.acceptedGreenGeneration !== undefined
    || args?.verificationLagWarnThreshold !== undefined
    || args?.verificationLagBlockThreshold !== undefined
    || args?.verificationBacklogLimit !== undefined
    || args?.verificationWorkspaceBacklogLimit !== undefined
    || args?.verificationProjectBacklogLimit !== undefined
  );
}

function verificationPolicyFor(args: any, accessMode: ResourceAccessMode, resourceKey: string): VerificationQueuePolicy | undefined {
  if (accessMode !== 'verify') return undefined;
  const sharedLimit = boundedBacklogLimit(args?.verificationBacklogLimit, DEFAULT_VERIFICATION_BACKLOG_PER_RESOURCE);
  const projectId = normalizedOptionalString(args?.projectId);
  const seriesKey = normalizedOptionalString(args?.verificationSeriesKey);
  const candidateKey = normalizedOptionalString(args?.verificationCandidateKey);
  const generation = normalizedNonNegativeInteger(args?.verificationGeneration);
  const evidenceIntent = verificationEvidenceIntentFor(args?.verificationEvidenceIntent);
  const explicitAcceptedGreenGeneration = normalizedNonNegativeInteger(args?.acceptedGreenGeneration);
  const acceptedGreenGeneration = explicitAcceptedGreenGeneration ?? (seriesKey ? getLatestAcceptedGreenGeneration(seriesKey) : undefined);
  const lag = generation !== undefined && acceptedGreenGeneration !== undefined
    ? Math.max(0, generation - acceptedGreenGeneration)
    : undefined;
  const lagWarnThreshold = boundedLagThreshold(args?.verificationLagWarnThreshold, DEFAULT_VERIFICATION_LAG_WARN_THRESHOLD);
  const lagBlockThreshold = Math.max(
    lagWarnThreshold,
    boundedLagThreshold(args?.verificationLagBlockThreshold, DEFAULT_VERIFICATION_LAG_BLOCK_THRESHOLD),
  );
  return {
    seriesKey,
    candidateKey,
    generation,
    evidenceIntent,
    required: evidenceIntent === 'red-required' || args?.verificationRequired === true || args?.reviewRequired === true || args?.requiredVerification === true,
    workKind: verificationWorkKindFor(args?.verificationWorkKind),
    acceptedGreenGeneration,
    lag,
    lagWarnThreshold,
    lagBlockThreshold,
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

function supersededJobResult(verification: VerificationQueuePolicy | undefined, supersededByCandidateKey: string, supersededByGeneration?: number) {
  return {
    ok: false,
    status: 'cancelled',
    code: 'JOB_SUPERSEDED',
    message: `Verification candidate ${verification?.candidateKey || 'unknown'} was superseded by ${supersededByCandidateKey}.`,
    verificationCandidateKey: verification?.candidateKey,
    verificationGeneration: verification?.generation,
    supersededByCandidateKey,
    supersededByGeneration,
    verificationFreshness: 'superseded',
    stale: true,
    superseded: true,
    authoritative: false,
  };
}

function staleGreenJobResult(verification: VerificationQueuePolicy | undefined) {
  return {
    ok: false,
    status: 'cancelled',
    code: 'VERIFICATION_RESULT_STALE',
    message: `Verification candidate ${verification?.candidateKey || 'unknown'} became stale before its GREEN result could be accepted.`,
    verificationCandidateKey: verification?.candidateKey,
    verificationGeneration: verification?.generation,
    verificationFreshness: 'stale',
    stale: true,
    superseded: false,
    authoritative: false,
  };
}

function taskExecutionFreshnessForArgs(args: any) {
  try {
    const binding = getTaskExecutionMutationBinding(args);
    if (!binding) return { taskBound: false as const, verificationFresh: null, sessionId: undefined as string | undefined };
    const ownership = getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root });
    return {
      taskBound: true as const,
      verificationFresh: ownership.verificationFresh === true,
      sessionId: binding.session.id,
      ownership,
    };
  } catch (error: any) {
    const workspaceId = normalizedOptionalString(args?.workspaceId);
    return {
      taskBound: Boolean(workspaceId),
      verificationFresh: false,
      sessionId: undefined as string | undefined,
      errorCode: typeof error?.code === 'string' ? error.code : undefined,
    };
  }
}

function invalidateFencedTaskVerification(entry: QueueEntry, reason: string) {
  const candidate = entry.args?.__verificationCandidate;
  const candidateId = normalizedOptionalString(candidate?.candidateId);
  if (!candidateId) return null;
  try {
    return invalidateTaskExecutionVerificationBinding(entry.args, {
      candidateId,
      executionKey: normalizedOptionalString(candidate?.executionIdentity?.key),
      reason,
    });
  } catch (error: any) {
    appendJobLog(entry.jobId, 'stderr', `\n[Verification Binding] Failed to invalidate fenced candidate ${candidateId}: ${error?.code || error?.message || 'unknown error'}.\n`);
    return null;
  }
}

function resultWithTaskExecutionFreshness(result: any, args: any) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || result?.ok !== true || result?.status !== 'succeeded') return result;
  const freshness = taskExecutionFreshnessForArgs(args);
  if (!freshness.taskBound) return result;
  return {
    ...result,
    executionVerificationFresh: freshness.verificationFresh,
    ...(freshness.verificationFresh
      ? { authoritative: true, verificationFreshness: 'current' }
      : { authoritative: false, verificationFreshness: 'unbound', code: result.code || 'EXECUTION_VERIFICATION_NOT_AUTHORITATIVE' }),
  };
}

function currentGreenJobResult(result: any, verification: VerificationQueuePolicy | undefined, args: any) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (result?.ok !== true || result?.status !== 'succeeded') {
    return verification?.evidenceIntent === 'green'
      ? { ...result, verificationFreshness: 'rejected', stale: false, superseded: false, authoritative: false }
      : result;
  }
  const executionScoped = resultWithTaskExecutionFreshness(result, args);
  if (verification?.evidenceIntent !== 'green') return executionScoped;
  if (executionScoped?.authoritative === false) {
    return { ...executionScoped, stale: false, superseded: false };
  }
  return {
    ...executionScoped,
    verificationFreshness: 'current',
    stale: false,
    superseded: false,
    authoritative: true,
  };
}

function capturedGreenCandidateIsCurrent(entry: QueueEntry) {
  if (entry.verification?.evidenceIntent !== 'green') return true;
  const candidate = entry.args?.__verificationCandidate;
  if (!candidate || typeof candidate.repoRevision !== 'string' || !candidate.repoRevision.trim()) return true;
  try {
    const root = resolveProjectRoot(entry.state, entry.args);
    return isVerificationCandidateCurrent(root, candidate, candidate.commandConfigFingerprint);
  } catch {
    return false;
  }
}

function terminalizeObsoleteGreenResult(entry: QueueEntry, leaseGuard: JobLeaseGuard) {
  const verification = entry.verification;
  if (verification?.evidenceIntent !== 'green') return false;

  const superseding = findNewerVerification(verification);
  if (superseding) {
    if (recordSupersession(entry, superseding.candidateKey, superseding.generation, false)) {
      writeJobResult(entry.jobId, supersededJobResult(verification, superseding.candidateKey, superseding.generation));
      invalidateFencedTaskVerification(entry, `superseded-by:${superseding.candidateKey}`);
      appendJobLog(entry.jobId, 'stderr', `\n[Verification Superseded] Late GREEN fenced by candidate ${superseding.candidateKey}.\n`);
      return true;
    }
    if (getJob(entry.jobId)?.supersededAt) return true;
  }

  if (capturedGreenCandidateIsCurrent(entry)) return false;
  const transitioned = transitionJobStatus(entry.jobId, ['running'], {
    status: 'cancelled',
    failureSummary: 'Verification candidate became stale before GREEN completion.',
  }, leaseGuard);
  if (!transitioned) return getJob(entry.jobId)?.status !== 'running';
  writeJobResult(entry.jobId, staleGreenJobResult(verification));
  invalidateFencedTaskVerification(entry, 'candidate-stale-before-terminal-acceptance');
  appendJobLog(entry.jobId, 'stderr', '\n[Verification Stale] Repository or command configuration changed before GREEN completion.\n');
  return true;
}

function recordSupersession(
  entry: QueueEntry,
  supersededByCandidateKey: string,
  supersededByGeneration: number | undefined,
  cooperativeCancellationRequested: boolean,
) {
  const persisted = markJobSuperseded(entry.jobId, supersededByCandidateKey, supersededByGeneration);
  if (!persisted) return false;
  rememberJobSupersession(entry.jobId, {
    candidateKey: entry.verification?.candidateKey,
    supersededByCandidateKey,
    supersededByGeneration,
    cooperativeCancellationRequested,
    recordedAt: Date.now(),
  });
  return true;
}

function findNewerVerification(policy: VerificationQueuePolicy): SupersedingVerification | undefined {
  if (policy.required || !policy.seriesKey || !policy.candidateKey || policy.generation === undefined) return undefined;
  let newest: SupersedingVerification | undefined;
  for (const job of listRecentJobs(200)) {
    if (job.verificationSeriesKey !== policy.seriesKey || job.verificationGeneration === undefined || job.verificationGeneration <= policy.generation) continue;
    if (!job.verificationCandidateKey || job.supersededAt) continue;
    if (!newest || job.verificationGeneration > (newest.generation ?? -1)) {
      newest = { candidateKey: job.verificationCandidateKey, generation: job.verificationGeneration };
    }
  }
  return newest;
}

function shouldSupersedeExisting(entry: QueueEntry, policy: VerificationQueuePolicy) {
  const existing = entry.verification;
  if (!existing || existing.seriesKey !== policy.seriesKey || existing.candidateKey === policy.candidateKey) return false;
  if (existing.generation !== undefined && policy.generation !== undefined) return existing.generation < policy.generation;
  if (existing.generation !== undefined && policy.generation === undefined) return false;
  return true;
}

function supersedeObsoleteVerification(policy: VerificationQueuePolicy) {
  if (!policy.seriesKey || !policy.candidateKey) return;

  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const entry = queue[index];
    if (!shouldSupersedeExisting(entry, policy) || !canSupersedeVerification(entry)) continue;
    if (!recordSupersession(entry, policy.candidateKey, policy.generation, false)) continue;
    safelyReconcileTerminalDurableExecution(getJob(entry.jobId));
    queue.splice(index, 1);
    writeJobResult(entry.jobId, supersededJobResult(entry.verification, policy.candidateKey, policy.generation));
    finalizeQueueWaitTelemetry(entry);
    void releaseVerificationCandidateForArgsAsync(entry.args).catch(() => {});
    appendJobLog(entry.jobId, 'stderr', `\n[Verification Superseded] Replaced by candidate ${policy.candidateKey}.\n`);
    finalizeSingleFlight(entry);
    notifyJobWaiters(entry.jobId);
    supersededQueuedJobs += 1;
  }

  for (const active of activeJobs.values()) {
    const entry = active.entry;
    if (!shouldSupersedeExisting(entry, policy) || !canSupersedeVerification(entry)) continue;
    const canCancel = typeof active.cancelFn === 'function' && entry.args?.allowSupersedeRunning !== false;
    if (!recordSupersession(entry, policy.candidateKey, policy.generation, canCancel)) continue;
    writeJobResult(entry.jobId, supersededJobResult(entry.verification, policy.candidateKey, policy.generation));
    appendJobLog(entry.jobId, 'stderr', `\n[Verification Superseded] Newer candidate ${policy.candidateKey} is authoritative.\n`);
    if (canCancel) {
      active.cancelFn?.();
      cooperativeSupersedeCancellations += 1;
    }
  }
}

function terminalizeIncomingSupersededJob(jobId: string, verification: VerificationQueuePolicy, superseding: SupersedingVerification) {
  const persisted = markJobSuperseded(jobId, superseding.candidateKey, superseding.generation);
  if (!persisted) return false;
  rememberJobSupersession(jobId, {
    candidateKey: verification.candidateKey,
    supersededByCandidateKey: superseding.candidateKey,
    supersededByGeneration: superseding.generation,
    cooperativeCancellationRequested: false,
    recordedAt: Date.now(),
  });
  safelyReconcileTerminalDurableExecution(persisted);
  writeJobResult(jobId, supersededJobResult(verification, superseding.candidateKey, superseding.generation));
  appendJobLog(jobId, 'stderr', `\n[Verification Superseded] Request is older than candidate ${superseding.candidateKey}.\n`);
  supersededQueuedJobs += 1;
  notifyJobWaiters(jobId);
  return true;
}

function enforceVerificationLag(policy: VerificationQueuePolicy) {
  if (policy.lag === undefined) return;
  maxVerificationLagObserved = Math.max(maxVerificationLagObserved, policy.lag);
  if (policy.lag >= policy.lagWarnThreshold) verificationLagWarnings += 1;
  if (policy.required || policy.workKind !== 'behavioral' || policy.lag < policy.lagBlockThreshold) return;
  verificationLagBlocks += 1;
  throw createApiError(429, 'VERIFICATION_LAG_BACKPRESSURE', 'Verification lag is too large for another behavioral revision; catch up GREEN evidence before continuing.', {
    retryable: true,
    details: {
      seriesKey: policy.seriesKey,
      verificationGeneration: policy.generation,
      acceptedGreenGeneration: policy.acceptedGreenGeneration,
      lag: policy.lag,
      warnThreshold: policy.lagWarnThreshold,
      blockThreshold: policy.lagBlockThreshold,
      workKind: policy.workKind,
      requiredVerification: policy.required,
    },
  });
}

function verificationAwareSchedulerPriority(basePriority: number, policy: VerificationQueuePolicy | undefined) {
  if (!policy || policy.required || policy.workKind !== 'behavioral' || policy.lag === undefined || policy.lag < policy.lagWarnThreshold) {
    return basePriority;
  }
  return Math.min(9, basePriority + 2);
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

function notifyJobWaiters(jobId: string) {
  const status = getToolJobStatus(jobId);
  if (!status || !isTerminalStatus(status.status)) return;
  const waiters = jobWaiters.get(jobId);
  if (!waiters) return;
  jobWaiters.delete(jobId);
  for (const resolve of waiters) resolve(status);
}

function verificationCandidateReuseKeyForEntry(entry: QueueEntry) {
  const policy = entry.verification;
  const admission = entry.args?.__projectCommandAdmissionIdentity;
  if (!policy?.seriesKey || !policy.candidateKey || policy.generation === undefined || !admission || typeof admission !== 'object') return undefined;
  if (!String(admission.repoRevision || '').trim() || !String(admission.lineageToken || '').trim()) return undefined;
  return createHash('sha256').update(stableStringify({
    resourceKey: entry.resourceKey,
    seriesKey: policy.seriesKey,
    candidateKey: policy.candidateKey,
    generation: policy.generation,
    repoRevision: admission.repoRevision,
    lineageToken: admission.lineageToken,
    commandConfigFingerprint: admission.commandConfigFingerprint,
    dependencyFingerprint: admission.dependencyFingerprint,
    environmentFingerprint: admission.environmentFingerprint,
    platform: admission.platform,
    arch: admission.arch,
    runtime: admission.runtime,
  })).digest('hex');
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
      const workspaceId = normalizedOptionalString(args?.workspaceId);
      let executionSessionId: string | undefined;
      if (workspaceId) {
        try {
          executionSessionId = getTaskExecutionMutationBinding(args)?.session.id;
        } catch {
          return null;
        }
      }
      return createHash('sha256').update(stableStringify({
        resourceKey,
        toolName,
        kind,
        executionKey: executionIdentity.key,
        executionSessionId,
      })).digest('hex');
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

// Single-flight completion and cancellation remain façade-local because they mutate the same
// leader/follower/waiter topology atomically; extracting them would split one in-memory authority.
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
    if (leaderResult !== null && leaderResult !== undefined) {
      writeJobResult(followerJobId, resultWithTaskExecutionFreshness(leaderResult, followerStatus.args));
    }
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
    nextAction: `Call get_tool_job_result for ${status.jobId} with waitMs=30000; call cancel_tool_job with this jobId only if this exact job must be stopped.`,
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
      : 'Read get_tool_job_result and change strategy explicitly; do not replay the same failed payload unchanged.';
  }
  if (status === 'cancelled') {
    return 'The job was cancelled; inspect why before deciding whether a changed tool call is still needed.';
  }
  return 'Read get_tool_job_result or devflow_health_check for diagnostics.';
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
    toolName: job.toolName,
    resourceScope: resourceScopeFor(job.resourceKey),
    admissionWaitMs: 0,
    enqueuedAt,
    responseHandoffMs: 0,
    workspaceLockWaitMs: 0,
    capacityWaitMs: 0,
    blockerReasons: {},
  };
  rememberJobPhaseTelemetry(phaseTelemetry);
  const recoveredVerification = verificationPolicyFor(job.args, schedulerProfile.accessMode, job.resourceKey);
  const recoveredBasePriority = getSchedulerPriority(job.toolName, job.args, schedulerProfile.accessMode, schedulerProfile.verificationClass);
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
    verificationDemand: schedulerProfile.verificationDemand,
    enqueuedAt,
    schedulerPriority: verificationAwareSchedulerPriority(recoveredBasePriority, recoveredVerification),
    singleFlightKey: recoveredSingleFlightKey,
    verification: recoveredVerification,
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
      coalescing: {
        verificationHits: verificationCoalescingHits,
      },
      superseded: {
        queued: supersededQueuedJobs,
        savedExecutions: supersededQueuedJobs,
        cooperativeCancellationRequests: cooperativeSupersedeCancellations,
        tracked: jobSupersessionById.size,
      },
      backpressure: {
        rejections: verificationBackpressureRejections,
        defaultResourceLimit: DEFAULT_VERIFICATION_BACKLOG_PER_RESOURCE,
        defaultProjectLimit: DEFAULT_VERIFICATION_BACKLOG_PER_PROJECT,
      },
      lag: {
        warnings: verificationLagWarnings,
        blocks: verificationLagBlocks,
        maxObserved: maxVerificationLagObserved,
        defaultWarnThreshold: DEFAULT_VERIFICATION_LAG_WARN_THRESHOLD,
        defaultBlockThreshold: DEFAULT_VERIFICATION_LAG_BLOCK_THRESHOLD,
      },
      waitTelemetry: summarizeQueueWaitTelemetry(),
      phaseTelemetry: summarizeJobPhaseTelemetry(),
      durable,
      failures: failedJobs.slice(0, 10).map(job => {
        const structuredErrorCode = getTerminalJobErrorCode(job.jobId);
        const errorCode = structuredErrorCode || (job.status === 'timed_out' ? 'JOB_TIMED_OUT' : undefined);
        const recovery = recoveryPolicyForJobStatus(job.status, errorCode);
        return {
          jobId: job.jobId,
          toolName: job.toolName,
          status: job.status,
          failureSummary: job.failureSummary || getLastLog(job.jobId).slice(-500),
          ...(errorCode ? { errorCode } : {}),
          ...(recovery ? { recovery } : {}),
          recoveryClassification: job.recoveryClassification,
        };
      })
    },
    recentJobs: recentJobs.map(buildJobSummary).filter(Boolean)
  };
}

function notifySchedulerCapacityWaiters() {
  queueLifecycle.notifyCapacityWaiters();
}

function waitForSchedulerCapacityChange() {
  return queueLifecycle.waitForCapacityChange();
}

function releaseSchedulerLease(entry: QueueEntry, leaseGeneration: number, observation?: { actualDurationMs?: number }) {
  return queueLifecycle.releaseSchedulerLease(entry, leaseGeneration, observation);
}

function releaseStaleActiveLease(job: McpToolJob) {
  const active = activeJobs.get(job.jobId);
  if (!active || active.leaseGeneration !== job.leaseGeneration) return undefined;
  active.closeLogs?.();
  releaseSchedulerLease(active.entry, active.leaseGeneration);
  activeJobs.delete(job.jobId);
  try {
    active.cancelFn?.();
  } catch {
    // Durable terminal/recovery state owns convergence even if cooperative cancellation throws.
  }
  return active;
}

function runDurableJobRecoveryPass(state?: AppState, nowMs = Date.now()) {
  return runLeaseRecoveryPass(state, nowMs, {
    isSingleFlightFollower: (jobId) => followerToLeader.has(jobId),
    hasQueuedOrActive: (jobId) => queue.some((entry) => entry.jobId === jobId) || activeJobs.has(jobId),
    recordDurableExecutionPending,
    enqueueRecoveredJob,
    releaseStaleActiveLease,
    finalizeSingleFlight,
    safelyReconcileTerminalDurableExecution,
    releaseTerminalVerificationCandidate,
    releaseVerificationCandidateForArgsAsync,
    invalidateFencedTaskVerification,
    scheduleProcessQueue: () => setImmediate(processQueue),
    durableExecutionDeadlineDelayMs,
    buildExecutionDeadlineEvidence,
    summarizeError,
  });
}

function startDurableJobRecoveryLoop(state?: AppState) {
  if (state) durableRecoveryState = state;
  if (durableRecoveryTimer) return;
  durableRecoveryTimer = setInterval(() => {
    if (durableRecoveryState) runDurableJobRecoveryPass(durableRecoveryState, Date.now());
  }, JOB_RECOVERY_SWEEP_MS);
  durableRecoveryTimer.unref?.();
}

function reconcileTerminalDurableJobsAfterRestart() {
  for (const job of listRecentJobs(200)) {
    if (!isTerminalStatus(job.status) || activeJobs.has(job.jobId)) continue;
    safelyReconcileTerminalDurableExecution(job);
  }
}

export function initMcpToolJobs(state?: AppState) {
  if (state) durableRecoveryState = state;
  reconcileTerminalDurableJobsAfterRestart();
  reconcileAutonomousTailsAfterRestart(state);
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
  const supersededByCandidateKey = job.supersededByCandidateKey || supersession?.supersededByCandidateKey;
  const supersededByGeneration = job.supersededByGeneration ?? supersession?.supersededByGeneration;
  const isSuperseded = Boolean(job.supersededAt || supersededByCandidateKey);
  const terminalResult = isTerminalStatus(job.status) ? readJobResult(jobId)?.result : undefined;
  const resultFreshness = terminalResult?.verificationFreshness;
  const verificationFreshness = isSuperseded
    ? 'superseded'
    : resultFreshness === 'stale'
      ? 'stale'
      : verification?.evidenceIntent === 'green' && job.status === 'succeeded'
        ? 'current'
        : undefined;
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
      verificationGeneration: verification.generation,
      verificationEvidenceIntent: verification.evidenceIntent,
      verificationRequired: verification.required,
      acceptedGreenGeneration: verification.acceptedGreenGeneration,
      verificationLag: verification.lag,
    } : {}),
    ...(verificationFreshness ? {
      verificationFreshness,
      authoritative: verificationFreshness === 'current',
      stale: verificationFreshness === 'stale',
      superseded: verificationFreshness === 'superseded',
    } : {}),
    ...(isSuperseded ? {
      supersededByCandidateKey,
      supersededByGeneration,
      cooperativeCancellationRequested: supersession?.cooperativeCancellationRequested || false,
    } : {}),
    ...(blocker || {}),
    lastLog: getLastLog(jobId),
    ...(recovery ? { recovery } : {}),
    nextAction: getNextAction(job.status, recovery)
  };
}

// Cancellation remains façade-local for the same atomicity boundary as single-flight completion.
export function cancelToolJob(jobId: string) {
  const leaderJobId = followerToLeader.get(jobId);
  const activeBeforeCancel = activeJobs.get(jobId);
  const reason = leaderJobId ? 'Cancelled single-flight follower.' : activeBeforeCancel ? 'Cancellation requested.' : 'Cancelled before start.';
  activeBeforeCancel?.closeLogs?.();
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
    safelyReconcileTerminalDurableExecution(persisted);
    finalizeQueueWaitTelemetry(cancelledEntry);
    void releaseVerificationCandidateForArgsAsync(cancelledEntry.args).catch(() => {});
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancelled before start.\n');
    finalizeSingleFlight(cancelledEntry);
    notifyJobWaiters(jobId);
    return true;
  }

  const active = activeBeforeCancel ?? activeJobs.get(jobId);
  if (active) {
    writeJobResult(jobId, {
      ok: false,
      status: 'cancelled',
      code: 'JOB_CANCELLED',
      message: reason,
    });
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancellation persisted; waiting for worker teardown before releasing lifecycle and scheduler authority.\n');
    try {
      active.cancelFn?.();
    } catch {
      // Persisted cancellation remains authoritative even if cooperative teardown throws.
    }
    notifySchedulerCapacityWaiters();
    notifyJobWaiters(jobId);
    return true;
  }

  safelyReconcileTerminalDurableExecution(persisted);
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

  const admissionBindingArgs = resolveBuiltinToolJobBindingArgs(toolName, jobArgs);
  const resourceKey = resolveAdmissionResourceKey(state, admissionBindingArgs, kind);
  const schedulerProfile = getSchedulerProfile(state, toolName, admissionBindingArgs, kind, resourceKey);

  const admissionExecutionFreshness = admissionPreflight?.cachedResult
    ? taskExecutionFreshnessForArgs(jobArgs)
    : null;
  if (
    admissionPreflight?.cachedResult
    && (!admissionExecutionFreshness?.taskBound || admissionExecutionFreshness.verificationFresh === true)
  ) {
    const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const verification = verificationPolicyFor(jobArgs, schedulerProfile.accessMode, resourceKey);
    const superseding = verification ? findNewerVerification(verification) : undefined;
    if (verification && !superseding) supersedeObsoleteVerification(verification);
    const acceptedJob = createAcceptedDurableToolJob(jobId, toolName, jobArgs, resourceKey, { eagerArtifacts: toolName !== 'search_local_files' });
    jobArgs = acceptedJob.args;
    if (verification && superseding) {
      terminalizeIncomingSupersededJob(jobId, verification, superseding);
      return {
        jobId,
        status: 'cancelled' as const,
        queuePosition: 0,
        sharedWith: undefined as string | undefined,
        handoffImmediately: false,
        cacheHit: false,
        accessMode: schedulerProfile.accessMode,
        costClass: schedulerProfile.costClass,
        nextAction: `Verification request was superseded by ${superseding.candidateKey}.`,
      };
    }
    const cachedAcceptedResult = currentGreenJobResult(admissionPreflight.cachedResult, verification, jobArgs);
    writeJobResult(jobId, cachedAcceptedResult);
    const completedJob = transitionJobStatus(jobId, ['queued'], { status: 'succeeded' });
    safelyReconcileTerminalDurableExecution(completedJob);
    maybeEnqueueAutonomousTail(state, completedJob, cachedAcceptedResult);
    const completedAt = Date.now();
    const phaseTelemetry: JobPhaseTelemetryState = {
      jobId,
      resourceScope: resourceScopeFor(resourceKey),
      toolName,
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
      createJob(followerJobId, toolName, jobArgs, resourceKey, { eagerArtifacts: toolName !== 'search_local_files' });
      updateJobStatus(followerJobId, { status: 'running' });
      const verificationCoalesced = schedulerProfile.accessMode === 'verify';
      appendJobLog(
        followerJobId,
        'stdout',
        verificationCoalesced
          ? `[Verification Coalesced] Sharing identity-matched execution ${leaderJobId}.\n`
          : `[Single Flight] Following ${leaderJobId}.\n`,
      );
      const followers = singleFlightFollowers.get(leaderJobId) || new Set<string>();
      followers.add(followerJobId);
      singleFlightFollowers.set(leaderJobId, followers);
      followerToLeader.set(followerJobId, leaderJobId);
      singleFlightHits += 1;
      if (verificationCoalesced) verificationCoalescingHits += 1;
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
  let superseding: SupersedingVerification | undefined;
  try {
    verification = verificationPolicyFor(jobArgs, schedulerProfile.accessMode, resourceKey);
    if (verification) {
      superseding = findNewerVerification(verification);
      if (!superseding) {
        enforceVerificationLag(verification);
        supersedeObsoleteVerification(verification);
        enforceVerificationBackpressure(verification, resourceKey);
      }
    }
    job = createAcceptedDurableToolJob(jobId, toolName, jobArgs, resourceKey, { eagerArtifacts: toolName !== 'search_local_files' });
    jobArgs = job.args;
    if (verification && superseding) {
      terminalizeIncomingSupersededJob(jobId, verification, superseding);
      return {
        jobId,
        status: 'cancelled' as const,
        queuePosition: 0,
        sharedWith: undefined as string | undefined,
        handoffImmediately: false,
        accessMode: schedulerProfile.accessMode,
        costClass: schedulerProfile.costClass,
        nextAction: `Verification request was superseded by ${superseding.candidateKey}.`,
      };
    }
  } catch (error) {
    throw error;
  }
  const enqueuedAt = Date.now();
  const phaseTelemetry: JobPhaseTelemetryState = {
    jobId,
    resourceScope: resourceScopeFor(resourceKey),
    toolName,
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
    verificationDemand: schedulerProfile.verificationDemand,
    enqueuedAt,
    schedulerPriority: verificationAwareSchedulerPriority(
      getSchedulerPriority(toolName, jobArgs, schedulerProfile.accessMode, schedulerProfile.verificationClass),
      verification,
    ),
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
      : `Call get_tool_job_result for ${jobId} with waitMs=30000; call cancel_tool_job with this jobId only if this exact job must be stopped.`
  };
}

async function processQueue() {
  queueLifecycle.processQueue(queue, {
    activeEntries: activeSchedulerEntries,
    advanceWaitTelemetry: advanceQueueWaitTelemetry,
    finalizeWaitTelemetry: finalizeQueueWaitTelemetry,
    startJob,
  });
}

function setJobActiveContext(jobId: string, cancelFn: () => unknown, leaseGeneration: number) {
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
    resourceDemand: request.resourceDemand ?? entry.verificationDemand,
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

  const releasePermit = (permit: VerificationProcessPermit, result?: unknown) => {
    if (entry.verificationPermitId === permit.id) entry.verificationPermitId = undefined;
    const actualDurationMs = Number((result as any)?.resourceProfile?.actual?.durationMs);
    const observation = Number.isFinite(actualDurationMs) && actualDurationMs > 0 ? { actualDurationMs } : undefined;
    if (releaseVerificationProcessPermit(permit, observation)) notifySchedulerCapacityWaiters();
  };

  return {
    runWithPermit: async <T>(request: VerificationPermitDemand, run: () => Promise<T>) => {
      if (disposed) throw transitionAbortError(entry.jobId);
      assertActiveTransitionLease(entry.jobId, leaseGeneration);
      const permit = reservedPermit || await acquireVerificationPermitForActiveJob(entry.jobId, leaseGeneration, request);
      reservedPermit = undefined;
      let result: T | undefined;
      try {
        assertActiveTransitionLease(entry.jobId, leaseGeneration);
        result = await run();
        return result;
      } finally {
        releasePermit(permit, result);
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
  if (entry.accessMode === nextAccessMode) {
    if (nextAccessMode !== 'verify') return;
    const permit = await acquireVerificationPermitForActiveJob(jobId, leaseGeneration, request);
    return createVerificationExecutionLease(entry, leaseGeneration, permit);
  }

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
      reuseKey: verificationCandidateReuseKeyForEntry(entry),
    });
    if (!candidate) return;
    const nextArgs = { ...entry.args, __verificationCandidate: candidate };
    const persisted = transitionJobStatus(entry.jobId, ['running'], { args: nextArgs }, leaseGuard);
    if (!persisted) {
      await releaseVerificationCandidateForArgsAsync(nextArgs).catch(() => {});
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
    if (persisted && isTerminalStatus(persisted.status)) {
      safelyReconcileTerminalDurableExecution(persisted);
      void releaseVerificationCandidateForArgsAsync(entry.args).catch(() => {});
    }
    finalizeSingleFlight(entry);
    setImmediate(processQueue);
    return;
  }

  entry.args = claimed.args;
  const leaseGeneration = claimed.leaseGeneration || 0;
  const leaseGuard: JobLeaseGuard = { workerId: JOB_WORKER_ID, leaseGeneration };
  try {
    recordDurableExecutionPending(claimed, 'running');
  } catch (error) {
    const failed = transitionJobStatus(entry.jobId, ['running'], {
      status: 'failed',
      failureSummary: `Durable execution binding could not be refreshed before execution: ${summarizeError(error)}`,
    }, leaseGuard);
    if (failed) {
      appendJobLog(entry.jobId, 'stderr', `\n[Execution Fenced Before Start] ${summarizeError(error)}\n`);
      safelyReconcileTerminalDurableExecution(failed);
    }
    finalizeSingleFlight(entry);
    setImmediate(processQueue);
    return;
  }
  const bufferedLogger = createBufferedJobLogger(entry.jobId, leaseGuard);
  queueLifecycle.markScheduled(entry);
  activeJobs.set(entry.jobId, { entry, leaseGeneration, closeLogs: bufferedLogger.close });
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

  const logger = bufferedLogger.logger;
  let completedResult: any;
  let executionDeadlineTimer: NodeJS.Timeout | undefined;

  const armExecutionDeadline = () => {
    const deadline = durableExecutionDeadlineDelayMs(entry);
    if (!deadline) return;
    executionDeadlineTimer = setTimeout(() => {
      const active = activeJobs.get(entry.jobId);
      if (!active || active.leaseGeneration !== leaseGeneration) return;
      const childTermination = cancelActiveJobForDeadline(active);
      active.cancelFn = undefined;
      active.closeLogs?.();
      const executionDeadline = buildExecutionDeadlineEvidence(entry.jobId, deadline, entry.args, childTermination);
      const failureSummary = `Execution deadline exceeded after ${deadline.executionBudgetMs}ms plus ${deadline.reconciliationGraceMs}ms reconciliation grace. Last active phase: ${executionDeadline.lastActivePhase}.`;
      const timeoutResult = {
        ok: false,
        status: 'timed_out',
        code: 'JOB_EXECUTION_DEADLINE_EXCEEDED',
        message: failureSummary,
        timedOut: true,
        durationMs: deadline.delayMs,
        executionDeadline,
      };
      const wrote = writeJobResult(entry.jobId, timeoutResult, leaseGuard);
      const transitioned = wrote
        ? transitionJobStatus(entry.jobId, ['running'], {
            status: 'timed_out',
            failureSummary,
            recoveryClassification: 'interrupted',
          }, leaseGuard)
        : null;
      if (!transitioned) return;

      appendJobLog(entry.jobId, 'stderr', `\n[Job Timed Out] ${failureSummary}\n`);
      invalidateFencedTaskVerification(entry, 'durable-execution-deadline');
      safelyReconcileTerminalDurableExecution(transitioned);
      releaseSchedulerLease(entry, leaseGeneration);
      activeJobs.delete(entry.jobId);
      finalizeSingleFlight(entry);
      setImmediate(processQueue);
      void releaseVerificationCandidateForArgsAsync(entry.args).catch(() => {});
    }, deadline.delayMs);
    executionDeadlineTimer.unref?.();
  };

  try {
    await prepareVerificationCandidateForActiveJob(entry, leaseGeneration, leaseGuard);
    if (!entry.phaseTelemetry.executionStartedAt) entry.phaseTelemetry.executionStartedAt = Date.now();
    rememberJobPhaseTelemetry(entry.phaseTelemetry);
    armExecutionDeadline();
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
    completedResult = result;
    entry.phaseTelemetry.executionCompletedAt = Date.now();
    bufferedLogger.flush();

    const currentStatus = getJob(entry.jobId)?.status;
    const obsoleteGreen = currentStatus === 'running' ? terminalizeObsoleteGreenResult(entry, leaseGuard) : false;
    if (currentStatus === 'cancelled' || currentStatus === 'timed_out') {
      // Persisted cancellation/timeout wins over a late worker result and revokes only this candidate's binding.
      invalidateFencedTaskVerification(entry, `terminal-status:${currentStatus}`);
    } else if (obsoleteGreen) {
      // A newer generation or changed repository fenced this GREEN before terminal acceptance.
    } else if (isTimedOutResult(result)) {
      const wrote = writeJobResult(entry.jobId, result, leaseGuard);
      const transitioned = wrote
        ? transitionJobStatus(entry.jobId, ['running'], { status: 'timed_out', failureSummary: 'Job timed out.' }, leaseGuard)
        : null;
      if (transitioned) appendJobLog(entry.jobId, 'stderr', '\n[Job Timed Out]\n');
    } else {
      const acceptedResult = currentGreenJobResult(result, entry.verification, entry.args);
      completedResult = acceptedResult;
      const wrote = writeJobResult(entry.jobId, acceptedResult, leaseGuard);
      if (wrote) transitionJobStatus(entry.jobId, ['running'], { status: 'succeeded' }, leaseGuard);
    }
  } catch (error: any) {
    if (!entry.phaseTelemetry.executionCompletedAt) entry.phaseTelemetry.executionCompletedAt = Date.now();
    bufferedLogger.flush();
    const currentStatus = getJob(entry.jobId)?.status;
    const normalizedError = normalizeUnknownError(error).error;
    const failureSummary = summarizeError(error);
    if (currentStatus === 'cancelled') {
      const supersession = jobSupersessionById.get(entry.jobId);
      const cancelledResult = supersession
        ? Object.assign(supersededJobResult(entry.verification, supersession.supersededByCandidateKey, supersession.supersededByGeneration), { error: normalizedError })
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
    if (executionDeadlineTimer) clearTimeout(executionDeadlineTimer);
    bufferedLogger.close();
    const leaseWasAlreadyReleased = queueLifecycle.hasReleasedSchedulerLease(entry.jobId, leaseGeneration);
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
    const completedDurationMs = Number(completedResult?.resourceProfile?.actual?.durationMs);
    releaseSchedulerLease(
      entry,
      leaseGeneration,
      Number.isFinite(completedDurationMs) && completedDurationMs > 0 ? { actualDurationMs: completedDurationMs } : undefined,
    );
    const terminalJob = getJob(entry.jobId);
    safelyReconcileTerminalDurableExecution(terminalJob);
    if (terminalJob?.status === 'succeeded') maybeEnqueueAutonomousTail(entry.state, terminalJob, completedResult);
    const active = activeJobs.get(entry.jobId);
    if (active?.leaseGeneration === leaseGeneration) {
      activeJobs.delete(entry.jobId);
      finalizeSingleFlight(entry);
    }
    queueLifecycle.forgetReleasedSchedulerLease(entry.jobId, leaseGeneration);
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

export function __reconcileAutonomousTailsAfterRestartForTests(state?: AppState) {
  return reconcileAutonomousTailsAfterRestart(state);
}

export function __resetQueueWaitTelemetryForTests() {
  recentQueueWaitTelemetry.length = 0;
  jobPhaseTelemetryById.clear();
  jobSupersessionById.clear();
  supersededQueuedJobs = 0;
  verificationCoalescingHits = 0;
  cooperativeSupersedeCancellations = 0;
  verificationBackpressureRejections = 0;
  verificationLagWarnings = 0;
  verificationLagBlocks = 0;
  maxVerificationLagObserved = 0;
}

export function __resetMcpToolJobRuntimeForTests() {
  if (activeJobs.size > 0) {
    throw new Error('Cannot reset MCP tool job runtime while jobs are actively executing.');
  }
  queue.length = 0;
  singleFlightLeaders.clear();
  singleFlightFollowers.clear();
  followerToLeader.clear();
  jobWaiters.clear();
  queueLifecycle.resetForTests();
}

export function __setToolJobTestRunner(toolName: string, runner: AsyncRunner | null) {
  if (runner) {
    testRunners.set(toolName, runner);
  } else {
    testRunners.delete(toolName);
  }
}
