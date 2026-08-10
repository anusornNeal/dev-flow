import type { AppState } from '../types';
import { describeProjectCommand, type ProjectCommandVerificationClass } from './projectCommandService';
import os from 'node:os';

export type JobKind = 'repo-command' | 'repo-write' | 'repo-read' | 'skill-read';
export type ResourceAccessMode = 'read' | 'verify' | 'write';
export type JobCostClass = 'light-read' | 'search' | 'verify' | 'write';
export type SchedulerBlockReason = 'active_write' | 'active_resource' | 'cost_pool_saturated' | 'writer_barrier' | 'capacity_saturated' | 'shared_resource_conflict';
export type SchedulerWaitType = 'workspace_lock' | 'capacity';

export interface SchedulerQueueEntry {
  jobId: string;
  resourceKey: string;
  kind: JobKind;
  toolName: string;
  args: any;
  accessMode: ResourceAccessMode;
  costClass: JobCostClass;
  enqueuedAt: number;
  schedulerPriority?: number;
  verificationClass?: ProjectCommandVerificationClass;
  sharedResources?: string[];
}

export interface SchedulerBlocker {
  blockedByJobId?: string;
  blockedByAccessMode?: ResourceAccessMode;
  blockReason: SchedulerBlockReason;
  waitType?: SchedulerWaitType;
}

interface ResourceStats {
  accessCount: Record<ResourceAccessMode, number>;
  costCount: Record<JobCostClass, number>;
}

export type SchedulerProfile = {
  accessMode: ResourceAccessMode;
  costClass: JobCostClass;
  verificationClass?: ProjectCommandVerificationClass;
  sharedResources?: string[];
};

const MAX_CONCURRENCY: Record<JobCostClass, number> = {
  'light-read': 8,
  search: 4,
  verify: 2,
  write: 1,
};


const PRIORITY_AGING_MS = 30_000;

const activeResources = new Map<string, ResourceStats>();
let globalVerifyCapacity = Math.max(1, Math.min(4, Number(process.env.DEVFLOW_MAX_VERIFY_PROCESSES) || Math.min(2, os.cpus().length || 1)));
let activeGlobalVerify = 0;
let activeFastVerify = 0;
let activeHeavyVerify = 0;

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

function scopeVerificationResources(args: any, resourceScope: string | undefined, resources: string[]) {
  const projectId = typeof args?.projectId === 'string' ? args.projectId.trim() : '';
  const scope = projectId ? `project:${projectId}` : (resourceScope || 'verification');
  return Array.from(new Set(resources.filter(Boolean).map((resource) => `${scope}:${resource}`)));
}

export function getSchedulerProfile(
  state: AppState,
  toolName: string,
  args: any,
  kind: JobKind,
  resourceScope?: string,
): SchedulerProfile {
  if (kind === 'repo-write') return { accessMode: 'write', costClass: 'write' };
  if (kind === 'skill-read') return { accessMode: 'read', costClass: 'light-read' };
  if (kind === 'repo-read') {
    return { accessMode: 'read', costClass: toolName === 'search_local_files' ? 'search' : 'light-read' };
  }
  if (toolName === 'run_project_command') {
    try {
      const descriptor = describeProjectCommand(state, args);
      if (descriptor.access === 'verify') {
        return {
          accessMode: 'verify',
          costClass: 'verify',
          verificationClass: descriptor.verificationClass,
          sharedResources: scopeVerificationResources(args, resourceScope, descriptor.sharedResources),
        };
      }
    } catch {
      // Invalid/unresolved commands stay conservatively exclusive until execution reports the error.
    }
  }
  return { accessMode: 'write', costClass: 'write' };
}

export function getSchedulerPriority(
  toolName: string,
  args: any,
  accessMode: ResourceAccessMode,
  verificationClass?: ProjectCommandVerificationClass,
) {
  if (Number.isFinite(Number(args?.schedulerPriority))) return Math.max(0, Math.min(9, Number(args.schedulerPriority)));
  if (accessMode !== 'verify') return 0;
  if (verificationClass === 'heavy') return 2;
  if (verificationClass === 'fast') return 1;
  const command = String(args?.command || '').toLowerCase();
  return command === 'test' || command === 'verify' || command === 'full' || args?.verificationMode === 'FULL' ? 2 : 1;
}

function verificationClassForEntry(entry: SchedulerQueueEntry): ProjectCommandVerificationClass {
  return entry.verificationClass === 'fast' ? 'fast' : 'heavy';
}

export function incrementScheduledResource(entry: SchedulerQueueEntry) {
  const stats = getResourceStats(entry.resourceKey);
  stats.accessCount[entry.accessMode] += 1;
  stats.costCount[entry.costClass] += 1;
  if (entry.costClass === 'verify') {
    activeGlobalVerify += 1;
    if (verificationClassForEntry(entry) === 'fast') activeFastVerify += 1;
    else activeHeavyVerify += 1;
  }
}

export function decrementScheduledResource(entry: SchedulerQueueEntry) {
  const stats = getResourceStats(entry.resourceKey);
  stats.accessCount[entry.accessMode] = Math.max(0, stats.accessCount[entry.accessMode] - 1);
  stats.costCount[entry.costClass] = Math.max(0, stats.costCount[entry.costClass] - 1);
  if (entry.costClass === 'verify') {
    activeGlobalVerify = Math.max(0, activeGlobalVerify - 1);
    if (verificationClassForEntry(entry) === 'fast') activeFastVerify = Math.max(0, activeFastVerify - 1);
    else activeHeavyVerify = Math.max(0, activeHeavyVerify - 1);
  }
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
  entry.verificationClass = entry.verificationClass || 'heavy';
  activeGlobalVerify += 1;
  if (verificationClassForEntry(entry) === 'fast') activeFastVerify += 1;
  else activeHeavyVerify += 1;
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

function sharedResourceCapacity(resource: string) {
  return resource.endsWith(':repo') ? 2 : 1;
}

function findSharedResourceConflict(entry: SchedulerQueueEntry, activeEntries: SchedulerQueueEntry[]) {
  if (entry.accessMode !== 'verify' || !entry.sharedResources?.length) return undefined;
  for (const resource of entry.sharedResources) {
    const sharing = activeEntries.filter((active) =>
      active.accessMode === 'verify'
      && active.sharedResources?.includes(resource),
    );
    if (sharing.length >= sharedResourceCapacity(resource)) return sharing[0];
  }
  return undefined;
}

export function getBlockerForQueueEntry(
  entry: SchedulerQueueEntry,
  queueIndex: number,
  queue: SchedulerQueueEntry[],
  activeEntries: SchedulerQueueEntry[],
  now = Date.now(),
): SchedulerBlocker | null {
  if (entry.accessMode !== 'write') {
    for (let index = 0; index < queueIndex; index += 1) {
      const earlier = queue[index];
      if (earlier.resourceKey === entry.resourceKey && earlier.accessMode === 'write') {
        return { blockedByJobId: earlier.jobId, blockedByAccessMode: 'write', blockReason: 'writer_barrier', waitType: 'workspace_lock' };
      }
    }
  }

  if (entry.accessMode === 'write') {
    const active = findActiveEntry(entry.resourceKey, activeEntries, () => true);
    if (active) {
      return { blockedByJobId: active.jobId, blockedByAccessMode: active.accessMode, blockReason: 'active_resource', waitType: 'workspace_lock' };
    }
    return null;
  }

  const activeWrite = findActiveEntry(entry.resourceKey, activeEntries, (active) => active.accessMode === 'write');
  if (activeWrite) {
    return { blockedByJobId: activeWrite.jobId, blockedByAccessMode: 'write', blockReason: 'active_write', waitType: 'workspace_lock' };
  }

  if (entry.costClass === 'verify') {
    if (activeGlobalVerify >= globalVerifyCapacity) {
      return { blockReason: 'capacity_saturated', waitType: 'capacity' };
    }
    const sharedConflict = findSharedResourceConflict(entry, activeEntries);
    if (sharedConflict) {
      return {
        blockedByJobId: sharedConflict.jobId,
        blockedByAccessMode: sharedConflict.accessMode,
        blockReason: 'shared_resource_conflict',
        waitType: 'capacity',
      };
    }
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

export function selectNextRunnableQueueIndex(
  queue: SchedulerQueueEntry[],
  activeEntries: SchedulerQueueEntry[],
  now = Date.now(),
) {
  const candidates = queue
    .map((entry, index) => ({
      index,
      entry,
      effectivePriority: Math.max(0, (entry.schedulerPriority ?? 0) - Math.floor(Math.max(0, now - entry.enqueuedAt) / PRIORITY_AGING_MS)),
    }))
    .filter(({ entry, index }) => !getBlockerForQueueEntry(entry, index, queue, activeEntries, now))
    .sort((left, right) => left.effectivePriority - right.effectivePriority || left.entry.enqueuedAt - right.entry.enqueuedAt || left.index - right.index);
  return candidates[0]?.index ?? -1;
}

export function getSchedulerCapacitySnapshot() {
  return {
    verify: {
      active: activeGlobalVerify,
      capacity: globalVerifyCapacity,
      fast: { active: activeFastVerify },
      heavy: { active: activeHeavyVerify, capacity: globalVerifyCapacity },
    },
  };
}

export function setGlobalVerifyCapacityForTests(value: number) {
  globalVerifyCapacity = Math.max(1, Math.floor(value));
}

export function buildQueueEntryDiagnostics(
  entry: SchedulerQueueEntry,
  queueIndex: number,
  queue: SchedulerQueueEntry[],
  activeEntries: SchedulerQueueEntry[],
  now = Date.now(),
) {
  const blocker = getBlockerForQueueEntry(entry, queueIndex, queue, activeEntries, now);
  return {
    jobId: entry.jobId,
    toolName: entry.toolName,
    kind: entry.kind,
    resourceKey: entry.resourceKey,
    accessMode: entry.accessMode,
    costClass: entry.costClass,
    ...(entry.verificationClass ? { verificationClass: entry.verificationClass } : {}),
    ...(entry.sharedResources?.length ? { sharedResources: entry.sharedResources } : {}),
    queueAgeMs: Math.max(0, now - entry.enqueuedAt),
    ...(blocker || {}),
  };
}

export function getActiveResourceSnapshot() {
  return Object.fromEntries(activeResources.entries());
}

export function resetSchedulerResourceStateForTests() {
  activeResources.clear();
  activeGlobalVerify = 0;
  activeFastVerify = 0;
  activeHeavyVerify = 0;
  globalVerifyCapacity = Math.max(1, Math.min(4, Number(process.env.DEVFLOW_MAX_VERIFY_PROCESSES) || Math.min(2, os.cpus().length || 1)));
}
