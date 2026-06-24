import { randomUUID } from 'crypto';
import type { AppState } from '../types';
import { createJob, updateJobStatus, appendJobLog, writeJobResult, getJob, readJobLog, listInterruptedJobs, listRecentJobs, startBackgroundJobCleanup } from '../repositories/mcpToolJobRepository';
import { resolveProjectRoot } from './localFileService';

// Import async runners (we will define these later in their respective files)
import { runProjectCommandAsync } from './projectCommandService';
import { applyLocalPatchAsync } from './localPatchService';
import { searchLocalFilesAsync } from './localFileService';
import { commitGitChanges } from './gitService';
import { editFilesBatch } from './fileEditBatchService';

type JobKind = 'repo-command' | 'repo-write' | 'repo-read' | 'skill-read';
type Logger = { stdout: (data: string) => void; stderr: (data: string) => void };
type AsyncRunner = (
  state: AppState,
  args: any,
  logger: Logger,
  setCancelFn: (fn: () => void) => void,
) => Promise<any>;

const MAX_CONCURRENCY: Record<JobKind, number> = {
  'repo-command': 1,
  'repo-write': 1,
  'repo-read': 2,
  'skill-read': 4
};

interface QueueEntry {
  jobId: string;
  resourceKey: string;
  kind: JobKind;
  state: AppState;
  toolName: string;
  args: any;
}

const queue: QueueEntry[] = [];
const activeJobs = new Map<string, { entry: QueueEntry; cancelFn?: () => void }>();
const testRunners = new Map<string, AsyncRunner>();

interface ResourceStats {
  readers: number;
  writers: number;
  kindCount: Record<string, number>;
}

const activeResources = new Map<string, ResourceStats>();

function getResourceStats(resourceKey: string): ResourceStats {
  let stats = activeResources.get(resourceKey);
  if (!stats) {
    stats = { readers: 0, writers: 0, kindCount: {} };
    activeResources.set(resourceKey, stats);
  }
  return stats;
}

function incrementResource(resourceKey: string, kind: JobKind) {
  const stats = getResourceStats(resourceKey);
  if (kind === 'repo-command' || kind === 'repo-write') {
    stats.writers++;
  } else {
    stats.readers++;
  }
  stats.kindCount[kind] = (stats.kindCount[kind] || 0) + 1;
}

function decrementResource(resourceKey: string, kind: JobKind) {
  const stats = getResourceStats(resourceKey);
  if (kind === 'repo-command' || kind === 'repo-write') {
    stats.writers--;
  } else {
    stats.readers--;
  }
  stats.kindCount[kind] = (stats.kindCount[kind] || 0) - 1;
  if (stats.readers <= 0 && stats.writers <= 0) {
    activeResources.delete(resourceKey);
  }
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
  const activeJobsList = Array.from(activeJobs.values()).map(a => ({
    jobId: a.entry.jobId,
    kind: a.entry.kind,
    resourceKey: a.entry.resourceKey,
    toolName: a.entry.toolName
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
    queue: queue.map(q => ({ jobId: q.jobId, kind: q.kind, resourceKey: q.resourceKey })),
    active: activeJobsList,
    resources: Object.fromEntries(Array.from(activeResources.entries())),
    metrics: {
      completedJobs: terminalJobs.length,
      failedJobs: failedJobs.length,
      averageWaitMs: average(waitSamples),
      averageRunMs: average(runSamples),
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
  return {
    ...job,
    queuePosition: position >= 0 ? position + 1 : 0,
    lastLog: getLastLog(jobId),
    nextAction: getNextAction(job.status)
  };
}

export function cancelToolJob(jobId: string) {
  const qIdx = queue.findIndex(q => q.jobId === jobId);
  if (qIdx >= 0) {
    queue.splice(qIdx, 1);
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancelled before start.\n');
    updateJobStatus(jobId, { status: 'cancelled', failureSummary: 'Cancelled before start.' });
    return true;
  }
  
  const active = activeJobs.get(jobId);
  if (active) {
    if (active.cancelFn) {
      active.cancelFn();
    }
    appendJobLog(jobId, 'stderr', '\n[Job Cancelled] Cancellation requested.\n');
    updateJobStatus(jobId, { status: 'cancelled', failureSummary: 'Cancellation requested.' });
    return true;
  }
  
  return false;
}

export function enqueueToolJob(state: AppState, toolName: string, args: any, kind: JobKind) {
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

  const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const job = createJob(jobId, toolName, args, resourceKey);

  const entry: QueueEntry = {
    jobId,
    resourceKey,
    kind,
    state,
    toolName,
    args
  };

  queue.push(entry);
  
  // Try to process queue
  setImmediate(processQueue);

  return {
    jobId,
    status: job.status,
    queuePosition: queue.length,
    nextAction: 'Poll get_tool_job_status or get_tool_job_log; call cancel_tool_job to stop the job.'
  };
}

async function processQueue() {
  const blockedResources = new Set<string>();

  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    const { resourceKey, kind } = entry;
    
    if (blockedResources.has(resourceKey)) {
      continue;
    }
    
    const stats = getResourceStats(resourceKey);
    const limit = MAX_CONCURRENCY[kind] || 1;
    const currentKindCount = stats.kindCount[kind] || 0;
    
    let canStart = false;
    const isWriter = kind === 'repo-command' || kind === 'repo-write';
    
    if (isWriter) {
      if (stats.readers === 0 && stats.writers === 0) {
        canStart = true;
      }
    } else {
      if (stats.writers === 0 && currentKindCount < limit) {
        canStart = true;
      }
    }
    
    if (canStart) {
      queue.splice(i, 1);
      i--;
      startJob(entry);
    } else {
      blockedResources.add(resourceKey);
    }
  }
}

function setJobActiveContext(jobId: string, cancelFn: () => void) {
  const active = activeJobs.get(jobId);
  if (active) {
    active.cancelFn = cancelFn;
  }
}

async function startJob(entry: QueueEntry) {
  incrementResource(entry.resourceKey, entry.kind);
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
      result = await testRunner(entry.state, entry.args, logger, (cancelFn) => setJobActiveContext(entry.jobId, cancelFn));
    } else if (entry.toolName === 'run_project_command') {
      result = await runProjectCommandAsync(entry.state, entry.args, logger, (cancelFn) => setJobActiveContext(entry.jobId, cancelFn));
    } else if (entry.toolName === 'apply_patch') {
      result = await applyLocalPatchAsync(entry.state, entry.args, logger, (cancelFn) => setJobActiveContext(entry.jobId, cancelFn));
    } else if (entry.toolName === 'search_local_files') {
      result = await searchLocalFilesAsync(entry.state, entry.args, logger, (cancelFn) => setJobActiveContext(entry.jobId, cancelFn));
    } else if (entry.toolName === 'commit_git_changes') {
      result = commitGitChanges(entry.state, entry.args);
    } else if (entry.toolName === 'edit_local_files_batch') {
      result = editFilesBatch(entry.state, entry.args);
    } else {
      throw new Error(`No async runner implemented for tool: ${entry.toolName}`);
    }

    // Check if cancelled during execution
    const currentStatus = getJob(entry.jobId)?.status;
    if (currentStatus === 'cancelled' || currentStatus === 'timed_out') {
      // Don't overwrite cancelled/timed_out status
    } else if (isTimedOutResult(result)) {
      updateJobStatus(entry.jobId, { status: 'timed_out', failureSummary: 'Job timed out.' });
      writeJobResult(entry.jobId, result);
      logger.stderr(`\n[Job Timed Out]\n`);
    } else {
      updateJobStatus(entry.jobId, { status: 'succeeded' });
      writeJobResult(entry.jobId, result);
    }
  } catch (error: any) {
    const currentStatus = getJob(entry.jobId)?.status;
    if (currentStatus === 'cancelled') {
      // Ignore
    } else if (error.name === 'AbortError' || error.message.includes('ETIMEDOUT') || error.code === 'ETIMEDOUT') {
      updateJobStatus(entry.jobId, { status: 'timed_out', failureSummary: summarizeError(error) });
      logger.stderr(`\n[Job Timed Out]`);
    } else {
      updateJobStatus(entry.jobId, { status: 'failed', failureSummary: summarizeError(error) });
      logger.stderr(`\n[Job Failed] ${error.message}\n${error.stack || ''}`);
    }
  } finally {
    decrementResource(entry.resourceKey, entry.kind);
    activeJobs.delete(entry.jobId);
    
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
      kind: data.entry.kind
    })),
    activeResources: Object.fromEntries(activeResources.entries()),
    queuedJobs: queue.map(q => ({
      jobId: q.jobId,
      toolName: q.toolName,
      resourceKey: q.resourceKey,
      kind: q.kind
    })),
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
