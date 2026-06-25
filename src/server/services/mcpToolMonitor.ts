import db from '../../db/index';
import { getJobMetrics } from './mcpToolJobService';

const MAX_RECORDS = 500;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 60 * 1000;
const STALE_AGENT_RUN_MS = 30 * 60 * 1000;

interface ToolCallInput {
  toolName: string;
  args: Record<string, any>;
  status: number;
  durationMs: number;
  timestamp?: number;
}

interface ToolCallRecord extends Required<ToolCallInput> {
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
  records.push({
    ...input,
    timestamp: input.timestamp ?? Date.now(),
    inputHash: hashText(stableStringify(input.args || {})),
  });
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
}

export function getToolCallSummary(options?: { now?: number; windowMs?: number }) {
  const now = options?.now ?? Date.now();
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const windowStart = now - windowMs;
  const recent = records.filter((record) => record.timestamp >= windowStart);

  const byTool = new Map<string, { toolName: string; count: number; errorCount: number; avgDurationMs: number; totalDurationMs: number }>();
  const byToolAndInput = new Map<string, { toolName: string; inputHash: string; count: number; firstSeenAt: number; lastSeenAt: number }>();

  for (const record of recent) {
    const tool = byTool.get(record.toolName) || {
      toolName: record.toolName,
      count: 0,
      errorCount: 0,
      avgDurationMs: 0,
      totalDurationMs: 0,
    };
    tool.count += 1;
    tool.errorCount += record.status >= 400 ? 1 : 0;
    tool.totalDurationMs += record.durationMs;
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
      .map(({ totalDurationMs, ...entry }) => entry)
      .slice(0, 10),
    duplicateBursts,
    latestCalls: recent.slice(-20).reverse().map((record) => ({
      toolName: record.toolName,
      status: record.status,
      durationMs: record.durationMs,
      inputHash: record.inputHash,
      timestamp: new Date(record.timestamp).toISOString(),
    })),
    recommendations,
  };
}

export function getDevFlowDiagnostics(options?: { now?: number; windowMs?: number }) {
  const now = options?.now ?? Date.now();
  const toolSummary = getToolCallSummary({ now, windowMs: options?.windowMs });
  const jobMetrics = getJobMetrics();
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
    mcp: {
      queueDepth: (jobMetrics as any).queueDepth,
      activeJobs: (jobMetrics as any).activeJobs,
      queuedJobs: (jobMetrics as any).queuedJobs,
      activeResources: (jobMetrics as any).activeResources,
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
