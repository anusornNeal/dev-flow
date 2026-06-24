import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { resolveProjectRoot, resolveSafePath } from './localFileService';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_FILES = 2500;
const MAX_FILE_BYTES = 100_000;
const INDEX_EXTENSIONS = new Set(['.kt', '.kts', '.java', '.xml', '.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', '.gradle', '.idea', '.devflow', '.agents']);

interface RepoIndexEntry {
  path: string;
  extension: string;
  symbols: string[];
  preview: string;
}

interface RepoIndexCacheEntry {
  root: string;
  generatedAt: number;
  entries: RepoIndexEntry[];
}

const cache = new Map<string, RepoIndexCacheEntry>();

export function clearRepoInspectionIndexCache() {
  cache.clear();
}

function walkFiles(root: string, startPath: string, results: string[], signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('Operation aborted');
  }
  if (results.length >= MAX_FILES) return;
  for (const entry of fs.readdirSync(startPath, { withFileTypes: true })) {
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }
    if (results.length >= MAX_FILES) return;
    if (entry.name.startsWith('.') && !['.github'].includes(entry.name)) continue;
    const fullPath = path.join(startPath, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkFiles(root, fullPath, results, signal);
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (INDEX_EXTENSIONS.has(extension)) {
      results.push(path.relative(root, fullPath));
    }
  }
}

function extractSymbols(content: string, extension: string) {
  const symbols = new Set<string>();
  const patterns = extension === '.xml'
    ? [
        /android:id="@\+id\/([A-Za-z0-9_]+)"/g,
        /name="([A-Za-z0-9_.]+)"/g,
      ]
    : [
        /\b(?:class|interface|object|enum class|data class)\s+([A-Z][A-Za-z0-9_]*)/g,
        /\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
        /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
        /\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g,
      ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) symbols.add(match[1]);
      if (symbols.size >= 30) return Array.from(symbols);
    }
  }
  return Array.from(symbols);
}

function buildIndex(root: string, relativePath?: string, signal?: AbortSignal): RepoIndexCacheEntry {
  const basePath = resolveSafePath(root, relativePath || '.');
  const files: string[] = [];
  walkFiles(root, basePath, files, signal);

  const entries: RepoIndexEntry[] = [];
  for (const relativeFile of files) {
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }
    const fullPath = path.join(root, relativeFile);
    const stat = fs.statSync(fullPath);
    const extension = path.extname(relativeFile).toLowerCase();
    const content = stat.size <= MAX_FILE_BYTES ? fs.readFileSync(fullPath, 'utf8') : '';
    entries.push({
      path: relativeFile,
      extension,
      symbols: content ? extractSymbols(content, extension) : [],
      preview: content.split(/\r?\n/).slice(0, 12).join('\n'),
    });
  }

  return { root, generatedAt: Date.now(), entries };
}

function getOrBuildIndex(state: AppState, args: Record<string, any>, signal?: AbortSignal) {
  const root = resolveProjectRoot(state, args);
  const relativePath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
  const cacheKey = `${path.resolve(root)}::${relativePath}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) {
    return { index: cached, cached: true };
  }
  const index = buildIndex(root, relativePath, signal);
  cache.set(cacheKey, index);
  return { index, cached: false };
}

function scoreEntry(entry: RepoIndexEntry, queryTerms: string[]) {
  if (queryTerms.length === 0) return 1;
  const haystack = [entry.path, ...entry.symbols, entry.preview].join(' ').toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export function getRepoInspectionIndex(state: AppState, args: Record<string, any>, signal?: AbortSignal) {
  const { index, cached } = getOrBuildIndex(state, args, signal);
  const queryTerms = String(args.q || args.query || '')
    .toLowerCase()
    .split(/[^a-z0-9_ก-๙]+/i)
    .map((term) => term.trim())
    .filter(Boolean);
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(50, Number(args.limit))) : 15;

  const matches = index.entries
    .map((entry) => ({ entry, score: scoreEntry(entry, queryTerms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path))
    .slice(0, limit)
    .map(({ entry, score }) => ({
      path: entry.path,
      extension: entry.extension,
      symbols: entry.symbols,
      score,
    }));

  return {
    root: index.root,
    cached,
    generatedAt: new Date(index.generatedAt).toISOString(),
    fileCount: index.entries.length,
    query: queryTerms.join(' '),
    matches,
  };
}
