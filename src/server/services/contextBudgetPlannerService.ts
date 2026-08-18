export type ContextIntent =
  | 'authoring'
  | 'small-bug-fix'
  | 'cross-module-change'
  | 'verification-debugging'
  | 'architecture-analysis';

export type ContextEvidenceRank = 'must' | 'should' | 'optional';
export type ContextDisclosureLevel = 'project-summary' | 'symbols' | 'snippets' | 'callers-tests' | 'full-file';

export const ADAPTIVE_SOURCE_DISCLOSURE_POLICY = Object.freeze({
  smallFileMaxLines: 400,
  smallFileMaxBytes: 20_000,
  largeFileWindowLines: 300,
  maxLargeFileWindowLines: 350,
  tinyTailMaxLines: 50,
} as const);

export interface ContextCandidate {
  path: string;
  score?: number;
  symbols?: string[];
  imports?: string[];
  [key: string]: unknown;
}

export interface RankedContextEvidence extends ContextCandidate {
  rank: ContextEvidenceRank;
  reasons: string[];
  isTest: boolean;
  selected: boolean;
}

export interface ContextBudgetProfile {
  indexLimit: number;
  snippetLimit: number;
  snippetLines: number;
  perSnippetBytes: number;
  snippetBytes: number;
  maxContextBytes: number;
}

export interface ContextPlan {
  intent: ContextIntent;
  disclosureLevel: ContextDisclosureLevel;
  budgets: ContextBudgetProfile;
  evidence: RankedContextEvidence[];
  rationale: string[];
}

const PROFILES: Record<ContextIntent, { disclosureLevel: ContextDisclosureLevel; budgets: ContextBudgetProfile }> = {
  authoring: {
    disclosureLevel: 'symbols',
    budgets: { indexLimit: 5, snippetLimit: 2, snippetLines: 40, perSnippetBytes: 6_000, snippetBytes: 12_000, maxContextBytes: 18_000 },
  },
  'small-bug-fix': {
    disclosureLevel: 'snippets',
    budgets: { indexLimit: 7, snippetLimit: 3, snippetLines: 60, perSnippetBytes: 7_000, snippetBytes: 18_000, maxContextBytes: 28_000 },
  },
  'verification-debugging': {
    disclosureLevel: 'callers-tests',
    budgets: { indexLimit: 10, snippetLimit: 5, snippetLines: 80, perSnippetBytes: 8_000, snippetBytes: 32_000, maxContextBytes: 46_000 },
  },
  'cross-module-change': {
    disclosureLevel: 'callers-tests',
    budgets: { indexLimit: 12, snippetLimit: 6, snippetLines: 100, perSnippetBytes: 9_000, snippetBytes: 40_000, maxContextBytes: 58_000 },
  },
  'architecture-analysis': {
    disclosureLevel: 'callers-tests',
    budgets: { indexLimit: 18, snippetLimit: 8, snippetLines: 140, perSnippetBytes: 12_000, snippetBytes: 64_000, maxContextBytes: 90_000 },
  },
};

const DISCLOSURE_LEVELS = new Set<ContextDisclosureLevel>([
  'project-summary',
  'symbols',
  'snippets',
  'callers-tests',
  'full-file',
]);

function normalizePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function isTestPath(filePath: string) {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:\.test\.|\.spec\.)/i.test(filePath.replace(/\\/g, '/'));
}

function queryTerms(query: string) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_ก-๙]+/i)
    .map((term) => term.trim())
    .filter(Boolean);
}

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

export function inferContextIntent(input: {
  query?: string;
  intent?: string;
  targetFiles?: string[];
  complexity?: string;
}): ContextIntent {
  const explicit = String(input.intent || '').trim().toLowerCase();
  const aliases: Record<string, ContextIntent> = {
    authoring: 'authoring',
    writing: 'authoring',
    config: 'authoring',
    'small-bug': 'small-bug-fix',
    'small-bug-fix': 'small-bug-fix',
    bug: 'small-bug-fix',
    debug: 'verification-debugging',
    verification: 'verification-debugging',
    'verification-debugging': 'verification-debugging',
    'cross-module': 'cross-module-change',
    'cross-module-change': 'cross-module-change',
    architecture: 'architecture-analysis',
    'architecture-analysis': 'architecture-analysis',
  };
  if (aliases[explicit]) return aliases[explicit];

  const query = String(input.query || '').toLowerCase();
  const targetCount = Array.isArray(input.targetFiles) ? input.targetFiles.filter(Boolean).length : 0;
  const complexity = String(input.complexity || '').toLowerCase();

  if (includesAny(query, ['architecture', 'module boundaries', 'whole system', 'system design', 'onboard repo', 'project overview'])) {
    return 'architecture-analysis';
  }
  if (includesAny(query, ['failing', 'failure', 'regression', 'debug', 'diagnose', 'verification', 'verify why', 'test failure'])) {
    return 'verification-debugging';
  }
  if (targetCount >= 4 || includesAny(complexity, ['high', 'deep', 'complex']) || includesAny(query, ['cross-module', 'across modules', 'across route', 'route service repository', 'end-to-end', 'multiple modules'])) {
    return 'cross-module-change';
  }
  if (includesAny(query, ['crash', 'bug', 'broken', 'fix ', 'incorrect', 'exception', 'error when'])) {
    return 'small-bug-fix';
  }
  if (includesAny(query, ['wording', 'copy ', 'readme', 'documentation', 'docs ', 'config ', 'package.json', 'rename label', 'text change'])) {
    return 'authoring';
  }
  return 'small-bug-fix';
}

export function rankContextEvidence(
  candidates: ContextCandidate[],
  input: {
    query?: string;
    intent?: ContextIntent | string;
    targetFiles?: string[];
    changedFiles?: Array<string | { path?: string; workingPath?: string }>;
    snippetLimit?: number;
  } = {},
): RankedContextEvidence[] {
  const intent = inferContextIntent({ query: input.query, intent: input.intent, targetFiles: input.targetFiles });
  const targets = new Set((input.targetFiles || []).map(normalizePath));
  const changed = new Set((input.changedFiles || []).map((entry) => normalizePath(typeof entry === 'string' ? entry : String(entry?.workingPath || entry?.path || ''))).filter(Boolean));
  const terms = queryTerms(String(input.query || ''));
  const maxScore = candidates.reduce((max, candidate) => Math.max(max, Number(candidate.score || 0)), 0);
  const normalizedCandidates = candidates.map((candidate, originalIndex) => {
    const filePath = String(candidate.path || '');
    const normalized = normalizePath(filePath);
    const score = Number(candidate.score || 0);
    const symbols = Array.isArray(candidate.symbols) ? candidate.symbols.map(String) : [];
    const reasons: string[] = [];
    let rank: ContextEvidenceRank = 'optional';
    const test = isTestPath(filePath);

    if (targets.has(normalized)) {
      rank = 'must';
      reasons.push('explicit target file');
    }
    if (changed.has(normalized)) {
      rank = 'must';
      reasons.push('changed working-tree file');
    }

    const searchable = [normalized, ...symbols.map((symbol) => symbol.toLowerCase())].join(' ');
    const matchedTerms = terms.filter((term) => searchable.includes(term));
    if (matchedTerms.length > 0) reasons.push(`query match: ${matchedTerms.slice(0, 3).join(', ')}`);

    if (test && ['small-bug-fix', 'verification-debugging', 'cross-module-change'].includes(intent)) {
      if (rank === 'optional') rank = 'should';
      reasons.push('related test evidence');
    }
    if (score === maxScore && maxScore > 0 && rank === 'optional') {
      rank = 'must';
      reasons.push('highest semantic/index match');
    } else if (score >= Math.max(1, maxScore - 1) && rank === 'optional') {
      rank = 'should';
      reasons.push('strong semantic/index match');
    }
    if (intent === 'architecture-analysis' && rank === 'optional' && score > 0) {
      rank = 'should';
      reasons.push('architecture breadth evidence');
    }
    if (reasons.length === 0) reasons.push('lower-confidence supporting evidence');

    return {
      ...candidate,
      path: filePath,
      score,
      rank,
      reasons,
      isTest: test,
      selected: false,
      originalIndex,
    };
  });

  const order: Record<ContextEvidenceRank, number> = { must: 0, should: 1, optional: 2 };
  const evidencePriority = (entry: { reasons: string[] }) => {
    if (entry.reasons.includes('explicit target file')) return 0;
    if (entry.reasons.includes('changed working-tree file')) return 1;
    if (entry.reasons.includes('highest semantic/index match')) return 2;
    if (entry.reasons.includes('related test evidence')) return 3;
    return 4;
  };
  const sorted = normalizedCandidates.sort((left, right) =>
    order[left.rank] - order[right.rank]
    || evidencePriority(left) - evidencePriority(right)
    || Number(right.score || 0) - Number(left.score || 0)
    || left.originalIndex - right.originalIndex
    || left.path.localeCompare(right.path),
  );
  const defaultLimit = PROFILES[intent].budgets.snippetLimit;
  const selectionLimit = Math.max(0, Math.floor(Number(input.snippetLimit ?? defaultLimit)));
  return sorted.map(({ originalIndex: _originalIndex, ...entry }, index) => ({
    ...entry,
    selected: index < selectionLimit && (entry.rank !== 'optional' || intent === 'architecture-analysis'),
  }));
}

export function planContextBudget(input: {
  query?: string;
  intent?: string;
  complexity?: string;
  candidates?: ContextCandidate[];
  targetFiles?: string[];
  changedFiles?: Array<string | { path?: string; workingPath?: string }>;
  requestedDisclosureLevel?: string;
}): ContextPlan {
  const intent = inferContextIntent(input);
  const profile = PROFILES[intent];
  const requested = String(input.requestedDisclosureLevel || '').trim().toLowerCase() as ContextDisclosureLevel;
  const explicitLevel = DISCLOSURE_LEVELS.has(requested) ? requested : undefined;
  const disclosureLevel = explicitLevel || profile.disclosureLevel;
  const budgets: ContextBudgetProfile = disclosureLevel === 'full-file'
    ? {
      indexLimit: Math.max(profile.budgets.indexLimit, 18),
      snippetLimit: Math.max(profile.budgets.snippetLimit, 8),
      snippetLines: 400,
      perSnippetBytes: 50_000,
      snippetBytes: Math.max(profile.budgets.snippetBytes + 1, 120_000),
      maxContextBytes: Math.max(profile.budgets.maxContextBytes + 1, 160_000),
    }
    : { ...profile.budgets };
  const evidence = rankContextEvidence(input.candidates || [], {
    query: input.query,
    intent,
    targetFiles: input.targetFiles,
    changedFiles: input.changedFiles,
    snippetLimit: budgets.snippetLimit,
  });
  const rationale = [
    `intent=${intent}`,
    `disclosure=${disclosureLevel}`,
    `snippetBudget=${budgets.snippetBytes}`,
    explicitLevel ? `explicit disclosure override=${explicitLevel}` : 'automatic bounded disclosure',
  ];

  return { intent, disclosureLevel, budgets, evidence, rationale };
}
