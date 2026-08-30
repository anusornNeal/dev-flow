import fs from 'node:fs';
import path from 'node:path';
import type { AppState } from '../types';
import { createApiError } from './api';
import { findProjectByIdentifier } from './taskService';

const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ENTRY_BYTES = 16 * 1024;
const DEFAULT_READ_BYTES = 128 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const MAX_LIST_ITEMS = 100;

function requireProject(state: AppState, args: Record<string, any>) {
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  if (!projectId) {
    throw createApiError(400, 'WORKER_LOG_PROJECT_REQUIRED', 'projectId is required for worker diagnostic logs.');
  }
  const cachedProject = Array.isArray((state as any).projectsCache)
    ? (state as any).projectsCache.find((entry: any) => entry?.id === projectId)
    : undefined;
  const project = cachedProject || findProjectByIdentifier(state, { projectId });
  if (!project) {
    throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${projectId}' was not found.`, { affectedId: projectId });
  }
  if (!project.localPath) {
    throw createApiError(409, 'WORKER_LOG_PROJECT_ROOT_UNAVAILABLE', `Project '${projectId}' has no local root for worker diagnostic logs.`, { affectedId: projectId });
  }
  return project;
}

function normalizeWorkerId(value: unknown) {
  const workerId = typeof value === 'string' ? value.trim() : '';
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw createApiError(400, 'WORKER_LOG_INVALID_WORKER_ID', 'workerId must be 1-64 characters using only letters, numbers, dot, underscore, or hyphen, and must start with a letter or number.');
  }
  return workerId;
}

function logDirectory(projectRoot: string) {
  return path.join(projectRoot, '.devflow', 'worker-logs');
}

function logPath(projectRoot: string, workerId: string) {
  const directory = logDirectory(projectRoot);
  const resolved = path.resolve(directory, `${workerId}.md`);
  const expectedPrefix = `${path.resolve(directory)}${path.sep}`;
  if (!resolved.startsWith(expectedPrefix)) {
    throw createApiError(400, 'WORKER_LOG_PATH_REJECTED', 'Worker log path escaped the bounded diagnostic namespace.');
  }
  return resolved;
}

function boundedReadBytes(value: unknown) {
  if (value === undefined || value === null || value === '') return DEFAULT_READ_BYTES;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) {
    throw createApiError(400, 'WORKER_LOG_INVALID_READ_LIMIT', 'maxBytes must be a positive number.');
  }
  return Math.min(MAX_READ_BYTES, Math.floor(numeric));
}

export function appendWorkerDiagnosticLog(state: AppState, args: Record<string, any>) {
  const project = requireProject(state, args);
  const workerId = normalizeWorkerId(args.workerId);
  const entry = typeof args.entry === 'string' ? args.entry : '';
  const entryBytes = Buffer.byteLength(entry, 'utf8');
  if (!entry.trim()) throw createApiError(400, 'WORKER_LOG_ENTRY_REQUIRED', 'entry must be a non-empty string.');
  if (entryBytes > MAX_ENTRY_BYTES) {
    throw createApiError(413, 'WORKER_LOG_ENTRY_TOO_LARGE', `Worker log entry exceeds ${MAX_ENTRY_BYTES} UTF-8 bytes.`);
  }

  const directory = logDirectory(project.localPath!);
  const target = logPath(project.localPath!, workerId);
  fs.mkdirSync(directory, { recursive: true });
  const prefix = fs.existsSync(target) && fs.statSync(target).size > 0 ? '\n' : '';
  fs.appendFileSync(target, `${prefix}${entry.replace(/\s+$/, '')}\n`, { encoding: 'utf8', flag: 'a' });
  const stat = fs.statSync(target);
  return {
    projectId: project.id,
    workerId,
    path: `.devflow/worker-logs/${workerId}.md`,
    appendedBytes: entryBytes,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    appendOnly: true,
  };
}

export function readWorkerDiagnosticLog(state: AppState, args: Record<string, any>) {
  const project = requireProject(state, args);
  const workerId = normalizeWorkerId(args.workerId);
  const target = logPath(project.localPath!, workerId);
  const maxBytes = boundedReadBytes(args.maxBytes);
  if (!fs.existsSync(target)) {
    return {
      projectId: project.id,
      workerId,
      path: `.devflow/worker-logs/${workerId}.md`,
      exists: false,
      content: '',
      bytes: 0,
      returnedBytes: 0,
      truncated: false,
    };
  }
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw createApiError(409, 'WORKER_LOG_NOT_FILE', 'Worker diagnostic log target is not a file.');
  const content = fs.readFileSync(target);
  const start = Math.max(0, content.length - maxBytes);
  const returned = content.subarray(start).toString('utf8');
  return {
    projectId: project.id,
    workerId,
    path: `.devflow/worker-logs/${workerId}.md`,
    exists: true,
    content: returned,
    bytes: stat.size,
    returnedBytes: Buffer.byteLength(returned, 'utf8'),
    truncated: start > 0,
    modifiedAt: stat.mtime.toISOString(),
  };
}

export function listWorkerDiagnosticLogs(state: AppState, args: Record<string, any>) {
  const project = requireProject(state, args);
  const directory = logDirectory(project.localPath!);
  if (!fs.existsSync(directory)) return { projectId: project.id, logs: [], total: 0 };
  const logs = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const workerId = entry.name.slice(0, -3);
      if (!WORKER_ID_PATTERN.test(workerId)) return null;
      const stat = fs.statSync(path.join(directory, entry.name));
      return {
        workerId,
        path: `.devflow/worker-logs/${entry.name}`,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return {
    projectId: project.id,
    logs: logs.slice(0, MAX_LIST_ITEMS),
    total: logs.length,
    truncated: logs.length > MAX_LIST_ITEMS,
  };
}
