import fs from 'node:fs';
import path from 'node:path';
import { getDevFlowRuntimeDir } from '../../lib/devFlowPaths';
import {
  captureProcessIdentity,
  terminateProcessTree,
  type ProcessIdentityProbe,
  type ProcessTreeTerminationResult,
  type SupportedPlatform,
} from '../../lib/platformRuntime';

export type ResidualVerificationTrigger = 'timeout' | 'cancel';
export type ResidualVerificationState = 'quarantined' | 'identity-unconfirmed' | 'termination-unconfirmed' | 'observation-only';

export type ResidualVerificationResourceEstimate = {
  cpuRatio: number;
  memoryBytes: number;
  processCount: number;
};

export type ResidualVerificationResourceSnapshot = {
  count: number;
  oldestAgeMs: number;
  attempts: number;
  remediationActiveCount?: number;
  observationOnlyCount?: number;
  states: Record<string, number>;
  resourceEstimate: ResidualVerificationResourceEstimate;
};

export type ResidualVerificationProcessRecord = {
  id: string;
  pid: number;
  platform: SupportedPlatform;
  identityHash?: string;
  trigger: ResidualVerificationTrigger;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  state: ResidualVerificationState;
  lastReason?: string;
  resourceEstimate: ResidualVerificationResourceEstimate;
};

type PersistedResidualState = {
  version: 1;
  records: ResidualVerificationProcessRecord[];
};

type ReaperOptions = {
  now?: number;
  captureIdentity?: (pid: number, options?: { platform?: SupportedPlatform }) => ProcessIdentityProbe;
  terminateTree?: (pid: number, options?: { platform?: SupportedPlatform; expectedIdentityHash?: string }) => ProcessTreeTerminationResult;
};

const STATE_VERSION = 1 as const;
const REAPER_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000, 60_000, 120_000] as const;
const MAX_REAPER_ATTEMPTS = 12;
const OBSERVATION_BACKOFF_MS = 15 * 60_000;
let records: ResidualVerificationProcessRecord[] | null = null;
let reaperTimer: NodeJS.Timeout | undefined;

function statePath() {
  return path.join(getDevFlowRuntimeDir(), 'residual-verification-processes.json');
}

function normalizeEstimate(input?: Partial<ResidualVerificationResourceEstimate>): ResidualVerificationResourceEstimate {
  return {
    cpuRatio: Math.max(0, Math.min(1, Number(input?.cpuRatio) || 0)),
    memoryBytes: Math.max(0, Math.floor(Number(input?.memoryBytes) || 0)),
    processCount: Math.max(1, Math.floor(Number(input?.processCount) || 1)),
  };
}

function loadState() {
  if (records) return records;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as PersistedResidualState;
    records = parsed?.version === STATE_VERSION && Array.isArray(parsed.records)
      ? parsed.records.filter((record) => Number.isFinite(record?.pid) && record.pid > 0)
      : [];
  } catch {
    records = [];
  }
  scheduleReaper();
  return records;
}

function persistState() {
  const current = loadState();
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: STATE_VERSION, records: current } satisfies PersistedResidualState));
  fs.renameSync(temp, file);
}

function backoffMs(attempts: number) {
  return REAPER_BACKOFF_MS[Math.min(REAPER_BACKOFF_MS.length - 1, Math.max(0, attempts - 1))];
}

function recordId(pid: number, identityHash?: string) {
  return `residual-${pid}-${identityHash?.slice(0, 16) || 'unknown'}`;
}

function scheduleReaper() {
  if (reaperTimer) clearTimeout(reaperTimer);
  reaperTimer = undefined;
  const runnable = records || [];
  if (!runnable.length) return;
  const delay = Math.max(0, Math.min(...runnable.map((record) => record.nextAttemptAt)) - Date.now());
  reaperTimer = setTimeout(() => {
    reaperTimer = undefined;
    try { reapResidualVerificationProcesses(); } catch { /* durable debt remains for the next pass */ }
  }, delay);
  reaperTimer.unref?.();
}

export function registerResidualVerificationProcess(input: {
  pid: number;
  platform?: SupportedPlatform;
  identityHash?: string;
  trigger: ResidualVerificationTrigger;
  reason?: string;
  resourceEstimate?: Partial<ResidualVerificationResourceEstimate>;
  now?: number;
}) {
  const pid = Math.floor(Number(input.pid));
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const now = input.now ?? Date.now();
  const current = loadState();
  const id = recordId(pid, input.identityHash);
  const existing = current.find((record) => record.id === id);
  if (existing) {
    existing.updatedAt = now;
    existing.trigger = input.trigger;
    existing.lastReason = input.reason || existing.lastReason;
    existing.resourceEstimate = normalizeEstimate(input.resourceEstimate || existing.resourceEstimate);
    existing.nextAttemptAt = Math.min(existing.nextAttemptAt, now);
    persistState();
    scheduleReaper();
    return { ...existing };
  }
  const record: ResidualVerificationProcessRecord = {
    id,
    pid,
    platform: input.platform ?? process.platform,
    ...(input.identityHash ? { identityHash: input.identityHash } : {}),
    trigger: input.trigger,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    nextAttemptAt: now,
    state: input.identityHash ? 'quarantined' : 'identity-unconfirmed',
    ...(input.reason ? { lastReason: input.reason } : {}),
    resourceEstimate: normalizeEstimate(input.resourceEstimate),
  };
  current.push(record);
  persistState();
  scheduleReaper();
  return { ...record };
}

export function reapResidualVerificationProcesses(options: ReaperOptions = {}) {
  const now = options.now ?? Date.now();
  const captureIdentity = options.captureIdentity ?? ((pid, probeOptions) => captureProcessIdentity(pid, probeOptions));
  const terminateTree = options.terminateTree ?? ((pid, terminateOptions) => terminateProcessTree(pid, terminateOptions));
  const current = loadState();
  let changed = false;

  for (let index = current.length - 1; index >= 0; index -= 1) {
    const record = current[index];
    if (record.nextAttemptAt > now) continue;

    const observationOnly = record.state === 'observation-only' || record.attempts >= MAX_REAPER_ATTEMPTS;
    const probe = captureIdentity(record.pid, { platform: record.platform });
    if (probe.supported && !probe.exists) {
      current.splice(index, 1);
      changed = true;
      continue;
    }

    record.updatedAt = now;
    if (!probe.supported || !probe.identityHash) {
      if (!observationOnly) record.attempts += 1;
      const exhausted = observationOnly || record.attempts >= MAX_REAPER_ATTEMPTS;
      record.state = exhausted ? 'observation-only' : 'identity-unconfirmed';
      record.lastReason = probe.reason || 'identity-unavailable';
      record.nextAttemptAt = now + (exhausted ? OBSERVATION_BACKOFF_MS : backoffMs(record.attempts));
      changed = true;
      continue;
    }

    if (!record.identityHash) {
      if (!observationOnly) record.attempts += 1;
      const exhausted = observationOnly || record.attempts >= MAX_REAPER_ATTEMPTS;
      record.state = exhausted ? 'observation-only' : 'identity-unconfirmed';
      record.lastReason = 'missing-original-process-identity';
      record.nextAttemptAt = now + (exhausted ? OBSERVATION_BACKOFF_MS : backoffMs(record.attempts));
      changed = true;
      continue;
    }

    if (probe.identityHash !== record.identityHash) {
      current.splice(index, 1);
      changed = true;
      continue;
    }

    if (observationOnly) {
      record.state = 'observation-only';
      record.nextAttemptAt = now + OBSERVATION_BACKOFF_MS;
      changed = true;
      continue;
    }

    record.attempts += 1;
    const termination = terminateTree(record.pid, {
      platform: record.platform,
      expectedIdentityHash: record.identityHash,
    });
    if (termination.terminated && termination.confirmed) {
      current.splice(index, 1);
      changed = true;
      continue;
    }

    if (termination.reason === 'pid-reused') {
      current.splice(index, 1);
      changed = true;
      continue;
    }
    const exhausted = record.attempts >= MAX_REAPER_ATTEMPTS;
    record.state = exhausted ? 'observation-only' : 'termination-unconfirmed';
    record.lastReason = termination.reason || 'termination-unconfirmed';
    record.nextAttemptAt = now + (exhausted ? OBSERVATION_BACKOFF_MS : backoffMs(record.attempts));
    changed = true;
  }

  if (changed) persistState();
  scheduleReaper();
  return getResidualVerificationResourceSnapshot(now);
}

export function getResidualVerificationResourceSnapshot(now = Date.now()): ResidualVerificationResourceSnapshot {
  const current = loadState();
  const resourceEstimate = current.reduce<ResidualVerificationResourceEstimate>((sum, record) => ({
    cpuRatio: Math.min(1, sum.cpuRatio + record.resourceEstimate.cpuRatio),
    memoryBytes: sum.memoryBytes + record.resourceEstimate.memoryBytes,
    processCount: sum.processCount + record.resourceEstimate.processCount,
  }), { cpuRatio: 0, memoryBytes: 0, processCount: 0 });
  const observationOnlyCount = current.filter((record) =>
    record.state === 'observation-only' || record.attempts >= MAX_REAPER_ATTEMPTS).length;
  return {
    count: current.length,
    oldestAgeMs: current.length ? Math.max(...current.map((record) => Math.max(0, now - record.createdAt))) : 0,
    attempts: current.reduce((sum, record) => sum + record.attempts, 0),
    remediationActiveCount: current.length - observationOnlyCount,
    observationOnlyCount,
    states: current.reduce<Record<string, number>>((summary, record) => {
      const state = record.attempts >= MAX_REAPER_ATTEMPTS ? 'observation-only' : record.state;
      summary[state] = (summary[state] || 0) + 1;
      return summary;
    }, {}),
    resourceEstimate,
  };
}

export function reloadResidualVerificationProcessStateForTests() {
  if (reaperTimer) clearTimeout(reaperTimer);
  reaperTimer = undefined;
  records = null;
  return getResidualVerificationResourceSnapshot();
}

export function clearResidualVerificationProcessStateForTests() {
  if (reaperTimer) clearTimeout(reaperTimer);
  reaperTimer = undefined;
  records = [];
  try { fs.rmSync(statePath(), { force: true }); } catch { /* best effort */ }
}
