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
  repoIndexCacheState?: string;
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
      ...(typeof tool.repoIndexCacheState === 'string' && tool.repoIndexCacheState ? { repoIndexCacheState: tool.repoIndexCacheState } : {}),
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

export type LifecycleTaskSloInput = {
  taskId: string;
  outcome: 'succeeded' | 'failed' | 'blocked';
  path: 'normal' | 'recovery' | 'break-glass';
  phaseDurationsMs: Record<string, number>;
  ownershipRotationsAfterInitialClaim: number;
  reclaims: number;
  automaticReconciliations: number;
  emergencyOperations: number;
  finalizationAttempts: number;
  finalizationRetries: number;
  cleanupPendingCount: number;
  authoritativeTerminalOutcomes: number;
  currentAuthorityCount: number;
  duplicateSideEffects: number;
  unauthorizedWipLossCount: number;
  unrecoverableSoftStateCount: number;
  unresolvedWriterCount: number;
  visibleWriterBlockerCount: number;
};

export type LifecycleTaskSloViolation = {
  code: string;
  message: string;
  actual: number;
  expected: string;
};

function nonNegativeCount(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function normalizedPhaseDurations(value: Record<string, number> | undefined) {
  return Object.fromEntries(Object.entries(value || {}).map(([phase, duration]) => [
    phase,
    Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : 0,
  ]));
}

export function evaluateLifecycleTaskSlo(input: LifecycleTaskSloInput) {
  const metrics: LifecycleTaskSloInput = {
    ...input,
    taskId: String(input?.taskId || '').trim(),
    outcome: input?.outcome || 'blocked',
    path: input?.path || 'recovery',
    phaseDurationsMs: normalizedPhaseDurations(input?.phaseDurationsMs),
    ownershipRotationsAfterInitialClaim: nonNegativeCount(input?.ownershipRotationsAfterInitialClaim),
    reclaims: nonNegativeCount(input?.reclaims),
    automaticReconciliations: nonNegativeCount(input?.automaticReconciliations),
    emergencyOperations: nonNegativeCount(input?.emergencyOperations),
    finalizationAttempts: nonNegativeCount(input?.finalizationAttempts),
    finalizationRetries: nonNegativeCount(input?.finalizationRetries),
    cleanupPendingCount: nonNegativeCount(input?.cleanupPendingCount),
    authoritativeTerminalOutcomes: nonNegativeCount(input?.authoritativeTerminalOutcomes),
    currentAuthorityCount: nonNegativeCount(input?.currentAuthorityCount),
    duplicateSideEffects: nonNegativeCount(input?.duplicateSideEffects),
    unauthorizedWipLossCount: nonNegativeCount(input?.unauthorizedWipLossCount),
    unrecoverableSoftStateCount: nonNegativeCount(input?.unrecoverableSoftStateCount),
    unresolvedWriterCount: nonNegativeCount(input?.unresolvedWriterCount),
    visibleWriterBlockerCount: nonNegativeCount(input?.visibleWriterBlockerCount),
  };
  const violations: LifecycleTaskSloViolation[] = [];
  const add = (code: string, message: string, actual: number, expected: string) => {
    violations.push({ code, message, actual, expected });
  };

  if (metrics.path === 'normal' && metrics.ownershipRotationsAfterInitialClaim > 0) {
    add('NORMAL_PATH_OWNERSHIP_CHURN', 'Healthy normal work must not rotate ownership after the initial claim.', metrics.ownershipRotationsAfterInitialClaim, '0');
  }
  if (metrics.path === 'normal' && metrics.emergencyOperations > 0) {
    add('NORMAL_PATH_EMERGENCY_USED', 'Healthy normal work must complete without break-glass operations.', metrics.emergencyOperations, '0');
  }
  if (metrics.outcome === 'succeeded' && metrics.authoritativeTerminalOutcomes !== 1) {
    add('TERMINAL_OUTCOME_NOT_EXACTLY_ONCE', 'A successful logical task must have exactly one authoritative terminal outcome.', metrics.authoritativeTerminalOutcomes, '1');
  }
  if (metrics.currentAuthorityCount > 1) {
    add('MULTIPLE_CURRENT_AUTHORITIES', 'At most one current lifecycle authority may exist for a task/workspace.', metrics.currentAuthorityCount, '<=1');
  }
  if (metrics.duplicateSideEffects > 0) {
    add('DUPLICATE_DURABLE_SIDE_EFFECT', 'Retries must not duplicate durable Git/lifecycle effects.', metrics.duplicateSideEffects, '0');
  }
  if (metrics.unauthorizedWipLossCount > 0) {
    add('UNAUTHORIZED_WIP_LOSS', 'Dirty WIP may be lost only through an explicitly acknowledged destructive action.', metrics.unauthorizedWipLossCount, '0');
  }
  if (metrics.unrecoverableSoftStateCount > 0) {
    add('UNRECOVERABLE_SOFT_STATE', 'Every soft workflow incident must expose normal continuation, deterministic recovery, or audited break-glass.', metrics.unrecoverableSoftStateCount, '0');
  }
  if (metrics.unresolvedWriterCount > metrics.visibleWriterBlockerCount) {
    add('UNRESOLVED_WRITER_NOT_FULLY_BLOCKED', 'Every unresolved durable writer must remain visible as an authoritative blocker.', metrics.unresolvedWriterCount - metrics.visibleWriterBlockerCount, '0 unblocked writers');
  }

  return {
    status: violations.length === 0 ? 'within_slo' as const : 'regressed' as const,
    metrics,
    phaseDurationsMs: metrics.phaseDurationsMs,
    violations,
  };
}
