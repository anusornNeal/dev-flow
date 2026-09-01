import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 2 * 60_000;
const MAX_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 128;

export type CommandResultReuseIdentity = {
  repositoryScope: string;
  reusePolicy: 'exact-revision' | 'effective-input';
  repoRevision?: string;
  semanticKey: string;
  coverageScope?: 'targeted' | 'broad' | 'full';
  targets?: string[];
  commandConfigFingerprint: string;
  affectedInputFingerprint: string;
  dependencyFingerprint: string;
  environmentFingerprint: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  responseMode: 'compact' | 'standard' | 'debug';
  evidenceLineageToken: string;
};

export type CommandResultEvidenceMetadata = {
  evidenceId: string;
  sourceConsumerId?: string;
  consumers: string[];
  reusable: boolean;
  retention?: 'ttl' | 'bounded';
  reuseIdentity?: CommandResultReuseIdentity;
};

type CommandResultCacheEntry<T> = {
  createdAt: number;
  expiresAt: number | null;
  value: T;
  evidence?: CommandResultEvidenceMetadata;
};

const cache = new Map<string, CommandResultCacheEntry<unknown>>();
let evictionCount = 0;

function prune(now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
    evictionCount += 1;
  }
}

export function getCachedCommandResult<T>(key: string, consumerId?: string): { value: T; createdAt: number; evidence?: CommandResultEvidenceMetadata } | null {
  const now = Date.now();
  const entry = cache.get(key) as CommandResultCacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  const normalizedConsumer = typeof consumerId === 'string' && consumerId.trim() ? consumerId.trim() : '';
  if (entry.evidence && normalizedConsumer && !entry.evidence.consumers.includes(normalizedConsumer)) {
    entry.evidence.consumers.push(normalizedConsumer);
  }
  cache.delete(key);
  cache.set(key, entry);
  return { value: entry.value, createdAt: entry.createdAt, ...(entry.evidence ? { evidence: { ...entry.evidence, consumers: [...entry.evidence.consumers] } } : {}) };
}

export function rememberCommandResult<T>(
  key: string,
  value: T,
  ttlMs?: number,
  evidenceInput?: {
    sourceConsumerId?: string;
    reusable?: boolean;
    retention?: 'ttl' | 'bounded';
    reuseIdentity?: CommandResultReuseIdentity;
  },
) {
  const now = Date.now();
  prune(now);
  const parsed = Number(ttlMs);
  const ttl = Number.isFinite(parsed) ? Math.max(1_000, Math.min(MAX_TTL_MS, Math.floor(parsed))) : DEFAULT_TTL_MS;
  const sourceConsumerId = typeof evidenceInput?.sourceConsumerId === 'string' && evidenceInput.sourceConsumerId.trim()
    ? evidenceInput.sourceConsumerId.trim()
    : undefined;
  const retention = evidenceInput?.retention === 'bounded' ? 'bounded' : 'ttl';
  const expiresAt = retention === 'bounded' ? null : now + ttl;
  const evidence = evidenceInput ? {
    evidenceId: crypto.randomUUID(),
    ...(sourceConsumerId ? { sourceConsumerId } : {}),
    consumers: sourceConsumerId ? [sourceConsumerId] : [],
    reusable: evidenceInput.reusable !== false,
    retention,
    ...(evidenceInput?.reuseIdentity ? { reuseIdentity: { ...evidenceInput.reuseIdentity } } : {}),
  } satisfies CommandResultEvidenceMetadata : undefined;
  cache.set(key, { createdAt: now, expiresAt, value, ...(evidence ? { evidence } : {}) });
  return { createdAt: now, expiresAt, ...(evidence ? { evidence: { ...evidence, consumers: [...evidence.consumers] } } : {}) };
}

export function classifyCommandResultIdentityMismatch(
  candidates: CommandResultReuseIdentity[],
  identity: CommandResultReuseIdentity,
  fallbackReason = 'NO_REUSABLE_ENTRY',
) {
  const compatible = candidates.filter((entry) => (
    entry.repositoryScope === identity.repositoryScope
    && entry.reusePolicy === identity.reusePolicy
  ));
  if (compatible.length === 0) return fallbackReason;
  const dimensions: Array<[keyof CommandResultReuseIdentity, string]> = [
    ['semanticKey', 'SEMANTIC_KEY_CHANGED'],
    ['coverageScope', 'COVERAGE_SCOPE_CHANGED'],
    ['targets', 'TARGETS_CHANGED'],
    ['cwd', 'SEMANTIC_KEY_CHANGED'],
    ['commandConfigFingerprint', 'COMMAND_CONFIG_CHANGED'],
    ['affectedInputFingerprint', 'AFFECTED_INPUT_CHANGED'],
    ['dependencyFingerprint', 'DEPENDENCY_CHANGED'],
    ['environmentFingerprint', 'ENVIRONMENT_CHANGED'],
    ['evidenceLineageToken', 'PROJECT_RULES_CHANGED'],
    ['repoRevision', 'CANDIDATE_AUTHORITY_CHANGED'],
    ['timeoutMs', 'EXECUTION_BUDGET_CHANGED'],
    ['maxOutputBytes', 'RESPONSE_SHAPING_CHANGED'],
    ['responseMode', 'RESPONSE_SHAPING_CHANGED'],
  ];
  const dimensionMatches = (candidate: CommandResultReuseIdentity, key: keyof CommandResultReuseIdentity) => {
    if (key === 'targets') return JSON.stringify(candidate.targets) === JSON.stringify(identity.targets);
    return candidate[key] === identity[key];
  };
  let best = compatible[0];
  let bestMismatchCount = Number.POSITIVE_INFINITY;
  for (const candidate of compatible) {
    const mismatchCount = dimensions.reduce((count, [key]) => count + (dimensionMatches(candidate, key) ? 0 : 1), 0);
    if (mismatchCount < bestMismatchCount) {
      best = candidate;
      bestMismatchCount = mismatchCount;
    }
  }
  for (const [key, reason] of dimensions) {
    if (!dimensionMatches(best, key)) return reason;
  }
  return fallbackReason;
}

export function classifyCommandResultCacheMiss(identity: CommandResultReuseIdentity) {
  const candidates = Array.from(cache.values())
    .map((entry) => entry.evidence?.reuseIdentity)
    .filter((entry): entry is CommandResultReuseIdentity => Boolean(entry));
  return classifyCommandResultIdentityMismatch(
    candidates,
    identity,
    evictionCount > 0 ? 'ENTRY_EVICTED' : 'NO_REUSABLE_ENTRY',
  );
}

export function clearCommandResultCache() {
  const count = cache.size;
  cache.clear();
  evictionCount = 0;
  return count;
}

export function getCommandResultCacheStats() {
  prune();
  return { entries: cache.size, maxEntries: MAX_ENTRIES, defaultTtlMs: DEFAULT_TTL_MS, evictions: evictionCount };
}
