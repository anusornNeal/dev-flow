import { randomUUID } from 'crypto';
import type { AppState } from '../types';
import { createJob, updateJobStatus, appendJobLog, writeJobResult, getJob, listInterruptedJobs, startBackgroundJobCleanup, type JobStatus } from '../repositories/mcpToolJobRepository';
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

export function getQueueMetrics() {
  const activeJobsList = Array.from(activeJobs.values()).map(a => ({
    jobId: a.entry.jobId,
    kind: a.entry.kind,
    resourceKey: a.entry.resourceKey,
    toolName: a.entry.toolName
  }));
  
  return {
    queueLength: queue.length,
    activeJobs: activeJobs.size,
    queue: queue.map(q => ({ jobId: q.jobId, kind: q.kind, resourceKey: q.resourceKey })),
    active: activeJobsList,
    resources: Object.fromEntries(Array.from(activeResources.entries()))
  };
}

export function initMcpToolJobs() {
  const interrupted = listInterruptedJobs();
  if (interrupted.length > 0) {
    console.log(`[mcp-tool-job] Marked ${interrupted.length} stale jobs as interrupted on startup.`);
  }
  startBackgroundJobCleanup();
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

  return { jobId, status: job.status, queuePosition: queue.length };
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
    decrementResource(entry.resourceKey, entry.kind);
    activeJobs.delete(entry.jobId);
    
    // Process queue to see if anything else can start
    setImmediate(processQueue);
  }
}
