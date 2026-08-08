import type { AppState } from '../types';
import { describeProjectCommand } from './projectCommandService';

export type JobKind = 'repo-command' | 'repo-write' | 'repo-read' | 'skill-read';
export type ResourceAccessMode = 'read' | 'verify' | 'write';
export type JobCostClass = 'light-read' | 'search' | 'verify' | 'write';
export type SchedulerBlockReason = 'active_write' | 'active_resource' | 'cost_pool_saturated' | 'writer_barrier';

export interface SchedulerQueueEntry {
  jobId: string;
  resourceKey: string;
  kind: JobKind;
  toolName: string;
  args: any;
  accessMode: ResourceAccessMode;
  costClass: JobCostClass;
  enqueuedAt: number;
}

export interface SchedulerBlocker {
  blockedByJobId?: string;
  blockedByAccessMode?: ResourceAccessMode;
  blockReason: SchedulerBlockReason;
}

interface ResourceStats {
  accessCount: Record<ResourceAccessMode, number>;
  costCount: Record<JobCostClass, number>;
}

const MAX_CONCURRENCY: Record<JobCostClass, number> = {
  'light-read': 8,
  search: 4,
  verify: 2,
  write: 1,
};

const activeResources = new Map<string, ResourceStats>();

function getResourceStats(resourceKey: string): ResourceStats {
  let stats = activeResources.get(resourceKey);
  if (!stats) {
    stats = {
      accessCount: { read: 0, verify: 0, write: 0 },
      costCount: { 'light-read': 0, search: 0, verify: 0, write: 0 },
    };
    activeResources.set(resourceKey, stats);
  }
  return stats;
}

export function getSchedulerProfile(
  state: AppState,
  toolName: string,
  args: any,
  kind: JobKind,
): { accessMode: ResourceAccessMode; costClass: JobCostClass } {
  if (kind === 'repo-write') return { accessMode: 'write', costClass: 'write' };
  if (kind === 'skill-read') return { accessMode: 'read', costClass: 'light-read' };
  if (kind === 'repo-read') {
    return { accessMode: 'read', costClass: toolName === 'search_local_files' ? 'search' : 'light-read' };
  }
  if (toolName === 'run_project_command') {
    try {
      const descriptor = describeProjectCommand(state, args);
      if (descriptor.access === 'verify') return { accessMode: 'verify', costClass: 'verify' };
    } catch {
      // Invalid/unresolved commands stay conservatively exclusive until execution reports the error.
    }
  }
  return { accessMode: 'write', costClass: 'write' };
}

export function incrementScheduledResource(entry: SchedulerQueueEntry) {
  const stats = getResourceStats(entry.resourceKey);
  stats.accessCount[entry.accessMode] += 1;
  stats.costCount[entry.costClass] += 1;
}

export function decrementScheduledResource(entry: SchedulerQueueEntry) {
  const stats = getResourceStats(entry.resourceKey);
  stats.accessCount[entry.accessMode] = Math.max(0, stats.accessCount[entry.accessMode] - 1);
  stats.costCount[entry.costClass] = Math.max(0, stats.costCount[entry.costClass] - 1);
  const activeCount = stats.accessCount.read + stats.accessCount.verify + stats.accessCount.write;
  if (activeCount === 0) activeResources.delete(entry.resourceKey);
}

export function transitionScheduledResource(entry: SchedulerQueueEntry, nextAccessMode: ResourceAccessMode) {
  if (entry.accessMode === nextAccessMode) return false;
  if (entry.accessMode !== 'write' || nextAccessMode !== 'verify') {
    throw new Error(`Unsafe scheduler access transition ${entry.accessMode} -> ${nextAccessMode} for ${entry.jobId}.`);
  }
  const stats = getResourceStats(entry.resourceKey);
  stats.accessCount.write = Math.max(0, stats.accessCount.write - 1);
  stats.costCount.write = Math.max(0, stats.costCount.write - 1);
  entry.accessMode = 'verify';
  entry.costClass = 'verify';
  stats.accessCount.verify += 1;
  stats.costCount.verify += 1;
  return true;
}

function findActiveEntry(
  resourceKey: string,
  activeEntries: SchedulerQueueEntry[],
  predicate: (entry: SchedulerQueueEntry) => boolean,
) {
  return activeEntries.find((entry) => entry.resourceKey === resourceKey && predicate(entry));
}

export function getBlockerForQueueEntry(
  entry: SchedulerQueueEntry,
  queueIndex: number,
  queue: SchedulerQueueEntry[],
  activeEntries: SchedulerQueueEntry[],
): SchedulerBlocker | null {
  if (entry.accessMode !== 'write') {
    for (let index = 0; index < queueIndex; index += 1) {
      const earlier = queue[index];
      if (earlier.resourceKey === entry.resourceKey && earlier.accessMode === 'write') {
        return { blockedByJobId: earlier.jobId, blockedByAccessMode: 'write', blockReason: 'writer_barrier' };
      }
    }
  }

  if (entry.accessMode === 'write') {
    const active = findActiveEntry(entry.resourceKey, activeEntries, () => true);
    if (active) {
      return { blockedByJobId: active.jobId, blockedByAccessMode: active.accessMode, blockReason: 'active_resource' };
    }
    return null;
  }

  const activeWrite = findActiveEntry(entry.resourceKey, activeEntries, (active) => active.accessMode === 'write');
  if (activeWrite) {
    return { blockedByJobId: activeWrite.jobId, blockedByAccessMode: 'write', blockReason: 'active_write' };
  }

  const stats = activeResources.get(entry.resourceKey);
  const costCount = stats?.costCount[entry.costClass] || 0;
  if (costCount >= MAX_CONCURRENCY[entry.costClass]) {
    const activeSameCost = findActiveEntry(entry.resourceKey, activeEntries, (active) => active.costClass === entry.costClass);
    return {
      blockedByJobId: activeSameCost?.jobId,
      blockedByAccessMode: activeSameCost?.accessMode,
      blockReason: 'cost_pool_saturated',
    };
  }
  return null;
}

export function buildQueueEntryDiagnostics(
  entry: SchedulerQueueEntry,
  queueIndex: number,
  queue: SchedulerQueueEntry[],
  activeEntries: SchedulerQueueEntry[],
  now = Date.now(),
) {
  const blocker = getBlockerForQueueEntry(entry, queueIndex, queue, activeEntries);
  return {
    jobId: entry.jobId,
    toolName: entry.toolName,
    kind: entry.kind,
    resourceKey: entry.resourceKey,
    accessMode: entry.accessMode,
    costClass: entry.costClass,
    queueAgeMs: Math.max(0, now - entry.enqueuedAt),
    ...(blocker || {}),
  };
}

export function getActiveResourceSnapshot() {
  return Object.fromEntries(activeResources.entries());
}

export function resetSchedulerResourceStateForTests() {
  activeResources.clear();
}
