import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import { createApiError } from './api';
import { recordRepoCacheAccess, registerRepoCacheInvalidator } from './repoCacheInvalidationService';

const DEFAULT_IGNORED_ENTRY_NAMES = new Set([
  '.git', '.devflow', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.vite',
]);
const DEFAULT_RIPGREP_EXCLUDES = [
  '!**/.git/**', '!**/.devflow/jobs/**', '!**/node_modules/**', '!**/dist/**', '!**/build/**', '!**/coverage/**',
  '!**/.next/**', '!**/.turbo/**', '!**/.vite/**', '!**/.yarn/**', '!**/.vscode/**', '!**/.idea/**',
  '!**/*.lock', '!**/*-lock.json', '!**/*.map', '!**/*.min.js', '!**/*.min.css', '!**/*.log',
];
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX_ENTRIES = 100;
const FALLBACK_SEARCH_MAX_FILES = 5_000;
const FALLBACK_SEARCH_MAX_FILE_BYTES = 200 * 1024;
const RIPGREP_FAILURE_COOLDOWN_MS = 5_000;

type SearchBackend = 'ripgrep' | 'fallback';
export type SearchFallbackReason = 'ripgrep-unavailable' | 'ripgrep-exec-error' | 'ripgrep-runtime-failure' | 'circuit-open' | 'recovery-forced';

type RipgrepResolution = {
  key: string;
  executable: string | null;
  source: 'explicit' | 'devflow-bundled' | 'editor-bundled' | 'path' | null;
};

export type SearchResult = {
  root: string;
  path: string;
  query: string;
  count: number;
  scannedMatchCount: number;
  truncated: boolean;
  matches: Array<{ path: string; line: number; preview: string }>;
  terminatedAfterLimit?: boolean;
  backend?: SearchBackend;
  fallbackReason?: SearchFallbackReason;
  cache?: { hit: boolean; generatedAt: string; ageMs: number; ttlMs: number };
};

type SearchCacheEntry = { createdAt: number; result: SearchResult };

let ripgrepResolutionCache: RipgrepResolution | null = null;
let ripgrepFailureCircuit: { path: string; reason: string; openUntil: number } | null = null;
const localSearchRuntimeMetrics = {
  fallbackCount: 0,
  infrastructureFailureCount: 0,
  circuitBypassCount: 0,
  lastFallbackReason: null as SearchFallbackReason | null,
};
const searchCache = new Map<string, SearchCacheEntry>();

function shouldUseIgnoredEntries(args: Record<string, any>) {
  return args.includeIgnored === true || String(args.includeIgnored).toLowerCase() === 'true';
}

function shouldSkipFallbackDirectory(entryName: string, args: Record<string, any>) {
  if (shouldUseIgnoredEntries(args)) return false;
  return DEFAULT_IGNORED_ENTRY_NAMES.has(entryName) || ['.yarn', '.vscode', '.idea'].includes(entryName);
}

function shouldSkipFallbackFile(filePath: string, args: Record<string, any>) {
  if (shouldUseIgnoredEntries(args)) return false;
  const name = path.basename(filePath).toLowerCase();
  return name.endsWith('.lock') || name.endsWith('-lock.json') || name.endsWith('.map') || name.endsWith('.min.js') || name.endsWith('.min.css') || name.endsWith('.log');
}

function pathExecutableCandidates(directory: string) {
  const base = path.join(directory, 'rg');
  if (process.platform !== 'win32') return [base];
  const pathExt = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const preferred = ['.exe', ...pathExt.filter((entry) => entry !== '.exe')];
  return preferred.map((extension) => `${base}${extension}`);
}

function isExecutableFile(candidate: string) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function ripgrepBinaryName() { return process.platform === 'win32' ? 'rg.exe' : 'rg'; }
function ripgrepPlatformTarget() { return `${process.platform}-${process.arch}`; }

function ripgrepPackageCandidates(appRoot: string) {
  const binary = ripgrepBinaryName();
  const target = ripgrepPlatformTarget();
  return [
    path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', target, binary),
    path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', binary),
    path.join(appRoot, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', target, binary),
    path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', target, binary),
    path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', target, binary),
  ];
}

function editorBundledRipgrepCandidates() {
  if (process.platform !== 'win32') return [];
  const installRoots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code Insiders') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Microsoft VS Code') : '',
  ].filter(Boolean);
  const candidates: string[] = [];
  for (const installRoot of installRoots) {
    const appRoots = [path.join(installRoot, 'resources', 'app')];
    try {
      for (const entry of fs.readdirSync(installRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) appRoots.push(path.join(installRoot, entry.name, 'resources', 'app'));
      }
    } catch {
      // Optional editor discovery must never make local search fail.
    }
    for (const appRoot of appRoots) candidates.push(...ripgrepPackageCandidates(appRoot));
  }
  return candidates;
}

function resolveRipgrepExecutable() {
  const explicit = String(process.env.DEVFLOW_RG_PATH || '').trim();
  const pathValue = String(process.env.PATH || '');
  const appRoot = getDevFlowAppRoot();
  const key = [process.platform, process.arch, appRoot, explicit, pathValue, String(process.env.PATHEXT || ''), String(process.env.LOCALAPPDATA || ''), String(process.env.ProgramFiles || '')].join('|');
  if (ripgrepResolutionCache?.key === key) return ripgrepResolutionCache.executable;

  let executable: string | null = null;
  let source: RipgrepResolution['source'] = null;
  if (explicit) {
    const candidate = path.resolve(explicit);
    if (isExecutableFile(candidate)) { executable = candidate; source = 'explicit'; }
  }
  if (!executable) {
    for (const candidate of ripgrepPackageCandidates(appRoot)) {
      if (!isExecutableFile(candidate)) continue;
      executable = candidate; source = 'devflow-bundled'; break;
    }
  }
  if (!executable) {
    for (const candidate of editorBundledRipgrepCandidates()) {
      if (!isExecutableFile(candidate)) continue;
      executable = candidate; source = 'editor-bundled'; break;
    }
  }
  if (!executable && pathValue) {
    for (const directory of pathValue.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)) {
      const normalizedDirectory = directory.replace(/^"|"$/g, '');
      for (const candidate of pathExecutableCandidates(normalizedDirectory)) {
        if (!isExecutableFile(candidate)) continue;
        executable = candidate; source = 'path'; break;
      }
      if (executable) break;
    }
  }
  ripgrepResolutionCache = { key, executable, source };
  return executable;
}

export function clearLocalSearchRuntimeState() {
  ripgrepResolutionCache = null;
  ripgrepFailureCircuit = null;
  localSearchRuntimeMetrics.fallbackCount = 0;
  localSearchRuntimeMetrics.infrastructureFailureCount = 0;
  localSearchRuntimeMetrics.circuitBypassCount = 0;
  localSearchRuntimeMetrics.lastFallbackReason = null;
}

function getActiveRipgrepCircuit(ripgrepPath: string | null, now = Date.now()) {
  if (!ripgrepPath || !ripgrepFailureCircuit || ripgrepFailureCircuit.path !== ripgrepPath) return null;
  if (ripgrepFailureCircuit.openUntil <= now) { ripgrepFailureCircuit = null; return null; }
  return ripgrepFailureCircuit;
}

function recordSearchFallback(reason: SearchFallbackReason) {
  localSearchRuntimeMetrics.fallbackCount += 1;
  localSearchRuntimeMetrics.lastFallbackReason = reason;
  if (reason === 'circuit-open') localSearchRuntimeMetrics.circuitBypassCount += 1;
}

function recordRipgrepInfrastructureFailure(ripgrepPath: string, reason: string) {
  localSearchRuntimeMetrics.infrastructureFailureCount += 1;
  ripgrepFailureCircuit = { path: ripgrepPath, reason, openUntil: Date.now() + RIPGREP_FAILURE_COOLDOWN_MS };
}

function markRipgrepSuccess(ripgrepPath: string) { if (ripgrepFailureCircuit?.path === ripgrepPath) ripgrepFailureCircuit = null; }
function isRipgrepQueryFailure(stderr: string) { return /regex parse error|error parsing regex|invalid regex|unclosed group|unrecognized escape|repetition operator|look-around|backreferences? (?:are|is) not supported/i.test(stderr); }

export function getLocalSearchRuntimeStatus() {
  const resolvedRipgrepPath = resolveRipgrepExecutable();
  const circuit = getActiveRipgrepCircuit(resolvedRipgrepPath);
  const ripgrepPath = circuit ? null : resolvedRipgrepPath;
  const fallbackReason: SearchFallbackReason | null = circuit ? 'circuit-open' : resolvedRipgrepPath ? null : 'ripgrep-unavailable';
  return {
    backend: (ripgrepPath ? 'ripgrep' : 'fallback') as SearchBackend,
    ripgrepPath,
    ripgrepCandidatePath: circuit ? resolvedRipgrepPath : null,
    ripgrepSource: ripgrepResolutionCache?.source || null,
    fallbackAvailable: true,
    fallbackReason,
    circuitOpen: Boolean(circuit),
    circuitOpenUntil: circuit ? new Date(circuit.openUntil).toISOString() : null,
    fallbackCount: localSearchRuntimeMetrics.fallbackCount,
    infrastructureFailureCount: localSearchRuntimeMetrics.infrastructureFailureCount,
    circuitBypassCount: localSearchRuntimeMetrics.circuitBypassCount,
    lastFallbackReason: localSearchRuntimeMetrics.lastFallbackReason,
  };
}

function compileFallbackSearchRegex(query: string) {
  try { return new RegExp(query); }
  catch (error) {
    throw createApiError(400, 'SEARCH_QUERY_INVALID', 'Search query is not a valid regular expression.', { details: error instanceof Error ? error.message : String(error) });
  }
}

function searchLocalFilesFallback(root: string, searchPath: string, query: string, limit: number, args: Record<string, any>) {
  const matcher = compileFallbackSearchRegex(query);
  const matches: Array<{ path: string; line: number; preview: string }> = [];
  let scannedMatchCount = 0;
  let scannedFiles = 0;
  let truncated = false;
  const stack = [searchPath];
  while (stack.length > 0 && scannedFiles < FALLBACK_SEARCH_MAX_FILES && !truncated) {
    const currentPath = stack.pop()!;
    let stat: fs.Stats;
    try { stat = fs.statSync(currentPath); } catch { continue; }
    if (stat.isDirectory()) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(currentPath, { withFileTypes: true }); } catch { continue; }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && shouldSkipFallbackDirectory(entry.name, args)) continue;
        stack.push(path.join(currentPath, entry.name));
      }
      continue;
    }
    if (!stat.isFile() || stat.size > FALLBACK_SEARCH_MAX_FILE_BYTES || shouldSkipFallbackFile(currentPath, args)) continue;
    scannedFiles += 1;
    let content: string;
    try { content = fs.readFileSync(currentPath, 'utf8'); } catch { continue; }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      matcher.lastIndex = 0;
      if (!matcher.test(lines[index])) continue;
      scannedMatchCount += 1;
      if (matches.length < limit) {
        matches.push({ path: path.relative(root, currentPath), line: index + 1, preview: lines[index].trim() });
        continue;
      }
      truncated = true;
      break;
    }
  }
  if (scannedFiles >= FALLBACK_SEARCH_MAX_FILES && stack.length > 0) truncated = true;
  return { matches, scannedMatchCount, truncated, scannedFiles };
}

function buildRipgrepArgs(query: string, searchPath: string, limit: number, args: Record<string, any>) {
  const rgArgs = ['--json', '--line-number', '--hidden', '--max-count', String(limit), '--max-filesize', '200K'];
  if (!shouldUseIgnoredEntries(args)) for (const glob of DEFAULT_RIPGREP_EXCLUDES) rgArgs.push('--glob', glob);
  rgArgs.push(query, searchPath);
  return rgArgs;
}

function makeSearchCacheKey(root: string, searchPath: string, query: string, limit: number, args: Record<string, any>) {
  return JSON.stringify({ root: path.resolve(root), path: path.relative(root, searchPath) || '.', query, limit, includeIgnored: shouldUseIgnoredEntries(args) });
}

function cloneSearchResult(result: SearchResult): SearchResult {
  return { ...result, matches: result.matches.map((match) => ({ ...match })), cache: result.cache ? { ...result.cache } : undefined };
}

function getCachedSearchResult(cacheKey: string): SearchResult | null {
  const entry = searchCache.get(cacheKey);
  if (!entry) return null;
  const ageMs = Date.now() - entry.createdAt;
  if (ageMs > SEARCH_CACHE_TTL_MS) { searchCache.delete(cacheKey); return null; }
  const cached = cloneSearchResult(entry.result);
  cached.cache = { hit: true, generatedAt: new Date(entry.createdAt).toISOString(), ageMs, ttlMs: SEARCH_CACHE_TTL_MS };
  return cached;
}

function rememberSearchResult(cacheKey: string, result: SearchResult): SearchResult {
  const createdAt = Date.now();
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  const stored = cloneSearchResult(result);
  stored.cache = undefined;
  searchCache.set(cacheKey, { createdAt, result: stored });
  return { ...cloneSearchResult(result), cache: { hit: false, generatedAt: new Date(createdAt).toISOString(), ageMs: 0, ttlMs: SEARCH_CACHE_TTL_MS } };
}

function parseRipgrepMatchLine(line: string, root: string) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    if (parsed.type !== 'match') return null;
    return { path: path.relative(root, parsed.data.path.text), line: parsed.data.line_number, preview: parsed.data.lines.text.trim() };
  } catch { return null; }
}

function parseRipgrepMatches(stdout: string, root: string, limit: number) {
  const matches: Array<{ path: string; line: number; preview: string }> = [];
  let scannedMatchCount = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const match = parseRipgrepMatchLine(line, root);
    if (!match) continue;
    scannedMatchCount += 1;
    if (matches.length < limit) matches.push(match);
  }
  return { matches, scannedMatchCount, truncated: scannedMatchCount > matches.length };
}

export function clearLocalFileSearchCache(root?: string) {
  if (!root) { const count = searchCache.size; searchCache.clear(); return count; }
  const normalizedRoot = path.resolve(root);
  let count = 0;
  for (const [key, entry] of Array.from(searchCache.entries())) {
    try {
      const parsed = JSON.parse(key.split('|')[0]);
      if (path.resolve(parsed.root) === normalizedRoot || path.resolve(entry.result.root) === normalizedRoot) { searchCache.delete(key); count += 1; }
    } catch { searchCache.delete(key); count += 1; }
  }
  return count;
}

registerRepoCacheInvalidator('local-file-search', clearLocalFileSearchCache);

function prepareSearch(root: string, searchPath: string, args: Record<string, any>) {
  const query = String(args.query || '').trim();
  if (!query) throw createApiError(400, 'QUERY_REQUIRED', 'query is required.');
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : 20;
  const runtime = getLocalSearchRuntimeStatus();
  const cacheKey = `${makeSearchCacheKey(root, searchPath, query, limit, args)}|${runtime.backend}|${runtime.ripgrepPath || ''}`;
  return { query, limit, runtime, cacheKey };
}

function fallbackResult(root: string, searchPath: string, query: string, limit: number, args: Record<string, any>, cacheKey: string, reason: SearchFallbackReason, terminated = false) {
  recordSearchFallback(reason);
  const fallback = searchLocalFilesFallback(root, searchPath, query, limit, args);
  return rememberSearchResult(cacheKey, {
    root,
    path: path.relative(root, searchPath) || '.',
    query,
    count: fallback.matches.length,
    scannedMatchCount: fallback.scannedMatchCount,
    truncated: fallback.truncated,
    terminatedAfterLimit: terminated || (fallback.truncated && fallback.matches.length >= limit),
    backend: 'fallback',
    fallbackReason: reason,
    matches: fallback.matches,
  });
}

export function searchResolvedLocalFiles(root: string, searchPath: string, args: Record<string, any>) {
  const { query, limit, runtime, cacheKey } = prepareSearch(root, searchPath, args);
  if (args.forceFallbackSearch === true) {
    recordRepoCacheAccess('local-file-search', false, root);
    return fallbackResult(root, searchPath, query, limit, args, cacheKey, 'recovery-forced');
  }
  const cached = getCachedSearchResult(cacheKey);
  recordRepoCacheAccess('local-file-search', Boolean(cached), root);
  if (cached) return cached;
  if (!runtime.ripgrepPath) return fallbackResult(root, searchPath, query, limit, args, cacheKey, (runtime.fallbackReason || 'ripgrep-unavailable') as SearchFallbackReason);

  const rg = spawnSync(runtime.ripgrepPath, buildRipgrepArgs(query, searchPath, limit, args), { cwd: root, encoding: 'utf8', shell: false, maxBuffer: 2_000_000 });
  if (rg.error) {
    recordRipgrepInfrastructureFailure(runtime.ripgrepPath, rg.error.message);
    return fallbackResult(root, searchPath, query, limit, args, cacheKey, 'ripgrep-exec-error');
  }
  if (rg.status !== 0 && rg.status !== 1) {
    const stderr = rg.stderr?.trim() || '';
    if (isRipgrepQueryFailure(stderr)) throw createApiError(400, 'SEARCH_QUERY_INVALID', 'Search query is not valid for ripgrep.', { details: { exitCode: rg.status, stderr } });
    recordRipgrepInfrastructureFailure(runtime.ripgrepPath, stderr || `exit ${rg.status}`);
    return fallbackResult(root, searchPath, query, limit, args, cacheKey, 'ripgrep-runtime-failure');
  }
  markRipgrepSuccess(runtime.ripgrepPath);
  const parsed = parseRipgrepMatches(rg.stdout || '', root, limit);
  return rememberSearchResult(cacheKey, { root, path: path.relative(root, searchPath) || '.', query, count: parsed.matches.length, scannedMatchCount: parsed.scannedMatchCount, truncated: parsed.truncated, backend: 'ripgrep', matches: parsed.matches });
}

export async function searchResolvedLocalFilesAsync(
  root: string,
  searchPath: string,
  args: Record<string, any>,
  logger: { stdout: (data: string) => void; stderr: (data: string) => void },
  setCancelFn: (fn: () => void) => void,
): Promise<SearchResult> {
  const { query, limit, runtime, cacheKey } = prepareSearch(root, searchPath, args);
  if (args.forceFallbackSearch === true) {
    recordRepoCacheAccess('local-file-search', false, root);
    return fallbackResult(root, searchPath, query, limit, args, cacheKey, 'recovery-forced');
  }
  const cached = getCachedSearchResult(cacheKey);
  recordRepoCacheAccess('local-file-search', Boolean(cached), root);
  if (cached) return cached;
  if (!runtime.ripgrepPath) return fallbackResult(root, searchPath, query, limit, args, cacheKey, (runtime.fallbackReason || 'ripgrep-unavailable') as SearchFallbackReason);

  return new Promise((resolve, reject) => {
    const child = spawn(runtime.ripgrepPath!, buildRipgrepArgs(query, searchPath, limit, args), { cwd: root, shell: false });
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    let scannedMatchCount = 0;
    let lineBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    let terminatedAfterLimit = false;

    const processLine = (line: string) => {
      const match = parseRipgrepMatchLine(line, root);
      if (!match) return;
      scannedMatchCount += 1;
      if (matches.length < limit) matches.push(match);
      if (matches.length >= limit && !terminatedAfterLimit) { terminatedAfterLimit = true; child.kill('SIGTERM'); }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(rememberSearchResult(cacheKey, { root, path: path.relative(root, searchPath) || '.', query, count: matches.length, scannedMatchCount, truncated: terminatedAfterLimit || scannedMatchCount > matches.length, terminatedAfterLimit, backend: 'ripgrep', matches }));
    };
    setCancelFn(() => { if (settled) return; settled = true; child.kill('SIGTERM'); reject(new Error('Job cancelled')); });
    child.stdout.on('data', (data) => {
      const chunk = data.toString('utf8');
      lineBuffer += chunk;
      logger.stdout(chunk);
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) { processLine(line); if (terminatedAfterLimit) break; }
    });
    child.stderr.on('data', (data) => { const chunk = data.toString('utf8'); stderrBuffer += chunk; logger.stderr(chunk); });
    child.on('error', (error) => {
      if (settled) return;
      recordRipgrepInfrastructureFailure(runtime.ripgrepPath!, error.message);
      settled = true;
      resolve(fallbackResult(root, searchPath, query, limit, args, cacheKey, 'ripgrep-exec-error'));
    });
    child.on('close', (code) => {
      if (!terminatedAfterLimit && lineBuffer.trim()) processLine(lineBuffer);
      if (settled) return;
      if (code !== 0 && code !== 1 && !terminatedAfterLimit) {
        const stderr = stderrBuffer.trim();
        if (isRipgrepQueryFailure(stderr)) { settled = true; reject(createApiError(400, 'SEARCH_QUERY_INVALID', 'Search query is not valid for ripgrep.', { details: { exitCode: code, stderr } })); return; }
        recordRipgrepInfrastructureFailure(runtime.ripgrepPath!, stderr || `exit ${code}`);
        settled = true;
        resolve(fallbackResult(root, searchPath, query, limit, args, cacheKey, 'ripgrep-runtime-failure'));
        return;
      }
      if (runtime.ripgrepPath) markRipgrepSuccess(runtime.ripgrepPath);
      finish();
    });
  });
}
