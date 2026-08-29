export type ToolRecoveryCategory = 'automatic' | 'refresh-repreview' | 'decision-required' | 'terminal';
export type ToolRecoveryStrategy =
  | 'refresh-context'
  | 'split-batch'
  | 'wait-result'
  | 'fallback-search'
  | 'narrow-scope-or-increase-timeout'
  | 'refresh-source-repreview'
  | 'refresh-base-repreview'
  | 'request-decision'
  | 'resolve-conflict'
  | 'stop-safety'
  | 'inspect-dirty-tree'
  | 'inspect-result'
  | 'stop';

export type ToolRecoveryPolicy = {
  code: string;
  category: ToolRecoveryCategory;
  strategy: ToolRecoveryStrategy;
  retrySamePayload: false;
  autoApply: boolean;
  requiresFreshSource: boolean;
  requiresFreshPreview: boolean;
  guidance: string;
};

export type RecoveryAttemptHistory = {
  code: string;
  strategy: string;
  payloadFingerprint: string;
};

const AUTOMATIC: Record<string, { strategy: ToolRecoveryStrategy; guidance: string }> = {
  CONTEXT_STALE: { strategy: 'refresh-context', guidance: 'Refresh repository/context evidence before retrying with updated inputs.' },
  CONTEXT_HANDLE_STALE: { strategy: 'refresh-context', guidance: 'Refresh the context handle and retry with the new handle.' },
  CACHE_STALE: { strategy: 'refresh-context', guidance: 'Refresh the stale cache/context and retry using the refreshed evidence.' },
  BATCH_BYTE_LIMIT: { strategy: 'split-batch', guidance: 'Split the request into a smaller bounded batch; do not replay the same oversized payload.' },
  JOB_PENDING: { strategy: 'wait-result', guidance: 'Wait for the existing job result instead of creating a duplicate job.' },
  JOB_QUEUED: { strategy: 'wait-result', guidance: 'Wait for the queued job result instead of replaying the tool call.' },
  JOB_RUNNING: { strategy: 'wait-result', guidance: 'Wait for the running job result instead of replaying the tool call.' },
  SEARCH_BACKEND_UNAVAILABLE: { strategy: 'fallback-search', guidance: 'Switch to the bounded fallback search backend rather than replaying the unavailable backend.' },
  RIPGREP_UNAVAILABLE: { strategy: 'fallback-search', guidance: 'Switch to the bounded fallback search backend rather than replaying ripgrep.' },
  JOB_TIMED_OUT: { strategy: 'narrow-scope-or-increase-timeout', guidance: 'Change strategy by narrowing scope or increasing the timeout before another attempt.' },
};

const REFRESH_REPREVIEW: Record<string, { strategy: ToolRecoveryStrategy; guidance: string }> = {
  FILE_CHANGED_SINCE_READ: { strategy: 'refresh-source-repreview', guidance: 'Re-read the changed source and create a fresh preview before any mutation.' },
  CONTENT_CHANGED: { strategy: 'refresh-source-repreview', guidance: 'Re-read the changed source and create a fresh preview before any mutation.' },
  EDIT_REF_STALE: { strategy: 'refresh-source-repreview', guidance: 'Re-read the source to obtain a fresh reference, then create a fresh preview before mutation.' },
  EDIT_REF_NOT_FOUND: { strategy: 'refresh-source-repreview', guidance: 'Re-read the source to obtain a fresh reference, then create a fresh preview before mutation.' },
  EDIT_PLAN_STALE: { strategy: 'refresh-source-repreview', guidance: 'Re-read the changed source and prepare a fresh preview; never replay the stale plan.' },
  EDIT_PLAN_EXPIRED: { strategy: 'refresh-source-repreview', guidance: 'Refresh source evidence and prepare a new preview rather than replaying the expired plan.' },
  EDIT_PLAN_NOT_FOUND: { strategy: 'refresh-source-repreview', guidance: 'Refresh source evidence and prepare a new preview rather than replaying the missing plan id.' },
  BASE_REVISION_CHANGED: { strategy: 'refresh-base-repreview', guidance: 'Refresh the base revision and recompute a preview before any mutation.' },
  REPO_REVISION_CHANGED: { strategy: 'refresh-base-repreview', guidance: 'Refresh repository revision evidence and recompute a preview before mutation.' },
  ANCHOR_MOVED: { strategy: 'refresh-source-repreview', guidance: 'Re-read the source, relocate the intended anchor, and preview again before mutation.' },
  NO_MATCH: { strategy: 'refresh-source-repreview', guidance: 'Refresh source evidence and recompute the edit preview before deciding whether the anchor moved.' },
};

const DECISION_REQUIRED: Record<string, { strategy: ToolRecoveryStrategy; guidance: string }> = {
  AMBIGUOUS_MATCH: { strategy: 'request-decision', guidance: 'Multiple targets match; require an explicit target decision before mutation.' },
  PROJECT_AMBIGUOUS: { strategy: 'request-decision', guidance: 'Multiple projects match; require an explicit project identifier.' },
  COMMAND_CONFIG_AMBIGUOUS: { strategy: 'request-decision', guidance: 'Configuration is ambiguous; require an explicit cleanup/selection decision.' },
  IDEMPOTENCY_CONFLICT: { strategy: 'request-decision', guidance: 'The idempotency key represents different work; require an explicit decision/new key.' },
  PROJECT_IDENTITY_CONFLICT: { strategy: 'resolve-conflict', guidance: 'Repository identity conflicts with an existing project; resolve the conflict explicitly.' },
  INTEGRATION_CONFLICT: { strategy: 'resolve-conflict', guidance: 'Integration has real conflicts; require explicit conflict resolution.' },
  EDIT_REF_PROJECT_MISMATCH: { strategy: 'request-decision', guidance: 'The reference belongs to another project/workspace; re-resolve the intended target explicitly.' },
  UNSAFE_PATH: { strategy: 'stop-safety', guidance: 'Safety boundary rejected the path; do not auto-recover or broaden access.' },
  FILE_ACCESS_DENIED: { strategy: 'stop-safety', guidance: 'Path access is outside the allowed root; do not auto-recover or broaden access.' },
  PATCH_PATH_DENIED: { strategy: 'stop-safety', guidance: 'Patch paths violate containment rules; do not auto-convert or broaden access.' },
  WORKSPACE_BASE_DIRTY: { strategy: 'inspect-dirty-tree', guidance: 'Base workspace has unrelated changes; inspect ownership and require an explicit decision.' },
  WORKSPACE_SOURCE_DIRTY: { strategy: 'inspect-dirty-tree', guidance: 'Source workspace has uncommitted changes; inspect ownership and require an explicit decision.' },
  WORKSPACE_DIRTY: { strategy: 'inspect-dirty-tree', guidance: 'Workspace is dirty; inspect changes before cleanup or mutation.' },
  WORKING_TREE_DIRTY: { strategy: 'inspect-dirty-tree', guidance: 'Working tree has changes; inspect ownership before unrelated mutation.' },
  GIT_DIRTY_SWITCH_BLOCKED: { strategy: 'inspect-dirty-tree', guidance: 'Dirty changes block switching; require an explicit disposition of those changes.' },
  GIT_DIRTY_BASE_BLOCKED: { strategy: 'inspect-dirty-tree', guidance: 'Dirty base blocks branch creation; require an explicit disposition of those changes.' },
  GIT_PUSH_DIRTY_TREE: { strategy: 'inspect-dirty-tree', guidance: 'Dirty changes block publish; require an explicit disposition of those changes.' },
  PULL_REQUEST_DIRTY_TREE: { strategy: 'inspect-dirty-tree', guidance: 'Dirty changes block pull-request creation; require an explicit disposition of those changes.' },
  EDIT_PLAN_CONSUMED: { strategy: 'inspect-result', guidance: 'Inspect the previous apply result/current diff; never replay or auto-reprepare a consumed mutation.' },
};

function normalizeCode(code: unknown) {
  return String(code || 'UNKNOWN_ERROR').trim().toUpperCase() || 'UNKNOWN_ERROR';
}

export function getToolRecoveryPolicy(code: unknown): ToolRecoveryPolicy {
  const normalized = normalizeCode(code);
  const automatic = AUTOMATIC[normalized];
  if (automatic) {
    return {
      code: normalized,
      category: 'automatic',
      strategy: automatic.strategy,
      retrySamePayload: false,
      autoApply: true,
      requiresFreshSource: false,
      requiresFreshPreview: false,
      guidance: automatic.guidance,
    };
  }

  const refresh = REFRESH_REPREVIEW[normalized];
  if (refresh) {
    return {
      code: normalized,
      category: 'refresh-repreview',
      strategy: refresh.strategy,
      retrySamePayload: false,
      autoApply: false,
      requiresFreshSource: true,
      requiresFreshPreview: true,
      guidance: refresh.guidance,
    };
  }

  const decision = DECISION_REQUIRED[normalized];
  if (decision) {
    return {
      code: normalized,
      category: 'decision-required',
      strategy: decision.strategy,
      retrySamePayload: false,
      autoApply: false,
      requiresFreshSource: false,
      requiresFreshPreview: false,
      guidance: decision.guidance,
    };
  }

  return {
    code: normalized,
    category: 'terminal',
    strategy: 'stop',
    retrySamePayload: false,
    autoApply: false,
    requiresFreshSource: false,
    requiresFreshPreview: false,
    guidance: 'No safe automatic recovery is defined. Inspect the error and change strategy explicitly.',
  };
}

export function evaluateRecoveryAttempt(input: {
  code: unknown;
  payloadFingerprint: string;
  history?: RecoveryAttemptHistory[];
  maxSteps?: number;
  sourceRefreshed?: boolean;
  previewRefreshed?: boolean;
}) {
  const policy = getToolRecoveryPolicy(input.code);
  const history = Array.isArray(input.history) ? input.history : [];
  const maxSteps = Math.max(1, Math.min(10, Math.floor(Number(input.maxSteps || 3))));
  const payloadFingerprint = String(input.payloadFingerprint || '');

  if (policy.category === 'decision-required') {
    return { ...policy, decision: 'decision' as const, reason: 'decision-required' as const, maxSteps, stepsUsed: history.length };
  }
  if (policy.category === 'terminal') {
    return { ...policy, decision: 'stop' as const, reason: 'terminal' as const, maxSteps, stepsUsed: history.length };
  }
  if (history.length >= maxSteps) {
    return { ...policy, decision: 'stop' as const, reason: 'budget-exhausted' as const, maxSteps, stepsUsed: history.length };
  }
  if (history.some((entry) => entry.code === policy.code && entry.strategy === policy.strategy && entry.payloadFingerprint === payloadFingerprint)) {
    return { ...policy, decision: 'stop' as const, reason: 'loop-detected' as const, maxSteps, stepsUsed: history.length };
  }
  if (policy.category === 'refresh-repreview') {
    if (input.sourceRefreshed === true && input.previewRefreshed === true) {
      return { ...policy, decision: 'stop' as const, reason: 'fresh-preview-required-before-explicit-apply' as const, maxSteps, stepsUsed: history.length };
    }
    return { ...policy, decision: 'execute' as const, reason: 'refresh-and-repreview' as const, maxSteps, stepsUsed: history.length };
  }
  return { ...policy, decision: 'execute' as const, reason: 'bounded-automatic-recovery' as const, maxSteps, stepsUsed: history.length };
}

export function recoveryPolicyForJobStatus(status: string, errorCode?: string) {
  if (status === 'queued') return getToolRecoveryPolicy('JOB_QUEUED');
  if (status === 'running') return getToolRecoveryPolicy('JOB_RUNNING');
  if (status === 'timed_out') return getToolRecoveryPolicy(errorCode || 'JOB_TIMED_OUT');
  if (status === 'failed') return getToolRecoveryPolicy(errorCode);
  return null;
}
