import { createHash } from 'node:crypto';

export const HARNESS_POLICY_VERSION = 'harness-policy.v1' as const;

export type HarnessPolicyAuthority = 'hard' | 'soft' | 'advisory';
export type HarnessPolicySource =
  | 'hard-invariant'
  | 'explicit-user'
  | 'explicit-task'
  | 'task-default'
  | 'project-default'
  | 'task-risk'
  | 'adaptive'
  | 'conservative-fallback';

export type HarnessRisk = 'low' | 'medium' | 'high' | 'unknown';
export type HarnessWorkKind = 'small-ui' | 'bug-fix' | 'cross-module' | 'high-risk' | 'unknown';
export type ContextSearchBudgetClass = 'compact' | 'standard' | 'expanded';
export type VerificationCoverageIntent = 'none' | 'targeted' | 'broad' | 'full';
export type ScopeRelationship = 'disjoint' | 'overlap' | 'unknown';
export type RelatedWorkState = boolean | 'unknown';

export type HarnessSoftChoices = {
  planningEvidenceRequired?: boolean;
  contextSearchBudgetClass?: ContextSearchBudgetClass;
  verificationCoverage?: VerificationCoverageIntent;
  parallelAllowed?: boolean;
};

export type HarnessPolicyInput = {
  task?: {
    revision?: string;
    risk?: HarnessRisk;
    kind?: HarnessWorkKind;
    explicit?: HarnessSoftChoices;
    defaults?: HarnessSoftChoices;
  };
  user?: {
    revision?: string;
    explicit?: HarnessSoftChoices;
  };
  project?: {
    revision?: string;
    defaults?: HarnessSoftChoices;
  };
  rules?: {
    revision?: string;
  };
  runtime?: {
    revision?: string;
    scopeRelationship?: ScopeRelationship;
    relatedWorkActive?: RelatedWorkState;
    restartRequested?: boolean;
    managedWorkspace?: boolean;
    ownershipProven?: boolean;
    pathsSafe?: boolean;
    workingTreeClean?: boolean;
    commitOwned?: boolean;
    integrationSafe?: boolean;
  };
  adaptive?: {
    revision?: string;
    choices?: HarnessSoftChoices;
  };
};

export type HarnessPolicyDecision<T> = {
  value: T;
  authority: HarnessPolicyAuthority;
  source: HarnessPolicySource;
  reasonCodes: string[];
};

export type HarnessPolicy = {
  version: typeof HARNESS_POLICY_VERSION;
  policyId: string;
  inputFingerprint: string;
  revisionFingerprint: string;
  integrity: {
    requireManagedWorkspace: HarnessPolicyDecision<true>;
    requireWorkspaceOwnership: HarnessPolicyDecision<true>;
    requireRepoRelativePathSafety: HarnessPolicyDecision<true>;
    requireTaskOwnedCommit: HarnessPolicyDecision<true>;
    requireFreshPolicyForLifecycleAction: HarnessPolicyDecision<true>;
    requireSafeFinalizationIntegration: HarnessPolicyDecision<true>;
  };
  planningEvidence: HarnessPolicyDecision<{ required: boolean }>;
  contextSearchBudget: HarnessPolicyDecision<{ budgetClass: ContextSearchBudgetClass }>;
  verification: HarnessPolicyDecision<{
    required: boolean;
    coverage: VerificationCoverageIntent;
    mechanics: 'delegated-to-verification-planner';
  }>;
  parallel: HarnessPolicyDecision<{ eligible: boolean }>;
  restart: HarnessPolicyDecision<{ gate: 'not-requested' | 'allowed' | 'blocked' }>;
  finalization: HarnessPolicyDecision<{
    eligible: boolean;
    requirements: {
      managedWorkspace: true;
      ownershipProven: true;
      pathsSafe: true;
      workingTreeClean: true;
      taskOwnedCommit: true;
      safeIntegration: true;
      freshPolicy: true;
    };
    missingFacts: string[];
  }>;
};

type NormalizedSoftChoices = {
  planningEvidenceRequired?: boolean;
  contextSearchBudgetClass?: ContextSearchBudgetClass;
  verificationCoverage?: VerificationCoverageIntent;
  parallelAllowed?: boolean;
};

type NormalizedHarnessPolicyInput = {
  task: {
    revision: string;
    risk: HarnessRisk;
    kind: HarnessWorkKind;
    explicit: NormalizedSoftChoices;
    defaults: NormalizedSoftChoices;
  };
  user: {
    revision: string;
    explicit: NormalizedSoftChoices;
  };
  project: {
    revision: string;
    defaults: NormalizedSoftChoices;
  };
  rules: { revision: string };
  runtime: {
    revision: string;
    scopeRelationship: ScopeRelationship;
    relatedWorkActive: RelatedWorkState;
    restartRequested: boolean;
    managedWorkspace?: boolean;
    ownershipProven?: boolean;
    pathsSafe?: boolean;
    workingTreeClean?: boolean;
    commitOwned?: boolean;
    integrationSafe?: boolean;
  };
  adaptive: {
    revision: string;
    choices: NormalizedSoftChoices;
  };
};

type SoftChoiceKey = keyof NormalizedSoftChoices;

type SoftResolution<T> = {
  value: T;
  source: Exclude<HarnessPolicySource, 'hard-invariant' | 'task-risk'>;
  reasonCodes: string[];
};

const CONTEXT_RANK: Record<ContextSearchBudgetClass, number> = {
  compact: 0,
  standard: 1,
  expanded: 2,
};

const VERIFICATION_RANK: Record<VerificationCoverageIntent, number> = {
  none: 0,
  targeted: 1,
  broad: 2,
  full: 3,
};

function boundedRevision(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().slice(0, 200) : '';
  return normalized || '<unknown>';
}

function normalizeRisk(value: unknown): HarnessRisk {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'unknown';
}

function normalizeKind(value: unknown): HarnessWorkKind {
  return value === 'small-ui' || value === 'bug-fix' || value === 'cross-module' || value === 'high-risk'
    ? value
    : 'unknown';
}

function normalizeContextBudget(value: unknown): ContextSearchBudgetClass | undefined {
  return value === 'compact' || value === 'standard' || value === 'expanded' ? value : undefined;
}

function normalizeVerificationCoverage(value: unknown): VerificationCoverageIntent | undefined {
  return value === 'none' || value === 'targeted' || value === 'broad' || value === 'full' ? value : undefined;
}

function normalizeSoftChoices(value: unknown): NormalizedSoftChoices {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    planningEvidenceRequired: typeof raw.planningEvidenceRequired === 'boolean' ? raw.planningEvidenceRequired : undefined,
    contextSearchBudgetClass: normalizeContextBudget(raw.contextSearchBudgetClass),
    verificationCoverage: normalizeVerificationCoverage(raw.verificationCoverage),
    parallelAllowed: typeof raw.parallelAllowed === 'boolean' ? raw.parallelAllowed : undefined,
  };
}

function normalizeScopeRelationship(value: unknown): ScopeRelationship {
  return value === 'disjoint' || value === 'overlap' ? value : 'unknown';
}

function normalizeRelatedWorkState(value: unknown): RelatedWorkState {
  return value === true || value === false ? value : 'unknown';
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeInput(input: HarnessPolicyInput): NormalizedHarnessPolicyInput {
  return {
    task: {
      revision: boundedRevision(input.task?.revision),
      risk: normalizeRisk(input.task?.risk),
      kind: normalizeKind(input.task?.kind),
      explicit: normalizeSoftChoices(input.task?.explicit),
      defaults: normalizeSoftChoices(input.task?.defaults),
    },
    user: {
      revision: boundedRevision(input.user?.revision),
      explicit: normalizeSoftChoices(input.user?.explicit),
    },
    project: {
      revision: boundedRevision(input.project?.revision),
      defaults: normalizeSoftChoices(input.project?.defaults),
    },
    rules: {
      revision: boundedRevision(input.rules?.revision),
    },
    runtime: {
      revision: boundedRevision(input.runtime?.revision),
      scopeRelationship: normalizeScopeRelationship(input.runtime?.scopeRelationship),
      relatedWorkActive: normalizeRelatedWorkState(input.runtime?.relatedWorkActive),
      restartRequested: input.runtime?.restartRequested === true,
      managedWorkspace: optionalBoolean(input.runtime?.managedWorkspace),
      ownershipProven: optionalBoolean(input.runtime?.ownershipProven),
      pathsSafe: optionalBoolean(input.runtime?.pathsSafe),
      workingTreeClean: optionalBoolean(input.runtime?.workingTreeClean),
      commitOwned: optionalBoolean(input.runtime?.commitOwned),
      integrationSafe: optionalBoolean(input.runtime?.integrationSafe),
    },
    adaptive: {
      revision: boundedRevision(input.adaptive?.revision),
      choices: normalizeSoftChoices(input.adaptive?.choices),
    },
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function revisionIdentity(input: NormalizedHarnessPolicyInput) {
  return {
    task: input.task.revision,
    user: input.user.revision,
    project: input.project.revision,
    rules: input.rules.revision,
    runtime: input.runtime.revision,
    adaptive: input.adaptive.revision,
  };
}

function riskFallback(input: NormalizedHarnessPolicyInput): Required<NormalizedSoftChoices> {
  const unknown = input.task.risk === 'unknown' || input.task.kind === 'unknown';
  const high = input.task.risk === 'high' || input.task.kind === 'high-risk' || input.task.kind === 'cross-module';
  if (unknown) {
    return {
      planningEvidenceRequired: true,
      contextSearchBudgetClass: 'expanded',
      verificationCoverage: 'broad',
      parallelAllowed: false,
    };
  }
  if (high) {
    return {
      planningEvidenceRequired: true,
      contextSearchBudgetClass: 'expanded',
      verificationCoverage: 'broad',
      parallelAllowed: true,
    };
  }
  if (input.task.kind === 'bug-fix') {
    return {
      planningEvidenceRequired: true,
      contextSearchBudgetClass: 'standard',
      verificationCoverage: 'targeted',
      parallelAllowed: true,
    };
  }
  return {
    planningEvidenceRequired: false,
    contextSearchBudgetClass: input.task.risk === 'medium' ? 'standard' : 'compact',
    verificationCoverage: input.task.risk === 'medium' ? 'targeted' : 'targeted',
    parallelAllowed: true,
  };
}

function resolveSoftChoice<K extends SoftChoiceKey>(
  input: NormalizedHarnessPolicyInput,
  key: K,
  fallback: Required<NormalizedSoftChoices>[K],
): SoftResolution<Required<NormalizedSoftChoices>[K]> {
  const candidates = [
    { source: 'explicit-user' as const, value: input.user.explicit[key], reason: 'EXPLICIT_USER_DIRECTIVE' },
    { source: 'explicit-task' as const, value: input.task.explicit[key], reason: 'EXPLICIT_TASK_DIRECTIVE' },
    { source: 'task-default' as const, value: input.task.defaults[key], reason: 'TASK_DEFAULT_APPLIED' },
    { source: 'project-default' as const, value: input.project.defaults[key], reason: 'PROJECT_DEFAULT_APPLIED' },
    { source: 'adaptive' as const, value: input.adaptive.choices[key], reason: 'ADAPTIVE_CHOICE_APPLIED' },
  ].filter((entry) => entry.value !== undefined);

  if (candidates.length === 0) {
    return {
      value: fallback,
      source: 'conservative-fallback',
      reasonCodes: ['DEFAULT_POLICY_APPLIED'],
    };
  }

  const selected = candidates[0]!;
  const conflict = candidates.some((entry) => entry.value !== selected.value);
  return {
    value: selected.value as Required<NormalizedSoftChoices>[K],
    source: selected.source,
    reasonCodes: [selected.reason, ...(conflict ? ['SOFT_DIRECTIVE_CONFLICT_RESOLVED'] : [])],
  };
}

function unknownInputReasons(input: NormalizedHarnessPolicyInput) {
  const reasons: string[] = [];
  if (input.task.risk === 'unknown') reasons.push('TASK_RISK_UNKNOWN');
  if (input.task.kind === 'unknown') reasons.push('TASK_KIND_UNKNOWN');
  if (input.task.revision === '<unknown>') reasons.push('TASK_REVISION_UNKNOWN');
  if (input.project.revision === '<unknown>') reasons.push('PROJECT_REVISION_UNKNOWN');
  if (input.rules.revision === '<unknown>') reasons.push('RULE_REVISION_UNKNOWN');
  if (input.runtime.revision === '<unknown>') reasons.push('RUNTIME_REVISION_UNKNOWN');
  return reasons;
}

function hardDecision<T>(value: T, reasonCodes: string[]): HarnessPolicyDecision<T> {
  return { value, authority: 'hard', source: 'hard-invariant', reasonCodes };
}

function applyPlanningRiskMinimum(
  input: NormalizedHarnessPolicyInput,
  resolved: SoftResolution<boolean>,
): HarnessPolicyDecision<{ required: boolean }> {
  const mustPlan = input.task.risk === 'high'
    || input.task.risk === 'unknown'
    || input.task.kind === 'cross-module'
    || input.task.kind === 'high-risk'
    || input.task.kind === 'unknown';
  if (mustPlan && resolved.value === false) {
    return {
      value: { required: true },
      authority: 'soft',
      source: 'task-risk',
      reasonCodes: [...resolved.reasonCodes, 'TASK_RISK_MINIMUM_ENFORCED'],
    };
  }
  return {
    value: { required: resolved.value },
    authority: 'soft',
    source: resolved.source,
    reasonCodes: resolved.reasonCodes,
  };
}

function minimumContextBudget(input: NormalizedHarnessPolicyInput): ContextSearchBudgetClass {
  if (input.task.risk === 'high' || input.task.risk === 'unknown' || input.task.kind === 'cross-module' || input.task.kind === 'high-risk' || input.task.kind === 'unknown') {
    return 'expanded';
  }
  if (input.task.risk === 'medium' || input.task.kind === 'bug-fix') return 'standard';
  return 'compact';
}

function applyContextRiskMinimum(
  input: NormalizedHarnessPolicyInput,
  resolved: SoftResolution<ContextSearchBudgetClass>,
): HarnessPolicyDecision<{ budgetClass: ContextSearchBudgetClass }> {
  const minimum = minimumContextBudget(input);
  if (CONTEXT_RANK[resolved.value] < CONTEXT_RANK[minimum]) {
    return {
      value: { budgetClass: minimum },
      authority: 'advisory',
      source: 'task-risk',
      reasonCodes: [...resolved.reasonCodes, 'TASK_RISK_MINIMUM_ENFORCED'],
    };
  }
  return {
    value: { budgetClass: resolved.value },
    authority: 'advisory',
    source: resolved.source,
    reasonCodes: resolved.reasonCodes,
  };
}

function minimumVerificationCoverage(input: NormalizedHarnessPolicyInput): VerificationCoverageIntent {
  if (input.task.risk === 'high' || input.task.risk === 'unknown' || input.task.kind === 'cross-module' || input.task.kind === 'high-risk' || input.task.kind === 'unknown') {
    return 'broad';
  }
  if (input.task.risk === 'medium') return 'targeted';
  return 'none';
}

function applyVerificationRiskMinimum(
  input: NormalizedHarnessPolicyInput,
  resolved: SoftResolution<VerificationCoverageIntent>,
): HarnessPolicyDecision<HarnessPolicy['verification']['value']> {
  const minimum = minimumVerificationCoverage(input);
  const coverage = VERIFICATION_RANK[resolved.value] < VERIFICATION_RANK[minimum] ? minimum : resolved.value;
  const escalated = coverage !== resolved.value;
  const source: HarnessPolicySource = escalated ? 'task-risk' : resolved.source;
  const reasonCodes = [
    ...resolved.reasonCodes,
    ...(escalated ? ['TASK_RISK_MINIMUM_ENFORCED'] : []),
    ...(coverage === 'none' && input.task.kind === 'small-ui' ? ['SMALL_UI_SOFT_VERIFICATION_WAIVER'] : []),
    'VERIFICATION_MECHANICS_DELEGATED',
  ];
  return {
    value: {
      required: coverage !== 'none',
      coverage,
      mechanics: 'delegated-to-verification-planner',
    },
    authority: 'soft',
    source,
    reasonCodes,
  };
}

function evaluateParallel(
  input: NormalizedHarnessPolicyInput,
  resolved: SoftResolution<boolean>,
): HarnessPolicyDecision<{ eligible: boolean }> {
  if (input.runtime.scopeRelationship === 'overlap') {
    return hardDecision({ eligible: false }, ['ACTIVE_SCOPE_COLLISION']);
  }
  if (input.runtime.scopeRelationship === 'unknown') {
    return hardDecision({ eligible: false }, ['SCOPE_RELATIONSHIP_UNKNOWN', 'CONSERVATIVE_PARALLEL_BLOCK']);
  }
  return {
    value: { eligible: resolved.value },
    authority: 'soft',
    source: resolved.source,
    reasonCodes: [...resolved.reasonCodes, 'DISJOINT_SCOPE_CONFIRMED'],
  };
}

function evaluateRestart(input: NormalizedHarnessPolicyInput): HarnessPolicyDecision<{ gate: 'not-requested' | 'allowed' | 'blocked' }> {
  if (!input.runtime.restartRequested) return hardDecision({ gate: 'not-requested' }, ['RESTART_NOT_REQUESTED']);
  if (input.runtime.relatedWorkActive === true) return hardDecision({ gate: 'blocked' }, ['RELATED_WORK_ACTIVE']);
  if (input.runtime.relatedWorkActive === 'unknown') {
    return hardDecision({ gate: 'blocked' }, ['RELATED_WORK_STATE_UNKNOWN', 'CONSERVATIVE_RESTART_BLOCK']);
  }
  return hardDecision({ gate: 'allowed' }, ['RELATED_WORK_INACTIVE']);
}

function evaluateFinalization(input: NormalizedHarnessPolicyInput): HarnessPolicy['finalization'] {
  const requiredFacts: Array<[string, boolean | undefined]> = [
    ['managedWorkspace', input.runtime.managedWorkspace],
    ['ownershipProven', input.runtime.ownershipProven],
    ['pathsSafe', input.runtime.pathsSafe],
    ['workingTreeClean', input.runtime.workingTreeClean],
    ['taskOwnedCommit', input.runtime.commitOwned],
    ['safeIntegration', input.runtime.integrationSafe],
  ];
  const missingFacts = requiredFacts.filter(([, value]) => value !== true).map(([name]) => name);
  return hardDecision({
    eligible: missingFacts.length === 0,
    requirements: {
      managedWorkspace: true,
      ownershipProven: true,
      pathsSafe: true,
      workingTreeClean: true,
      taskOwnedCommit: true,
      safeIntegration: true,
      freshPolicy: true,
    },
    missingFacts,
  }, missingFacts.length === 0
    ? ['FINALIZATION_INTEGRITY_SATISFIED', 'POLICY_FRESHNESS_REQUIRED']
    : ['FINALIZATION_INTEGRITY_INCOMPLETE', 'POLICY_FRESHNESS_REQUIRED']);
}

export function evaluateHarnessPolicy(rawInput: HarnessPolicyInput): HarnessPolicy {
  const input = normalizeInput(rawInput || {});
  const fallback = riskFallback(input);
  const unknownReasons = unknownInputReasons(input);

  const planningResolved = resolveSoftChoice(input, 'planningEvidenceRequired', fallback.planningEvidenceRequired);
  const contextResolved = resolveSoftChoice(input, 'contextSearchBudgetClass', fallback.contextSearchBudgetClass);
  const verificationResolved = resolveSoftChoice(input, 'verificationCoverage', fallback.verificationCoverage);
  const parallelResolved = resolveSoftChoice(input, 'parallelAllowed', fallback.parallelAllowed);

  const planningEvidence = applyPlanningRiskMinimum(input, planningResolved);
  const contextSearchBudget = applyContextRiskMinimum(input, contextResolved);
  const verification = applyVerificationRiskMinimum(input, verificationResolved);
  const parallel = evaluateParallel(input, parallelResolved);
  const restart = evaluateRestart(input);
  const finalization = evaluateFinalization(input);

  if (unknownReasons.length > 0) {
    planningEvidence.reasonCodes = [...planningEvidence.reasonCodes, ...unknownReasons, 'UNKNOWN_INPUT_CONSERVATIVE'];
    contextSearchBudget.reasonCodes = [...contextSearchBudget.reasonCodes, ...unknownReasons, 'UNKNOWN_INPUT_CONSERVATIVE'];
    verification.reasonCodes = [...verification.reasonCodes, ...unknownReasons, 'UNKNOWN_INPUT_CONSERVATIVE'];
  }

  const inputFingerprint = fingerprint({ version: HARNESS_POLICY_VERSION, input });
  const revisionFingerprint = fingerprint({ version: HARNESS_POLICY_VERSION, revisions: revisionIdentity(input) });

  return {
    version: HARNESS_POLICY_VERSION,
    policyId: `${HARNESS_POLICY_VERSION}:${inputFingerprint.slice(0, 24)}`,
    inputFingerprint,
    revisionFingerprint,
    integrity: {
      requireManagedWorkspace: hardDecision(true, ['MANAGED_WORKSPACE_REQUIRED']),
      requireWorkspaceOwnership: hardDecision(true, ['WORKSPACE_OWNERSHIP_REQUIRED']),
      requireRepoRelativePathSafety: hardDecision(true, ['REPO_RELATIVE_PATH_SAFETY_REQUIRED']),
      requireTaskOwnedCommit: hardDecision(true, ['TASK_OWNED_COMMIT_REQUIRED']),
      requireFreshPolicyForLifecycleAction: hardDecision(true, ['POLICY_FRESHNESS_REQUIRED']),
      requireSafeFinalizationIntegration: hardDecision(true, ['SAFE_FINALIZATION_INTEGRATION_REQUIRED']),
    },
    planningEvidence,
    contextSearchBudget,
    verification,
    parallel,
    restart,
    finalization,
  };
}

export function isHarnessPolicyCurrent(policy: HarnessPolicy, input: HarnessPolicyInput): boolean {
  if (!policy || policy.version !== HARNESS_POLICY_VERSION) return false;
  const fresh = evaluateHarnessPolicy(input);
  return policy.inputFingerprint === fresh.inputFingerprint
    && policy.revisionFingerprint === fresh.revisionFingerprint
    && policy.policyId === fresh.policyId;
}
