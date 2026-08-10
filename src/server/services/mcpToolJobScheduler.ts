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
  verificationPermitId?: string;
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

export type VerificationProcessPermitRequest = {
  jobId: string;
  verificationClass?: ProjectCommandVerificationClass;
  sharedResources?: string[];
};

export type VerificationProcessPermit = {
  id: string;
  jobId: string;
  verificationClass: ProjectCommandVerificationClass;
  sharedResources: string[];
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
let verificationPermitSequence = 0;
const activeVerificationPermits = new Map<string, VerificationProcessPermit>();
const activeSharedVerificationResources = new Map<string, number>();

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

export function scopeVerificationResources(args: any, resourceScope: string | undefined, resources: string[]) {
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

function verificationClassForRequest(request: VerificationProcessPermitRequest): ProjectCommandVerificationClass {
  return request.verificationClass === 'fast' ? 'fast' : 'heavy';
}

function normalizedSharedResources(resources: string[] | undefined) {
  return Array.from(new Set((resources || []).map((resource) => String(resource || '').trim()).filter(Boolean)));
}

function updateSharedResourceUsage(resources: string[], delta: 1 | -1) {
  for (const resource of resources) {
    const next = Math.max(0, (activeSharedVerificationResources.get(resource) || 0) + delta);
    if (next === 0) activeSharedVerificationResources.delete(resource);
    else activeSharedVerificationResources.set(resource, next);
  }
}

export function getVerificationProcessPermitBlocker(request: VerificationProcessPermitRequest): SchedulerBlocker | null {
  if (activeGlobalVerify >= globalVerifyCapacity) {
    return { blockReason: 'capacity_saturated', waitType: 'capacity' };
  }
  const resources = normalizedSharedResources(request.sharedResources);
  for (const resource of resources) {
    if ((activeSharedVerificationResources.get(resource) || 0) >= sharedResourceCapacity(resource)) {
      const blockingPermit = Array.from(activeVerificationPermits.values()).find((permit) => permit.sharedResources.includes(resource));
      return {
        blockedByJobId: blockingPermit?.jobId,
        blockedByAccessMode: 'verify',
        blockReason: 'shared_resource_conflict',
        waitType: 'capacity',
      };
    }
  }
  return null;
}

export function tryAcquireVerificationProcessPermit(request: VerificationProcessPermitRequest) {
  const normalizedRequest: VerificationProcessPermitRequest = {
    ...request,
    sharedResources: normalizedSharedResources(request.sharedResources),
  };
  const blocker = getVerificationProcessPermitBlocker(normalizedRequest);
  if (blocker) return { permit: null as VerificationProcessPermit | null, blocker };

  const permit: VerificationProcessPermit = {
    id: `verify-permit-${++verificationPermitSequence}`,
    jobId: request.jobId,
    verificationClass: verificationClassForRequest(request),
    sharedResources: normalizedRequest.sharedResources || [],
  };
  activeVerificationPermits.set(permit.id, permit);
  activeGlobalVerify += 1;
  if (permit.verificationClass === 'fast') activeFastVerify += 1;
  else activeHeavyVerify += 1;
  updateSharedResourceUsage(permit.sharedResources, 1);
  return { permit, blocker: null as SchedulerBlocker | null };
}

export function releaseVerificationProcessPermit(permit: VerificationProcessPermit) {
  const active = activeVerificationPermits.get(permit.id);
  if (!active) return false;
  activeVerificationPermits.delete(permit.id);
  activeGlobalVerify = Math.max(0, activeGlobalVerify - 1);
  if (active.verificationClass === 'fast') activeFastVerify = Math.max(0, activeFastVerify - 1);
  else activeHeavyVerify = Math.max(0, activeHeavyVerify - 1);
  updateSharedResourceUsage(active.sharedResources, -1);
  return true;
}

export function incrementScheduledResource(entry: SchedulerQueueEntry) {
  const stats = getResourceStats(entry.resourceKey);
  stats.accessCount[entry.accessMode] += 1;
  stats.costCount[entry.costClass] += 1;
  if (entry.costClass === 'verify') {
    const reservation = tryAcquireVerificationProcessPermit({
      jobId: entry.jobId,
      verificationClass: verificationClassForEntry(entry),
      sharedResources: entry.sharedResources,
    });
    if (!reservation.permit) {
      stats.accessCount[entry.accessMode] = Math.max(0, stats.accessCount[entry.accessMode] - 1);
      stats.costCount[entry.costClass] = Math.max(0, stats.costCount[entry.costClass] - 1);
      const activeCount = stats.accessCount.read + stats.accessCount.verify + stats.accessCount.write;
      if (activeCount === 0) activeResources.delete(entry.resourceKey);
      throw new Error(`Scheduler admitted verification without an available process permit for ${entry.jobId}.`);
    }
    entry.verificationPermitId = reservation.permit.id;
  }
}

export function decrementScheduledResource(entry: SchedulerQueueEntry) {
  const stats = getResourceStats(entry.resourceKey);
  stats.accessCount[entry.accessMode] = Math.max(0, stats.accessCount[entry.accessMode] - 1);
  stats.costCount[entry.costClass] = Math.max(0, stats.costCount[entry.costClass] - 1);
  if (entry.verificationPermitId) {
    const permit = activeVerificationPermits.get(entry.verificationPermitId);
    if (permit) releaseVerificationProcessPermit(permit);
    entry.verificationPermitId = undefined;
  }
  const activeCount = stats.accessCount.read + stats.accessCount.verify + stats.accessCount.write;
  if (activeCount === 0) activeResources.delete(entry.resourceKey);
}

export function transitionScheduledResource(
  entry: SchedulerQueueEntry,
  nextAccessMode: ResourceAccessMode,
  verificationPermit?: VerificationProcessPermit,
) {
  if (entry.accessMode === nextAccessMode) return false;
  if (entry.accessMode !== 'write' || nextAccessMode !== 'verify') {
    throw new Error(`Unsafe scheduler access transition ${entry.accessMode} -> ${nextAccessMode} for ${entry.jobId}.`);
  }
  const activePermit = verificationPermit ? activeVerificationPermits.get(verificationPermit.id) : undefined;
  if (!activePermit || activePermit.jobId !== entry.jobId) {
    throw new Error(`A reserved verification process permit is required before write -> verify transition for ${entry.jobId}.`);
  }
  const stats = getResourceStats(entry.resourceKey);
  stats.accessCount.write = Math.max(0, stats.accessCount.write - 1);
  stats.costCount.write = Math.max(0, stats.costCount.write - 1);
  entry.verificationClass = activePermit.verificationClass;
  entry.sharedResources = [...activePermit.sharedResources];
  entry.verificationPermitId = activePermit.id;
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
    const processBlocker = getVerificationProcessPermitBlocker({
      jobId: entry.jobId,
      verificationClass: verificationClassForEntry(entry),
      sharedResources: entry.sharedResources,
    });
    if (processBlocker) return processBlocker;
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
  verificationPermitSequence = 0;
  activeVerificationPermits.clear();
  activeSharedVerificationResources.clear();
  globalVerifyCapacity = Math.max(1, Math.min(4, Number(process.env.DEVFLOW_MAX_VERIFY_PROCESSES) || Math.min(2, os.cpus().length || 1)));
}
