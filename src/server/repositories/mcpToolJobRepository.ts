import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import db from '../../db/index.js';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import { publishServerEvent } from '../services/serverEventService.js';
import { redactCredentialText } from '../services/credentialVaultService.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
export type JobRecoveryClassification = 'resumable' | 'retryable' | 'interrupted' | 'terminal';

export interface McpToolJob {
  jobId: string;
  toolName: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  waitMs?: number;
  durationMs?: number;
  failureSummary?: string;
  args: any;
  resourceKey: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
  recoveryClassification?: JobRecoveryClassification;
  artifactDir: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  resultBytes?: number;
  resultSha256?: string;
  patchBytes?: number;
  patchSha256?: string;
}

export interface JobTransitionOptions {
  workerId?: string;
  nowMs?: number;
}

function resolveJobsDir() {
  const explicitJobsDir = process.env.DEVFLOW_JOBS_DIR;
  if (explicitJobsDir && explicitJobsDir.trim()) {
    return path.resolve(explicitJobsDir);
  }

  const explicitDbPath = process.env.DEVFLOW_DB_PATH;
  if (explicitDbPath && explicitDbPath.trim()) {
    return path.join(path.dirname(path.resolve(explicitDbPath)), 'jobs');
  }

  return path.resolve(getDevFlowAppRoot(), '.devflow', 'jobs');
}

const JOBS_DIR = resolveJobsDir();
const SECRET_KEY_PATTERN = /(token|secret|password|pass|apikey|api_key|authorization|cookie)/i;
const MAX_LOG_READ_BYTES = 200_000;
const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const TERMINAL_STATUSES: JobStatus[] = ['succeeded', 'failed', 'timed_out', 'cancelled'];
let recentJobsCache: McpToolJob[] | null = null;
let recentJobsDiskScanCount = 0;

function sortRecentJobs(jobs: McpToolJob[]) {
  return jobs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function upsertRecentJobCache(job: McpToolJob) {
  if (!recentJobsCache) return;
  const index = recentJobsCache.findIndex((entry) => entry.jobId === job.jobId);
  if (index >= 0) recentJobsCache.splice(index, 1);
  recentJobsCache.push(job);
  sortRecentJobs(recentJobsCache);
}

function removeRecentJobCache(jobId: string) {
  if (!recentJobsCache) return;
  const index = recentJobsCache.findIndex((entry) => entry.jobId === jobId);
  if (index >= 0) recentJobsCache.splice(index, 1);
}

export function clearRecentJobCache() {
  const count = recentJobsCache?.length || 0;
  recentJobsCache = null;
  recentJobsDiskScanCount = 0;
  return count;
}

export function getRecentJobCacheStats() {
  return {
    hydrated: recentJobsCache !== null,
    entries: recentJobsCache?.length || 0,
    diskScanCount: recentJobsDiskScanCount,
  };
}

function redactValue(value: any): any {
  if (typeof value === 'string') return redactCredentialText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  const copy: Record<string, any> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    copy[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactValue(nestedValue);
  }
  return copy;
}

function ensureJobsDir() {
  if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });
}

function getArtifactDir(jobId: string) {
  return path.join(JOBS_DIR, jobId);
}

function readTail(filePath: string, maxBytes: number) {
  if (!fs.existsSync(filePath)) return { text: '', truncated: false, bytes: 0, returnedBytes: 0 };
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return {
      text: buffer.toString('utf8'),
      truncated: stat.size > length,
      bytes: stat.size,
      returnedBytes: length,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function fileMetadata(filePath: string) {
  if (!fs.existsSync(filePath)) return { bytes: 0, sha256: undefined as string | undefined };
  const buffer = fs.readFileSync(filePath);
  return {
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

function parseArgs(value: unknown) {
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    return {};
  }
}

function rowToJob(row: any): McpToolJob {
  return {
    jobId: row.job_id,
    toolName: row.tool_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    waitMs: row.wait_ms ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    failureSummary: row.failure_summary || undefined,
    args: parseArgs(row.args_json),
    resourceKey: row.resource_key,
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: row.lease_expires_at || undefined,
    heartbeatAt: row.heartbeat_at || undefined,
    cancelRequestedAt: row.cancel_requested_at || undefined,
    cancelReason: row.cancel_reason || undefined,
    recoveryClassification: row.recovery_classification || undefined,
    artifactDir: row.artifact_dir || getArtifactDir(row.job_id),
    stdoutBytes: Number(row.stdout_bytes || 0),
    stderrBytes: Number(row.stderr_bytes || 0),
    resultBytes: Number(row.result_bytes || 0),
    resultSha256: row.result_sha256 || undefined,
    patchBytes: Number(row.patch_bytes || 0),
    patchSha256: row.patch_sha256 || undefined,
  };
}

function getDbJob(jobId: string): McpToolJob | null {
  const row = db.prepare('SELECT * FROM mcp_tool_jobs WHERE job_id = ?').get(jobId) as any;
  return row ? rowToJob(row) : null;
}

function writeCompatibilityStatus(job: McpToolJob) {
  try {
    fs.mkdirSync(job.artifactDir, { recursive: true });
    fs.writeFileSync(path.join(job.artifactDir, 'status.json'), JSON.stringify(job, null, 2));
  } catch {
    // SQLite is authoritative; compatibility artifacts must not break lifecycle persistence.
  }
}

function importLegacyJob(jobId: string): McpToolJob | null {
  const artifactDir = getArtifactDir(jobId);
  const statusPath = path.join(artifactDir, 'status.json');
  if (!fs.existsSync(statusPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Partial<McpToolJob>;
    if (!raw.jobId || !raw.toolName || !raw.status || !raw.createdAt || !raw.updatedAt) return null;
    const safeArgs = redactValue(raw.args || {});
    db.prepare(`
      INSERT OR IGNORE INTO mcp_tool_jobs (
        job_id, tool_name, status, created_at, updated_at, started_at, completed_at,
        wait_ms, duration_ms, failure_summary, args_json, resource_key, artifact_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      raw.jobId,
      raw.toolName,
      raw.status,
      raw.createdAt,
      raw.updatedAt,
      raw.startedAt || null,
      raw.completedAt || null,
      raw.waitMs ?? null,
      raw.durationMs ?? null,
      raw.failureSummary || null,
      JSON.stringify(safeArgs),
      raw.resourceKey || 'global',
      artifactDir,
    );
    return getDbJob(jobId);
  } catch {
    return null;
  }
}

function toTimestamp(value: string | undefined, fallback: string) {
  const time = Date.parse(value || fallback);
  return Number.isFinite(time) ? time : Date.parse(fallback);
}

function buildUpdatedJob(job: McpToolJob, updates: Partial<McpToolJob>, nowMs: number) {
  const nowIso = new Date(nowMs).toISOString();
  const updated: McpToolJob = { ...job, ...updates, updatedAt: nowIso };

  if (updates.status === 'running' && !job.startedAt) {
    updated.startedAt = nowIso;
    updated.waitMs = Math.max(0, nowMs - toTimestamp(job.createdAt, nowIso));
  }

  if (updates.status && TERMINAL_STATUSES.includes(updates.status)) {
    updated.completedAt = nowIso;
    const startTime = toTimestamp(updated.startedAt || job.startedAt, job.createdAt || nowIso);
    updated.durationMs = Math.max(0, nowMs - startTime);
    updated.leaseOwner = undefined;
    updated.leaseExpiresAt = undefined;
    updated.heartbeatAt = undefined;
    updated.recoveryClassification = updates.recoveryClassification || job.recoveryClassification || 'terminal';
    if (updates.status === 'succeeded') updated.failureSummary = undefined;
  }

  return updated;
}

function persistLifecycle(job: McpToolJob, expectedStatus: JobStatus, workerId?: string) {
  const result = db.prepare(`
    UPDATE mcp_tool_jobs SET
      tool_name = ?, status = ?, created_at = ?, updated_at = ?, started_at = ?, completed_at = ?,
      wait_ms = ?, duration_ms = ?, failure_summary = ?, args_json = ?, resource_key = ?,
      lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, cancel_requested_at = ?, cancel_reason = ?,
      recovery_classification = ?, artifact_dir = ?, stdout_bytes = ?, stderr_bytes = ?, result_bytes = ?,
      result_sha256 = ?, patch_bytes = ?, patch_sha256 = ?
    WHERE job_id = ? AND status = ?${workerId ? ' AND lease_owner = ?' : ''}
  `).run(
    job.toolName,
    job.status,
    job.createdAt,
    job.updatedAt,
    job.startedAt || null,
    job.completedAt || null,
    job.waitMs ?? null,
    job.durationMs ?? null,
    job.failureSummary || null,
    JSON.stringify(redactValue(job.args || {})),
    job.resourceKey,
    job.leaseOwner || null,
    job.leaseExpiresAt || null,
    job.heartbeatAt || null,
    job.cancelRequestedAt || null,
    job.cancelReason || null,
    job.recoveryClassification || null,
    job.artifactDir,
    job.stdoutBytes || 0,
    job.stderrBytes || 0,
    job.resultBytes || 0,
    job.resultSha256 || null,
    job.patchBytes || 0,
    job.patchSha256 || null,
    job.jobId,
    expectedStatus,
    ...(workerId ? [workerId] : []),
  );
  return Number(result.changes || 0) === 1;
}

function publishJobLifecycleEvent(job: McpToolJob, reason: string) {
  const projectId = typeof job.args?.projectId === 'string' ? job.args.projectId : undefined;
  publishServerEvent('job.changed', {
    projectId,
    entityId: job.jobId,
    status: job.status,
    reason,
  });
}

export function createJob(jobId: string, toolName: string, args: any, resourceKey: string): McpToolJob {
  ensureJobsDir();
  const artifactDir = getArtifactDir(jobId);
  fs.mkdirSync(artifactDir, { recursive: true });
  const safeArgs = redactValue(args);
  const now = new Date().toISOString();
  const job: McpToolJob = {
    jobId,
    toolName,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    args: safeArgs,
    resourceKey,
    artifactDir,
    stdoutBytes: 0,
    stderrBytes: 0,
    resultBytes: 0,
    patchBytes: 0,
  };

  db.prepare(`
    INSERT INTO mcp_tool_jobs (
      job_id, tool_name, status, created_at, updated_at, args_json, resource_key, artifact_dir
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, toolName, job.status, now, now, JSON.stringify(safeArgs), resourceKey, artifactDir);

  fs.writeFileSync(path.join(artifactDir, 'input.json'), JSON.stringify({ toolName, args: safeArgs, resourceKey }, null, 2));
  fs.writeFileSync(path.join(artifactDir, 'stdout.log'), '');
  fs.writeFileSync(path.join(artifactDir, 'stderr.log'), '');
  writeCompatibilityStatus(job);
  upsertRecentJobCache(job);
  publishJobLifecycleEvent(job, 'created');
  return job;
}

export function getJob(jobId: string): McpToolJob | null {
  return getDbJob(jobId) || importLegacyJob(jobId);
}

export function transitionJobStatus(
  jobId: string,
  expectedStatuses: JobStatus[],
  updates: Partial<McpToolJob>,
  options: JobTransitionOptions = {},
): McpToolJob | null {
  if (expectedStatuses.length === 0) return null;
  let previousStatus: JobStatus | null = null;
  const stored = db.transaction(() => {
    const current = getJob(jobId);
    if (!current || !expectedStatuses.includes(current.status)) return null;
    if (TERMINAL_STATUSES.includes(current.status) && updates.status) return null;
    if (options.workerId && current.leaseOwner !== options.workerId) return null;

    previousStatus = current.status;
    const updated = buildUpdatedJob(current, updates, options.nowMs ?? Date.now());
    if (!persistLifecycle(updated, current.status, options.workerId)) return null;
    const persisted = getDbJob(jobId);
    if (!persisted) return null;
    writeCompatibilityStatus(persisted);
    upsertRecentJobCache(persisted);
    return persisted;
  })();
  if (stored && previousStatus !== stored.status) publishJobLifecycleEvent(stored, 'transition');
  return stored;
}

export function updateJobStatus(jobId: string, updates: Partial<McpToolJob>): McpToolJob | null {
  const current = getJob(jobId);
  if (!current) return null;
  const safeUpdates = redactValue(updates) as Partial<McpToolJob>;
  return transitionJobStatus(jobId, [current.status], safeUpdates);
}

export function claimJob(jobId: string, workerId: string, leaseMs: number, nowMs = Date.now()): McpToolJob | null {
  const boundedLeaseMs = Math.max(1_000, Math.min(5 * 60_000, Math.floor(leaseMs || 0)));
  const nowIso = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + boundedLeaseMs).toISOString();

  const claimed = db.transaction(() => {
    const current = getJob(jobId);
    if (!current || current.cancelRequestedAt || TERMINAL_STATUSES.includes(current.status)) return null;
    const canClaimQueued = current.status === 'queued';
    const canClaimExpired = current.status === 'running' && (!current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= nowMs);
    if (!canClaimQueued && !canClaimExpired) return null;

    const startedAt = current.startedAt || nowIso;
    const waitMs = current.waitMs ?? Math.max(0, nowMs - toTimestamp(current.createdAt, nowIso));
    const result = db.prepare(`
      UPDATE mcp_tool_jobs SET
        status = 'running', updated_at = ?, started_at = ?, wait_ms = ?,
        lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?
      WHERE job_id = ?
        AND cancel_requested_at IS NULL
        AND (
          status = 'queued'
          OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
    `).run(nowIso, startedAt, waitMs, workerId, leaseExpiresAt, nowIso, jobId, nowIso);
    if (Number(result.changes || 0) !== 1) return null;

    const claimed = getDbJob(jobId);
    if (claimed) {
      writeCompatibilityStatus(claimed);
      upsertRecentJobCache(claimed);
    }
    return claimed;
  })();
  if (claimed) publishJobLifecycleEvent(claimed, 'claimed');
  return claimed;
}

export function heartbeatJob(jobId: string, workerId: string, leaseMs: number, nowMs = Date.now()): McpToolJob | null {
  const boundedLeaseMs = Math.max(1_000, Math.min(5 * 60_000, Math.floor(leaseMs || 0)));
  const nowIso = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + boundedLeaseMs).toISOString();
  const result = db.prepare(`
    UPDATE mcp_tool_jobs SET updated_at = ?, heartbeat_at = ?, lease_expires_at = ?
    WHERE job_id = ? AND status = 'running' AND lease_owner = ? AND cancel_requested_at IS NULL
  `).run(nowIso, nowIso, leaseExpiresAt, jobId, workerId);
  if (Number(result.changes || 0) !== 1) return null;
  const updated = getDbJob(jobId);
  if (updated) {
    writeCompatibilityStatus(updated);
    upsertRecentJobCache(updated);
  }
  return updated;
}

export function requestJobCancellation(jobId: string, reason = 'Cancellation requested.', nowMs = Date.now()): McpToolJob | null {
  const nowIso = new Date(nowMs).toISOString();
  const cancelled = db.transaction(() => {
    const current = getJob(jobId);
    if (!current || TERMINAL_STATUSES.includes(current.status)) return null;
    const startTime = toTimestamp(current.startedAt, current.createdAt || nowIso);
    const result = db.prepare(`
      UPDATE mcp_tool_jobs SET
        status = 'cancelled', updated_at = ?, completed_at = ?, duration_ms = ?,
        failure_summary = ?, cancel_requested_at = ?, cancel_reason = ?, recovery_classification = COALESCE(recovery_classification, 'terminal'),
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL
      WHERE job_id = ? AND status IN ('queued', 'running')
    `).run(nowIso, nowIso, Math.max(0, nowMs - startTime), reason, nowIso, reason, jobId);
    if (Number(result.changes || 0) !== 1) return null;
    const cancelled = getDbJob(jobId);
    if (cancelled) {
      writeCompatibilityStatus(cancelled);
      upsertRecentJobCache(cancelled);
    }
    return cancelled;
  })();
  if (cancelled) publishJobLifecycleEvent(cancelled, 'cancelled');
  return cancelled;
}

export function setJobRecoveryClassification(jobId: string, classification: JobRecoveryClassification, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const result = db.prepare(`
    UPDATE mcp_tool_jobs SET recovery_classification = ?, updated_at = ? WHERE job_id = ?
  `).run(classification, nowIso, jobId);
  if (Number(result.changes || 0) !== 1) return null;
  const updated = getDbJob(jobId);
  if (updated) upsertRecentJobCache(updated);
  return updated;
}

export function requeueJobForRecovery(jobId: string, nowMs = Date.now()): McpToolJob | null {
  const nowIso = new Date(nowMs).toISOString();
  const requeued = db.transaction(() => {
    const current = getJob(jobId);
    if (!current || current.status !== 'running' || current.cancelRequestedAt) return null;
    if (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > nowMs) return null;
    const result = db.prepare(`
      UPDATE mcp_tool_jobs SET
        status = 'queued', updated_at = ?, started_at = NULL, wait_ms = NULL,
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
        recovery_classification = 'retryable',
        failure_summary = 'Server restarted while this retry-safe job was running.'
      WHERE job_id = ? AND status = 'running' AND cancel_requested_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(nowIso, jobId, nowIso);
    if (Number(result.changes || 0) !== 1) return null;
    const updated = getDbJob(jobId);
    if (updated) {
      writeCompatibilityStatus(updated);
      upsertRecentJobCache(updated);
    }
    return updated;
  })();
  if (requeued) publishJobLifecycleEvent(requeued, 'recovery-requeue');
  return requeued;
}

export function listRecoverableJobs(nowMs = Date.now()): McpToolJob[] {
  const nowIso = new Date(nowMs).toISOString();
  const rows = db.prepare(`
    SELECT * FROM mcp_tool_jobs
    WHERE cancel_requested_at IS NULL
      AND (
        status = 'queued'
        OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
      )
    ORDER BY created_at ASC
  `).all(nowIso) as any[];
  return rows.map(rowToJob);
}

export function appendJobLog(jobId: string, stream: 'stdout' | 'stderr', data: string) {
  const job = getJob(jobId);
  if (!job) return;
  fs.mkdirSync(job.artifactDir, { recursive: true });
  const filePath = path.join(job.artifactDir, `${stream}.log`);
  fs.appendFileSync(filePath, redactCredentialText(data));
  const bytes = fs.statSync(filePath).size;
  db.prepare(`UPDATE mcp_tool_jobs SET ${stream === 'stdout' ? 'stdout_bytes' : 'stderr_bytes'} = ? WHERE job_id = ?`).run(bytes, jobId);
  if (recentJobsCache) {
    const updated = getDbJob(jobId);
    if (updated) upsertRecentJobCache(updated);
  }
}

export function writeJobResult(jobId: string, result: any) {
  const job = getJob(jobId);
  if (!job) return;
  fs.mkdirSync(job.artifactDir, { recursive: true });
  const safeResult = redactValue(result);
  const resultPath = path.join(job.artifactDir, 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify(safeResult, null, 2));
  const resultMeta = fileMetadata(resultPath);

  let patchMeta = { bytes: 0, sha256: undefined as string | undefined };
  if (safeResult?.patch) {
    const patchPath = path.join(job.artifactDir, 'patch.diff');
    fs.writeFileSync(patchPath, safeResult.patch);
    patchMeta = fileMetadata(patchPath);
  }

  db.prepare(`
    UPDATE mcp_tool_jobs SET result_bytes = ?, result_sha256 = ?, patch_bytes = ?, patch_sha256 = ?
    WHERE job_id = ?
  `).run(resultMeta.bytes, resultMeta.sha256 || null, patchMeta.bytes, patchMeta.sha256 || null, jobId);
  if (recentJobsCache) {
    const updated = getDbJob(jobId);
    if (updated) upsertRecentJobCache(updated);
  }
}

export function readJobLog(jobId: string, stream: 'stdout' | 'stderr' | 'both'): { log: string; truncated: boolean; bytes: number; returnedBytes: number } {
  const job = getJob(jobId);
  if (!job) return { log: '', truncated: false, bytes: 0, returnedBytes: 0 };
  if (stream === 'both') {
    const out = readTail(path.join(job.artifactDir, 'stdout.log'), Math.floor(MAX_LOG_READ_BYTES / 2));
    const err = readTail(path.join(job.artifactDir, 'stderr.log'), Math.floor(MAX_LOG_READ_BYTES / 2));
    return {
      log: `${out.text}${err.text}`,
      truncated: out.truncated || err.truncated,
      bytes: out.bytes + err.bytes,
      returnedBytes: out.returnedBytes + err.returnedBytes,
    };
  }
  const tail = readTail(path.join(job.artifactDir, `${stream}.log`), MAX_LOG_READ_BYTES);
  return { log: tail.text, truncated: tail.truncated, bytes: tail.bytes, returnedBytes: tail.returnedBytes };
}

export function readJobResult(jobId: string): any {
  const job = getJob(jobId);
  if (!job) return null;
  const resultPath = path.join(job.artifactDir, 'result.json');
  if (!fs.existsSync(resultPath)) return null;
  try {
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const patchPath = path.join(job.artifactDir, 'patch.diff');
    return {
      result,
      patch: fs.existsSync(patchPath) ? readTail(patchPath, 500_000).text : undefined,
    };
  } catch {
    return null;
  }
}

export function getDurableJobMetrics(nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status IN ('failed', 'timed_out') THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN recovery_classification IN ('resumable', 'retryable', 'interrupted') THEN 1 ELSE 0 END) AS recovered,
      SUM(CASE WHEN status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?) THEN 1 ELSE 0 END) AS stale_running
    FROM mcp_tool_jobs
  `).get(nowIso) as any;
  const oldestLease = db.prepare(`
    SELECT MIN(heartbeat_at) AS oldest_heartbeat FROM mcp_tool_jobs WHERE status = 'running' AND heartbeat_at IS NOT NULL
  `).get() as any;
  const oldestHeartbeatMs = oldestLease?.oldest_heartbeat ? Date.parse(oldestLease.oldest_heartbeat) : NaN;
  return {
    queued: Number(counts?.queued || 0),
    running: Number(counts?.running || 0),
    failed: Number(counts?.failed || 0),
    recovered: Number(counts?.recovered || 0),
    staleRunning: Number(counts?.stale_running || 0),
    oldestLeaseAgeMs: Number.isFinite(oldestHeartbeatMs) ? Math.max(0, nowMs - oldestHeartbeatMs) : 0,
  };
}

export function cleanupOldJobs() {
  ensureJobsDir();
  try {
    const cutoffIso = new Date(Date.now() - MAX_JOB_AGE_MS).toISOString();
    const rows = db.prepare(`
      SELECT job_id, artifact_dir FROM mcp_tool_jobs
      WHERE status IN ('succeeded', 'failed', 'timed_out', 'cancelled') AND updated_at < ?
    `).all(cutoffIso) as any[];
    const removeRow = db.prepare('DELETE FROM mcp_tool_jobs WHERE job_id = ?');
    for (const row of rows) {
      try {
        fs.rmSync(row.artifact_dir || getArtifactDir(row.job_id), { recursive: true, force: true });
      } catch {
        // Artifact cleanup is best effort; lifecycle deletion remains deterministic.
      }
      removeRow.run(row.job_id);
      removeRecentJobCache(row.job_id);
    }
  } catch (error) {
    console.error('[mcp-tool-job] Cleanup failed:', error);
  }
}

export function listInterruptedJobs(): McpToolJob[] {
  const interrupted: McpToolJob[] = [];
  for (const job of listRecoverableJobs()) {
    const updated = transitionJobStatus(job.jobId, [job.status], {
      status: 'failed',
      failureSummary: 'Server restarted before this job completed.',
      recoveryClassification: 'interrupted',
    });
    if (updated) {
      appendJobLog(job.jobId, 'stderr', '\n[Job Interrupted] Server restarted before this job completed.\n');
      interrupted.push(updated);
    }
  }
  return interrupted;
}

let backgroundJobCleanupStarted = false;

export function startBackgroundJobCleanup() {
  if (backgroundJobCleanupStarted) return;
  backgroundJobCleanupStarted = true;
  setTimeout(() => {
    cleanupOldJobs();
    setInterval(cleanupOldJobs, CLEANUP_INTERVAL_MS).unref();
  }, 5000).unref();
}

export function listRecentJobs(limit: number = 50): McpToolJob[] {
  ensureJobsDir();
  if (!recentJobsCache) {
    recentJobsDiskScanCount += 1;
    const rows = db.prepare('SELECT * FROM mcp_tool_jobs ORDER BY updated_at DESC').all() as any[];
    recentJobsCache = sortRecentJobs(rows.map(rowToJob));
  }
  return recentJobsCache.slice(0, Math.max(0, limit));
}
