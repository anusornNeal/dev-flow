import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import type { AppState } from '../types';
import { createApiError } from './api';
import { findProjectByIdentifier } from './taskService';
import { issueFileRef } from './fileReferenceService';
import { invalidateRepoReadCaches } from './repoCacheInvalidationService';
import { searchResolvedLocalFiles, searchResolvedLocalFilesAsync } from './localSearchService';
import { createOrReuseSessionWorkspace, resolveSessionWorkspace } from './sessionWorkspaceService';
export { clearLocalFileSearchCache, clearLocalSearchRuntimeState, getLocalSearchRuntimeStatus } from './localSearchService';

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

const READ_CHUNK_BYTES = 64 * 1024;

export type FileRevision = {
  token: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  modifiedAt: string;
};

export type LocalFileReadResult = {
  root: string;
  path: string;
  content?: string;
  bytes: number;
  returnedBytes?: number;
  startLine?: number;
  endLine?: number;
  totalLines: number;
  truncated?: boolean;
  modifiedAt: string;
  revision: string;
  fileRevision: FileRevision;
  fileRef?: string;
  fileRefCreatedAt?: string;
  fileRefExpiresAt?: string;
  fileRefReused?: boolean;
  responseMode?: 'compact' | 'standard' | 'debug';
  omittedBytes?: number;
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
}function countLinesSync(filePath: string) {
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

function findIdentifierProject(state: AppState, args: Record<string, any>) {
  return findProjectByIdentifier(state, {
    projectId: typeof args.projectId === 'string' ? args.projectId.trim() : undefined,
    projectName: typeof args.projectName === 'string' ? args.projectName.trim() : undefined,
    repo: typeof args.repo === 'string' ? args.repo.trim() : undefined,
    repoUrl: typeof args.repoUrl === 'string' ? args.repoUrl.trim() : undefined,
    localPath: typeof args.localPath === 'string' ? args.localPath.trim() : undefined,
  });
}

function resolveExplicitWorkspace(state: AppState, args: Record<string, any>, identifierProject: ReturnType<typeof findIdentifierProject>) {
  const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : '';
  if (!workspaceId) return null;
  const workspace = resolveSessionWorkspace(workspaceId);
  if (!workspace) {
    throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
  }
  const requestedIdentifier = args.projectId || args.projectName || args.repo || args.repoUrl;
  if (requestedIdentifier && !identifierProject) {
    throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${requestedIdentifier}' was not found.`, { affectedId: String(requestedIdentifier) });
  }
  if (identifierProject && workspace.projectId !== identifierProject.id) {
    throw createApiError(409, 'WORKSPACE_PROJECT_MISMATCH', `Workspace '${workspaceId}' belongs to project '${workspace.projectId}', not '${identifierProject.id}'.`, {
      affectedId: workspaceId,
      details: { workspaceProjectId: workspace.projectId, requestedProjectId: identifierProject.id },
    });
  }
  return workspace;
}

export function resolveProjectResourceIdentity(state: AppState, args: Record<string, any>) {
  const identifierProject = findIdentifierProject(state, args);
  const workspace = resolveExplicitWorkspace(state, args, identifierProject);
  if (workspace) return `workspace:${workspace.workspaceId}`;
  if (identifierProject) {
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    if (sessionId) return `workspace:${createOrReuseSessionWorkspace(identifierProject, sessionId).workspaceId}`;
  }
  return `repo:${resolveProjectRoot(state, args)}`;
}

export function resolveProjectRoot(state: AppState, args: Record<string, any>) {
  const identifierProject = findIdentifierProject(state, args);
  const workspace = resolveExplicitWorkspace(state, args, identifierProject);
  if (workspace) return workspace.root;

  if (identifierProject) {
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    if (sessionId) return createOrReuseSessionWorkspace(identifierProject, sessionId).root;
    return identifierProject.localPath || getDevFlowAppRoot();
  }

  const directLocalPath = typeof args.localPath === 'string' ? args.localPath.trim() : '';
  if (directLocalPath) return directLocalPath;

  const requestedIdentifier = args.projectId || args.projectName || args.repo || args.repoUrl;
  if (requestedIdentifier) {
    throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${requestedIdentifier}' was not found.`, { affectedId: String(requestedIdentifier) });
  }

  return getDevFlowAppRoot();
}

function normalizeToolRelativePath(value?: string) {
  return String(value || '.')
    .trim()
    .replace(/\\/g, '/');
}

function toToolRelativePath(root: string, targetPath: string) {
  const relativePath = path.relative(root, targetPath) || '.';
  return relativePath.replace(/\\/g, '/');
}

export function resolveSafePath(root: string, relativePath?: string) {
  const normalizedRelativePath = normalizeToolRelativePath(relativePath || '.');
  if (/^[A-Za-z]:\//.test(normalizedRelativePath) || normalizedRelativePath.startsWith('//')) {
    throw createApiError(403, 'FILE_ACCESS_DENIED', 'Requested path is outside the allowed project root.');
  }

  const candidate = path.resolve(root, normalizedRelativePath || '.');
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
  const relativeBase = toToolRelativePath(root, targetPath);

  const results: Array<{ path: string; type: 'file' | 'directory' }> = [];
  const visit = (currentPath: string) => {
    if (results.length >= limit) return;
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (shouldSkipEntry(entry.name, args)) continue;
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = toToolRelativePath(root, fullPath);
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
    results.push({ path: toToolRelativePath(root, targetPath), type: 'file' });
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

type OptionalFileRefMetadata = {
  fileRef?: string;
  fileRefCreatedAt?: string;
  fileRefExpiresAt?: string;
  fileRefReused?: boolean;
};

function includeFileRefMetadata(state: AppState, args: Record<string, any>, root: string, targetPath: string, revision: FileRevision): OptionalFileRefMetadata {
  const requested = args.includeFileRef === true || String(args.includeFileRef).toLowerCase() === 'true';
  if (!requested) return {};
  const issued = issueFileRef(state, args, {
    root,
    targetPath,
    filePath: toToolRelativePath(root, targetPath),
    revision,
  });
  return {
    fileRef: issued.fileRef,
    fileRefCreatedAt: issued.createdAt,
    fileRefExpiresAt: issued.expiresAt,
    fileRefReused: issued.reused,
  };
}

export function readResolvedLocalFile(state: AppState, args: Record<string, any>, root: string): LocalFileReadResult {
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
  const responseMode = args.responseMode === 'compact' || args.responseMode === 'debug' ? args.responseMode : 'standard';
  const defaultMaxBytes = responseMode === 'compact' ? 4_000 : responseMode === 'debug' ? 100_000 : 40_000;
  const requestedMaxBytes = Number.isFinite(Number(args.maxBytes)) ? Math.max(1, Math.min(100_000, Number(args.maxBytes))) : defaultMaxBytes;
  const maxBytes = responseMode === 'compact' ? Math.min(4_000, requestedMaxBytes) : requestedMaxBytes;
  const hasLineWindow = args.startLine !== undefined || args.endLine !== undefined;

  if (mode === 'metadata') {
    return {
      root,
      path: toToolRelativePath(root, targetPath),
      bytes: stat.size,
      totalLines: countLinesSync(targetPath),
      modifiedAt: stat.mtime.toISOString(),
      revision: revision.token,
      fileRevision: revision,
      responseMode,
      omittedBytes: stat.size,
      ...includeFileRefMetadata(state, args, root, targetPath, revision),
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
    path: toToolRelativePath(root, targetPath),
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
    responseMode,
    omittedBytes: truncatedByBytes && !hasLineWindow ? Math.max(0, stat.size - maxBytes) : 0,
    ...includeFileRefMetadata(state, args, root, targetPath, revision),
  };
}

export function readLocalFile(state: AppState, args: Record<string, any>): LocalFileReadResult {
  return readResolvedLocalFile(state, args, resolveProjectRoot(state, args));
}

export function splitFileSnippetBatchArgsForRecovery(args: Record<string, any>) {
  const files = Array.isArray(args.files) ? args.files : [];
  if (files.length < 2) return [];
  const maxTotalBytes = Number.isFinite(Number(args.maxTotalBytes)) ? Math.max(1, Math.min(500_000, Number(args.maxTotalBytes))) : 100_000;
  const groups: any[][] = [];
  let current: any[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const estimate = Number.isFinite(Number(file?.maxBytes)) ? Math.max(1, Math.min(100_000, Number(file.maxBytes))) : 40_000;
    if (current.length > 0 && currentBytes + estimate > maxTotalBytes) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += estimate;
  }
  if (current.length > 0) groups.push(current);
  if (groups.length < 2) {
    const midpoint = Math.ceil(files.length / 2);
    groups.splice(0, groups.length, files.slice(0, midpoint), files.slice(midpoint));
  }
  return groups.filter((group) => group.length > 0).map((group) => ({ ...args, files: group }));
}

export function combineFileSnippetBatchRecoveryResults(results: any[]) {
  const batches = Array.isArray(results) ? results : [];
  const files = batches.flatMap((result) => Array.isArray(result?.files) ? result.files : []);
  const successCount = files.filter((entry) => entry?.ok !== false).length;
  const errorCount = files.length - successCount;
  return {
    root: batches.find((result) => result?.root)?.root,
    count: files.length,
    requestedCount: batches.reduce((sum, result) => sum + Number(result?.requestedCount || 0), 0),
    successCount,
    errorCount,
    partial: successCount > 0 && errorCount > 0,
    totalReturnedBytes: batches.reduce((sum, result) => sum + Number(result?.totalReturnedBytes || 0), 0),
    maxTotalBytes: batches.reduce((max, result) => Math.max(max, Number(result?.maxTotalBytes || 0)), 0),
    truncated: batches.some((result) => result?.truncated === true),
    files,
  };
}

export function readFileSnippetsBatch(state: AppState, args: Record<string, any>) {
  const requestedFiles = Array.isArray(args.files) ? args.files : null;
  if (!requestedFiles || requestedFiles.length === 0) {
    throw createApiError(400, 'FILES_REQUIRED', 'files must be a non-empty array.');
  }

  const maxFiles = Number.isFinite(Number(args.maxFiles)) ? Math.max(1, Math.min(25, Number(args.maxFiles))) : 25;
  const maxTotalBytes = Number.isFinite(Number(args.maxTotalBytes)) ? Math.max(1, Math.min(500_000, Number(args.maxTotalBytes))) : 100_000;
  const allowPartial = args.allowPartial === true || String(args.allowPartial).toLowerCase() === 'true';
  const selectedFiles = requestedFiles.slice(0, maxFiles);
  const root = resolveProjectRoot(state, args);
  const baseArgs = {
    projectId: args.projectId,
    projectName: args.projectName,
    repo: args.repo,
    repoUrl: args.repoUrl,
    localPath: args.localPath,
    sessionId: args.sessionId,
    workspaceId: args.workspaceId,
  };
  const results: any[] = [];
  let totalReturnedBytes = 0;

  const errorResult = (filePath: string, error: unknown) => {
    const payload = (error as any)?.payload;
    return {
      ok: false,
      path: filePath,
      error: {
        code: payload?.code || 'READ_FAILED',
        message: payload?.message || (error instanceof Error ? error.message : String(error)),
        retryable: payload?.retryable ?? false,
        status: Number((error as any)?.status || 500),
      },
    };
  };

  for (let index = 0; index < selectedFiles.length; index += 1) {
    const entry = selectedFiles[index];
    const requestedPath = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? String(entry.filePath || entry.path || '').trim()
      : `files[${index}]`;
    try {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw createApiError(400, 'FILE_ENTRY_INVALID', `files[${index}] must be an object.`, { affectedId: `files[${index}]` });
      }
      if (!requestedPath) {
        throw createApiError(400, 'FILE_PATH_REQUIRED', `files[${index}].filePath is required.`, { affectedId: `files[${index}]` });
      }

      const remainingBytes = maxTotalBytes - totalReturnedBytes;
      if (remainingBytes <= 0) {
        results.push(errorResult(requestedPath, createApiError(413, 'BATCH_BYTE_LIMIT', `Batch response byte budget (${maxTotalBytes}) is exhausted.`, { affectedId: requestedPath })));
        continue;
      }

      const requestedMaxBytes = Number.isFinite(Number(entry.maxBytes)) ? Math.max(1, Math.min(100_000, Number(entry.maxBytes))) : 40_000;
      const readMaxBytes = Math.min(requestedMaxBytes, remainingBytes);
      const result = readResolvedLocalFile(state, {
        ...baseArgs,
        filePath: requestedPath,
        mode: entry.mode,
        startLine: entry.startLine,
        endLine: entry.endLine,
        maxBytes: readMaxBytes,
        responseMode: entry.responseMode ?? args.responseMode,
        includeFileRef: entry.includeFileRef ?? args.includeFileRef,
      }, root);
      const returnedBytes = Number(result.returnedBytes || 0);
      if (readMaxBytes < requestedMaxBytes && result.truncated === true) {
        results.push(errorResult(requestedPath, createApiError(413, 'BATCH_BYTE_LIMIT', `File '${requestedPath}' exceeds the remaining batch response byte budget.`, { affectedId: requestedPath })));
        continue;
      }
      if (returnedBytes > remainingBytes) {
        results.push(errorResult(requestedPath, createApiError(413, 'BATCH_BYTE_LIMIT', `File '${requestedPath}' exceeds the remaining batch response byte budget.`, { affectedId: requestedPath })));
        continue;
      }

      totalReturnedBytes += returnedBytes;
      results.push(result);
    } catch (error) {
      if (!allowPartial) throw error;
      results.push(errorResult(requestedPath || `files[${index}]`, error));
    }
  }

  const successCount = results.filter((entry) => entry?.ok !== false).length;
  const errorCount = results.length - successCount;
  return {
    root,
    count: results.length,
    requestedCount: requestedFiles.length,
    successCount,
    errorCount,
    partial: successCount > 0 && errorCount > 0,
    totalReturnedBytes,
    maxTotalBytes,
    truncated: requestedFiles.length > selectedFiles.length
      || results.some((result) => result?.truncated === true || result?.error?.code === 'BATCH_BYTE_LIMIT'),
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
  const previousContent = existed ? fs.readFileSync(targetPath, 'utf8') : null;
  if (args.createOnly === true || String(args.createOnly).toLowerCase() === 'true') {
    if (existed) {
      throw createApiError(409, 'FILE_EXISTS', `File '${filePath}' already exists.`, { affectedId: filePath });
    }
  }

  assertFileRevisionMatches(targetPath, args, filePath);

  if (existed) {
    if (previousContent === content) {
      const revision = getFileRevision(targetPath);
      return {
        root,
        path: toToolRelativePath(root, targetPath),
        bytes: Buffer.byteLength(content, 'utf8'),
        created: false,
        changed: false,
        updatedAt: revision.modifiedAt,
        revision: revision.token,
        fileRevision: revision,
      };
    }
  }

  if (typeof args.__authorizeOwnedChanges === 'function') {
    args.__authorizeOwnedChanges([filePath]);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  if (typeof args.__recordOwnedChanges === 'function') {
    try {
      args.__recordOwnedChanges([filePath]);
    } catch (error) {
      try {
        if (existed) fs.writeFileSync(targetPath, previousContent!, 'utf8');
        else fs.rmSync(targetPath, { force: true });
        invalidateRepoReadCaches(root, 'writeLocalFileOwnershipRollback', { paths: [filePath] });
      } catch (rollbackError) {
        throw createApiError(500, 'WRITE_OWNERSHIP_ROLLBACK_FAILED', `Ownership persistence failed and file rollback could not restore '${filePath}'.`, {
          affectedId: filePath,
          details: {
            cause: error instanceof Error ? error.message : String(error),
            rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          },
        });
      }
      throw createApiError(409, 'WRITE_OWNERSHIP_FAILED', `Ownership persistence failed; write to '${filePath}' was rolled back.`, {
        affectedId: filePath,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  const revision = getFileRevision(targetPath);
  invalidateRepoReadCaches(root, 'writeLocalFile', { paths: [filePath] });

  return {
    root,
    path: toToolRelativePath(root, targetPath),
    bytes: Buffer.byteLength(content, 'utf8'),
    created: !existed,
    changed: true,
    updatedAt: new Date().toISOString(),
    revision: revision.token,
    fileRevision: revision,
  };
}

export function searchLocalFiles(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  const searchPath = resolveSafePath(root, String(args.path || '.'));
  return searchResolvedLocalFiles(root, searchPath, args);
}

export async function searchLocalFilesAsync(
  state: AppState,
  args: Record<string, any>,
  logger: { stdout: (data: string) => void; stderr: (data: string) => void },
  setCancelFn: (fn: () => void) => void,
): Promise<any> {
  const root = resolveProjectRoot(state, args);
  const searchPath = resolveSafePath(root, String(args.path || '.'));
  return searchResolvedLocalFilesAsync(root, searchPath, args, logger, setCancelFn);
}
