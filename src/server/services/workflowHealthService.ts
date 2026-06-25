import type { AppState } from '../types';
import { getCapabilityCatalog } from '../contracts/devflowContract';
import { getGitStatus } from './gitService';
import { getDevFlowDiagnostics } from './mcpToolMonitor';

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
  const windowMs = numberArg(args.windowMs, 10 * 60 * 1000);
  const catalog = getCapabilityCatalog();
  const diagnostics = getDevFlowDiagnostics({ windowMs });
  const gitProbe = probe(() => getGitStatus(state, args));

  const git = gitProbe.ok === true ? {
    ok: true,
    clean: Array.isArray(gitProbe.value.files) && gitProbe.value.files.length === 0,
    changedFileCount: Array.isArray(gitProbe.value.files) ? gitProbe.value.files.length : 0,
    changedFiles: Array.isArray(gitProbe.value.files) ? gitProbe.value.files : [],
  } : {
    ok: false,
    clean: false,
    error: gitProbe.error,
  };

  if (!git.ok) recommendations.push('Git status is unavailable; check projectId/localPath and whether the project is a git repository.');
  if (git.ok && !git.clean) recommendations.push('Working tree has local changes; review or commit them before starting unrelated work.');

  const queueDepth = Number(diagnostics?.mcp?.queueDepth || 0);
  const failedJobs = Number(diagnostics?.mcp?.metrics?.failedJobs || 0);
  const failedJobSummaries = Array.isArray(diagnostics?.mcp?.metrics?.failures) ? diagnostics.mcp.metrics.failures.slice(0, 10) : [];
  const failedJobGroups = summarizeFailedJobGroups(failedJobSummaries);
  const staleAgentRuns = Number(diagnostics?.agents?.staleCount || 0);
  const duplicateBursts = Array.isArray(diagnostics?.tools?.duplicateBursts) ? diagnostics.tools.duplicateBursts.length : 0;
  if (queueDepth > 0) recommendations.push('MCP tool jobs are queued; inspect job status/log before starting conflicting repo work.');
  if (failedJobs > 0) {
    const groupedTools = failedJobGroups.map((group) => `${group.toolName}=${group.count}`).join(', ');
    recommendations.push(groupedTools
      ? `Recent tool jobs include failures grouped by tool (${groupedTools}); inspect diagnostics.failedJobGroups before retrying broad work.`
      : 'Recent tool jobs include failures; inspect logs/results before retrying broad work.');
  }
  if (staleAgentRuns > 0) recommendations.push('There are stale agent runs; cancel or retry them before starting more agent-owned work.');
  if (duplicateBursts > 0) recommendations.push('Duplicate tool bursts detected; prefer get_repo_context_bundle before repeated reads/searches.');

  const keyToolsPresent = {
    get_repo_context_bundle: catalog.tools.some((tool: any) => tool.name === 'get_repo_context_bundle'),
    move_task_to_status: catalog.tools.some((tool: any) => tool.name === 'move_task_to_status'),
    commit_git_changes: catalog.tools.some((tool: any) => tool.name === 'commit_git_changes'),
    devflow_health_check: catalog.tools.some((tool: any) => tool.name === 'devflow_health_check'),
  };
  const hasErrors = !git.ok || catalog.tools.length === 0;
  const hasWarnings = recommendations.length > 0;
  const status = hasErrors ? 'error' : hasWarnings ? 'warning' : 'ok';

  return {
    ok: status !== 'error',
    status,
    generatedAt: new Date().toISOString(),
    checks: { git: git.ok, capabilityCatalog: catalog.tools.length > 0, diagnostics: true },
    capabilities: {
      contractVersion: catalog.contractVersion,
      toolCount: catalog.tools.length,
      lightweightToolCount: catalog.tools.filter((tool: any) => tool.lightweight).length,
      asyncToolCount: catalog.tools.filter((tool: any) => tool.executionPolicy?.mode === 'job').length,
      keyToolsPresent,
    },
    git,
    diagnostics: { queueDepth, failedJobs, failedJobGroups, failedJobSummaries, staleAgentRuns, duplicateBursts },
    recommendations,
  };
}
