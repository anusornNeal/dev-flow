const DEFAULT_TTL_MS = 2 * 60_000;
const MAX_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 128;

type CommandResultCacheEntry<T> = {
  createdAt: number;
  expiresAt: number;
  value: T;
};

const cache = new Map<string, CommandResultCacheEntry<unknown>>();

function prune(now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function getCachedCommandResult<T>(key: string): { value: T; createdAt: number } | null {
  const now = Date.now();
  const entry = cache.get(key) as CommandResultCacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return { value: entry.value, createdAt: entry.createdAt };
}

export function rememberCommandResult<T>(key: string, value: T, ttlMs?: number) {
  const now = Date.now();
  prune(now);
  const parsed = Number(ttlMs);
  const ttl = Number.isFinite(parsed) ? Math.max(1_000, Math.min(MAX_TTL_MS, Math.floor(parsed))) : DEFAULT_TTL_MS;
  cache.set(key, { createdAt: now, expiresAt: now + ttl, value });
  return { createdAt: now, expiresAt: now + ttl };
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
