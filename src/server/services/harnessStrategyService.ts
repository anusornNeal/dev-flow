import { createHash } from 'node:crypto';

import type {
  ContextSearchBudgetClass,
  HarnessPolicyAuthority,
  HarnessPolicySource,
  HarnessRisk,
  HarnessWorkKind,
  VerificationCoverageIntent,
} from './harnessPolicyService.js';

export const HARNESS_STRATEGY_VERSION = 'harness-strategy.v1' as const;

export type HarnessStrategyDisclosureLevel = 'project-summary' | 'symbols' | 'snippets' | 'callers-tests';
export type HarnessStrategyRolloutMode = 'shadow' | 'bounded-auto';
export type HarnessStrategyEvidenceSource = 'calibration' | 'holdout' | 'runtime';
export type HarnessStrategyEvidenceScope = 'task-class' | 'global';
export type HarnessStrategyRegression = 'improvement' | 'unchanged' | 'regression';

export type HarnessStrategyChoices = {
  contextProfile: HarnessStrategyDisclosureLevel;
  contextSearchBudgetClass: ContextSearchBudgetClass;
  searchReadBudget: number;
  planningEvidenceRequired: boolean;
  verificationCoverage: VerificationCoverageIntent;
};

export type HarnessStrategyTaskInput = {
  risk?: HarnessRisk;
  kind?: HarnessWorkKind;
  targetFileCount?: number;
  sharedContract?: boolean;
  reproductionAvailable?: boolean;
  explicitVerificationWaiver?: boolean;
  hardSafetyAffected?: boolean;
};

export type HarnessStrategyTaskFingerprint = {
  version: 'harness-task-fingerprint.v1';
  fingerprint: string;
  normalized: {
    risk: HarnessRisk;
    kind: HarnessWorkKind;
    targetFileBucket: '0-1' | '2-4' | '5+' | 'unknown';
    sharedContract: boolean | 'unknown';
    reproductionAvailable: boolean | 'unknown';
    explicitVerificationWaiver: boolean | 'unknown';
    hardSafetyAffected: boolean | 'unknown';
  };
};

export type HarnessStrategyContextGovernorInput = {
  planIdentity?: string;
  disclosureLevel?: HarnessStrategyDisclosureLevel;
  maxContextBytes?: number;
  maxSearchReadBudget?: number;
};

export type HarnessStrategyPolicyDecision<T> = {
  value: T;
  authority?: HarnessPolicyAuthority;
  source?: HarnessPolicySource;
};

export type HarnessStrategyPolicyInput = {
  planningEvidence?: HarnessStrategyPolicyDecision<{ required: boolean }>;
  contextSearchBudget?: HarnessStrategyPolicyDecision<{ budgetClass: ContextSearchBudgetClass }>;
  verification?: HarnessStrategyPolicyDecision<{ required: boolean; coverage: VerificationCoverageIntent }>;
  hardSafetyBlocked?: boolean;
};

export type HarnessStrategyEvidence = {
  evidenceId: string;
  evidenceWindow: string;
  source: HarnessStrategyEvidenceSource;
  scope?: HarnessStrategyEvidenceScope;
  taskFingerprint?: string;
  strategyVersion: string;
  choices: HarnessStrategyChoices;
  sampleCount: number;
  oraclePassRate: number;
  firstPassSuccessRate: number;
  repairRate: number;
  retryRate: number;
  verificationFailureRate: number;
  averageContextBytes: number;
  averageToolCallCount: number;
  regression?: HarnessStrategyRegression;
};

export type HarnessStrategyRolloutInput = {
  mode?: HarnessStrategyRolloutMode;
  minSamples?: number;
  minConfidence?: number;
  minOraclePassRate?: number;
  minScoreMargin?: number;
  hysteresisMargin?: number;
  cooldownDecisions?: number;
  decisionSequence?: number;
  previous?: {
    strategyId?: string;
    lastChangedDecisionSequence?: number;
  };
};

export type HarnessStrategyInput = {
  task: HarnessStrategyTaskInput;
  contextGovernor?: HarnessStrategyContextGovernorInput;
  policy?: HarnessStrategyPolicyInput;
  evidence?: HarnessStrategyEvidence[];
  rollout?: HarnessStrategyRolloutInput;
};

export type HarnessStrategyDecision = {
  version: typeof HARNESS_STRATEGY_VERSION;
  decisionId: string;
  taskFingerprint: HarnessStrategyTaskFingerprint;
  strategyId: string;
  strategyVersion: string;
  status: 'fallback' | 'recommended';
  recommendation: HarnessStrategyChoices;
  adaptivePolicyChoices: {
    planningEvidenceRequired: boolean;
    contextSearchBudgetClass: ContextSearchBudgetClass;
    verificationCoverage: VerificationCoverageIntent;
  };
  rollout: {
    mode: HarnessStrategyRolloutMode;
    autoApplyEligible: boolean;
  };
  confidence: number;
  score: number;
  scoreMargin: number;
  evidence: {
    sampleCount: number;
    matchingEvidenceIds: string[];
    evidenceWindows: string[];
    sources: HarnessStrategyEvidenceSource[];
    holdoutValidated: boolean;
  };
  reasonCodes: string[];
};

type NormalizedEvidence = Omit<HarnessStrategyEvidence, 'scope' | 'sampleCount' | 'oraclePassRate' | 'firstPassSuccessRate' | 'repairRate' | 'retryRate' | 'verificationFailureRate' | 'averageContextBytes' | 'averageToolCallCount'> & {
  scope: HarnessStrategyEvidenceScope;
  sampleCount: number;
  oraclePassRate: number;
  firstPassSuccessRate: number;
  repairRate: number;
  retryRate: number;
  verificationFailureRate: number;
  averageContextBytes: number;
  averageToolCallCount: number;
};

type CandidateAggregate = {
  key: string;
  strategyVersion: string;
  choices: HarnessStrategyChoices;
  records: NormalizedEvidence[];
  holdout: NormalizedEvidence[];
  sampleCount: number;
  oraclePassRate: number;
  firstPassSuccessRate: number;
  repairRate: number;
  retryRate: number;
  verificationFailureRate: number;
  averageContextBytes: number;
  averageToolCallCount: number;
  qualityScore: number;
  score: number;
};

const DISCLOSURE_RANK: Record<HarnessStrategyDisclosureLevel, number> = {
  'project-summary': 0,
  symbols: 1,
  snippets: 2,
  'callers-tests': 3,
};

const LOCKING_POLICY_SOURCES = new Set<HarnessPolicySource>([
  'hard-invariant',
  'explicit-user',
  'explicit-task',
  'task-default',
  'project-default',
  'task-risk',
]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function hash(value: unknown, length = 24) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex').slice(0, length);
}

function clampRate(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function clampNonNegative(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function round(value: number, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeRisk(value: unknown): HarnessRisk {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'unknown';
}

function normalizeKind(value: unknown): HarnessWorkKind {
  return value === 'small-ui' || value === 'bug-fix' || value === 'cross-module' || value === 'high-risk'
    ? value
    : 'unknown';
}

function normalizeBoolean(value: unknown): boolean | 'unknown' {
  return typeof value === 'boolean' ? value : 'unknown';
}

function targetFileBucket(value: unknown): HarnessStrategyTaskFingerprint['normalized']['targetFileBucket'] {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unknown';
  if (value <= 1) return '0-1';
  if (value <= 4) return '2-4';
  return '5+';
}

export function createHarnessTaskFingerprint(task: HarnessStrategyTaskInput): HarnessStrategyTaskFingerprint {
  const normalized = {
    risk: normalizeRisk(task.risk),
    kind: normalizeKind(task.kind),
    targetFileBucket: targetFileBucket(task.targetFileCount),
    sharedContract: normalizeBoolean(task.sharedContract),
    reproductionAvailable: normalizeBoolean(task.reproductionAvailable),
    explicitVerificationWaiver: normalizeBoolean(task.explicitVerificationWaiver),
    hardSafetyAffected: normalizeBoolean(task.hardSafetyAffected),
  } as const;
  return {
    version: 'harness-task-fingerprint.v1',
    fingerprint: `harness-task-fingerprint.v1:${hash(normalized, 32)}`,
    normalized,
  };
}

function deterministicDefault(task: HarnessStrategyTaskFingerprint['normalized']): HarnessStrategyChoices {
  const high = task.risk === 'high' || task.kind === 'cross-module' || task.kind === 'high-risk';
  const unknown = task.risk === 'unknown' || task.kind === 'unknown';
  if (unknown || high) {
    return {
      contextProfile: 'callers-tests',
      contextSearchBudgetClass: 'expanded',
      searchReadBudget: 8,
      planningEvidenceRequired: true,
      verificationCoverage: 'broad',
    };
  }
  if (task.kind === 'bug-fix') {
    return {
      contextProfile: task.sharedContract === true ? 'callers-tests' : 'snippets',
      contextSearchBudgetClass: 'standard',
      searchReadBudget: task.sharedContract === true ? 6 : 5,
      planningEvidenceRequired: true,
      verificationCoverage: 'targeted',
    };
  }
  return {
    contextProfile: 'snippets',
    contextSearchBudgetClass: task.risk === 'medium' ? 'standard' : 'compact',
    searchReadBudget: task.risk === 'medium' ? 5 : 3,
    planningEvidenceRequired: false,
    verificationCoverage: 'targeted',
  };
}

function normalizedChoices(value: HarnessStrategyChoices): HarnessStrategyChoices {
  const profile = value?.contextProfile;
  const contextProfile: HarnessStrategyDisclosureLevel = profile in DISCLOSURE_RANK ? profile : 'snippets';
  const contextSearchBudgetClass: ContextSearchBudgetClass = value?.contextSearchBudgetClass === 'compact'
    || value?.contextSearchBudgetClass === 'standard'
    || value?.contextSearchBudgetClass === 'expanded'
    ? value.contextSearchBudgetClass
    : 'standard';
  const verificationCoverage: VerificationCoverageIntent = value?.verificationCoverage === 'none'
    || value?.verificationCoverage === 'targeted'
    || value?.verificationCoverage === 'broad'
    || value?.verificationCoverage === 'full'
    ? value.verificationCoverage
    : 'targeted';
  return {
    contextProfile,
    contextSearchBudgetClass,
    searchReadBudget: boundedInteger(value?.searchReadBudget, 5, 1, 12),
    planningEvidenceRequired: value?.planningEvidenceRequired === true,
    verificationCoverage,
  };
}

function normalizeEvidence(records: HarnessStrategyEvidence[]): NormalizedEvidence[] {
  return records
    .filter((record) => record && typeof record === 'object' && typeof record.evidenceId === 'string' && typeof record.strategyVersion === 'string')
    .map((record) => ({
      ...record,
      scope: (record.scope === 'global' ? 'global' : 'task-class') as HarnessStrategyEvidenceScope,
      evidenceId: record.evidenceId.trim().slice(0, 160),
      evidenceWindow: String(record.evidenceWindow || '<unknown>').trim().slice(0, 160),
      strategyVersion: record.strategyVersion.trim().slice(0, 120),
      choices: normalizedChoices(record.choices),
      sampleCount: boundedInteger(record.sampleCount, 0, 0, 1_000_000),
      oraclePassRate: clampRate(record.oraclePassRate),
      firstPassSuccessRate: clampRate(record.firstPassSuccessRate),
      repairRate: clampRate(record.repairRate),
      retryRate: clampRate(record.retryRate),
      verificationFailureRate: clampRate(record.verificationFailureRate),
      averageContextBytes: clampNonNegative(record.averageContextBytes),
      averageToolCallCount: clampNonNegative(record.averageToolCallCount),
      regression: record.regression === 'improvement' || record.regression === 'unchanged' || record.regression === 'regression'
        ? record.regression
        : undefined,
    }))
    .filter((record) => record.evidenceId.length > 0 && record.strategyVersion.length > 0 && record.sampleCount > 0);
}

function candidateKey(strategyVersion: string, choices: HarnessStrategyChoices) {
  return `${strategyVersion}:${hash(choices, 20)}`;
}

function weightedAverage(records: NormalizedEvidence[], key: keyof Pick<NormalizedEvidence,
  'oraclePassRate' | 'firstPassSuccessRate' | 'repairRate' | 'retryRate' | 'verificationFailureRate' | 'averageContextBytes' | 'averageToolCallCount'>) {
  const sampleCount = records.reduce((sum, record) => sum + record.sampleCount, 0);
  if (sampleCount <= 0) return 0;
  return records.reduce((sum, record) => sum + Number(record[key]) * record.sampleCount, 0) / sampleCount;
}

function buildCandidates(matching: NormalizedEvidence[], allEvidence: NormalizedEvidence[]): CandidateAggregate[] {
  const grouped = new Map<string, NormalizedEvidence[]>();
  for (const record of matching) {
    const key = candidateKey(record.strategyVersion, record.choices);
    grouped.set(key, [...(grouped.get(key) || []), record]);
  }
  const aggregates: CandidateAggregate[] = [];
  for (const [key, records] of grouped) {
    const first = records[0]!;
    const holdout = allEvidence.filter((record) => record.source === 'holdout' && candidateKey(record.strategyVersion, record.choices) === key);
    const sampleCount = records.reduce((sum, record) => sum + record.sampleCount, 0);
    const oraclePassRate = weightedAverage(records, 'oraclePassRate');
    const firstPassSuccessRate = weightedAverage(records, 'firstPassSuccessRate');
    const repairRate = weightedAverage(records, 'repairRate');
    const retryRate = weightedAverage(records, 'retryRate');
    const verificationFailureRate = weightedAverage(records, 'verificationFailureRate');
    const qualityScore = (
      oraclePassRate * 0.60
      + firstPassSuccessRate * 0.20
      + (1 - repairRate) * 0.08
      + (1 - retryRate) * 0.06
      + (1 - verificationFailureRate) * 0.06
    );
    aggregates.push({
      key,
      strategyVersion: first.strategyVersion,
      choices: first.choices,
      records,
      holdout,
      sampleCount,
      oraclePassRate,
      firstPassSuccessRate,
      repairRate,
      retryRate,
      verificationFailureRate,
      averageContextBytes: weightedAverage(records, 'averageContextBytes'),
      averageToolCallCount: weightedAverage(records, 'averageToolCallCount'),
      qualityScore,
      score: 0,
    });
  }
  const maxContext = Math.max(1, ...aggregates.map((candidate) => candidate.averageContextBytes));
  const maxTools = Math.max(1, ...aggregates.map((candidate) => candidate.averageToolCallCount));
  for (const candidate of aggregates) {
    const contextEfficiency = 1 - Math.min(1, candidate.averageContextBytes / maxContext);
    const toolEfficiency = 1 - Math.min(1, candidate.averageToolCallCount / maxTools);
    const efficiencyScore = aggregates.length === 1 ? 1 : (contextEfficiency + toolEfficiency) / 2;
    candidate.score = round(candidate.qualityScore * 0.82 + efficiencyScore * 0.18);
  }
  return aggregates.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
}

function applyContextGovernorBounds(
  choices: HarnessStrategyChoices,
  context: HarnessStrategyContextGovernorInput | undefined,
  reasons: string[],
): HarnessStrategyChoices {
  if (!context) return choices;
  let next = { ...choices };
  if (context.disclosureLevel && context.disclosureLevel in DISCLOSURE_RANK
    && DISCLOSURE_RANK[next.contextProfile] > DISCLOSURE_RANK[context.disclosureLevel]) {
    next.contextProfile = context.disclosureLevel;
    reasons.push('CONTEXT_GOVERNOR_DISCLOSURE_BOUND_APPLIED');
  }
  let searchReadCap = boundedInteger(context.maxSearchReadBudget, 12, 1, 12);
  if (typeof context.maxContextBytes === 'number' && Number.isFinite(context.maxContextBytes) && context.maxContextBytes >= 0) {
    const byteCap = context.maxContextBytes <= 16_000 ? 4 : context.maxContextBytes <= 40_000 ? 6 : 8;
    searchReadCap = Math.min(searchReadCap, byteCap);
  }
  if (next.searchReadBudget > searchReadCap) {
    next.searchReadBudget = searchReadCap;
    reasons.push('CONTEXT_GOVERNOR_SEARCH_READ_BOUND_APPLIED');
  }
  return next;
}

function policyDecisionLocked(source: HarnessPolicySource | undefined) {
  return source !== undefined && LOCKING_POLICY_SOURCES.has(source);
}

function applyPolicyBounds(
  choices: HarnessStrategyChoices,
  policy: HarnessStrategyPolicyInput | undefined,
  reasons: string[],
) {
  let next = { ...choices };
  let conflict = false;
  if (policy?.planningEvidence && policyDecisionLocked(policy.planningEvidence.source)) {
    const value = policy.planningEvidence.value.required;
    if (next.planningEvidenceRequired !== value) conflict = true;
    next.planningEvidenceRequired = value;
  }
  if (policy?.contextSearchBudget && policyDecisionLocked(policy.contextSearchBudget.source)) {
    const value = policy.contextSearchBudget.value.budgetClass;
    if (next.contextSearchBudgetClass !== value) conflict = true;
    next.contextSearchBudgetClass = value;
  }
  if (policy?.verification && policyDecisionLocked(policy.verification.source)) {
    const value = policy.verification.value.coverage;
    if (next.verificationCoverage !== value) conflict = true;
    next.verificationCoverage = value;
  }
  if (conflict) reasons.push('POLICY_CONSTRAINT_APPLIED');
  return { choices: next, conflict };
}

function rolloutConfig(input: HarnessStrategyRolloutInput | undefined) {
  return {
    mode: input?.mode === 'bounded-auto' ? 'bounded-auto' as const : 'shadow' as const,
    minSamples: boundedInteger(input?.minSamples, 6, 1, 10_000),
    minConfidence: clampRate(input?.minConfidence, 0.80),
    minOraclePassRate: clampRate(input?.minOraclePassRate, 0.95),
    minScoreMargin: clampRate(input?.minScoreMargin, 0.03),
    hysteresisMargin: clampRate(input?.hysteresisMargin, 0.02),
    cooldownDecisions: boundedInteger(input?.cooldownDecisions, 3, 0, 10_000),
    decisionSequence: boundedInteger(input?.decisionSequence, 0, 0, Number.MAX_SAFE_INTEGER),
    previous: input?.previous,
  };
}

function finalizeDecision(args: {
  taskFingerprint: HarnessStrategyTaskFingerprint;
  status: 'fallback' | 'recommended';
  choices: HarnessStrategyChoices;
  strategyVersion: string;
  confidence: number;
  score: number;
  scoreMargin: number;
  sampleCount: number;
  records: NormalizedEvidence[];
  holdoutValidated: boolean;
  mode: HarnessStrategyRolloutMode;
  autoApplyEligible: boolean;
  reasonCodes: string[];
}) : HarnessStrategyDecision {
  const strategyId = `${HARNESS_STRATEGY_VERSION}:${hash({ strategyVersion: args.strategyVersion, choices: args.choices }, 24)}`;
  const evidenceIds = [...new Set(args.records.map((record) => record.evidenceId))].sort();
  const evidenceWindows = [...new Set(args.records.map((record) => record.evidenceWindow))].sort();
  const sources = [...new Set(args.records.map((record) => record.source))].sort() as HarnessStrategyEvidenceSource[];
  const reasonCodes = [...new Set(args.reasonCodes)].sort();
  const decisionIdentity = {
    taskFingerprint: args.taskFingerprint.fingerprint,
    strategyId,
    status: args.status,
    confidence: round(args.confidence),
    score: round(args.score),
    scoreMargin: round(args.scoreMargin),
    evidenceIds,
    evidenceWindows,
    holdoutValidated: args.holdoutValidated,
    mode: args.mode,
    autoApplyEligible: args.autoApplyEligible,
    reasonCodes,
  };
  return {
    version: HARNESS_STRATEGY_VERSION,
    decisionId: `${HARNESS_STRATEGY_VERSION}:decision:${hash(decisionIdentity, 32)}`,
    taskFingerprint: args.taskFingerprint,
    strategyId,
    strategyVersion: args.strategyVersion,
    status: args.status,
    recommendation: args.choices,
    adaptivePolicyChoices: {
      planningEvidenceRequired: args.choices.planningEvidenceRequired,
      contextSearchBudgetClass: args.choices.contextSearchBudgetClass,
      verificationCoverage: args.choices.verificationCoverage,
    },
    rollout: {
      mode: args.mode,
      autoApplyEligible: args.autoApplyEligible,
    },
    confidence: round(args.confidence),
    score: round(args.score),
    scoreMargin: round(args.scoreMargin),
    evidence: {
      sampleCount: args.sampleCount,
      matchingEvidenceIds: evidenceIds,
      evidenceWindows,
      sources,
      holdoutValidated: args.holdoutValidated,
    },
    reasonCodes,
  };
}

export function recommendHarnessStrategy(input: HarnessStrategyInput): HarnessStrategyDecision {
  const taskFingerprint = createHarnessTaskFingerprint(input.task || {});
  const config = rolloutConfig(input.rollout);
  const normalizedEvidence = normalizeEvidence(input.evidence || []);
  const matching = normalizedEvidence.filter((record) => record.scope === 'task-class' && record.taskFingerprint === taskFingerprint.fingerprint);
  const mismatchedTaskEvidence = normalizedEvidence.some((record) => record.scope === 'task-class' && record.taskFingerprint !== taskFingerprint.fingerprint);
  const reasons: string[] = [];

  const fallback = (extraReasons: string[], records: NormalizedEvidence[] = []) => {
    let choices = deterministicDefault(taskFingerprint.normalized);
    choices = applyContextGovernorBounds(choices, input.contextGovernor, reasons);
    const policyResult = applyPolicyBounds(choices, input.policy, reasons);
    choices = policyResult.choices;
    return finalizeDecision({
      taskFingerprint,
      status: 'fallback',
      choices,
      strategyVersion: 'deterministic-default.v1',
      confidence: 0,
      score: 0,
      scoreMargin: 0,
      sampleCount: records.reduce((sum, record) => sum + record.sampleCount, 0),
      records,
      holdoutValidated: false,
      mode: config.mode,
      autoApplyEligible: false,
      reasonCodes: [...reasons, ...extraReasons, 'DETERMINISTIC_FALLBACK'],
    });
  };

  if (input.policy?.hardSafetyBlocked === true || taskFingerprint.normalized.hardSafetyAffected === true) {
    return fallback(['HARD_POLICY_BLOCK']);
  }
  if (matching.length === 0) {
    return fallback([mismatchedTaskEvidence ? 'DISTRIBUTION_SHIFT_FALLBACK' : 'COLD_START_FALLBACK']);
  }

  const candidates = buildCandidates(matching, normalizedEvidence)
    .filter((candidate) => !candidate.holdout.some((record) => record.regression === 'regression'));
  if (candidates.length === 0) {
    return fallback(['HOLDOUT_REGRESSION_REJECTED'], matching);
  }

  const top = candidates[0]!;
  if (top.sampleCount < config.minSamples) {
    return fallback(['INSUFFICIENT_EVIDENCE'], top.records);
  }
  if (top.oraclePassRate < config.minOraclePassRate) {
    return fallback(['QUALITY_GUARDRAIL_FAILED'], top.records);
  }
  const runnerUp = candidates[1];
  const scoreMargin = runnerUp ? round(top.score - runnerUp.score) : 1;
  if (runnerUp && scoreMargin < config.minScoreMargin) {
    return fallback(['CONFLICTING_EVIDENCE'], [...top.records, ...runnerUp.records]);
  }

  const confidence = round(Math.min(1, top.sampleCount / config.minSamples) * (0.5 + top.qualityScore * 0.5));
  let choices = applyContextGovernorBounds(top.choices, input.contextGovernor, reasons);
  const policyResult = applyPolicyBounds(choices, input.policy, reasons);
  choices = policyResult.choices;

  const holdoutRecords = top.holdout;
  const holdoutValidated = holdoutRecords.length > 0
    && holdoutRecords.every((record) => record.regression !== 'regression' && record.oraclePassRate >= config.minOraclePassRate);
  if (!holdoutValidated) reasons.push('HOLDOUT_EVIDENCE_REQUIRED_FOR_AUTO_APPLY');
  if (config.mode === 'shadow') reasons.push('SHADOW_MODE');
  if (confidence < config.minConfidence) reasons.push('CONFIDENCE_BELOW_AUTO_APPLY_THRESHOLD');

  let autoApplyEligible = config.mode === 'bounded-auto'
    && confidence >= config.minConfidence
    && holdoutValidated
    && !policyResult.conflict;

  const provisionalStrategyId = `${HARNESS_STRATEGY_VERSION}:${hash({ strategyVersion: top.strategyVersion, choices }, 24)}`;
  const previous = config.previous;
  if (autoApplyEligible && previous?.strategyId && previous.strategyId !== provisionalStrategyId) {
    const lastChanged = boundedInteger(previous.lastChangedDecisionSequence, 0, 0, Number.MAX_SAFE_INTEGER);
    if (config.decisionSequence - lastChanged < config.cooldownDecisions) {
      autoApplyEligible = false;
      reasons.push('ANTI_FLAP_COOLDOWN');
    } else if (scoreMargin < config.minScoreMargin + config.hysteresisMargin) {
      autoApplyEligible = false;
      reasons.push('ANTI_FLAP_HYSTERESIS');
    }
  }
  if (policyResult.conflict) reasons.push('AUTO_APPLY_BLOCKED_BY_POLICY_CONSTRAINT');
  if (autoApplyEligible) reasons.push('BOUNDED_AUTO_APPLY_ELIGIBLE');

  const usedRecords = [...top.records, ...holdoutRecords];
  return finalizeDecision({
    taskFingerprint,
    status: 'recommended',
    choices,
    strategyVersion: top.strategyVersion,
    confidence,
    score: top.score,
    scoreMargin,
    sampleCount: top.sampleCount,
    records: usedRecords,
    holdoutValidated,
    mode: config.mode,
    autoApplyEligible,
    reasonCodes: reasons,
  });
}
