const MIN_SAMPLES = 3;

const DEFAULT_P95_BUDGET_MS: Record<string, number> = {
  get_project_start_context: 500,
  repo_read_snapshot: 500,
  get_repo_context_bundle: 750,
  get_repo_inspection_index: 500,
  get_repo_context_delta: 300,
  get_repo_semantic_index: 500,
  read_local_file: 100,
  read_file_snippets_batch: 250,
  search_local_files: 1000,
  execute_repo_query_plan: 2500,
  safe_edit_local_file: 500,
  edit_local_files_batch: 1000,
  prepare_edit_plan: 1000,
  apply_prepared_edit_plan: 1000,
  apply_patch: 2000,
  run_project_command: 10000,
  devflow_health_check: 750,
};

type ToolSummary = {
  toolName: string;
  count?: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
  dominantPhase?: string;
  dominantPhaseP95Ms?: number;
  bundleCacheState?: string;
};

function budgetFor(toolName: string) {
  const envName = `DEVFLOW_SLO_${toolName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_P95_MS`;
  const configured = Number(process.env[envName]);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_P95_BUDGET_MS[toolName];
}

export function evaluatePerformanceSlo(topTools: ToolSummary[]) {
  const tools = topTools.map((tool) => {
    const budgetMs = budgetFor(tool.toolName);
    const count = Number(tool.count || 0);
    const p95DurationMs = Number(tool.p95DurationMs || 0);
    const status = !budgetMs
      ? 'unbudgeted'
      : count < MIN_SAMPLES
        ? 'insufficient_samples'
        : p95DurationMs > budgetMs
          ? 'regressed'
          : 'within_budget';
    return {
      toolName: tool.toolName,
      count,
      p50DurationMs: Number(tool.p50DurationMs || 0),
      p95DurationMs,
      budgetMs: budgetMs || null,
      status,
      ...(typeof tool.dominantPhase === 'string' && tool.dominantPhase ? { dominantPhase: tool.dominantPhase } : {}),
      ...(Number.isFinite(Number(tool.dominantPhaseP95Ms)) ? { dominantPhaseP95Ms: Number(tool.dominantPhaseP95Ms) } : {}),
      ...(typeof tool.bundleCacheState === 'string' && tool.bundleCacheState ? { bundleCacheState: tool.bundleCacheState } : {}),
    };
  });

  const regressions = tools
    .filter((tool) => tool.status === 'regressed')
    .sort((left, right) => (right.p95DurationMs - Number(right.budgetMs || 0)) - (left.p95DurationMs - Number(left.budgetMs || 0)));
  const sampled = tools.filter((tool) => tool.count >= MIN_SAMPLES);
  const dominant = [...sampled].sort((left, right) => right.p95DurationMs - left.p95DurationMs)[0] || null;

  return {
    minSamples: MIN_SAMPLES,
    tools,
    regressions,
    dominant,
  };
}
