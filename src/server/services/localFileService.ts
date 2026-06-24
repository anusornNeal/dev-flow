import fs from 'fs';
import path from 'path';
import { spawnSync, spawn } from 'child_process';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import type { AppState } from '../types';
import { createApiError } from './api';
import { findProjectByIdentifier } from './taskService';

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

function parseRipgrepMatches(stdout: string, root: string, limit: number) {
  const matches: Array<{ path: string; line: number; preview: string }> = [];
  let scannedMatchCount = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== 'match') continue;
      scannedMatchCount += 1;
      if (matches.length >= limit) continue;
      matches.push({
        path: path.relative(root, parsed.data.path.text),
        line: parsed.data.line_number,
        preview: parsed.data.lines.text.trim(),
      });
    } catch {
      // Ignore malformed rg lines.
    }
  }
  return { matches, scannedMatchCount, truncated: scannedMatchCount > matches.length };
}

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
  const mode = String(args.mode || 'content').toLowerCase();
  const raw = fs.readFileSync(targetPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;
  const maxBytes = Number.isFinite(Number(args.maxBytes)) ? Math.max(1, Math.min(100_000, Number(args.maxBytes))) : 40_000;
  const startLine = Number.isFinite(Number(args.startLine)) ? Math.max(1, Number(args.startLine)) : 1;
  const endLine = Number.isFinite(Number(args.endLine)) ? Math.max(startLine, Number(args.endLine)) : totalLines;
  const hasLineWindow = args.startLine !== undefined || args.endLine !== undefined;

  if (mode === 'metadata') {
    return {
      root,
      path: path.relative(root, targetPath),
      bytes: stat.size,
      totalLines,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  let content = hasLineWindow
    ? lines.slice(startLine - 1, Math.min(endLine, totalLines)).join('\n')
    : raw;
  let byteLength = Buffer.byteLength(content, 'utf8');
  let truncatedByBytes = false;
  if (maxBytes > 0 && byteLength > maxBytes) {
    content = Buffer.from(content, 'utf8').subarray(0, maxBytes).toString('utf8');
    content += '\n[truncated]';
    byteLength = Buffer.byteLength(content, 'utf8');
    truncatedByBytes = true;
  }

  return {
    root,
    path: path.relative(root, targetPath),
    content,
    bytes: stat.size,
    returnedBytes: byteLength,
    startLine: hasLineWindow ? startLine : 1,
    endLine: hasLineWindow ? Math.min(endLine, totalLines) : totalLines,
    totalLines,
    truncated: truncatedByBytes || (hasLineWindow && (startLine > 1 || endLine < totalLines)),
    modifiedAt: stat.mtime.toISOString(),
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

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');

  return {
    root,
    path: path.relative(root, targetPath),
    bytes: Buffer.byteLength(content, 'utf8'),
    created: !existed,
    updatedAt: new Date().toISOString(),
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
  const rg = spawnSync('rg', buildRipgrepArgs(query, searchPath, limit, args), {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 2_000_000,
  });

  if (!rg.error && rg.stdout) {
    const { matches, scannedMatchCount, truncated } = parseRipgrepMatches(rg.stdout, root, limit);
    return {
      root,
      path: path.relative(root, searchPath) || '.',
      query,
      count: matches.length,
      scannedMatchCount,
      truncated,
      matches,
    };
  }

  return {
    root,
    path: path.relative(root, searchPath) || '.',
    query,
    count: 0,
    scannedMatchCount: 0,
    truncated: false,
    matches: [],
  };
}

export async function searchLocalFilesAsync(state: AppState, args: Record<string, any>, logger: { stdout: (data: string) => void, stderr: (data: string) => void }, setCancelFn: (fn: () => void) => void): Promise<any> {
  const root = resolveProjectRoot(state, args);
  const query = String(args.query || '').trim();
  if (!query) {
    throw createApiError(400, 'QUERY_REQUIRED', 'query is required.');
  }

  const searchPath = resolveSafePath(root, String(args.path || '.'));
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : 20;

  return new Promise((resolve, reject) => {
    const child = spawn('rg', buildRipgrepArgs(query, searchPath, limit, args), {
      cwd: root,
      shell: false,
    });

    let stdoutBuffer = '';
    
    setCancelFn(() => {
      child.kill('SIGTERM');
      reject(new Error('Job cancelled'));
    });

    child.stdout.on('data', (data) => {
      const chunk = data.toString('utf8');
      stdoutBuffer += chunk;
      logger.stdout(chunk);
    });

    child.stderr.on('data', (data) => {
      logger.stderr(data.toString('utf8'));
    });

    child.on('error', (err) => {
      reject(createApiError(500, 'SEARCH_EXEC_ERROR', 'Failed to execute rg.', { details: err.message }));
    });

    child.on('close', (code) => {
      if (code !== 0 && code !== 1) { // rg returns 1 if no matches found
        reject(createApiError(500, 'SEARCH_FAILED', 'rg search failed.', { details: { exitCode: code } }));
        return;
      }

      const { matches, scannedMatchCount, truncated } = parseRipgrepMatches(stdoutBuffer, root, limit);

      resolve({
        root,
        path: path.relative(root, searchPath) || '.',
        query,
        count: matches.length,
        scannedMatchCount,
        truncated,
        matches,
      });
    });
  });
}
