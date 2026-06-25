import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync, spawn } from 'child_process';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import type { AppState } from '../types';
import { createApiError } from './api';
import { findProjectByIdentifier } from './taskService';
import { invalidateRepoReadCaches, registerRepoCacheInvalidator } from './repoCacheInvalidationService';

const DEFAULT_IGNORED_ENTRY_NAMES = new Set([
  '.git',
  '.devflow',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.vite',
]);

const DEFAULT_RIPGREP_EXCLUDES = [
  '!**/.git/**',
  '!**/.devflow/jobs/**',
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/coverage/**',
  '!**/.next/**',
  '!**/.turbo/**',
  '!**/.vite/**',
  '!**/.yarn/**',
  '!**/.vscode/**',
  '!**/.idea/**',
  '!**/*.lock',
  '!**/*-lock.json',
  '!**/*.map',
  '!**/*.min.js',
  '!**/*.min.css',
  '!**/*.log',
];

const READ_CHUNK_BYTES = 64 * 1024;
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX_ENTRIES = 100;

type SearchResult = {
  root: string;
  path: string;
  query: string;
  count: number;
  scannedMatchCount: number;
  truncated: boolean;
  matches: Array<{ path: string; line: number; preview: string }>;
  terminatedAfterLimit?: boolean;
  cache?: {
    hit: boolean;
    generatedAt: string;
    ageMs: number;
    ttlMs: number;
  };
};

type SearchCacheEntry = {
  createdAt: number;
  result: SearchResult;
};

const searchCache = new Map<string, SearchCacheEntry>();

export type FileRevision = {
  token: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  modifiedAt: string;
};

function buildFileRevision(filePath: string, stat: fs.Stats): FileRevision {
  const content = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  return {
    token: `${stat.size}:${Math.trunc(stat.mtimeMs)}:${sha256.slice(0, 16)}`,
    sha256,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    modifiedAt: stat.mtime.toISOString(),
  };
}

export function getFileRevision(filePath: string): FileRevision {
  return buildFileRevision(filePath, fs.statSync(filePath));
}

function expectedRevisionFromArgs(args: Record<string, any>): string | null {
  const value = args.expectedRevision ?? args.fileRevision ?? args.expectedFileRevision ?? args.expectedContentHash ?? args.expectedSha256;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function assertFileRevisionMatches(filePath: string, args: Record<string, any>, displayPath: string) {
  const expected = expectedRevisionFromArgs(args);
  if (!expected) return;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw createApiError(409, 'FILE_CHANGED_SINCE_READ', `File '${displayPath}' does not exist for expected revision '${expected}'.`, { affectedId: displayPath, expectedRevision: expected });
  }
  const actual = getFileRevision(filePath);
  const matches = expected === actual.token || expected === actual.sha256;
  if (!matches) {
    throw createApiError(409, 'FILE_CHANGED_SINCE_READ', `File '${displayPath}' changed since it was read.`, {
      affectedId: displayPath,
      expectedRevision: expected,
      actualRevision: actual.token,
      actualSha256: actual.sha256,
    });
  }
}

function shouldUseIgnoredEntries(args: Record<string, any>) {
  return args.includeIgnored === true || String(args.includeIgnored).toLowerCase() === 'true';
}

function shouldSkipEntry(entryName: string, args: Record<string, any>) {
  return !shouldUseIgnoredEntries(args) && DEFAULT_IGNORED_ENTRY_NAMES.has(entryName);
}

function buildRipgrepArgs(query: string, searchPath: string, limit: number, args: Record<string, any>) {
  const rgArgs = ['--json', '--line-number', '--hidden', '--max-count', String(limit), '--max-filesize', '200K'];
  if (!shouldUseIgnoredEntries(args)) {
    for (const glob of DEFAULT_RIPGREP_EXCLUDES) {
      rgArgs.push('--glob', glob);
    }
  }
  rgArgs.push(query, searchPath);
  return rgArgs;
}

function makeSearchCacheKey(root: string, searchPath: string, query: string, limit: number, args: Record<string, any>) {
  return JSON.stringify({
    root: path.resolve(root),
    path: path.relative(root, searchPath) || '.',
    query,
    limit,
    includeIgnored: shouldUseIgnoredEntries(args),
  });
}

function cloneSearchResult(result: SearchResult): SearchResult {
  return {
    ...result,
    matches: result.matches.map((match) => ({ ...match })),
    cache: result.cache ? { ...result.cache } : undefined,
  };
}

function getCachedSearchResult(cacheKey: string): SearchResult | null {
  const entry = searchCache.get(cacheKey);
  if (!entry) return null;
  const ageMs = Date.now() - entry.createdAt;
  if (ageMs > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(cacheKey);
    return null;
  }
  const cached = cloneSearchResult(entry.result);
  cached.cache = {
    hit: true,
    generatedAt: new Date(entry.createdAt).toISOString(),
    ageMs,
    ttlMs: SEARCH_CACHE_TTL_MS,
  };
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
  return {
    ...cloneSearchResult(result),
    cache: {
      hit: false,
      generatedAt: new Date(createdAt).toISOString(),
      ageMs: 0,
      ttlMs: SEARCH_CACHE_TTL_MS,
    },
  };
}

function parseRipgrepMatchLine(line: string, root: string) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    if (parsed.type !== 'match') return null;
    return {
      path: path.relative(root, parsed.data.path.text),
      line: parsed.data.line_number,
      preview: parsed.data.lines.text.trim(),
    };
  } catch {
    return null;
  }
}

function parseRipgrepMatches(stdout: string, root: string, limit: number) {
  const matches: Array<{ path: string; line: number; preview: string }> = [];
  let scannedMatchCount = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const match = parseRipgrepMatchLine(line, root);
    if (!match) continue;
    scannedMatchCount += 1;
    if (matches.length >= limit) continue;
    matches.push(match);
  }
  return { matches, scannedMatchCount, truncated: scannedMatchCount > matches.length };
}

function countLinesSync(filePath: string) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let totalLines = 1;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 10) totalLines += 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return totalLines;
}

function readLineWindowSync(filePath: string, startLine: number, endLine: number, maxBytes: number) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const selectedLines: string[] = [];
  let pending = '';
  let currentLine = 1;
  let collectionStoppedByBytes = false;
  const collectLine = (line: string) => {
    if (currentLine >= startLine && currentLine <= endLine && !collectionStoppedByBytes) {
      selectedLines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      if (Buffer.byteLength(selectedLines.join('\n'), 'utf8') > maxBytes + READ_CHUNK_BYTES) {
        collectionStoppedByBytes = true;
      }
    }
    currentLine += 1;
  };

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += buffer.subarray(0, bytesRead).toString('utf8');
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) {
        collectLine(part);
      }
    }
    collectLine(pending);
  } finally {
    fs.closeSync(fd);
  }

  let content = selectedLines.join('\n');
  let byteLength = Buffer.byteLength(content, 'utf8');
  let truncatedByBytes = collectionStoppedByBytes;
  if (maxBytes > 0 && byteLength > maxBytes) {
    content = Buffer.from(content, 'utf8').subarray(0, maxBytes).toString('utf8');
    content += '\n[truncated]';
    byteLength = Buffer.byteLength(content, 'utf8');
    truncatedByBytes = true;
  }

  return {
    content,
    totalLines: Math.max(1, currentLine - 1),
    byteLength,
    truncatedByBytes,
  };
}

export function clearLocalFileSearchCache(root?: string) {
  if (!root) {
    const count = searchCache.size;
    searchCache.clear();
    return count;
  }
  const normalizedRoot = path.resolve(root);
  let count = 0;
  for (const [key, entry] of Array.from(searchCache.entries())) {
    try {
      const parsed = JSON.parse(key);
      if (path.resolve(parsed.root) === normalizedRoot || path.resolve(entry.result.root) === normalizedRoot) {
        searchCache.delete(key);
        count += 1;
      }
    } catch {
      searchCache.delete(key);
      count += 1;
    }
  }
  return count;
}

registerRepoCacheInvalidator('local-file-search', clearLocalFileSearchCache);

export function resolveProjectRoot(state: AppState, args: Record<string, any>) {
  const identifierProject = findProjectByIdentifier(state, {
    projectId: typeof args.projectId === 'string' ? args.projectId.trim() : undefined,
    projectName: typeof args.projectName === 'string' ? args.projectName.trim() : undefined,
    repo: typeof args.repo === 'string' ? args.repo.trim() : undefined,
    repoUrl: typeof args.repoUrl === 'string' ? args.repoUrl.trim() : undefined,
    localPath: typeof args.localPath === 'string' ? args.localPath.trim() : undefined,
  });

  if (identifierProject) {
    return identifierProject.localPath || getDevFlowAppRoot();
  }

  const requestedIdentifier = args.projectId || args.projectName || args.repo || args.repoUrl || args.localPath;
  if (requestedIdentifier) {
    throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${requestedIdentifier}' was not found.`, { affectedId: String(requestedIdentifier) });
  }

  const directLocalPath = typeof args.localPath === 'string' ? args.localPath.trim() : '';
  if (directLocalPath) {
    return directLocalPath;
  }

  return getDevFlowAppRoot();
}

export function resolveSafePath(root: string, relativePath?: string) {
  const candidate = path.resolve(root, relativePath || '.');
  const normalizedRoot = path.resolve(root);
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  if (candidate !== normalizedRoot && !candidate.startsWith(rootWithSep)) {
    throw createApiError(403, 'FILE_ACCESS_DENIED', 'Requested path is outside the allowed project root.');
  }
  return candidate;
}

export function listLocalFiles(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  const targetPath = resolveSafePath(root, String(args.path || '.'));
  const recursive = args.recursive === true || String(args.recursive).toLowerCase() === 'true';
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(200, Number(args.limit))) : 100;
  const relativeBase = path.relative(root, targetPath) || '.';

  const results: Array<{ path: string; type: 'file' | 'directory' }> = [];
  const visit = (currentPath: string) => {
    if (results.length >= limit) return;
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (shouldSkipEntry(entry.name, args)) continue;
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(root, fullPath) || '.';
      results.push({ path: relativePath, type: entry.isDirectory() ? 'directory' : 'file' });
      if (recursive && entry.isDirectory()) {
        visit(fullPath);
      }
    }
  };

  if (!fs.existsSync(targetPath)) {
    throw createApiError(404, 'FILE_NOT_FOUND', `Path '${relativeBase}' was not found.`, { affectedId: relativeBase });
  }

  if (fs.statSync(targetPath).isDirectory()) {
    visit(targetPath);
  } else {
    results.push({ path: path.relative(root, targetPath), type: 'file' });
  }

  return {
    root,
    path: relativeBase,
    recursive,
    count: results.length,
    truncated: results.length >= limit,
    files: results,
  };
}

export function readLocalFile(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  const filePath = String(args.filePath || args.path || '').trim();
  if (!filePath) {
    throw createApiError(400, 'FILE_PATH_REQUIRED', 'filePath is required.');
  }

  const targetPath = resolveSafePath(root, filePath);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    throw createApiError(404, 'FILE_NOT_FOUND', `File '${filePath}' was not found.`, { affectedId: filePath });
  }

  const stat = fs.statSync(targetPath);
  const revision = buildFileRevision(targetPath, stat);
  const mode = String(args.mode || 'content').toLowerCase();
  const maxBytes = Number.isFinite(Number(args.maxBytes)) ? Math.max(1, Math.min(100_000, Number(args.maxBytes))) : 40_000;
  const hasLineWindow = args.startLine !== undefined || args.endLine !== undefined;

  if (mode === 'metadata') {
    return {
      root,
      path: path.relative(root, targetPath),
      bytes: stat.size,
      totalLines: countLinesSync(targetPath),
      modifiedAt: stat.mtime.toISOString(),
      revision: revision.token,
      fileRevision: revision,
    };
  }

  let content: string;
  let totalLines: number;
  let byteLength: number;
  let truncatedByBytes = false;
  const startLine = Number.isFinite(Number(args.startLine)) ? Math.max(1, Number(args.startLine)) : 1;

  if (hasLineWindow) {
    const provisionalEndLine = Number.isFinite(Number(args.endLine)) ? Math.max(startLine, Number(args.endLine)) : Number.MAX_SAFE_INTEGER;
    const window = readLineWindowSync(targetPath, startLine, provisionalEndLine, maxBytes);
    content = window.content;
    totalLines = window.totalLines;
    byteLength = window.byteLength;
    truncatedByBytes = window.truncatedByBytes;
  } else {
    const raw = fs.readFileSync(targetPath, 'utf8');
    totalLines = raw.split(/\r?\n/).length;
    content = raw;
    byteLength = Buffer.byteLength(content, 'utf8');
    if (maxBytes > 0 && byteLength > maxBytes) {
      content = Buffer.from(content, 'utf8').subarray(0, maxBytes).toString('utf8');
      content += '\n[truncated]';
      byteLength = Buffer.byteLength(content, 'utf8');
      truncatedByBytes = true;
    }
  }

  const endLine = Number.isFinite(Number(args.endLine)) ? Math.max(startLine, Number(args.endLine)) : totalLines;
  const returnedEndLine = hasLineWindow ? Math.min(endLine, totalLines) : totalLines;

  return {
    root,
    path: path.relative(root, targetPath),
    content,
    bytes: stat.size,
    returnedBytes: byteLength,
    startLine: hasLineWindow ? startLine : 1,
    endLine: returnedEndLine,
    totalLines,
    truncated: truncatedByBytes || (hasLineWindow && (startLine > 1 || endLine < totalLines)),
    modifiedAt: stat.mtime.toISOString(),
    revision: revision.token,
    fileRevision: revision,
  };
}

export function readFileSnippetsBatch(state: AppState, args: Record<string, any>) {
  const requestedFiles = Array.isArray(args.files) ? args.files : null;
  if (!requestedFiles || requestedFiles.length === 0) {
    throw createApiError(400, 'FILES_REQUIRED', 'files must be a non-empty array.');
  }

  const maxFiles = Number.isFinite(Number(args.maxFiles)) ? Math.max(1, Math.min(25, Number(args.maxFiles))) : 25;
  const selectedFiles = requestedFiles.slice(0, maxFiles);
  const baseArgs = {
    projectId: args.projectId,
    projectName: args.projectName,
    repo: args.repo,
    repoUrl: args.repoUrl,
    localPath: args.localPath,
  };

  const results = selectedFiles.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw createApiError(400, 'FILE_ENTRY_INVALID', `files[${index}] must be an object.`, { affectedId: `files[${index}]` });
    }

    const filePath = String(entry.filePath || entry.path || '').trim();
    if (!filePath) {
      throw createApiError(400, 'FILE_PATH_REQUIRED', `files[${index}].filePath is required.`, { affectedId: `files[${index}]` });
    }

    return readLocalFile(state, {
      ...baseArgs,
      filePath,
      mode: entry.mode,
      startLine: entry.startLine,
      endLine: entry.endLine,
      maxBytes: entry.maxBytes,
    });
  });

  return {
    root: results[0]?.root || resolveProjectRoot(state, args),
    count: results.length,
    requestedCount: requestedFiles.length,
    truncated: requestedFiles.length > results.length || results.some((result) => result.truncated === true),
    files: results,
  };
}

export function writeLocalFile(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  const filePath = String(args.filePath || args.path || '').trim();
  const content = typeof args.content === 'string' ? args.content : null;
  if (!filePath) {
    throw createApiError(400, 'FILE_PATH_REQUIRED', 'filePath is required.');
  }
  if (content === null) {
    throw createApiError(400, 'FILE_CONTENT_REQUIRED', 'content is required.');
  }
  if (Buffer.byteLength(content, 'utf8') > 1_000_000) {
    throw createApiError(400, 'FILE_TOO_LARGE', 'content must be 1 MB or smaller.');
  }

  const targetPath = resolveSafePath(root, filePath);
  const existed = fs.existsSync(targetPath);
  if (args.createOnly === true || String(args.createOnly).toLowerCase() === 'true') {
    if (existed) {
      throw createApiError(409, 'FILE_EXISTS', `File '${filePath}' already exists.`, { affectedId: filePath });
    }
  }

  assertFileRevisionMatches(targetPath, args, filePath);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  const revision = getFileRevision(targetPath);
  const cacheInvalidation = invalidateRepoReadCaches(root, 'writeLocalFile');

  return {
    root,
    path: path.relative(root, targetPath),
    bytes: Buffer.byteLength(content, 'utf8'),
    created: !existed,
    updatedAt: new Date().toISOString(),
    revision: revision.token,
    fileRevision: revision,
  };
}

export function searchLocalFiles(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  const query = String(args.query || '').trim();
  if (!query) {
    throw createApiError(400, 'QUERY_REQUIRED', 'query is required.');
  }

  const searchPath = resolveSafePath(root, String(args.path || '.'));
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : 20;
  const cacheKey = makeSearchCacheKey(root, searchPath, query, limit, args);
  const cached = getCachedSearchResult(cacheKey);
  if (cached) return cached;

  const rg = spawnSync('rg', buildRipgrepArgs(query, searchPath, limit, args), {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 2_000_000,
  });

  if (!rg.error && rg.stdout) {
    const { matches, scannedMatchCount, truncated } = parseRipgrepMatches(rg.stdout, root, limit);
    return rememberSearchResult(cacheKey, {
      root,
      path: path.relative(root, searchPath) || '.',
      query,
      count: matches.length,
      scannedMatchCount,
      truncated,
      matches,
    });
  }

  return rememberSearchResult(cacheKey, {
    root,
    path: path.relative(root, searchPath) || '.',
    query,
    count: 0,
    scannedMatchCount: 0,
    truncated: false,
    matches: [],
  });
}

export async function searchLocalFilesAsync(state: AppState, args: Record<string, any>, logger: { stdout: (data: string) => void, stderr: (data: string) => void }, setCancelFn: (fn: () => void) => void): Promise<any> {
  const root = resolveProjectRoot(state, args);
  const query = String(args.query || '').trim();
  if (!query) {
    throw createApiError(400, 'QUERY_REQUIRED', 'query is required.');
  }

  const searchPath = resolveSafePath(root, String(args.path || '.'));
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : 20;
  const cacheKey = makeSearchCacheKey(root, searchPath, query, limit, args);
  const cached = getCachedSearchResult(cacheKey);
  if (cached) return cached;

  return new Promise((resolve, reject) => {
    const child = spawn('rg', buildRipgrepArgs(query, searchPath, limit, args), {
      cwd: root,
      shell: false,
    });

    const matches: Array<{ path: string; line: number; preview: string }> = [];
    let scannedMatchCount = 0;
    let lineBuffer = '';
    let resolved = false;
    let terminatedAfterLimit = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      const result = rememberSearchResult(cacheKey, {
        root,
        path: path.relative(root, searchPath) || '.',
        query,
        count: matches.length,
        scannedMatchCount,
        truncated: terminatedAfterLimit || scannedMatchCount > matches.length,
        terminatedAfterLimit,
        matches,
      });
      resolve(result);
    };

    const processLine = (line: string) => {
      const match = parseRipgrepMatchLine(line, root);
      if (!match) return;
      scannedMatchCount += 1;
      if (matches.length < limit) {
        matches.push(match);
      }
      if (matches.length >= limit && !terminatedAfterLimit) {
        terminatedAfterLimit = true;
        child.kill('SIGTERM');
      }
    };

    setCancelFn(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGTERM');
      reject(new Error('Job cancelled'));
    });

    child.stdout.on('data', (data) => {
      const chunk = data.toString('utf8');
      lineBuffer += chunk;
      logger.stdout(chunk);
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
        if (terminatedAfterLimit) break;
      }
    });

    child.stderr.on('data', (data) => {
      logger.stderr(data.toString('utf8'));
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(createApiError(500, 'SEARCH_EXEC_ERROR', 'Failed to execute rg.', { details: err.message }));
    });

    child.on('close', (code) => {
      if (!terminatedAfterLimit && lineBuffer.trim()) {
        processLine(lineBuffer);
      }
      if (resolved) return;
      if (code !== 0 && code !== 1 && !terminatedAfterLimit) { // rg returns 1 if no matches found
        resolved = true;
        reject(createApiError(500, 'SEARCH_FAILED', 'rg search failed.', { details: { exitCode: code } }));
        return;
      }
      finish();
    });
  });
}
