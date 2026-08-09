import type { AppState } from '../types';
import { getCapabilityCatalog, getMcpToolList } from '../contracts/devflowContract';
import { getGitStatus } from './gitService';
import { getDevFlowDiagnostics } from './mcpToolMonitor';
import { getLocalSearchRuntimeStatus } from './localFileService';
import { evaluatePerformanceSlo } from './performanceSloService';
import { performance as nodePerformance } from 'node:perf_hooks';
import { publishServerEvent } from './serverEventService.js';
import { getRecoveryStatus } from './backupIntegrityService';

const lastHealthEventSignatures = new Map<string, string>();

type Probe<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string; status?: number } };

function probe<T>(fn: () => T): Probe<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error: any) {
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error || 'Unknown error'),
        code: error?.code,
        status: error?.status,
      },
    };
  }
}

function numberArg(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeFailedJobGroups(failures: any[]) {
  const groups = new Map<string, { toolName: string; count: number; statuses: string[]; examples: any[] }>();
  for (const failure of failures) {
    const toolName = String(failure?.toolName || 'unknown');
    const group = groups.get(toolName) || { toolName, count: 0, statuses: [], examples: [] };
    group.count += 1;
    const status = String(failure?.status || '').trim();
    if (status && !group.statuses.includes(status)) group.statuses.push(status);
    if (group.examples.length < 3) {
      group.examples.push({
        jobId: failure?.jobId,
        status: failure?.status,
        failureSummary: failure?.failureSummary || '',
      });
    }
    groups.set(toolName, group);
  }
  return Array.from(groups.values()).sort((left, right) => right.count - left.count);
}

export function getWorkflowHealth(state: AppState, args: Record<string, any> = {}) {
  const recommendations: string[] = [];
  const startedAt = nodePerformance.now();
  let phaseStartedAt = startedAt;
  const phaseMs = () => {
    const elapsed = nodePerformance.now() - phaseStartedAt;
    phaseStartedAt = nodePerformance.now();
    return Math.round(elapsed * 100) / 100;
  };
  const windowMs = numberArg(args.windowMs, 10 * 60 * 1000);
  const catalog = getCapabilityCatalog();
  const advertisedTools = getMcpToolList(catalog.mcpProfile.active);
  const advertisedNames = new Set(advertisedTools.map((tool) => tool.name));
  const advertisedDefinitions = catalog.tools.filter((tool: any) => advertisedNames.has(tool.name));
  const catalogMs = phaseMs();
  const diagnostics = getDevFlowDiagnostics({ windowMs });
  const diagnosticsMs = phaseMs();
  const gitProbe = probe(() => getGitStatus(state, args));
  const gitMs = phaseMs();
  const search = getLocalSearchRuntimeStatus();
  const searchMs = phaseMs();
  const sloPerformance = evaluatePerformanceSlo(Array.isArray(diagnostics?.tools?.topTools) ? diagnostics.tools.topTools : []);
  const recovery = getRecoveryStatus();
  const historicalPerformance = diagnostics?.performanceHistory || {
    windowMs,
    minSamples: 5,
    regressionThreshold: 0.15,
    comparisons: [],
    regressions: [],
    improvements: [],
    stable: [],
    insufficientSamples: [],
  };
  const sloMs = phaseMs();

  const git = gitProbe.ok === true ? {
    ok: true,
    clean: Array.isArray(gitProbe.value.files) && gitProbe.value.files.length === 0 && !gitProbe.value.operation?.blocked,
    changedFileCount: Array.isArray(gitProbe.value.files) ? gitProbe.value.files.length : 0,
    changedFiles: Array.isArray(gitProbe.value.files) ? gitProbe.value.files : [],
    operation: gitProbe.value.operation || { blocked: false, code: null, kind: null, marker: null, unmergedPathCount: 0, unmergedPaths: [] },
  } : {
    ok: false,
    clean: false,
    error: gitProbe.error,
  };

  if (!git.ok) recommendations.push('Git status is unavailable; check projectId/localPath and whether the project is a git repository.');
  if (git.ok && git.operation?.blocked) recommendations.push(`Git ${git.operation.kind || 'operation'} state is unresolved (${git.operation.unmergedPathCount || 0} unmerged paths); do not start unrelated write/integration work until the operation is resolved or aborted.`);
  if (git.ok && !git.clean && !git.operation?.blocked) recommendations.push('Working tree has local changes; review or commit them before starting unrelated work.');

  const queueDepth = Number(diagnostics?.mcp?.queueDepth || 0);
  const isolation = diagnostics?.isolation || {
    waits: { workspaceLockWait: { count: 0, p50Ms: 0, p95Ms: 0 }, capacityWait: { count: 0, p50Ms: 0, p95Ms: 0 }, blockerReasons: {} },
    capacity: { active: 0, limit: 0, saturated: false },
    workspaces: { known: 0, active: 0, integrationRequired: 0 },
    integrations: { conflicts: 0, pendingConflicts: 0 },
    activeResources: { workspaces: 0, sharedRepos: 0, other: 0 },
  };
  const failedJobs = Number(diagnostics?.mcp?.metrics?.failedJobs || 0);
  const failedJobSummaries = Array.isArray(diagnostics?.mcp?.metrics?.failures) ? diagnostics.mcp.metrics.failures.slice(0, 10) : [];
  const failedJobGroups = summarizeFailedJobGroups(failedJobSummaries);
  const durableJobs = diagnostics?.mcp?.metrics?.durable || { queued: 0, running: 0, failed: 0, recovered: 0, staleRunning: 0, oldestLeaseAgeMs: 0 };
  const staleAgentRuns = Number(diagnostics?.agents?.staleCount || 0);
  const duplicateBursts = Array.isArray(diagnostics?.tools?.duplicateBursts) ? diagnostics.tools.duplicateBursts.length : 0;
  if (queueDepth > 0) recommendations.push('MCP tool jobs are queued; inspect job status/log before starting conflicting repo work.');
  if (Number(durableJobs.staleRunning || 0) > 0) recommendations.push('A stale MCP tool job lease was detected in durable state; inspect recovery classification before retrying the job.');
  if (isolation.capacity?.saturated) recommendations.push('Verification capacity is saturated; queued verify work is capacity-limited rather than blocked by a workspace correctness lock.');
  if (failedJobs > 0) {
    const groupedTools = failedJobGroups.map((group) => `${group.toolName}=${group.count}`).join(', ');
    recommendations.push(groupedTools
      ? `Recent tool jobs include failures grouped by tool (${groupedTools}); inspect diagnostics.failedJobGroups before retrying broad work.`
      : 'Recent tool jobs include failures; inspect logs/results before retrying broad work.');
  }
  if (staleAgentRuns > 0) recommendations.push('There are stale agent runs; cancel or retry them before starting more agent-owned work.');
  if (duplicateBursts > 0) recommendations.push('Duplicate tool bursts detected; prefer get_repo_context_bundle before repeated reads/searches.');
  if (!recovery.lastVerifiedGoodBackup) recommendations.push('No verified recovery snapshot exists yet; create one from Settings or export a backup.');
  if (recovery.failureReason) recommendations.push(`Recovery verification needs attention: ${recovery.failureReason.code} — ${recovery.failureReason.reason}`);
  if (sloPerformance.regressions.length > 0) {
    const slow = sloPerformance.regressions.slice(0, 3).map((entry) => `${entry.toolName} p95=${entry.p95DurationMs}ms>${entry.budgetMs}ms`).join(', ');
    recommendations.push(`Performance SLO regression detected: ${slow}.`);
  }
  if (historicalPerformance.regressions.length > 0) {
    const slow = historicalPerformance.regressions
      .slice(0, 3)
      .map((entry: any) => `${entry.toolName} p95 ${entry.baseline?.p95DurationMs}ms→${entry.current?.p95DurationMs}ms (${entry.deltaPercent}%)`)
      .join(', ');
    recommendations.push(`Historical performance regression detected: ${slow}.`);
  }

  const keyToolsPresent = {
    get_repo_context_bundle: catalog.tools.some((tool: any) => tool.name === 'get_repo_context_bundle'),
    move_task_to_status: catalog.tools.some((tool: any) => tool.name === 'move_task_to_status'),
    commit_git_changes: catalog.tools.some((tool: any) => tool.name === 'commit_git_changes'),
    devflow_health_check: catalog.tools.some((tool: any) => tool.name === 'devflow_health_check'),
  };
  const hasErrors = !git.ok || Boolean(git.ok && git.operation?.blocked) || catalog.tools.length === 0;
  const hasWarnings = recommendations.some((recommendation) => !recommendation.startsWith('No verified recovery snapshot exists yet;'));
  const status = hasErrors ? 'error' : hasWarnings ? 'warning' : 'ok';
  const healthEventProjectId = typeof args.projectId === 'string' ? args.projectId : undefined;
  const healthEventKey = healthEventProjectId || 'global';
  const healthEventSignature = status === 'ok'
    ? ''
    : [
        status,
        failedJobs,
        staleAgentRuns,
        Number(durableJobs.staleRunning || 0),
        sloPerformance.regressions.length,
        git.ok ? git.operation?.code || '' : 'git-unavailable',
        git.ok ? git.operation?.kind || '' : '',
        git.ok ? git.operation?.unmergedPathCount || 0 : 0,
      ].join(':');
  const priorHealthEventSignature = lastHealthEventSignatures.get(healthEventKey) || '';
  if (healthEventSignature && healthEventSignature !== priorHealthEventSignature) {
    publishServerEvent('health.regression', {
      projectId: healthEventProjectId,
      status,
      reason: `failedJobs=${failedJobs};staleAgents=${staleAgentRuns};staleJobs=${Number(durableJobs.staleRunning || 0)};slo=${sloPerformance.regressions.length};gitBlocker=${git.ok ? git.operation?.code || 'none' : 'unavailable'};gitKind=${git.ok ? git.operation?.kind || 'none' : 'unknown'};unmerged=${git.ok ? git.operation?.unmergedPathCount || 0 : 0}`,
    });
  }
  if (healthEventSignature) lastHealthEventSignatures.set(healthEventKey, healthEventSignature);
  else lastHealthEventSignatures.delete(healthEventKey);

  return {
    ok: status !== 'error',
    status,
    generatedAt: new Date().toISOString(),
    checks: { git: git.ok, capabilityCatalog: advertisedTools.length > 0, diagnostics: true, recovery: Boolean(recovery.lastVerifiedGoodBackup) && !recovery.failureReason },
    capabilities: {
      contractVersion: catalog.contractVersion,
      toolCount: advertisedTools.length,
      backendToolCount: catalog.tools.length,
      lightweightToolCount: advertisedDefinitions.filter((tool: any) => tool.lightweight).length,
      asyncToolCount: advertisedDefinitions.filter((tool: any) => tool.executionPolicy?.mode === 'job').length,
      search,
      keyToolsPresent,
    },
    git,
    diagnostics: {
      queueDepth,
      failedJobs,
      failedJobGroups,
      failedJobSummaries,
      durableJobs,
      staleAgentRuns,
      duplicateBursts,
      performance: { ...sloPerformance, history: historicalPerformance },
      telemetryPersistence: diagnostics?.telemetryPersistence,
      isolation,
      recovery,
    },
    performance: {
      totalMs: Math.round((nodePerformance.now() - startedAt) * 100) / 100,
      phases: { catalogMs, diagnosticsMs, gitMs, searchMs, sloMs },
    },
    recommendations,
  };
}
