import db from '../../db/index';
import {
  buildDevFlowSupervisorDiagnostics,
  readDevFlowSupervisorState,
  type DevFlowSupervisorState,
} from '../../lib/devFlowSupervisor';
import { getJobMetrics } from './mcpToolJobService';
import { getLocalSearchRuntimeStatus } from './localFileService';
import { getSessionWorkspaceMetrics } from './sessionWorkspaceService';
import { getWorkspaceIntegrationMetrics } from './workspaceIntegrationService';
import { DEVFLOW_CONTRACT_VERSION } from '../contracts/devflowContract';
import {
  classifyRuntimeIdentity,
  getRuntimeIdentity,
  type RuntimeClientState,
} from './runtimeIdentityService';

const MAX_RECORDS = 500;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 60 * 1000;
const STALE_AGENT_RUN_MS = 30 * 60 * 1000;

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
  timestamp: number;
  inputHash: string;
}

const records: ToolCallRecord[] = [];

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
}

export function recordToolCall(input: ToolCallInput) {
  const serializedArgs = JSON.stringify(input.args || {});
  records.push({
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
    timestamp: input.timestamp ?? Date.now(),
    inputHash: hashText(stableStringify(input.args || {})),
  });
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
      .map(({ totalDurationMs, durationSamples, responseByteSamples, ...entry }) => ({
        ...entry,
        p50DurationMs: percentile(durationSamples, 50),
        p95DurationMs: percentile(durationSamples, 95),
        p50ResponseBytes: percentile(responseByteSamples, 50),
        p95ResponseBytes: percentile(responseByteSamples, 95),
      }))
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
      inputHash: record.inputHash,
      timestamp: new Date(record.timestamp).toISOString(),
    })),
    recommendations,
  };
}


export function buildIsolationDiagnostics(jobMetrics: any, workspaceMetrics: any, integrationMetrics: any) {
  const waitTelemetry = jobMetrics?.metrics?.waitTelemetry || {};
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
  const runtime = { ...getRuntimeIdentity(), contractVersion: DEVFLOW_CONTRACT_VERSION };
  const runtimeDiagnosis = classifyRuntimeIdentity(runtime, options?.clientState);
  const toolSummary = getToolCallSummary({ now, windowMs: options?.windowMs });
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
  if (staleAgentRuns.length > 0) {
    recommendations.push('Some agent runs are stale; cancel or retry them before starting more work on the same task.');
  }

  return {
    generatedAt: new Date(now).toISOString(),
    runtime,
    ...(runtimeDiagnosis ? { runtimeDiagnosis } : {}),
    search: getLocalSearchRuntimeStatus(),
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
    recommendations,
  };
}
