import { randomUUID } from 'crypto';
import type { AppState } from '../types';
import { createJob, updateJobStatus, appendJobLog, writeJobResult, getJob, listInterruptedJobs, listRecentJobs, type JobStatus } from '../repositories/mcpToolJobRepository';
import { resolveProjectRoot } from './localFileService';

// Import async runners (we will define these later in their respective files)
import { runProjectCommandAsync } from './projectCommandService';
import { applyLocalPatchAsync } from './localPatchService';
import { searchLocalFilesAsync } from './localFileService';

type JobKind = 'repo-command' | 'repo-write' | 'repo-read' | 'skill-read';

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
const activeResources = new Map<string, number>();

function getResourceCount(resourceKey: string): number {
  return activeResources.get(resourceKey) || 0;
}

function incrementResource(resourceKey: string) {
  activeResources.set(resourceKey, getResourceCount(resourceKey) + 1);
}

function decrementResource(resourceKey: string) {
  const count = getResourceCount(resourceKey);
  if (count <= 1) {
    activeResources.delete(resourceKey);
  } else {
    activeResources.set(resourceKey, count - 1);
  }
}

export function initMcpToolJobs() {
  const interrupted = listInterruptedJobs();
  if (interrupted.length > 0) {
    console.log(`[mcp-tool-job] Marked ${interrupted.length} stale jobs as interrupted on startup.`);
  }
}

export function getToolJobStatus(jobId: string) {
  const job = getJob(jobId);
  if (!job) return null;
  const position = queue.findIndex(q => q.jobId === jobId);
  return {
    ...job,
    queuePosition: position >= 0 ? position + 1 : 0
  };
}

export function cancelToolJob(jobId: string) {
  const qIdx = queue.findIndex(q => q.jobId === jobId);
  if (qIdx >= 0) {
    queue.splice(qIdx, 1);
    updateJobStatus(jobId, { status: 'cancelled' });
    return true;
  }
  
  const active = activeJobs.get(jobId);
  if (active) {
    if (active.cancelFn) {
      active.cancelFn();
    }
    updateJobStatus(jobId, { status: 'cancelled' });
    return true;
  }
  
  return false;
}

export function enqueueToolJob(state: AppState, toolName: string, args: any, kind: JobKind) {
  let resourceKey = 'global';
  if (kind !== 'skill-read') {
    try {
      const root = resolveProjectRoot(state, args);
      resourceKey = `repo:${root}:${kind}`;
    } catch {
      resourceKey = `repo:unknown:${kind}`;
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

  return { jobId, status: job.status, queuePosition: queue.length };
}

async function processQueue() {
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    const currentCount = getResourceCount(entry.resourceKey);
    const limit = MAX_CONCURRENCY[entry.kind] || 1;
    
    if (currentCount < limit) {
      queue.splice(i, 1);
      i--; // adjust index since we removed an item
      
      startJob(entry);
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
  incrementResource(entry.resourceKey);
  activeJobs.set(entry.jobId, { entry });
  updateJobStatus(entry.jobId, { status: 'running' });

  const logger = {
    stdout: (data: string) => appendJobLog(entry.jobId, 'stdout', data),
    stderr: (data: string) => appendJobLog(entry.jobId, 'stderr', data),
  };

  try {
    let result: any;
    
    if (entry.toolName === 'run_project_command') {
      result = await runProjectCommandAsync(entry.state, entry.args, logger, (cancelFn) => setJobActiveContext(entry.jobId, cancelFn));
    } else if (entry.toolName === 'apply_patch') {
      result = await applyLocalPatchAsync(entry.state, entry.args, logger, (cancelFn) => setJobActiveContext(entry.jobId, cancelFn));
    } else if (entry.toolName === 'search_local_files') {
      result = await searchLocalFilesAsync(entry.state, entry.args, logger, (cancelFn) => setJobActiveContext(entry.jobId, cancelFn));
    } else {
      throw new Error(`No async runner implemented for tool: ${entry.toolName}`);
    }

    // Check if cancelled during execution
    const currentStatus = getJob(entry.jobId)?.status;
    if (currentStatus === 'cancelled' || currentStatus === 'timed_out') {
      // Don't overwrite cancelled/timed_out status
    } else {
      updateJobStatus(entry.jobId, { status: 'succeeded' });
      writeJobResult(entry.jobId, result);
    }
  } catch (error: any) {
    const currentStatus = getJob(entry.jobId)?.status;
    if (currentStatus === 'cancelled') {
      // Ignore
    } else if (error.name === 'AbortError' || error.message.includes('ETIMEDOUT') || error.code === 'ETIMEDOUT') {
      updateJobStatus(entry.jobId, { status: 'timed_out' });
      logger.stderr(`\n[Job Timed Out]`);
    } else {
      updateJobStatus(entry.jobId, { status: 'failed' });
      logger.stderr(`\n[Job Failed] ${error.message}\n${error.stack || ''}`);
    }
  } finally {
    decrementResource(entry.resourceKey);
    activeJobs.delete(entry.jobId);
    
    // Process queue to see if anything else can start
    setImmediate(processQueue);
  }
}

export function getJobMetrics() {
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
    recentJobs: listRecentJobs(50)
  };
}
