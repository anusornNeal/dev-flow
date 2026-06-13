import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { AppState } from '../types';
import { createApiError } from './api';
import { findProjectByIdentifier } from './taskService';

function resolveProjectRoot(state: AppState, args: Record<string, any>) {
  const identifierProject = findProjectByIdentifier(state, {
    projectId: typeof args.projectId === 'string' ? args.projectId.trim() : undefined,
    projectName: typeof args.projectName === 'string' ? args.projectName.trim() : undefined,
    repo: typeof args.repo === 'string' ? args.repo.trim() : undefined,
    repoUrl: typeof args.repoUrl === 'string' ? args.repoUrl.trim() : undefined,
    localPath: typeof args.localPath === 'string' ? args.localPath.trim() : undefined,
  });

  if (identifierProject) {
    return identifierProject.localPath || process.cwd();
  }

  const requestedIdentifier = args.projectId || args.projectName || args.repo || args.repoUrl || args.localPath;
  if (requestedIdentifier) {
    throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${requestedIdentifier}' was not found.`, { affectedId: String(requestedIdentifier) });
  }

  const directLocalPath = typeof args.localPath === 'string' ? args.localPath.trim() : '';
  if (directLocalPath) {
    return directLocalPath;
  }

  return process.cwd();
}

function resolveSafePath(root: string, relativePath?: string) {
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
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(500, Number(args.limit))) : 200;
  const relativeBase = path.relative(root, targetPath) || '.';

  const results: Array<{ path: string; type: 'file' | 'directory' }> = [];
  const visit = (currentPath: string) => {
    if (results.length >= limit) return;
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) break;
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

  return {
    root,
    path: path.relative(root, targetPath),
    content: fs.readFileSync(targetPath, 'utf8'),
  };
}

export function searchLocalFiles(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  const query = String(args.query || '').trim();
  if (!query) {
    throw createApiError(400, 'QUERY_REQUIRED', 'query is required.');
  }

  const searchPath = resolveSafePath(root, String(args.path || '.'));
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(200, Number(args.limit))) : 50;
  const rg = spawnSync('rg', ['--json', '--line-number', '--max-count', String(limit), query, searchPath], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });

  if (!rg.error && rg.stdout) {
    const matches = [];
    for (const line of rg.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'match') continue;
        matches.push({
          path: path.relative(root, parsed.data.path.text),
          line: parsed.data.line_number,
          preview: parsed.data.lines.text.trim(),
        });
      } catch {
        // Ignore malformed rg lines.
      }
    }
    return {
      root,
      path: path.relative(root, searchPath) || '.',
      query,
      count: matches.length,
      matches,
    };
  }

  return {
    root,
    path: path.relative(root, searchPath) || '.',
    query,
    count: 0,
    matches: [],
  };
}
