import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { resolveProjectRoot, resolveSafePath } from './localFileService';
import { getProjectRulesContext, type ProjectFileRules } from './projectRulesService';
import { getRepoCacheLineage, recordRepoCacheAccess, registerRepoCacheInvalidator, type RepoCacheInvalidationContext } from './repoCacheInvalidationService';
import { getRepoRevisionForRoot, type RepoRevision } from './repoRevisionService';
import { rankContextEvidence } from './contextBudgetPlannerService';

const CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_MAX_FILES = 2500;
const FALLBACK_MAX_FILE_BYTES = 100_000;
const INDEX_EXTENSIONS = new Set(['.kt', '.kts', '.java', '.xml', '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.yaml', '.yml', '.sql']);
const FALLBACK_SKIP_DIRS = [
  '.git',
  'node_modules',
  'build',
  'dist',
  '.gradle',
  '.idea',
  '.devflow',
  '.agents',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'out',
  'tmp',
  'temp',
];
const FALLBACK_INCLUDE_DIRS = ['.github'];

interface RepoIndexEntry {
  path: string;
  extension: string;
  symbols: string[];
  imports: string[];
  referenceSymbols: string[];
  preview: string;
}

interface RepoIndexCacheEntry {
  root: string;
  relativePath: string;
  generatedAt: number;
  repoRevision?: RepoRevision;
  entries: RepoIndexEntry[];
  metadata: {
    maxFiles: number;
    maxFileBytes: number;
    includeIgnored: boolean;
    skippedDirectories: string[];
    skippedDirectoryCount: number;
    truncated: boolean;
    rules: {
      source: 'project-rules';
      ignoredDirectoryCount: number;
      includedDotDirectories: string[];
    };
  };
}

interface EffectiveFileRules {
  ignoreDirectories: Set<string>;
  includeDirectories: Set<string>;
  maxFiles: number;
  maxFileBytes: number;
}

const cache = new Map<string, RepoIndexCacheEntry>();

export function clearRepoInspectionIndexCache(root?: string) {
  if (!root) {
    const count = cache.size;
    cache.clear();
    return count;
  }
  const normalizedRoot = path.resolve(root);
  let count = 0;
  for (const [key, entry] of Array.from(cache.entries())) {
    if (path.resolve(entry.root) === normalizedRoot || key.startsWith(`${normalizedRoot}::`)) {
      cache.delete(key);
      count += 1;
    }
  }
  return count;
}

registerRepoCacheInvalidator('repo-inspection-index', (root?: string, context?: RepoCacheInvalidationContext) => {
  const dependencies = new Set(context?.dependencies || []);
  const requiresFullRebuild = dependencies.has('project-rules') || dependencies.has('repo-revision');
  if (root && context?.paths?.length && context.uncertain !== true && !requiresFullRebuild) return 0;
  return clearRepoInspectionIndexCache(root);
}, { dependencies: ['repo-content', 'repo-revision', 'project-rules'] });

function parseBoolean(value: unknown) {
  return value === true || String(value).toLowerCase() === 'true';
}

function normalizeRulePath(value: string) {
  return value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function loadEffectiveFileRules(): EffectiveFileRules {
  const projectRules: ProjectFileRules | undefined = getProjectRulesContext().files;
  const ignoreDirectories = new Set((projectRules?.ignoreDirectories?.length ? projectRules.ignoreDirectories : FALLBACK_SKIP_DIRS).map(normalizeRulePath));
  const includeDirectories = new Set((projectRules?.includeDirectories?.length ? projectRules.includeDirectories : FALLBACK_INCLUDE_DIRS).map(normalizeRulePath));
  for (const includeDir of includeDirectories) {
    ignoreDirectories.delete(includeDir);
  }
  return {
    ignoreDirectories,
    includeDirectories,
    maxFiles: projectRules?.maxFiles ?? FALLBACK_MAX_FILES,
    maxFileBytes: projectRules?.maxFileBytes ?? FALLBACK_MAX_FILE_BYTES,
  };
}

function shouldSkipDirectory(relativePath: string, entryName: string, rules: EffectiveFileRules) {
  const normalizedRelativePath = normalizeRulePath(relativePath);
  const normalizedEntryName = normalizeRulePath(entryName);
  return rules.ignoreDirectories.has(normalizedEntryName) || rules.ignoreDirectories.has(normalizedRelativePath);
}

function walkFiles(
  root: string,
  startPath: string,
  results: string[],
  options: { includeIgnored: boolean; skippedDirectories: Set<string>; rules: EffectiveFileRules },
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    throw new Error('Operation aborted');
  }
  if (results.length >= options.rules.maxFiles) return;
  for (const entry of fs.readdirSync(startPath, { withFileTypes: true })) {
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }
    if (results.length >= options.rules.maxFiles) return;
    const fullPath = path.join(startPath, entry.name);
    const relativeEntryPath = path.relative(root, fullPath).replace(/\\/g, '/') || entry.name;
    if (entry.name.startsWith('.') && !options.rules.includeDirectories.has(entry.name) && !options.includeIgnored) {
      options.skippedDirectories.add(relativeEntryPath);
      continue;
    }
    if (entry.isDirectory()) {
      if (!options.includeIgnored && shouldSkipDirectory(relativeEntryPath, entry.name, options.rules)) {
        options.skippedDirectories.add(relativeEntryPath);
        continue;
      }
      walkFiles(root, fullPath, results, options, signal);
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

function extractImports(content: string) {
  const imports = new Set<string>();
  for (const match of content.matchAll(/\b(?:from\s+|import\s*(?:\([^)]*\)\s*)?)["']([^"']+)["']/g)) {
    if (match[1]) imports.add(match[1]);
  }
  for (const match of content.matchAll(/^\s*import\s+([A-Za-z0-9_.*]+)\s*;?\s*$/gm)) {
    if (match[1] && !match[1].startsWith('{')) imports.add(match[1]);
  }
  return Array.from(imports).slice(0, 100);
}

function extractReferenceSymbols(content: string, ownSymbols: string[]) {
  const own = new Set(ownSymbols);
  const references = new Set<string>();
  for (const match of content.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)) {
    const value = match[0];
    if (own.has(value)) continue;
    if (['import', 'from', 'export', 'class', 'interface', 'function', 'fun', 'const', 'let', 'var', 'return', 'new', 'this', 'true', 'false', 'null', 'undefined'].includes(value)) continue;
    references.add(value);
    if (references.size >= 250) break;
  }
  return Array.from(references);
}

function buildIndexEntry(root: string, relativeFile: string, rules: EffectiveFileRules): RepoIndexEntry | null {
  const fullPath = path.join(root, relativeFile);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const extension = path.extname(relativeFile).toLowerCase();
  if (!INDEX_EXTENSIONS.has(extension)) return null;
  const content = stat.size <= rules.maxFileBytes ? fs.readFileSync(fullPath, 'utf8') : '';
  const symbols = content ? extractSymbols(content, extension) : [];
  return {
    path: relativeFile,
    extension,
    symbols,
    imports: content ? extractImports(content) : [],
    referenceSymbols: content ? extractReferenceSymbols(content, symbols) : [],
    preview: content.split(/\r?\n/).slice(0, 12).join('\n'),
  };
}

function tryGetRepoRevision(root: string): RepoRevision | undefined {
  try {
    return getRepoRevisionForRoot(root);
  } catch {
    return undefined;
  }
}

function isWithinIndexScope(root: string, relativePath: string, relativeFile: string) {
  const basePath = path.resolve(root, relativePath || '.');
  const fullPath = path.resolve(root, relativeFile);
  const fromBase = path.relative(basePath, fullPath);
  return fromBase === '' || (!fromBase.startsWith('..') && !path.isAbsolute(fromBase));
}

function shouldIndexChangedFile(relativeFile: string, includeIgnored: boolean, rules: EffectiveFileRules) {
  const normalized = normalizeRulePath(relativeFile);
  if (!INDEX_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return false;
  if (includeIgnored) return true;

  const parts = normalized.split('/').filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    const entryName = parts[index];
    const directoryPath = parts.slice(0, index + 1).join('/');
    if (entryName.startsWith('.') && !rules.includeDirectories.has(entryName)) return false;
    if (shouldSkipDirectory(directoryPath, entryName, rules)) return false;
  }
  return true;
}

function refreshIndexIncrementally(index: RepoIndexCacheEntry, currentRevision: RepoRevision, includeIgnored: boolean) {
  const previousRevision = index.repoRevision;
  if (!previousRevision || previousRevision.head !== currentRevision.head) return null;
  if ([...previousRevision.changedFiles, ...currentRevision.changedFiles].some((entry) => entry.status.startsWith('R'))) return null;

  const changedPaths = new Set([
    ...previousRevision.changedFiles.map((entry) => entry.workingPath),
    ...currentRevision.changedFiles.map((entry) => entry.workingPath),
  ]);
  const scopedPaths = Array.from(changedPaths).filter((relativeFile) => isWithinIndexScope(index.root, index.relativePath, relativeFile));
  const rules = loadEffectiveFileRules();
  const entries = new Map(index.entries.map((entry) => [normalizeRulePath(entry.path), entry]));

  for (const relativeFile of scopedPaths) {
    const normalized = normalizeRulePath(relativeFile);
    entries.delete(normalized);
    if (!shouldIndexChangedFile(normalized, includeIgnored, rules)) continue;
    const rebuilt = buildIndexEntry(index.root, normalized, rules);
    if (rebuilt) entries.set(normalized, rebuilt);
  }

  const refreshed: RepoIndexCacheEntry = {
    ...index,
    generatedAt: Date.now(),
    repoRevision: currentRevision,
    entries: Array.from(entries.values()).sort((left, right) => left.path.localeCompare(right.path)),
  };
  return { index: refreshed, changedEntries: scopedPaths.length };
}

function buildIndex(root: string, relativePath: string, includeIgnored: boolean, signal?: AbortSignal): RepoIndexCacheEntry {
  const basePath = resolveSafePath(root, relativePath || '.');
  const files: string[] = [];
  const skippedDirectories = new Set<string>();
  const rules = loadEffectiveFileRules();
  walkFiles(root, basePath, files, { includeIgnored, skippedDirectories, rules }, signal);

  const entries: RepoIndexEntry[] = [];
  for (const relativeFile of files) {
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }
    const entry = buildIndexEntry(root, relativeFile, rules);
    if (entry) entries.push(entry);
  }

  return {
    root,
    relativePath,
    generatedAt: Date.now(),
    repoRevision: tryGetRepoRevision(root),
    entries,
    metadata: {
      maxFiles: rules.maxFiles,
      maxFileBytes: rules.maxFileBytes,
      includeIgnored,
      skippedDirectories: Array.from(skippedDirectories).sort().slice(0, 50),
      skippedDirectoryCount: skippedDirectories.size,
      truncated: files.length >= rules.maxFiles,
      rules: {
        source: 'project-rules',
        ignoredDirectoryCount: rules.ignoreDirectories.size,
        includedDotDirectories: Array.from(rules.includeDirectories).sort(),
      },
    },
  };
}

function getOrBuildIndex(state: AppState, args: Record<string, any>, signal?: AbortSignal) {
  const root = resolveProjectRoot(state, args);
  const relativePath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
  const includeIgnored = parseBoolean(args.includeIgnored);
  const cacheKey = `${path.resolve(root)}::${relativePath}::includeIgnored=${includeIgnored}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    const currentRevision = tryGetRepoRevision(root);
    if (currentRevision && cached.repoRevision) {
      if (currentRevision.token === cached.repoRevision.token) {
        return { index: cached, cached: true, refresh: 'hit' as const, changedEntries: 0 };
      }
      const incremental = refreshIndexIncrementally(cached, currentRevision, includeIgnored);
      if (incremental) {
        cache.set(cacheKey, incremental.index);
        return { index: incremental.index, cached: true, refresh: 'incremental' as const, changedEntries: incremental.changedEntries };
      }
    } else if (Date.now() - cached.generatedAt < CACHE_TTL_MS) {
      return { index: cached, cached: true, refresh: 'hit' as const, changedEntries: 0 };
    }
  }
  const index = buildIndex(root, relativePath, includeIgnored, signal);
  cache.set(cacheKey, index);
  return { index, cached: false, refresh: 'rebuild' as const, changedEntries: index.entries.length };
}

function scoreEntry(entry: RepoIndexEntry, queryTerms: string[]) {
  if (queryTerms.length === 0) return 1;
  const haystack = [entry.path, ...entry.symbols, ...entry.imports, ...entry.referenceSymbols, entry.preview].join(' ').toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export function getRepoSemanticIndex(state: AppState, args: Record<string, any>, signal?: AbortSignal) {
  const { index, cached, refresh, changedEntries } = getOrBuildIndex(state, args, signal);
  recordRepoCacheAccess('repo-inspection-index', cached, index.root);
  const lineageToken = getRepoCacheLineage(index.root, ['repo-content', 'repo-revision', 'project-rules']).token;
  const symbol = String(args.symbol || args.q || args.query || '').trim();
  if (!symbol) {
    return { root: index.root, symbol, definitions: [], references: [], relatedTests: [], cache: { hit: cached, refresh, changedEntries, lineageToken } };
  }

  const definitions = index.entries
    .filter((entry) => entry.symbols.includes(symbol))
    .map((entry) => ({ path: entry.path, extension: entry.extension, symbols: entry.symbols, imports: entry.imports }));
  const references = index.entries
    .filter((entry) => entry.referenceSymbols.includes(symbol))
    .map((entry) => ({ path: entry.path, extension: entry.extension, symbols: entry.symbols, imports: entry.imports }));
  const relatedTests = [...definitions, ...references]
    .filter((entry, position, entries) => entries.findIndex((candidate) => candidate.path === entry.path) === position)
    .filter((entry) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:\.test\.|\.spec\.)/i.test(entry.path));

  return {
    root: index.root,
    symbol,
    repoRevision: index.repoRevision?.token,
    definitions,
    references,
    relatedTests,
    cache: { hit: cached, refresh, changedEntries, generatedAt: new Date(index.generatedAt).toISOString(), lineageToken },
  };
}

export function getRepoInspectionIndex(state: AppState, args: Record<string, any>, signal?: AbortSignal) {
  const { index, cached, refresh, changedEntries } = getOrBuildIndex(state, args, signal);
  recordRepoCacheAccess('repo-inspection-index', cached, index.root);
  const lineageToken = getRepoCacheLineage(index.root, ['repo-content', 'repo-revision', 'project-rules']).token;
  const queryTerms = String(args.q || args.query || '')
    .toLowerCase()
    .split(/[^a-z0-9_ก-๙]+/i)
    .map((term) => term.trim())
    .filter(Boolean);
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(50, Number(args.limit))) : 15;

  const rawMatches = index.entries
    .map((entry) => ({ entry, score: scoreEntry(entry, queryTerms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path))
    .slice(0, limit)
    .map(({ entry, score }) => ({
      path: entry.path,
      extension: entry.extension,
      symbols: entry.symbols,
      imports: entry.imports,
      score,
    }));
  const matches = rankContextEvidence(rawMatches, {
    query: String(args.q || args.query || ''),
    intent: args.contextIntent || args.intent,
    targetFiles: Array.isArray(args.targetFiles) ? args.targetFiles : [],
    changedFiles: Array.isArray(args.changedFiles) ? args.changedFiles : index.repoRevision?.changedFiles,
    snippetLimit: limit,
  });

  return {
    root: index.root,
    path: index.relativePath,
    cached,
    cache: {
      hit: cached,
      generatedAt: new Date(index.generatedAt).toISOString(),
      ttlMs: CACHE_TTL_MS,
      ageMs: Math.max(0, Date.now() - index.generatedAt),
      refresh,
      changedEntries,
      lineageToken,
    },
    generatedAt: new Date(index.generatedAt).toISOString(),
    repoRevision: index.repoRevision?.token,
    fileCount: index.entries.length,
    metadata: index.metadata,
    query: queryTerms.join(' '),
    matches,
  };
}
