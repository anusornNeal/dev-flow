import db from '../../db/index';
import {
  buildDevFlowSupervisorDiagnostics,
  readDevFlowSupervisorState,
  type DevFlowSupervisorState,
} from '../../lib/devFlowSupervisor';
import { getPerformanceBaseline, persistPerformanceSnapshots } from '../repositories/performanceTelemetryRepository.js';
import { getRepoRevisionForRoot } from './repoRevisionService.js';
import { getJobMetrics } from './mcpToolJobService';
import { getLocalSearchRuntimeStatus } from './localFileService';
import { getRepoContextBundlePerformanceSummary } from './projectStartContextService';
import { getRepoCacheDiagnostics } from './repoCacheInvalidationService';
import { getSessionWorkspaceMetrics } from './sessionWorkspaceService';
import { getWorkspaceIntegrationMetrics } from './workspaceIntegrationService';
import { getMcpTransportSummary } from './mcpTransportMonitor';
import { getVerificationResourceProfileDiagnostics } from './verificationResourceProfileService';
import { DEVFLOW_CONTRACT_VERSION, getCapabilityCatalog } from '../contracts/devflowContract';
import {
  classifyRuntimeIdentity,
  getRuntimeIdentity,
  getRuntimeSourceFreshness,
  type RuntimeClientState,
} from './runtimeIdentityService';

const MAX_RECORDS = 500;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 60 * 1000;
const STALE_AGENT_RUN_MS = 30 * 60 * 1000;
const PERFORMANCE_FLUSH_INTERVAL_MS = 60 * 1000;
const PERFORMANCE_MIN_SAMPLES = 5;
const PERFORMANCE_REGRESSION_THRESHOLD = 0.15;
const MAX_PENDING_DURATION_SAMPLES = 500;
type CompletionMode = 'inline-json' | 'request-stream' | 'durable-handoff';

interface ToolCallInput {
  toolName: string;
  args: Record<string, any>;
  status: number;
  durationMs: number;
  responseBytes?: number;
  inputBytes?: number;
  cacheHit?: boolean;
  phase?: string;
  processSpawns?: number;
  responseMode?: string;
  responseTruncated?: boolean;
  completionMode?: CompletionMode;
  handoffCount?: number;
  pollCount?: number;
  logicalOperationDurationMs?: number;
  jobId?: string;
  executionDurationMs?: number;
  timestamp?: number;
}

interface ToolCallRecord {
  toolName: string;
  status: number;
  durationMs: number;
  responseBytes?: number;
  inputBytes: number;
  cacheHit?: boolean;
  phase?: string;
  processSpawns?: number;
  responseMode?: string;
  responseTruncated?: boolean;
  completionMode: CompletionMode;
  handoffCount: number;
  pollCount: number;
  logicalOperationDurationMs: number;
  jobId?: string;
  executionDurationMs?: number;
  timestamp: number;
  inputHash: string;
  projectScope: string;
}

type PendingPerformanceBucket = {
  toolName: string;
  projectScope: string;
  windowStart: number;
  windowEnd: number;
  count: number;
  errorCount: number;
  durationSamples: number[];
  inputBytes: number;
  responseBytes: number;
  truncatedCount: number;
  cacheHitCount: number;
  processSpawns: number;
  completionModes: Record<CompletionMode, number>;
  handoffCount: number;
  pollCount: number;
  logicalOperationDurationSamples: number[];
  executionDurationSamples: number[];
};

const records: ToolCallRecord[] = [];
const pendingPerformance = new Map<string, PendingPerformanceBucket>();
let lastPerformanceFlushAt = 0;
let cachedAppRevision: string | null = null;

function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashText(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

function getProjectScope(args: Record<string, any>) {
  const projectId = String(args?.projectId || '').trim();
  if (projectId) return `project:${projectId.slice(0, 200)}`;
  const repo = String(args?.repo || args?.repoUrl || '').trim();
  if (repo) return `repo:${hashText(repo.toLowerCase())}`;
  const projectName = String(args?.projectName || '').trim();
  if (projectName) return `project-name:${hashText(projectName.toLowerCase())}`;
  return '';
}

function getAppRevision() {
  if (cachedAppRevision) return cachedAppRevision;
  const configured = String(process.env.DEVFLOW_APP_REVISION || process.env.GIT_COMMIT || '').trim();
  if (configured) {
    cachedAppRevision = configured.slice(0, 200);
    return cachedAppRevision;
  }
  try {
    cachedAppRevision = getRepoRevisionForRoot(process.cwd()).head || 'unknown';
  } catch {
    cachedAppRevision = 'unknown';
  }
  return cachedAppRevision;
}

function updatePendingPerformance(record: ToolCallRecord) {
  const key = `${record.toolName}\u0000${record.projectScope}`;
  const bucket = pendingPerformance.get(key) || {
    toolName: record.toolName,
    projectScope: record.projectScope,
    windowStart: record.timestamp,
    windowEnd: record.timestamp,
    count: 0,
    errorCount: 0,
    durationSamples: [],
    inputBytes: 0,
    responseBytes: 0,
    truncatedCount: 0,
    cacheHitCount: 0,
    processSpawns: 0,
    completionModes: { 'inline-json': 0, 'request-stream': 0, 'durable-handoff': 0 },
    handoffCount: 0,
    pollCount: 0,
    logicalOperationDurationSamples: [],
    executionDurationSamples: [],
  };
  bucket.windowStart = Math.min(bucket.windowStart, record.timestamp);
  bucket.windowEnd = Math.max(bucket.windowEnd, record.timestamp);
  bucket.count += 1;
  bucket.errorCount += record.status >= 400 ? 1 : 0;
  if (bucket.durationSamples.length < MAX_PENDING_DURATION_SAMPLES) bucket.durationSamples.push(record.durationMs);
  bucket.inputBytes += record.inputBytes;
  bucket.responseBytes += Number(record.responseBytes || 0);
  bucket.truncatedCount += record.responseTruncated === true ? 1 : 0;
  bucket.cacheHitCount += record.cacheHit === true ? 1 : 0;
  bucket.processSpawns += Number(record.processSpawns || 0);
  bucket.completionModes[record.completionMode] += 1;
  bucket.handoffCount += record.handoffCount;
  bucket.pollCount += record.pollCount;
  if (bucket.logicalOperationDurationSamples.length < MAX_PENDING_DURATION_SAMPLES) {
    bucket.logicalOperationDurationSamples.push(record.logicalOperationDurationMs);
  }
  if (record.executionDurationMs !== undefined && bucket.executionDurationSamples.length < MAX_PENDING_DURATION_SAMPLES) {
    bucket.executionDurationSamples.push(record.executionDurationMs);
  }
  pendingPerformance.set(key, bucket);
}

function getActiveAgentRuns(now = Date.now()) {
  const rows = db.prepare(`
    SELECT id, taskId, projectId, agent, model, effort, status, createdAt, startedAt, endedAt, errorMessage, triggerSource
    FROM agent_runs
    WHERE status IN ('queued', 'starting', 'running')
    ORDER BY createdAt ASC
  `).all() as any[];

  return rows.map((run) => {
    const startedOrCreated = Date.parse(run.startedAt || run.createdAt || '') || now;
    const ageMs = Math.max(0, now - startedOrCreated);
    return {
      ...run,
      ageMs,
      stale: ageMs > STALE_AGENT_RUN_MS,
    };
  });
}

export function clearToolCallRecords() {
  records.length = 0;
  pendingPerformance.clear();
  lastPerformanceFlushAt = 0;
}

export function recordToolCall(input: ToolCallInput) {
  const serializedArgs = JSON.stringify(input.args || {});
  const record: ToolCallRecord = {
    toolName: input.toolName,
    status: input.status,
    durationMs: input.durationMs,
    responseBytes: input.responseBytes,
    inputBytes: input.inputBytes ?? Buffer.byteLength(serializedArgs, 'utf8'),
    cacheHit: input.cacheHit,
    phase: input.phase,
    processSpawns: input.processSpawns,
    responseMode: input.responseMode,
    responseTruncated: input.responseTruncated,
    completionMode: input.completionMode || 'inline-json',
    handoffCount: Math.max(0, Number(input.handoffCount || 0)),
    pollCount: Math.max(0, Number(input.pollCount || 0)),
    logicalOperationDurationMs: Math.max(0, Number(input.logicalOperationDurationMs ?? input.durationMs)),
    ...(input.jobId ? { jobId: String(input.jobId).slice(0, 200) } : {}),
    ...(input.executionDurationMs !== undefined && Number.isFinite(Number(input.executionDurationMs))
      ? { executionDurationMs: Math.max(0, Number(input.executionDurationMs)) }
      : {}),
    timestamp: input.timestamp ?? Date.now(),
    inputHash: hashText(stableStringify(input.args || {})),
    projectScope: getProjectScope(input.args || {}),
  };
  records.push(record);
  updatePendingPerformance(record);
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

export function getToolCallSummary(options?: { now?: number; windowMs?: number }) {
  const now = options?.now ?? Date.now();
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const windowStart = now - windowMs;
  const recent = records.filter((record) => record.timestamp >= windowStart);
  const bundlePerformance = getRepoContextBundlePerformanceSummary({ now, windowMs });

  const byTool = new Map<string, {
    toolName: string;
    count: number;
    errorCount: number;
    avgDurationMs: number;
    totalDurationMs: number;
    durationSamples: number[];
    responseBytes: number;
    responseByteSamples: number[];
    maxResponseBytes: number;
    responseModes: Record<string, number>;
    truncatedCount: number;
    totalInputBytes: number;
    avgInputBytes: number;
    maxInputBytes: number;
    cacheHitCount: number;
    processSpawns: number;
    completionModes: Record<CompletionMode, number>;
    handoffCount: number;
    pollCount: number;
    logicalOperationDurationSamples: number[];
    executionDurationSamples: number[];
    phases: Record<string, number>;
  }>();
  const byToolAndInput = new Map<string, { toolName: string; inputHash: string; count: number; firstSeenAt: number; lastSeenAt: number }>();

  for (const record of recent) {
    const tool = byTool.get(record.toolName) || {
      toolName: record.toolName,
      count: 0,
      errorCount: 0,
      avgDurationMs: 0,
      totalDurationMs: 0,
      durationSamples: [],
      responseBytes: 0,
      responseByteSamples: [],
      maxResponseBytes: 0,
      responseModes: {},
      truncatedCount: 0,
      totalInputBytes: 0,
      avgInputBytes: 0,
      maxInputBytes: 0,
      cacheHitCount: 0,
      processSpawns: 0,
      completionModes: { 'inline-json': 0, 'request-stream': 0, 'durable-handoff': 0 },
      handoffCount: 0,
      pollCount: 0,
      logicalOperationDurationSamples: [],
      executionDurationSamples: [],
      phases: {},
    };
    tool.count += 1;
    tool.errorCount += record.status >= 400 ? 1 : 0;
    tool.totalDurationMs += record.durationMs;
    tool.durationSamples.push(record.durationMs);
    const responseBytes = Number(record.responseBytes || 0);
    tool.responseBytes += responseBytes;
    tool.responseByteSamples.push(responseBytes);
    tool.maxResponseBytes = Math.max(tool.maxResponseBytes, responseBytes);
    if (record.responseMode) tool.responseModes[record.responseMode] = (tool.responseModes[record.responseMode] || 0) + 1;
    tool.truncatedCount += record.responseTruncated === true ? 1 : 0;
    tool.totalInputBytes += record.inputBytes;
    tool.avgInputBytes = Math.round(tool.totalInputBytes / tool.count);
    tool.maxInputBytes = Math.max(tool.maxInputBytes, record.inputBytes);
    tool.cacheHitCount += record.cacheHit === true ? 1 : 0;
    tool.processSpawns += Number(record.processSpawns || 0);
    tool.completionModes[record.completionMode] += 1;
    tool.handoffCount += record.handoffCount;
    tool.pollCount += record.pollCount;
    if (tool.logicalOperationDurationSamples.length < MAX_PENDING_DURATION_SAMPLES) {
      tool.logicalOperationDurationSamples.push(record.logicalOperationDurationMs);
    }
    if (record.executionDurationMs !== undefined && tool.executionDurationSamples.length < MAX_PENDING_DURATION_SAMPLES) {
      tool.executionDurationSamples.push(record.executionDurationMs);
    }
    if (record.phase) tool.phases[record.phase] = (tool.phases[record.phase] || 0) + 1;
    tool.avgDurationMs = Math.round(tool.totalDurationMs / tool.count);
    byTool.set(record.toolName, tool);

    const duplicateKey = `${record.toolName}:${record.inputHash}`;
    const duplicate = byToolAndInput.get(duplicateKey) || {
      toolName: record.toolName,
      inputHash: record.inputHash,
      count: 0,
      firstSeenAt: record.timestamp,
      lastSeenAt: record.timestamp,
    };
    duplicate.count += 1;
    duplicate.firstSeenAt = Math.min(duplicate.firstSeenAt, record.timestamp);
    duplicate.lastSeenAt = Math.max(duplicate.lastSeenAt, record.timestamp);
    byToolAndInput.set(duplicateKey, duplicate);
  }

  const duplicateBursts = Array.from(byToolAndInput.values())
    .filter((entry) => entry.count >= 3 && entry.lastSeenAt - entry.firstSeenAt <= DUPLICATE_WINDOW_MS)
    .sort((left, right) => right.count - left.count)
    .slice(0, 10);

  const recommendations: string[] = [];
  if (duplicateBursts.some((entry) => ['get_git_status', 'get_git_branch'].includes(entry.toolName))) {
    recommendations.push('Replace repeated get_git_status/get_git_branch calls with get_project_start_context for startup context.');
  }
  if (duplicateBursts.some((entry) => ['search_local_files', 'get_repo_inspection_index'].includes(entry.toolName))) {
    recommendations.push('Reuse get_repo_inspection_index results before issuing repeated repo searches.');
  }

  return {
    windowMs,
    retainedCalls: records.length,
    totalCalls: recent.length,
    topTools: Array.from(byTool.values())
      .sort((left, right) => right.count - left.count)
      .map(({ totalDurationMs, durationSamples, responseByteSamples, logicalOperationDurationSamples, executionDurationSamples, ...entry }) => {
        const bundleEvidence = entry.toolName === 'get_repo_context_bundle'
          ? (bundlePerformance.warm.count > 0 ? bundlePerformance.warm : bundlePerformance.cold)
          : null;
        return {
          ...entry,
          p50DurationMs: percentile(durationSamples, 50),
          p95DurationMs: percentile(durationSamples, 95),
          p50ResponseBytes: percentile(responseByteSamples, 50),
          p95ResponseBytes: percentile(responseByteSamples, 95),
          completionModes: entry.completionModes,
          handoffCount: entry.handoffCount,
          pollCount: entry.pollCount,
          logicalOperationP50Ms: percentile(logicalOperationDurationSamples, 50),
          logicalOperationP95Ms: percentile(logicalOperationDurationSamples, 95),
          executionP50Ms: percentile(executionDurationSamples, 50),
          executionP95Ms: percentile(executionDurationSamples, 95),
          ...(bundleEvidence && bundleEvidence.count > 0 ? {
            dominantPhase: bundleEvidence.dominantPhase,
            dominantPhaseP95Ms: bundleEvidence.dominantPhaseP95Ms,
            repoIndexCacheState: bundleEvidence.repoIndexCacheState,
          } : {}),
        };
      })
      .slice(0, 10),
    duplicateBursts,
    latestCalls: recent.slice(-20).reverse().map((record) => ({
      toolName: record.toolName,
      status: record.status,
      durationMs: record.durationMs,
      responseBytes: Number(record.responseBytes || 0),
      inputBytes: record.inputBytes,
      cacheHit: record.cacheHit === true,
      phase: record.phase,
      processSpawns: Number(record.processSpawns || 0),
      responseMode: record.responseMode,
      responseTruncated: record.responseTruncated === true,
      completionMode: record.completionMode,
      handoffCount: record.handoffCount,
      pollCount: record.pollCount,
      logicalOperationDurationMs: record.logicalOperationDurationMs,
      ...(record.jobId ? { jobId: record.jobId } : {}),
      ...(record.executionDurationMs !== undefined ? { executionDurationMs: record.executionDurationMs } : {}),
      inputHash: record.inputHash,
      timestamp: new Date(record.timestamp).toISOString(),
    })),
    recommendations,
  };
}


export function flushPerformanceTelemetry(options: {
  now?: number;
  force?: boolean;
  minIntervalMs?: number;
  retentionMs?: number;
  maxRows?: number;
} = {}) {
  const now = options.now ?? Date.now();
  const minIntervalMs = Math.max(1, Number(options.minIntervalMs || PERFORMANCE_FLUSH_INTERVAL_MS));
  if (pendingPerformance.size === 0) {
    return { inserted: 0, deletedByAge: 0, deletedByCap: 0, retainedRows: 0, flushedBuckets: 0, skipped: false };
  }
  if (!options.force && lastPerformanceFlushAt > 0 && now - lastPerformanceFlushAt < minIntervalMs) {
    return { inserted: 0, deletedByAge: 0, deletedByCap: 0, retainedRows: 0, flushedBuckets: 0, skipped: true, reason: 'interval' };
  }

  const snapshots = Array.from(pendingPerformance.values()).map((bucket) => ({
    windowStart: bucket.windowStart,
    windowEnd: bucket.windowEnd,
    toolName: bucket.toolName,
    projectScope: bucket.projectScope,
    contractRevision: DEVFLOW_CONTRACT_VERSION,
    appRevision: getAppRevision(),
    count: bucket.count,
    errorCount: bucket.errorCount,
    p50DurationMs: percentile(bucket.durationSamples, 50),
    p95DurationMs: percentile(bucket.durationSamples, 95),
    inputBytes: bucket.inputBytes,
    responseBytes: bucket.responseBytes,
    truncatedCount: bucket.truncatedCount,
    cacheHitCount: bucket.cacheHitCount,
    processSpawns: bucket.processSpawns,
    executionP50Ms: percentile(bucket.executionDurationSamples, 50),
    executionP95Ms: percentile(bucket.executionDurationSamples, 95),
    logicalOperationP50Ms: percentile(bucket.logicalOperationDurationSamples, 50),
    logicalOperationP95Ms: percentile(bucket.logicalOperationDurationSamples, 95),
    handoffCount: bucket.handoffCount,
    pollCount: bucket.pollCount,
    inlineJsonCount: bucket.completionModes['inline-json'],
    requestStreamCount: bucket.completionModes['request-stream'],
    durableHandoffCount: bucket.completionModes['durable-handoff'],
  }));

  const result = persistPerformanceSnapshots(snapshots, {
    now,
    retentionMs: options.retentionMs,
    maxRows: options.maxRows,
  });
  pendingPerformance.clear();
  lastPerformanceFlushAt = now;
  return { ...result, flushedBuckets: snapshots.length, skipped: false };
}

export function getPerformanceHistoryComparison(options: {
  now?: number;
  windowMs?: number;
  minSamples?: number;
  regressionThreshold?: number;
  maxTools?: number;
} = {}) {
  const now = options.now ?? Date.now();
  const windowMs = Math.max(1, Number(options.windowMs || DEFAULT_WINDOW_MS));
  const windowStart = now - windowMs;
  const minSamples = Math.max(1, Math.floor(Number(options.minSamples || PERFORMANCE_MIN_SAMPLES)));
  const regressionThreshold = Math.max(0, Number(options.regressionThreshold ?? PERFORMANCE_REGRESSION_THRESHOLD));
  const maxTools = Math.max(1, Math.min(25, Math.floor(Number(options.maxTools || 10))));
  const groups = new Map<string, {
    toolName: string;
    projectScope: string;
    count: number;
    errorCount: number;
    durationSamples: number[];
    inputBytes: number;
    responseBytes: number;
    truncatedCount: number;
    cacheHitCount: number;
    processSpawns: number;
  }>();

  for (const record of records) {
    if (record.timestamp < windowStart) continue;
    const key = `${record.toolName}\u0000${record.projectScope}`;
    const group = groups.get(key) || {
      toolName: record.toolName,
      projectScope: record.projectScope,
      count: 0,
      errorCount: 0,
      durationSamples: [],
      inputBytes: 0,
      responseBytes: 0,
      truncatedCount: 0,
      cacheHitCount: 0,
      processSpawns: 0,
    };
    group.count += 1;
    group.errorCount += record.status >= 400 ? 1 : 0;
    group.durationSamples.push(record.durationMs);
    group.inputBytes += record.inputBytes;
    group.responseBytes += Number(record.responseBytes || 0);
    group.truncatedCount += record.responseTruncated === true ? 1 : 0;
    group.cacheHitCount += record.cacheHit === true ? 1 : 0;
    group.processSpawns += Number(record.processSpawns || 0);
    groups.set(key, group);
  }

  const comparisons = Array.from(groups.values())
    .sort((left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName))
    .slice(0, maxTools)
    .map((group) => {
      const current = {
        sampleCount: group.count,
        p50DurationMs: percentile(group.durationSamples, 50),
        p95DurationMs: percentile(group.durationSamples, 95),
        errorCount: group.errorCount,
        inputBytes: group.inputBytes,
        responseBytes: group.responseBytes,
        truncatedCount: group.truncatedCount,
        truncationRate: group.count > 0 ? Math.round((group.truncatedCount / group.count) * 10_000) / 10_000 : 0,
        cacheHitCount: group.cacheHitCount,
        processSpawns: group.processSpawns,
      };
      if (group.count < minSamples) {
        return {
          toolName: group.toolName,
          projectScope: group.projectScope,
          status: 'insufficient-samples' as const,
          reason: 'current',
          current,
          baseline: { status: 'insufficient-samples' as const, sampleCount: 0, minSamples },
          deltaPercent: null,
        };
      }

      const baseline = getPerformanceBaseline({
        toolName: group.toolName,
        projectScope: group.projectScope,
        beforeWindowEnd: windowStart,
        minSamples,
        maxSnapshots: 50,
      });
      if (baseline.status !== 'ready') {
        return {
          toolName: group.toolName,
          projectScope: group.projectScope,
          status: 'insufficient-samples' as const,
          reason: 'baseline',
          current,
          baseline,
          deltaPercent: null,
        };
      }

      const baselineP95 = Number(baseline.p95DurationMs || 0);
      const ratio = baselineP95 > 0 ? (current.p95DurationMs - baselineP95) / baselineP95 : 0;
      const status = ratio > regressionThreshold
        ? 'regression'
        : ratio < -regressionThreshold
          ? 'improvement'
          : 'stable';
      return {
        toolName: group.toolName,
        projectScope: group.projectScope,
        status,
        current,
        baseline,
        deltaPercent: Math.round(ratio * 10_000) / 100,
      };
    });

  return {
    windowMs,
    minSamples,
    regressionThreshold,
    comparisons,
    regressions: comparisons.filter((entry) => entry.status === 'regression'),
    improvements: comparisons.filter((entry) => entry.status === 'improvement'),
    stable: comparisons.filter((entry) => entry.status === 'stable'),
    insufficientSamples: comparisons.filter((entry) => entry.status === 'insufficient-samples'),
  };
}

export function buildIsolationDiagnostics(jobMetrics: any, workspaceMetrics: any, integrationMetrics: any) {
  const waitTelemetry = jobMetrics?.metrics?.waitTelemetry || {};
  const phaseTelemetry = jobMetrics?.metrics?.phaseTelemetry || {};
  const emptyTiming = { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 };
  const active = Array.isArray(jobMetrics?.activeJobs) ? jobMetrics.activeJobs : [];
  const activeResources = { workspaces: 0, sharedRepos: 0, other: 0 };
  const seen = new Set<string>();
  for (const entry of active) {
    const key = String(entry?.resourceKey || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (key.startsWith('workspace:')) activeResources.workspaces += 1;
    else if (key.startsWith('repo:')) activeResources.sharedRepos += 1;
    else activeResources.other += 1;
  }
  const verifyCapacity = jobMetrics?.capacity?.verify || {};
  const verifyLimit = Number(verifyCapacity.limit ?? verifyCapacity.capacity ?? 0);
  const verifyActive = Number(verifyCapacity.active || 0);
  return {
    waits: {
      workspaceLockWait: waitTelemetry.workspaceLockWait || { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 },
      capacityWait: waitTelemetry.capacityWait || { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 },
      blockerReasons: waitTelemetry.blockerReasons || {},
    },
    phases: {
      admissionWait: phaseTelemetry.admissionWait || emptyTiming,
      queueWait: phaseTelemetry.queueWait || emptyTiming,
      workspaceLockWait: phaseTelemetry.workspaceLockWait || waitTelemetry.workspaceLockWait || emptyTiming,
      capacityWait: phaseTelemetry.capacityWait || waitTelemetry.capacityWait || emptyTiming,
      candidatePreparation: phaseTelemetry.candidatePreparation || emptyTiming,
      execution: phaseTelemetry.execution || emptyTiming,
      responseHandoff: phaseTelemetry.responseHandoff || emptyTiming,
    },
    capacity: { active: verifyActive, limit: verifyLimit, saturated: verifyCapacity.saturated === true || (verifyLimit > 0 && verifyActive >= verifyLimit) },
    workspaces: {
      known: Number(workspaceMetrics?.knownWorkspaces || 0), active: Number(workspaceMetrics?.activeWorkspaces || 0),
      integrationRequired: Number(workspaceMetrics?.integrationRequired || 0), created: Number(workspaceMetrics?.created || 0),
      reused: Number(workspaceMetrics?.reused || 0), cleaned: Number(workspaceMetrics?.cleaned || 0), cleanupBlocked: Number(workspaceMetrics?.cleanupBlocked || 0),
    },
    integrations: {
      attempts: Number(integrationMetrics?.attempts || 0), successes: Number(integrationMetrics?.successes || 0), conflicts: Number(integrationMetrics?.conflicts || 0),
      aborts: Number(integrationMetrics?.aborts || 0), retries: Number(integrationMetrics?.retries || 0), pendingConflicts: Number(integrationMetrics?.pendingConflicts || 0),
    },
    activeResources,
  };
}

export function getDevFlowDiagnostics(options?: {
  now?: number;
  windowMs?: number;
  supervisorState?: DevFlowSupervisorState | null;
  clientState?: RuntimeClientState;
}) {
  const now = options?.now ?? Date.now();
  const supervisorState = options && Object.prototype.hasOwnProperty.call(options, 'supervisorState')
    ? options.supervisorState ?? null
    : readDevFlowSupervisorState();
  const runtimeSupervisor = buildDevFlowSupervisorDiagnostics(supervisorState);
  const capabilityCatalog = getCapabilityCatalog();
  const runtime = {
    ...getRuntimeIdentity(),
    sourceFreshness: getRuntimeSourceFreshness(),
    contractVersion: DEVFLOW_CONTRACT_VERSION,
    toolSurfaceIdentity: capabilityCatalog.mcpProfile.toolSurfaceIdentity,
  };
  const runtimeDiagnosis = classifyRuntimeIdentity(runtime, options?.clientState);
  const telemetryPersistence = flushPerformanceTelemetry({ now });
  const toolSummary = getToolCallSummary({ now, windowMs: options?.windowMs });
  const repoCaches = getRepoCacheDiagnostics({
    domains: [
      'local-file-search',
      'repo-inspection-index',
      'repo-context-bundle',
      'context-handles',
      'verification-results',
      'git-remote-evidence',
      'project-atlas',
      'skills',
    ],
  });
  const mcpTransport = getMcpTransportSummary({ now, windowMs: options?.windowMs });
  const performanceHistory = getPerformanceHistoryComparison({ now, windowMs: options?.windowMs });
  const verificationResources = getVerificationResourceProfileDiagnostics();
  const jobMetrics = getJobMetrics();
  const isolation = buildIsolationDiagnostics(jobMetrics, getSessionWorkspaceMetrics(), getWorkspaceIntegrationMetrics());
  const activeAgentRuns = getActiveAgentRuns(now);
  const staleAgentRuns = activeAgentRuns.filter((run) => run.stale);
  const recentFailures = db.prepare(`
    SELECT id, taskId, projectId, agent, status, endedAt, errorMessage, triggerSource
    FROM agent_runs
    WHERE status IN ('failed', 'cancelled')
    ORDER BY COALESCE(endedAt, createdAt) DESC
    LIMIT 10
  `).all() as any[];

  const recommendations = [...toolSummary.recommendations];
  if ((jobMetrics as any).queueDepth > 0) {
    recommendations.push('MCP tool jobs are queued; inspect get_tool_job_status/log for the oldest queued job.');
  }
  if (runtimeSupervisor.api.status === 'healthy' && (runtimeSupervisor.tunnel.status === 'degraded' || runtimeSupervisor.tunnel.status === 'down')) {
    recommendations.push(`Public zrok route is ${runtimeSupervisor.tunnel.status} while the local DevFlow API is healthy; inspect zrok service/share state and supervisor public-probe evidence.`);
  }
  if (staleAgentRuns.length > 0) {
    recommendations.push('Some agent runs are stale; cancel or retry them before starting more work on the same task.');
  }

  return {
    generatedAt: new Date(now).toISOString(),
    runtime,
    ...(runtimeDiagnosis ? { runtimeDiagnosis } : {}),
    search: getLocalSearchRuntimeStatus(),
    repoCaches,
    runtimeSupervisor,
    isolation,
    mcp: {
      queueDepth: (jobMetrics as any).queueDepth,
      activeJobs: (jobMetrics as any).activeJobs,
      queuedJobs: (jobMetrics as any).queuedJobs,
      activeResources: (jobMetrics as any).activeResources,
      capacity: (jobMetrics as any).capacity,
      metrics: (jobMetrics as any).metrics,
      recentJobs: (jobMetrics as any).recentJobs,
    },
    agents: {
      activeCount: activeAgentRuns.length,
      staleCount: staleAgentRuns.length,
      activeRuns: activeAgentRuns,
      staleRuns: staleAgentRuns,
      recentFailures,
    },
    tools: toolSummary,
    mcpTransport,
    telemetryPersistence,
    performanceHistory,
    verificationResources,
    recommendations,
  };
}
