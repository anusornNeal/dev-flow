import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 128;

type MetadataCacheEntry = {
  filePath: string;
  size: number;
  mtimeMs: number;
  content: string;
};

const cache = new Map<string, MetadataCacheEntry>();
let hits = 0;
let misses = 0;

function normalizedKey(filePath: string) {
  return path.resolve(filePath);
}

function pruneForInsert() {
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function readWorkspaceMetadataFile(filePath: string, maxBytes: number) {
  const key = normalizedKey(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(key);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      cache.delete(key);
      misses += 1;
      return null;
    }
    throw error;
  }
  if (!stat.isFile()) return null;
  if (stat.size > maxBytes) {
    throw new Error(`Metadata file '${key}' is ${stat.size} bytes; limit is ${maxBytes}.`);
  }

  const cached = cache.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    hits += 1;
    cache.delete(key);
    cache.set(key, cached);
    return { ...cached, cacheHit: true };
  }

  misses += 1;
  const entry: MetadataCacheEntry = {
    filePath: key,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    content: fs.readFileSync(key, 'utf8'),
  };
  cache.delete(key);
  pruneForInsert();
  cache.set(key, entry);
  return { ...entry, cacheHit: false };
}

export function clearWorkspaceMetadataCache(filePath?: string) {
  if (filePath) return cache.delete(normalizedKey(filePath)) ? 1 : 0;
  const count = cache.size;
  cache.clear();
  hits = 0;
  misses = 0;
  return count;
}

export function getWorkspaceMetadataCacheStats() {
  return { entries: cache.size, maxEntries: MAX_ENTRIES, hits, misses };
}
