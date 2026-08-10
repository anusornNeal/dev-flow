import type { AppState } from '../types';
import { describeProjectCommandResourceProfile, type ProjectCommandVerificationClass } from './projectCommandService';
import os from 'node:os';
import { captureSystemResourceSnapshot, diffSystemResourceSnapshots, type SystemResourceSnapshot } from '../../lib/platformRuntime';

export type JobKind = 'repo-command' | 'repo-write' | 'repo-read' | 'skill-read';
export type ResourceAccessMode = 'read' | 'verify' | 'write';
export type JobCostClass = 'light-read' | 'search' | 'verify' | 'write';
export type SchedulerBlockReason = 'active_write' | 'active_resource' | 'cost_pool_saturated' | 'writer_barrier' | 'capacity_saturated' | 'shared_resource_conflict' | 'resource_budget_saturated' | 'live_pressure_saturated' | 'interference_risk';
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
  verificationDemand?: VerificationResourceDemand;
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
  verificationDemand?: VerificationResourceDemand;
};

export type VerificationResourceConfidence = 'none' | 'low' | 'medium' | 'high';

export type VerificationResourceDemand = {
  profileKey: string;
  confidence: VerificationResourceConfidence;
  sampleCount: number;
  cpuRatio: number;
  memoryBytes: number;
  durationMs: number;
  processCount: number;
};

export type VerificationMachinePressure = {
  cpuRatio: number;
  memoryPressureRatio: number;
  totalMemoryBytes: number;
};

export type VerificationResourceBudgetConfig = {
  targetCpuRatio: number;
  hardCpuRatio: number;
  targetMemoryPressure: number;
  hardMemoryPressure: number;
  maxAdaptiveProcesses: number;
};

export type VerificationProcessPermitRequest = {
  jobId: string;
  verificationClass?: ProjectCommandVerificationClass;
  sharedResources?: string[];
  resourceDemand?: VerificationResourceDemand;
};

export type VerificationProcessPermit = {
  id: string;
  jobId: string;
  verificationClass: ProjectCommandVerificationClass;
  sharedResources: string[];
  resourceDemand?: VerificationResourceDemand;
  peerProfileKeys: string[];
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
const DEFAULT_VERIFICATION_RESOURCE_BUDGET: VerificationResourceBudgetConfig = {
  targetCpuRatio: 0.75,
  hardCpuRatio: 0.9,
  targetMemoryPressure: 0.8,
  hardMemoryPressure: 0.9,
  maxAdaptiveProcesses: Math.max(2, Math.min(8, os.cpus().length || 1)),
};
const MAX_INTERFERENCE_PAIRS = 128;
const MAX_INTERFERENCE_SAMPLES_PER_PAIR = 8;
const MIN_INTERFERENCE_SAMPLES = 2;
const INTERFERENCE_SLOWDOWN_THRESHOLD = 1.35;
let verificationResourceBudget: VerificationResourceBudgetConfig = readVerificationResourceBudgetConfig();
let verificationMachinePressureOverride: VerificationMachinePressure | null | undefined;
let previousSystemResourceSnapshot: SystemResourceSnapshot | undefined;
let lastObservedMachinePressure: VerificationMachinePressure | null = null;
let lastVerificationAdmissionMode: 'adaptive' | 'fallback' = 'fallback';
const verificationInterferenceByPair = new Map<string, number[]>();

function clampRatio(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function readVerificationResourceBudgetConfig(): VerificationResourceBudgetConfig {
  const targetCpuRatio = clampRatio(process.env.DEVFLOW_VERIFY_TARGET_CPU_RATIO, DEFAULT_VERIFICATION_RESOURCE_BUDGET.targetCpuRatio);
  const targetMemoryPressure = clampRatio(process.env.DEVFLOW_VERIFY_TARGET_MEMORY_PRESSURE, DEFAULT_VERIFICATION_RESOURCE_BUDGET.targetMemoryPressure);
  return {
    targetCpuRatio,
    hardCpuRatio: Math.max(targetCpuRatio, clampRatio(process.env.DEVFLOW_VERIFY_HARD_CPU_RATIO, DEFAULT_VERIFICATION_RESOURCE_BUDGET.hardCpuRatio)),
    targetMemoryPressure,
    hardMemoryPressure: Math.max(targetMemoryPressure, clampRatio(process.env.DEVFLOW_VERIFY_HARD_MEMORY_PRESSURE, DEFAULT_VERIFICATION_RESOURCE_BUDGET.hardMemoryPressure)),
    maxAdaptiveProcesses: Math.max(1, Math.floor(Number(process.env.DEVFLOW_MAX_ADAPTIVE_VERIFY_PROCESSES) || DEFAULT_VERIFICATION_RESOURCE_BUDGET.maxAdaptiveProcesses)),
  };
}

function normalizeResourceDemand(value: VerificationResourceDemand | undefined): VerificationResourceDemand | undefined {
  if (!value || !String(value.profileKey || '').trim()) return undefined;
  const confidence: VerificationResourceConfidence = value.confidence === 'medium' || value.confidence === 'high'
    ? value.confidence
    : value.confidence === 'low'
      ? 'low'
      : 'none';
  return {
    profileKey: String(value.profileKey).trim(),
    confidence,
    sampleCount: Math.max(0, Math.floor(Number(value.sampleCount) || 0)),
    cpuRatio: clampRatio(value.cpuRatio, 1),
    memoryBytes: Math.max(0, Number(value.memoryBytes) || 0),
    durationMs: Math.max(1, Number(value.durationMs) || 1),
    processCount: Math.max(1, Math.floor(Number(value.processCount) || 1)),
  };
}

function hasConfidentDemand(demand: VerificationResourceDemand | undefined) {
  return demand?.confidence === 'medium' || demand?.confidence === 'high';
}

function interferencePairKey(left: string, right: string) {
  return [left, right].sort().join('::');
}

function recordVerificationInterferenceSample(left: string, right: string, slowdownRatio: number) {
  const leftKey = String(left || '').trim();
  const rightKey = String(right || '').trim();
  const slowdown = Number(slowdownRatio);
  if (!leftKey || !rightKey || leftKey === rightKey || !Number.isFinite(slowdown) || slowdown <= 0) return false;
  const key = interferencePairKey(leftKey, rightKey);
  const samples = verificationInterferenceByPair.get(key) || [];
  samples.push(Math.max(0.25, Math.min(4, slowdown)));
  if (samples.length > MAX_INTERFERENCE_SAMPLES_PER_PAIR) samples.splice(0, samples.length - MAX_INTERFERENCE_SAMPLES_PER_PAIR);
  verificationInterferenceByPair.delete(key);
  verificationInterferenceByPair.set(key, samples);
  while (verificationInterferenceByPair.size > MAX_INTERFERENCE_PAIRS) {
    const oldest = verificationInterferenceByPair.keys().next().value as string | undefined;
    if (!oldest) break;
    verificationInterferenceByPair.delete(oldest);
  }
  return true;
}

function interferenceRiskFor(request: VerificationProcessPermitRequest) {
  const demand = normalizeResourceDemand(request.resourceDemand);
  if (!demand) return undefined;
  for (const permit of activeVerificationPermits.values()) {
    const peer = permit.resourceDemand;
    if (!peer) continue;
    const key = interferencePairKey(demand.profileKey, peer.profileKey);
    const samples = verificationInterferenceByPair.get(key) || [];
    if (samples.length < MIN_INTERFERENCE_SAMPLES) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    if (median >= INTERFERENCE_SLOWDOWN_THRESHOLD) return permit;
  }
  return undefined;
}

function readVerificationMachinePressure(): VerificationMachinePressure | null {
  if (verificationMachinePressureOverride !== undefined) {
    lastObservedMachinePressure = verificationMachinePressureOverride;
    return verificationMachinePressureOverride;
  }
  const current = captureSystemResourceSnapshot();
  const previous = previousSystemResourceSnapshot;
  previousSystemResourceSnapshot = current;
  if (!previous || current.totalMemoryBytes <= 0 || current.capturedAt <= previous.capturedAt) {
    lastObservedMachinePressure = null;
    return null;
  }
  const delta = diffSystemResourceSnapshots(previous, current);
  const pressure: VerificationMachinePressure = {
    cpuRatio: delta.cpuUtilization,
    memoryPressureRatio: current.totalMemoryBytes > 0 ? Math.max(0, Math.min(1, 1 - current.freeMemoryBytes / current.totalMemoryBytes)) : 0,
    totalMemoryBytes: current.totalMemoryBytes,
  };
  lastObservedMachinePressure = pressure;
  return pressure;
}

function activeWeightedDemand() {
  let activeCpuRatio = 0;
  let activeMemoryBytes = 0;
  let activeProcessCount = 0;
  let confidentPermits = 0;
  for (const permit of activeVerificationPermits.values()) {
    const demand = permit.resourceDemand;
    if (!demand) continue;
    activeCpuRatio += demand.cpuRatio;
    activeMemoryBytes += demand.memoryBytes;
    activeProcessCount += demand.processCount;
    if (hasConfidentDemand(demand)) confidentPermits += 1;
  }
  return { activeCpuRatio, activeMemoryBytes, activeProcessCount, confidentPermits };
}

function hasAdaptiveAdmissionEvidence(request: VerificationProcessPermitRequest) {
  const demand = normalizeResourceDemand(request.resourceDemand);
  if (!hasConfidentDemand(demand)) return false;
  for (const permit of activeVerificationPermits.values()) {
    if (!hasConfidentDemand(permit.resourceDemand)) return false;
  }
  return true;
}

function canUseAdaptiveAdmission(request: VerificationProcessPermitRequest, pressure: VerificationMachinePressure | null) {
  return hasAdaptiveAdmissionEvidence(request) && Boolean(pressure && pressure.totalMemoryBytes > 0);
}

function verificationResourceBudgetBlocker(request: VerificationProcessPermitRequest, pressure: VerificationMachinePressure): SchedulerBlocker | null {
  const demand = normalizeResourceDemand(request.resourceDemand)!;
  const active = activeWeightedDemand();
  if (activeGlobalVerify >= verificationResourceBudget.maxAdaptiveProcesses) {
    return { blockReason: 'resource_budget_saturated', waitType: 'capacity' };
  }
  if (pressure.cpuRatio >= verificationResourceBudget.targetCpuRatio || pressure.memoryPressureRatio >= verificationResourceBudget.targetMemoryPressure) {
    return { blockReason: 'live_pressure_saturated', waitType: 'capacity' };
  }
  const projectedCpu = active.activeCpuRatio + demand.cpuRatio;
  if (activeGlobalVerify > 0 && (projectedCpu > verificationResourceBudget.targetCpuRatio || projectedCpu > verificationResourceBudget.hardCpuRatio)) {
    return { blockReason: 'resource_budget_saturated', waitType: 'capacity' };
  }
  const baselineMemoryPressure = Math.max(0, pressure.memoryPressureRatio - active.activeMemoryBytes / pressure.totalMemoryBytes);
  const projectedMemoryPressure = baselineMemoryPressure + (active.activeMemoryBytes + demand.memoryBytes) / pressure.totalMemoryBytes;
  if (projectedMemoryPressure > verificationResourceBudget.hardMemoryPressure || (activeGlobalVerify > 0 && projectedMemoryPressure > verificationResourceBudget.targetMemoryPressure)) {
    return { blockReason: 'resource_budget_saturated', waitType: 'capacity' };
  }
  return null;
}

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

function verificationDemandFromPrediction(prediction: ReturnType<typeof describeProjectCommandResourceProfile>['prediction']): VerificationResourceDemand {
  const admissionVector = prediction.confidence === 'high' ? prediction.expected : prediction.upperBound;
  return {
    profileKey: prediction.profileKey,
    confidence: prediction.confidence,
    sampleCount: prediction.sampleCount,
    cpuRatio: admissionVector.cpuRatio,
    memoryBytes: admissionVector.memoryBytes,
    durationMs: prediction.expected.durationMs,
    processCount: admissionVector.processCount,
  };
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
      const profile = describeProjectCommandResourceProfile(state, args);
      const descriptor = profile.descriptor;
      if (descriptor.access === 'verify') {
        return {
          accessMode: 'verify',
          costClass: 'verify',
          verificationClass: descriptor.verificationClass,
          sharedResources: scopeVerificationResources(args, resourceScope, descriptor.sharedResources),
          verificationDemand: verificationDemandFromPrediction(profile.prediction),
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
  const interferencePermit = interferenceRiskFor(request);
  if (interferencePermit) {
    return { blockedByJobId: interferencePermit.jobId, blockedByAccessMode: 'verify', blockReason: 'interference_risk', waitType: 'capacity' };
  }
  if (hasAdaptiveAdmissionEvidence(request)) {
    const pressure = readVerificationMachinePressure();
    if (canUseAdaptiveAdmission(request, pressure)) {
      lastVerificationAdmissionMode = 'adaptive';
      return verificationResourceBudgetBlocker(request, pressure!);
    }
  }
  lastVerificationAdmissionMode = 'fallback';
  if (activeGlobalVerify >= globalVerifyCapacity) {
    return { blockReason: 'capacity_saturated', waitType: 'capacity' };
  }
  return null;
}

export function tryAcquireVerificationProcessPermit(request: VerificationProcessPermitRequest) {
  const normalizedRequest: VerificationProcessPermitRequest = {
    ...request,
    sharedResources: normalizedSharedResources(request.sharedResources),
    resourceDemand: normalizeResourceDemand(request.resourceDemand),
  };
  const blocker = getVerificationProcessPermitBlocker(normalizedRequest);
  if (blocker) return { permit: null as VerificationProcessPermit | null, blocker };

  const permit: VerificationProcessPermit = {
    id: `verify-permit-${++verificationPermitSequence}`,
    jobId: request.jobId,
    verificationClass: verificationClassForRequest(request),
    sharedResources: normalizedRequest.sharedResources || [],
    resourceDemand: normalizedRequest.resourceDemand,
    peerProfileKeys: Array.from(activeVerificationPermits.values()).map((active) => active.resourceDemand?.profileKey).filter((key): key is string => Boolean(key)),
  };
  activeVerificationPermits.set(permit.id, permit);
  activeGlobalVerify += 1;
  if (permit.verificationClass === 'fast') activeFastVerify += 1;
  else activeHeavyVerify += 1;
  updateSharedResourceUsage(permit.sharedResources, 1);
  return { permit, blocker: null as SchedulerBlocker | null };
}

export function releaseVerificationProcessPermit(permit: VerificationProcessPermit, observation?: { actualDurationMs?: number }) {
  const active = activeVerificationPermits.get(permit.id);
  if (!active) return false;
  if (active.resourceDemand && Number.isFinite(Number(observation?.actualDurationMs)) && Number(observation?.actualDurationMs) > 0) {
    const slowdown = Number(observation!.actualDurationMs) / Math.max(1, active.resourceDemand.durationMs);
    for (const peerProfileKey of active.peerProfileKeys) recordVerificationInterferenceSample(active.resourceDemand.profileKey, peerProfileKey, slowdown);
  }
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
      resourceDemand: entry.verificationDemand,
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

export function decrementScheduledResource(entry: SchedulerQueueEntry, observation?: { actualDurationMs?: number }) {
  const stats = getResourceStats(entry.resourceKey);
  stats.accessCount[entry.accessMode] = Math.max(0, stats.accessCount[entry.accessMode] - 1);
  stats.costCount[entry.costClass] = Math.max(0, stats.costCount[entry.costClass] - 1);
  if (entry.verificationPermitId) {
    const permit = activeVerificationPermits.get(entry.verificationPermitId);
    if (permit) releaseVerificationProcessPermit(permit, observation);
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
  entry.verificationDemand = activePermit.resourceDemand;
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
      resourceDemand: entry.verificationDemand,
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
  const weighted = activeWeightedDemand();
  let riskyPairs = 0;
  for (const samples of verificationInterferenceByPair.values()) {
    if (samples.length < MIN_INTERFERENCE_SAMPLES) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    if (median >= INTERFERENCE_SLOWDOWN_THRESHOLD) riskyPairs += 1;
  }
  return {
    verify: {
      active: activeGlobalVerify,
      capacity: globalVerifyCapacity,
      fast: { active: activeFastVerify },
      heavy: { active: activeHeavyVerify, capacity: globalVerifyCapacity },
      mode: lastVerificationAdmissionMode,
      weighted: {
        ...weighted,
        targetCpuRatio: verificationResourceBudget.targetCpuRatio,
        hardCpuRatio: verificationResourceBudget.hardCpuRatio,
        targetMemoryPressure: verificationResourceBudget.targetMemoryPressure,
        hardMemoryPressure: verificationResourceBudget.hardMemoryPressure,
        maxAdaptiveProcesses: verificationResourceBudget.maxAdaptiveProcesses,
      },
      livePressure: lastObservedMachinePressure,
      interference: { pairs: verificationInterferenceByPair.size, riskyPairs },
    },
  };
}

export function setGlobalVerifyCapacityForTests(value: number) {
  globalVerifyCapacity = Math.max(1, Math.floor(value));
}

export function setVerificationResourceBudgetForTests(overrides: Partial<VerificationResourceBudgetConfig>) {
  const next = { ...verificationResourceBudget, ...overrides };
  const targetCpuRatio = clampRatio(next.targetCpuRatio, DEFAULT_VERIFICATION_RESOURCE_BUDGET.targetCpuRatio);
  const targetMemoryPressure = clampRatio(next.targetMemoryPressure, DEFAULT_VERIFICATION_RESOURCE_BUDGET.targetMemoryPressure);
  verificationResourceBudget = {
    targetCpuRatio,
    hardCpuRatio: Math.max(targetCpuRatio, clampRatio(next.hardCpuRatio, DEFAULT_VERIFICATION_RESOURCE_BUDGET.hardCpuRatio)),
    targetMemoryPressure,
    hardMemoryPressure: Math.max(targetMemoryPressure, clampRatio(next.hardMemoryPressure, DEFAULT_VERIFICATION_RESOURCE_BUDGET.hardMemoryPressure)),
    maxAdaptiveProcesses: Math.max(1, Math.floor(Number(next.maxAdaptiveProcesses) || DEFAULT_VERIFICATION_RESOURCE_BUDGET.maxAdaptiveProcesses)),
  };
}

export function recordVerificationInterferenceSampleForTests(left: string, right: string, slowdownRatio: number) {
  return recordVerificationInterferenceSample(left, right, slowdownRatio);
}

export function setVerificationMachinePressureForTests(pressure: VerificationMachinePressure | null) {
  verificationMachinePressureOverride = pressure;
  lastObservedMachinePressure = pressure;
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
    ...(entry.verificationDemand ? { verificationDemand: entry.verificationDemand } : {}),
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
  verificationInterferenceByPair.clear();
  verificationResourceBudget = readVerificationResourceBudgetConfig();
  verificationMachinePressureOverride = undefined;
  previousSystemResourceSnapshot = undefined;
  lastObservedMachinePressure = null;
  lastVerificationAdmissionMode = 'fallback';
  globalVerifyCapacity = Math.max(1, Math.min(4, Number(process.env.DEVFLOW_MAX_VERIFY_PROCESSES) || Math.min(2, os.cpus().length || 1)));
}
