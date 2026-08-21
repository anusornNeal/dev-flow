import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 2 * 60_000;
const MAX_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 128;

export type CommandResultEvidenceMetadata = {
  evidenceId: string;
  sourceConsumerId?: string;
  consumers: string[];
  reusable: boolean;
  retention?: 'ttl' | 'bounded';
};

type CommandResultCacheEntry<T> = {
  createdAt: number;
  expiresAt: number | null;
  value: T;
  evidence?: CommandResultEvidenceMetadata;
};

const cache = new Map<string, CommandResultCacheEntry<unknown>>();

function prune(now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
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
  evidenceInput?: { sourceConsumerId?: string; reusable?: boolean; retention?: 'ttl' | 'bounded' },
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
  } satisfies CommandResultEvidenceMetadata : undefined;
  cache.set(key, { createdAt: now, expiresAt, value, ...(evidence ? { evidence } : {}) });
  return { createdAt: now, expiresAt, ...(evidence ? { evidence: { ...evidence, consumers: [...evidence.consumers] } } : {}) };
}

export function clearCommandResultCache() {
  const count = cache.size;
  cache.clear();
  return count;
}

export function getCommandResultCacheStats() {
  prune();
  return { entries: cache.size, maxEntries: MAX_ENTRIES, defaultTtlMs: DEFAULT_TTL_MS };
}
