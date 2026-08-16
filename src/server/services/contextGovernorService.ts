import crypto from 'node:crypto';
import {
  planContextBudget,
  type ContextCandidate,
  type ContextDisclosureLevel,
  type ContextIntent,
} from './contextBudgetPlannerService';

export type ContextExecutionStage = 'understand' | 'implement' | 'verify' | 'recover';
export type ContextTrustClass = 'authority' | 'pinned-approved' | 'repo-evidence-untrusted' | 'derived-metadata';
export type ContextFreshnessState = 'fresh' | 'stale' | 'missing' | 'pinned';

export interface ContextGovernorEvidenceInput {
  id?: string;
  kind?: string;
  source?: string;
  path?: string;
  revision?: string | number;
  frozenRevision?: string | number;
  approved?: boolean;
  required?: boolean;
  present?: boolean;
}

export interface ContextGovernorHandleInput {
  planIdentity?: string;
  repoRevision?: string;
  lineageToken?: string;
}

export interface ContextGovernorInput {
  query?: string;
  intent?: string;
  stage?: string;
  complexity?: string;
  repoRevision?: string;
  lineageToken?: string;
  targetFiles?: string[];
  changedFiles?: Array<string | { path?: string; workingPath?: string }>;
  candidates?: ContextCandidate[];
  requestedDisclosureLevel?: string;
  maxContextBytes?: number;
  taskRequirements?: string;
  requireTaskRequirements?: boolean;
  frozenEvidence?: ContextGovernorEvidenceInput[];
  latestEvidence?: ContextGovernorEvidenceInput[];
  missingFiles?: string[];
  missingTests?: string[];
  missingSymbols?: string[];
  missingRelationships?: string[];
  contextSufficient?: boolean;
  includeIgnored?: boolean;
  authorizedSensitivePaths?: string[];
  handle?: ContextGovernorHandleInput;
}

export interface ContextGovernorEvidence {
  key: string;
  kind: string;
  source: string;
  path?: string;
  revision?: string;
  frozenRevision?: string;
  trustClass: ContextTrustClass;
  freshness: ContextFreshnessState;
  required: boolean;
  retainedByReference: boolean;
  policyAuthority: boolean;
  reasonCodes: string[];
}

export interface ContextGovernorBlocker {
  code: 'CONTEXT_REQUIRED_EVIDENCE_MISSING' | 'CONTEXT_SENSITIVE_PATH_DENIED';
  evidenceKey?: string;
  path?: string;
  detail: string;
}

export interface ContextGovernorPlan {
  version: 1;
  planIdentity: string;
  intent: ContextIntent;
  stage: ContextExecutionStage;
  disclosureLevel: ContextDisclosureLevel;
  budgets: ReturnType<typeof planContextBudget>['budgets'];
  evidence: ReturnType<typeof planContextBudget>['evidence'];
  rationale: string[];
  requiredEvidence: ContextGovernorEvidence[];
  deferredEvidence: ContextGovernorEvidence[];
  freshness: {
    repoRevision: string;
    lineageToken: string;
    state: 'fresh' | 'stale' | 'unknown';
  };
  sourcePolicy: {
    repoContentTrust: 'untrusted-evidence';
    repositoryInstructionsAreAuthority: false;
    taskRequirementsAuthority: 'task-authority';
    frozenEvidencePolicy: 'pinned-until-explicitly-superseded';
  };
  expansion: {
    requested: boolean;
    allowedFiles: string[];
    allowedTests: string[];
    symbols: string[];
    relationships: string[];
    triggers: Array<{ code: string; from: ContextDisclosureLevel; to: ContextDisclosureLevel; explicitOnly?: boolean }>;
  };
  delivery: {
    mode: 'full' | 'reuse-handle' | 'refresh-delta' | 'blocked';
    reasonCodes: string[];
  };
  blockers: ContextGovernorBlocker[];
}

const DISCLOSURE_ORDER: ContextDisclosureLevel[] = ['project-summary', 'symbols', 'snippets', 'callers-tests', 'full-file'];
const IGNORED_SEGMENTS = new Set(['.git', '.devflow', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.next', '.gradle']);

function normalizeStage(value: unknown): ContextExecutionStage {
  const stage = String(value || '').trim().toLowerCase();
  if (['verify', 'verification', 'review', 'test'].includes(stage)) return 'verify';
  if (['recover', 'recovery', 'debug'].includes(stage)) return 'recover';
  if (['implement', 'implementation', 'edit', 'coding'].includes(stage)) return 'implement';
  return 'understand';
}

function normalizePath(value: unknown) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function uniqueSorted(values: unknown[]) {
  return [...new Set(values.map(normalizePath).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeStrings(values: unknown[]) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function hashIdentity(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function evidenceKey(input: ContextGovernorEvidenceInput, index: number) {
  const source = String(input.source || input.kind || 'evidence').trim() || 'evidence';
  const id = String(input.id || input.path || input.frozenRevision || input.revision || index).trim();
  return `${source}:${id}`;
}

function evidenceRevision(input: ContextGovernorEvidenceInput) {
  const value = input.frozenRevision ?? input.revision;
  return value === undefined || value === null ? undefined : String(value);
}

function makeEvidence(
  input: ContextGovernorEvidenceInput,
  index: number,
  overrides: Partial<ContextGovernorEvidence> = {},
): ContextGovernorEvidence {
  const path = input.path ? normalizePath(input.path) : undefined;
  const frozenRevision = input.frozenRevision === undefined ? undefined : String(input.frozenRevision);
  const revision = evidenceRevision(input);
  const pinned = frozenRevision !== undefined;
  return {
    key: evidenceKey(input, index),
    kind: String(input.kind || (pinned ? 'frozen-evidence' : 'evidence')),
    source: String(input.source || 'task-attachment'),
    ...(path ? { path } : {}),
    ...(revision ? { revision } : {}),
    ...(frozenRevision ? { frozenRevision } : {}),
    trustClass: pinned ? 'pinned-approved' : 'derived-metadata',
    freshness: input.present === false ? 'missing' : pinned ? 'pinned' : 'fresh',
    required: input.required !== false,
    retainedByReference: true,
    policyAuthority: false,
    reasonCodes: pinned ? ['FROZEN_EVIDENCE_PINNED'] : ['TASK_EVIDENCE_REFERENCED'],
    ...overrides,
  };
}

export function isSecretBearingContextPath(value: string) {
  const normalized = normalizePath(value).toLowerCase();
  const base = normalized.split('/').pop() || normalized;
  return base === '.env'
    || base.startsWith('.env.')
    || /(?:^|\/)(?:secrets?|credentials?)(?:[./_-]|$)/i.test(normalized)
    || /(?:^|\/)(?:id_rsa|id_ed25519|known_hosts|authorized_keys)$/i.test(normalized)
    || /\.(?:pem|p12|pfx|key|keystore|jks)$/i.test(base);
}

export function isIgnoredContextPath(value: string) {
  const normalized = normalizePath(value);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment.toLowerCase()))) return true;
  return segments.some((segment) => segment.startsWith('.') && segment !== '.github');
}

function isPathAuthorized(pathValue: string, authorized: Set<string>) {
  const normalized = normalizePath(pathValue).toLowerCase();
  return authorized.has(normalized);
}

function nextDisclosureLevel(level: ContextDisclosureLevel, missing: { symbols: string[]; relationships: string[]; files: string[]; tests: string[] }) {
  const index = DISCLOSURE_ORDER.indexOf(level);
  if (missing.relationships.length > 0 || missing.tests.length > 0) return DISCLOSURE_ORDER[Math.max(index, 3)] as ContextDisclosureLevel;
  if (missing.symbols.length > 0 || missing.files.length > 0) return DISCLOSURE_ORDER[Math.max(index, 2)] as ContextDisclosureLevel;
  return level;
}

function resolveIntent(input: ContextGovernorInput) {
  if (input.intent) return input.intent;
  const stage = normalizeStage(input.stage);
  return stage === 'verify' || stage === 'recover' ? 'verification-debugging' : undefined;
}

function boundedBudgets(base: ReturnType<typeof planContextBudget>['budgets'], requestedMaxContextBytes?: number) {
  const requested = Number(requestedMaxContextBytes);
  const maxContextBytes = Number.isFinite(requested) && requested > 0
    ? Math.max(1, Math.min(base.maxContextBytes, Math.floor(requested)))
    : base.maxContextBytes;
  const snippetBytes = Math.min(base.snippetBytes, Math.max(1, maxContextBytes));
  return {
    ...base,
    perSnippetBytes: Math.min(base.perSnippetBytes, snippetBytes),
    snippetBytes,
    maxContextBytes,
  };
}

export function planContextGovernor(input: ContextGovernorInput): ContextGovernorPlan {
  const stage = normalizeStage(input.stage);
  const targetFiles = uniqueSorted(input.targetFiles || []);
  const missingFiles = uniqueSorted(input.missingFiles || []);
  const missingTests = uniqueSorted(input.missingTests || []);
  const missingSymbols = normalizeStrings(input.missingSymbols || []);
  const missingRelationships = normalizeStrings(input.missingRelationships || []);
  const requestedDisclosureLevel = String(input.requestedDisclosureLevel || '').trim().toLowerCase();
  const explicitFullFile = requestedDisclosureLevel === 'full-file';
  const budgetPlan = planContextBudget({
    query: input.query,
    intent: resolveIntent(input),
    complexity: input.complexity,
    candidates: input.candidates || [],
    targetFiles,
    changedFiles: input.changedFiles,
    requestedDisclosureLevel: explicitFullFile ? 'full-file' : input.requestedDisclosureLevel,
  });
  const budgets = boundedBudgets(budgetPlan.budgets, input.maxContextBytes);

  const requiredEvidence: ContextGovernorEvidence[] = [];
  const deferredEvidence: ContextGovernorEvidence[] = [];
  const blockers: ContextGovernorBlocker[] = [];
  const taskRequirements = String(input.taskRequirements || '').trim();
  if (taskRequirements) {
    requiredEvidence.push({
      key: 'task:requirements',
      kind: 'task-requirements',
      source: 'task-record',
      trustClass: 'authority',
      freshness: 'fresh',
      required: true,
      retainedByReference: true,
      policyAuthority: true,
      reasonCodes: ['CURRENT_TASK_REQUIREMENTS_REQUIRED'],
    });
  } else if (input.requireTaskRequirements) {
    blockers.push({
      code: 'CONTEXT_REQUIRED_EVIDENCE_MISSING',
      evidenceKey: 'task:requirements',
      detail: 'Current task requirements are required but were not available to the context governor.',
    });
  }

  const frozenEvidence = [...(input.frozenEvidence || [])]
    .map((entry, index) => makeEvidence(entry, index, {
      trustClass: 'pinned-approved',
      freshness: entry.present === false ? 'missing' : 'pinned',
      required: true,
      retainedByReference: true,
      policyAuthority: false,
      reasonCodes: ['FROZEN_EVIDENCE_PINNED', 'LATEST_CANNOT_SILENTLY_REPLACE'],
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  requiredEvidence.push(...frozenEvidence);
  for (const evidence of frozenEvidence) {
    if (evidence.freshness === 'missing') {
      blockers.push({
        code: 'CONTEXT_REQUIRED_EVIDENCE_MISSING',
        evidenceKey: evidence.key,
        detail: `Pinned evidence '${evidence.key}' is required but unavailable.`,
      });
    }
  }

  for (const [index, entry] of (input.latestEvidence || []).entries()) {
    const candidate = makeEvidence(entry, index, {
      required: false,
      retainedByReference: true,
      trustClass: entry.approved ? 'pinned-approved' : 'derived-metadata',
      policyAuthority: false,
      reasonCodes: entry.approved ? ['APPROVED_EVIDENCE_AVAILABLE'] : ['UNAPPROVED_LATEST_DEFERRED'],
    });
    const pinnedMatch = frozenEvidence.find((frozen) => frozen.source === candidate.source && (frozen.path || frozen.key) === (candidate.path || candidate.key));
    if (pinnedMatch && !entry.approved && candidate.revision !== pinnedMatch.revision) deferredEvidence.push(candidate);
    else if (!entry.approved) deferredEvidence.push(candidate);
  }

  for (const filePath of targetFiles) {
    requiredEvidence.push({
      key: `repo-target:${filePath}`,
      kind: 'repo-target',
      source: 'repo-content',
      path: filePath,
      trustClass: 'repo-evidence-untrusted',
      freshness: input.repoRevision ? 'fresh' : 'missing',
      required: true,
      retainedByReference: false,
      policyAuthority: false,
      reasonCodes: ['EXPLICIT_TARGET_SCOPE', 'REPO_CONTENT_IS_EVIDENCE_NOT_AUTHORITY'],
    });
  }

  const authorized = new Set(uniqueSorted(input.authorizedSensitivePaths || []).map((entry) => entry.toLowerCase()));
  const allowedFiles: string[] = [];
  const allowedTests: string[] = [];
  const inspectAdaptivePath = (pathValue: string, destination: string[]) => {
    const secret = isSecretBearingContextPath(pathValue);
    const ignored = isIgnoredContextPath(pathValue);
    const explicitlyAuthorized = isPathAuthorized(pathValue, authorized);
    const ignoredAuthorized = ignored && input.includeIgnored === true && !secret;
    if ((secret || ignored) && !explicitlyAuthorized && !ignoredAuthorized) {
      blockers.push({
        code: 'CONTEXT_SENSITIVE_PATH_DENIED',
        path: pathValue,
        detail: `Adaptive context expansion denied for '${pathValue}' without explicit authorization.`,
      });
      return;
    }
    destination.push(pathValue);
  };
  missingFiles.forEach((entry) => inspectAdaptivePath(entry, allowedFiles));
  missingTests.forEach((entry) => inspectAdaptivePath(entry, allowedTests));

  const requestedExpansion = input.contextSufficient === false
    || missingFiles.length > 0
    || missingTests.length > 0
    || missingSymbols.length > 0
    || missingRelationships.length > 0;
  const proposedDisclosure = nextDisclosureLevel(budgetPlan.disclosureLevel, {
    symbols: missingSymbols,
    relationships: missingRelationships,
    files: allowedFiles,
    tests: allowedTests,
  });
  const disclosureLevel = proposedDisclosure === 'full-file' && !explicitFullFile ? 'callers-tests' : proposedDisclosure;

  const repoRevision = String(input.repoRevision || '');
  const lineageToken = String(input.lineageToken || '');
  const identityPayload = {
    version: 1,
    query: String(input.query || '').trim(),
    intent: budgetPlan.intent,
    stage,
    complexity: String(input.complexity || ''),
    repoRevision,
    targetFiles,
    requestedDisclosureLevel: explicitFullFile ? 'full-file' : String(input.requestedDisclosureLevel || ''),
    maxContextBytes: budgets.maxContextBytes,
    taskRequirementsHash: taskRequirements ? hashIdentity(taskRequirements) : '',
    frozenEvidence: frozenEvidence.map((entry) => ({ key: entry.key, revision: entry.revision, frozenRevision: entry.frozenRevision })),
  };
  const planIdentity = hashIdentity(identityPayload);

  const freshnessState = !repoRevision
    ? 'unknown' as const
    : input.handle && (input.handle.repoRevision !== repoRevision || input.handle.lineageToken !== lineageToken)
      ? 'stale' as const
      : 'fresh' as const;
  const deliveryReasonCodes: string[] = [];
  let deliveryMode: ContextGovernorPlan['delivery']['mode'] = 'full';
  if (blockers.some((entry) => entry.code === 'CONTEXT_REQUIRED_EVIDENCE_MISSING')) {
    deliveryMode = 'blocked';
    deliveryReasonCodes.push('REQUIRED_EVIDENCE_BLOCKED');
  } else if (input.handle) {
    if (input.handle.planIdentity === planIdentity && input.handle.repoRevision === repoRevision && input.handle.lineageToken === lineageToken) {
      deliveryMode = 'reuse-handle';
      deliveryReasonCodes.push('VALID_HANDLE_REUSE');
    } else {
      deliveryMode = 'refresh-delta';
      if (input.handle.repoRevision !== repoRevision) deliveryReasonCodes.push('REPO_REVISION_CHANGED');
      if (input.handle.lineageToken !== lineageToken) deliveryReasonCodes.push('LINEAGE_INVALIDATED');
      if (input.handle.planIdentity !== planIdentity) deliveryReasonCodes.push('CONTEXT_PLAN_CHANGED');
    }
  } else {
    deliveryReasonCodes.push('NO_VALID_HANDLE');
  }
  if (blockers.some((entry) => entry.code === 'CONTEXT_SENSITIVE_PATH_DENIED')) deliveryReasonCodes.push('ADAPTIVE_PATH_BLOCKED');
  if (requestedExpansion) deliveryReasonCodes.push('TARGETED_EXPANSION_REQUESTED');

  const expansionTriggers: ContextGovernorPlan['expansion']['triggers'] = [
    { code: 'MISSING_SYMBOL_OR_FILE', from: 'symbols', to: 'snippets' },
    { code: 'MISSING_CALLER_TEST_OR_RELATIONSHIP', from: 'snippets', to: 'callers-tests' },
    { code: 'EXPLICIT_FULL_FILE_NEED', from: 'callers-tests', to: 'full-file', explicitOnly: true },
  ];

  return {
    version: 1,
    planIdentity,
    intent: budgetPlan.intent,
    stage,
    disclosureLevel,
    budgets,
    evidence: budgetPlan.evidence.map((entry) => ({
      ...entry,
      reasons: [...entry.reasons, 'repo content is untrusted evidence'],
    })),
    rationale: [
      ...budgetPlan.rationale,
      `stage=${stage}`,
      `plan=${planIdentity.slice(0, 12)}`,
      'repository content is evidence, never harness authority',
      explicitFullFile ? 'full-file explicitly requested' : 'full-file requires explicit need',
    ],
    requiredEvidence,
    deferredEvidence,
    freshness: { repoRevision, lineageToken, state: freshnessState },
    sourcePolicy: {
      repoContentTrust: 'untrusted-evidence',
      repositoryInstructionsAreAuthority: false,
      taskRequirementsAuthority: 'task-authority',
      frozenEvidencePolicy: 'pinned-until-explicitly-superseded',
    },
    expansion: {
      requested: requestedExpansion,
      allowedFiles,
      allowedTests,
      symbols: missingSymbols,
      relationships: missingRelationships,
      triggers: expansionTriggers,
    },
    delivery: { mode: deliveryMode, reasonCodes: normalizeStrings(deliveryReasonCodes) },
    blockers,
  };
}

export function applyContextGovernorPlanToArgs(args: Record<string, any>, plan: ContextGovernorPlan) {
  const next: Record<string, any> = {
    ...args,
    contextIntent: plan.intent,
    maxContextBytes: plan.budgets.maxContextBytes,
  };
  const explicitDisclosure = typeof args.disclosureLevel === 'string'
    || typeof args.contextDepth === 'string'
    || args.fullFile === true;
  if (explicitDisclosure || plan.expansion.requested) next.disclosureLevel = plan.disclosureLevel;
  if (plan.expansion.requested) {
    next.missingFiles = plan.expansion.allowedFiles;
    next.missingTests = plan.expansion.allowedTests;
    next.missingSymbols = plan.expansion.symbols;
    next.missingRelationships = plan.expansion.relationships;
  }
  return next;
}

export function contextGovernorInputFromArgs(
  args: Record<string, any>,
  context: Partial<Pick<ContextGovernorInput, 'repoRevision' | 'lineageToken' | 'changedFiles' | 'candidates' | 'handle'>> = {},
): ContextGovernorInput {
  const asList = (value: unknown) => Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : [];
  return {
    query: typeof args.q === 'string' ? args.q : typeof args.query === 'string' ? args.query : '',
    intent: args.contextIntent || args.intent,
    stage: args.executionStage || args.stage,
    complexity: args.complexity,
    repoRevision: context.repoRevision,
    lineageToken: context.lineageToken,
    targetFiles: asList(args.targetFiles),
    changedFiles: context.changedFiles,
    candidates: context.candidates,
    requestedDisclosureLevel: args.disclosureLevel || args.contextDepth || (args.fullFile === true ? 'full-file' : undefined),
    maxContextBytes: args.maxContextBytes ?? args.maxSnippetTotalBytes,
    taskRequirements: typeof args.taskRequirements === 'string' ? args.taskRequirements : undefined,
    requireTaskRequirements: args.requireTaskRequirements === true,
    frozenEvidence: Array.isArray(args.frozenEvidence) ? args.frozenEvidence : [],
    latestEvidence: Array.isArray(args.latestEvidence) ? args.latestEvidence : [],
    contextSufficient: args.contextSufficient === false || String(args.contextSufficient || '').toLowerCase() === 'false' ? false : undefined,
    missingFiles: asList(args.missingFiles),
    missingTests: asList(args.missingTests),
    missingSymbols: asList(args.missingSymbols),
    missingRelationships: asList(args.missingRelationships),
    includeIgnored: args.includeIgnored === true || String(args.includeIgnored).toLowerCase() === 'true',
    authorizedSensitivePaths: asList(args.authorizedSensitivePaths),
    handle: context.handle,
  };
}
