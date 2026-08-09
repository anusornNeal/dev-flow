export type ContextIntent = 'authoring' | 'small-bug' | 'verification' | 'cross-module' | 'architecture';
export type ContextEvidenceRank = 'Must' | 'Should' | 'Optional';
export type ContextDisclosureLevel = 'project-summary' | 'symbols' | 'snippets' | 'related' | 'full-file';

export type ContextBudget = {
  indexLimit: number;
  snippetLimit: number;
  snippetLines: number;
  maxSnippetBytes: number;
  maxTotalSnippetBytes: number;
  estimatedTokenBudget: number;
};

export type ContextEvidence = {
  path: string;
  rank: ContextEvidenceRank;
  reasons: string[];
  score: number;
  symbols: string[];
  imports: string[];
};

type PlannerInput = {
  query?: string;
  intent?: ContextIntent | string;
  complexity?: string;
  targetFiles?: string[];
  deep?: boolean;
  disclosureLevel?: ContextDisclosureLevel | string;
};

type Candidate = {
  path?: string;
  score?: number;
  symbols?: string[];
  imports?: string[];
};

const INTENTS = new Set<ContextIntent>(['authoring', 'small-bug', 'verification', 'cross-module', 'architecture']);
const DISCLOSURE_LEVELS = new Set<ContextDisclosureLevel>(['project-summary', 'symbols', 'snippets', 'related', 'full-file']);
const RANK_ORDER: Record<ContextEvidenceRank, number> = { Must: 0, Should: 1, Optional: 2 };

const PROFILES: Record<ContextIntent, { disclosureLevel: ContextDisclosureLevel; budget: Omit<ContextBudget, 'estimatedTokenBudget'> }> = {
  authoring: {
    disclosureLevel: 'symbols',
    budget: { indexLimit: 5, snippetLimit: 2, snippetLines: 40, maxSnippetBytes: 4_000, maxTotalSnippetBytes: 8_000 },
  },
  'small-bug': {
    disclosureLevel: 'snippets',
    budget: { indexLimit: 8, snippetLimit: 3, snippetLines: 64, maxSnippetBytes: 5_000, maxTotalSnippetBytes: 15_000 },
  },
  verification: {
    disclosureLevel: 'related',
    budget: { indexLimit: 10, snippetLimit: 4, snippetLines: 72, maxSnippetBytes: 5_000, maxTotalSnippetBytes: 20_000 },
  },
  'cross-module': {
    disclosureLevel: 'related',
    budget: { indexLimit: 16, snippetLimit: 7, snippetLines: 96, maxSnippetBytes: 6_000, maxTotalSnippetBytes: 42_000 },
  },
  architecture: {
    disclosureLevel: 'related',
    budget: { indexLimit: 20, snippetLimit: 9, snippetLines: 120, maxSnippetBytes: 7_000, maxTotalSnippetBytes: 63_000 },
  },
};

const DEEP_ARCHITECTURE_BUDGET: Omit<ContextBudget, 'estimatedTokenBudget'> = {
  indexLimit: 30,
  snippetLimit: 10,
  snippetLines: 160,
  maxSnippetBytes: 10_000,
  maxTotalSnippetBytes: 100_000,
};

function normalizePath(value: unknown) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function queryTerms(query: string) {
  return query.toLowerCase().split(/[^a-z0-9_ก-๙]+/i).map((term) => term.trim()).filter((term) => term.length >= 2);
}

export function inferContextIntent(query: unknown): ContextIntent {
  const text = String(query || '').trim().toLowerCase();
  if (/\b(architecture|architectural|system design|dependency flow|dependencies|onboard|explain project|project structure)\b/.test(text)) {
    return 'architecture';
  }
  if (/\b(cross[- ]?module|integration|integrate|refactor|frontend.*backend|backend.*frontend|multiple (?:modules|services)|across (?:modules|services|layers))\b/.test(text)) {
    return 'cross-module';
  }
  if (/\b(test|tests|testing|verify|verification|debug|failing|failure|typecheck|lint|benchmark|regression)\b/.test(text)) {
    return 'verification';
  }
  if (/\b(copy|wording|label|readme|documentation|docs|config|configuration|package(?:\.json)?|setting|settings|author|authoring)\b/.test(text)) {
    return 'authoring';
  }
  return 'small-bug';
}

function resolveIntent(input: PlannerInput): ContextIntent {
  const explicit = String(input.intent || '').trim().toLowerCase() as ContextIntent;
  if (INTENTS.has(explicit)) return explicit;
  const complexity = String(input.complexity || '').trim().toLowerCase();
  if (complexity === 'architecture' || complexity === 'deep') return 'architecture';
  if (complexity === 'cross-module' || complexity === 'large') return 'cross-module';
  return inferContextIntent(input.query);
}

function resolveDisclosure(input: PlannerInput, intent: ContextIntent): ContextDisclosureLevel {
  const requested = String(input.disclosureLevel || '').trim().toLowerCase() as ContextDisclosureLevel;
  if (DISCLOSURE_LEVELS.has(requested)) return requested;
  if (input.deep === true && intent === 'architecture') return 'full-file';
  return PROFILES[intent].disclosureLevel;
}

function withTokens(budget: Omit<ContextBudget, 'estimatedTokenBudget'>): ContextBudget {
  return { ...budget, estimatedTokenBudget: Math.ceil(budget.maxTotalSnippetBytes / 4) };
}

export function createContextBudgetPlan(input: PlannerInput = {}) {
  const intent = resolveIntent(input);
  const disclosureLevel = resolveDisclosure(input, intent);
  const explicitFullFile = disclosureLevel === 'full-file';
  const deepArchitecture = input.deep === true && intent === 'architecture';
  const budget = withTokens(explicitFullFile || deepArchitecture ? DEEP_ARCHITECTURE_BUDGET : PROFILES[intent].budget);
  const allowFullFile = explicitFullFile;
  return {
    intent,
    disclosureLevel,
    budget,
    allowFullFile,
    escalation: {
      required: allowFullFile,
      nextTool: allowFullFile ? 'read_local_file' : undefined,
      guidance: allowFullFile
        ? 'Use explicit read_local_file calls only for the specific files still needed after ranked snippets.'
        : 'Escalate progressively to related evidence or explicit read_local_file only when ranked snippets are insufficient.',
    },
  };
}

function containsQueryEvidence(candidate: Candidate, terms: string[]) {
  if (terms.length === 0) return { path: false, symbol: false };
  const pathValue = normalizePath(candidate.path);
  const symbols = (candidate.symbols || []).join(' ').toLowerCase();
  return {
    path: terms.some((term) => pathValue.includes(term)),
    symbol: terms.some((term) => symbols.includes(term)),
  };
}

function isTestPath(path: string) {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:\.test\.|\.spec\.)/i.test(path);
}

export function rankContextEvidence(candidates: Candidate[], input: PlannerInput = {}): ContextEvidence[] {
  const intent = resolveIntent(input);
  const terms = queryTerms(String(input.query || ''));
  const explicitTargets = new Set((input.targetFiles || []).map(normalizePath).filter(Boolean));
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const candidatePath = String(candidate.path || '').replace(/\\/g, '/');
    const normalizedCandidatePath = normalizePath(candidatePath);
    const reasons: string[] = [];
    let rank: ContextEvidenceRank = 'Optional';
    if (explicitTargets.has(normalizedCandidatePath)) {
      rank = 'Must';
      reasons.push('explicit-target');
    }
    const queryEvidence = containsQueryEvidence(candidate, terms);
    if (queryEvidence.path) {
      rank = rank === 'Optional' ? 'Should' : rank;
      reasons.push('query-path-match');
    }
    if (queryEvidence.symbol) {
      rank = rank === 'Optional' ? 'Should' : rank;
      reasons.push('symbol-match');
    }
    if (intent === 'verification' && isTestPath(candidatePath)) {
      rank = rank === 'Must' ? 'Must' : 'Should';
      reasons.push('verification-test');
    }
    if (Number(candidate.score || 0) >= 3) {
      rank = rank === 'Optional' ? 'Should' : rank;
      reasons.push('high-search-score');
    }
    if (reasons.length === 0) reasons.push('supporting-evidence');
    return {
      path: candidatePath,
      rank,
      reasons,
      score: Number(candidate.score || 0),
      symbols: Array.isArray(candidate.symbols) ? candidate.symbols : [],
      imports: Array.isArray(candidate.imports) ? candidate.imports : [],
    };
  }).sort((left, right) =>
    RANK_ORDER[left.rank] - RANK_ORDER[right.rank]
    || right.score - left.score
    || left.path.localeCompare(right.path));
}
