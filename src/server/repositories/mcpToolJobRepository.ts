import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import db from '../../db/index.js';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import { publishServerEvent } from '../services/serverEventService.js';
import { redactCredentialText } from '../services/credentialVaultService.js';
import type { CommandResultReuseIdentity } from '../services/commandResultCacheService.js';

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
  leaseGeneration?: number;
  detachedAt?: string;
  fencedWriteCount?: number;
  cancelRequestedAt?: string;
  cancelReason?: string;
  verificationSeriesKey?: string;
  verificationCandidateKey?: string;
  verificationGeneration?: number;
  verificationEvidenceIntent?: string;
  supersededByCandidateKey?: string;
  supersededByGeneration?: number;
  supersededAt?: string;
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
  leaseGeneration?: number;
  nowMs?: number;
}

export interface JobLeaseGuard {
  workerId: string;
  leaseGeneration: number;
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
const MAX_DURABLE_FULL_GREEN_EVIDENCE = 128;
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

function normalizedJobString(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function normalizedJobGeneration(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : undefined;
}

function verificationMetadataFromArgs(args: any) {
  return {
    verificationSeriesKey: normalizedJobString(args?.verificationSeriesKey),
    verificationCandidateKey: normalizedJobString(args?.verificationCandidateKey),
    verificationGeneration: normalizedJobGeneration(args?.verificationGeneration),
    verificationEvidenceIntent: normalizedJobString(args?.verificationEvidenceIntent),
  };
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
    leaseGeneration: Number(row.lease_generation || 0),
    detachedAt: row.detached_at || undefined,
    fencedWriteCount: Number(row.fenced_write_count || 0),
    cancelRequestedAt: row.cancel_requested_at || undefined,
    cancelReason: row.cancel_reason || undefined,
    verificationSeriesKey: row.verification_series_key || undefined,
    verificationCandidateKey: row.verification_candidate_key || undefined,
    verificationGeneration: row.verification_generation == null ? undefined : Number(row.verification_generation),
    verificationEvidenceIntent: row.verification_evidence_intent || undefined,
    supersededByCandidateKey: row.superseded_by_candidate_key || undefined,
    supersededByGeneration: row.superseded_by_generation == null ? undefined : Number(row.superseded_by_generation),
    supersededAt: row.superseded_at || undefined,
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

function persistLifecycle(job: McpToolJob, expectedStatus: JobStatus, options: JobTransitionOptions = {}) {
  const workerClause = options.workerId ? ' AND lease_owner = ?' : '';
  const generationClause = options.leaseGeneration !== undefined ? ' AND lease_generation = ?' : '';
  const result = db.prepare(`
    UPDATE mcp_tool_jobs SET
      tool_name = ?, status = ?, created_at = ?, updated_at = ?, started_at = ?, completed_at = ?,
      wait_ms = ?, duration_ms = ?, failure_summary = ?, args_json = ?, resource_key = ?,
      lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, lease_generation = ?, detached_at = ?,
      cancel_requested_at = ?, cancel_reason = ?, recovery_classification = ?, artifact_dir = ?,
      verification_series_key = ?, verification_candidate_key = ?, verification_generation = ?, verification_evidence_intent = ?,
      superseded_by_candidate_key = ?, superseded_by_generation = ?, superseded_at = ?,
      stdout_bytes = ?, stderr_bytes = ?, result_bytes = ?, result_sha256 = ?, patch_bytes = ?, patch_sha256 = ?, fenced_write_count = ?
    WHERE job_id = ? AND status = ?${workerClause}${generationClause}
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
    job.leaseGeneration || 0,
    job.detachedAt || null,
    job.cancelRequestedAt || null,
    job.cancelReason || null,
    job.recoveryClassification || null,
    job.artifactDir,
    job.verificationSeriesKey || null,
    job.verificationCandidateKey || null,
    job.verificationGeneration ?? null,
    job.verificationEvidenceIntent || null,
    job.supersededByCandidateKey || null,
    job.supersededByGeneration ?? null,
    job.supersededAt || null,
    job.stdoutBytes || 0,
    job.stderrBytes || 0,
    job.resultBytes || 0,
    job.resultSha256 || null,
    job.patchBytes || 0,
    job.patchSha256 || null,
    job.fencedWriteCount || 0,
    job.jobId,
    expectedStatus,
    ...(options.workerId ? [options.workerId] : []),
    ...(options.leaseGeneration !== undefined ? [options.leaseGeneration] : []),
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

export function createJob(
  jobId: string,
  toolName: string,
  args: any,
  resourceKey: string,
  options: { eagerArtifacts?: boolean } = {},
): McpToolJob {
  const eagerArtifacts = options.eagerArtifacts !== false;
  if (eagerArtifacts) ensureJobsDir();
  const artifactDir = getArtifactDir(jobId);
  if (eagerArtifacts) fs.mkdirSync(artifactDir, { recursive: true });
  const safeArgs = redactValue(args);
  const verificationMetadata = verificationMetadataFromArgs(safeArgs);
  const now = new Date().toISOString();
  const job: McpToolJob = {
    jobId,
    toolName,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    args: safeArgs,
    resourceKey,
    ...verificationMetadata,
    artifactDir,
    stdoutBytes: 0,
    stderrBytes: 0,
    resultBytes: 0,
    patchBytes: 0,
  };

  db.prepare(`
    INSERT INTO mcp_tool_jobs (
      job_id, tool_name, status, created_at, updated_at, args_json, resource_key, artifact_dir,
      verification_series_key, verification_candidate_key, verification_generation, verification_evidence_intent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId, toolName, job.status, now, now, JSON.stringify(safeArgs), resourceKey, artifactDir,
    job.verificationSeriesKey || null, job.verificationCandidateKey || null,
    job.verificationGeneration ?? null, job.verificationEvidenceIntent || null,
  );

  if (eagerArtifacts) {
    fs.writeFileSync(path.join(artifactDir, 'input.json'), JSON.stringify({ toolName, args: safeArgs, resourceKey }, null, 2));
    fs.writeFileSync(path.join(artifactDir, 'stdout.log'), '');
    fs.writeFileSync(path.join(artifactDir, 'stderr.log'), '');
    writeCompatibilityStatus(job);
  }
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
    if (options.leaseGeneration !== undefined && current.leaseGeneration !== options.leaseGeneration) return null;

    previousStatus = current.status;
    const updated = buildUpdatedJob(current, updates, options.nowMs ?? Date.now());
    if (!persistLifecycle(updated, current.status, options)) return null;
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
    if (!current || current.cancelRequestedAt || current.supersededAt || TERMINAL_STATUSES.includes(current.status)) return null;
    const canClaimQueued = current.status === 'queued';
    const canClaimExpired = current.status === 'running' && (!current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= nowMs);
    if (!canClaimQueued && !canClaimExpired) return null;

    const startedAt = current.startedAt || nowIso;
    const waitMs = current.waitMs ?? Math.max(0, nowMs - toTimestamp(current.createdAt, nowIso));
    const result = db.prepare(`
      UPDATE mcp_tool_jobs SET
        status = 'running', updated_at = ?, started_at = ?, wait_ms = ?,
        lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
        lease_generation = lease_generation + 1
      WHERE job_id = ?
        AND cancel_requested_at IS NULL
        AND superseded_at IS NULL
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

export function heartbeatJob(jobId: string, workerId: string, leaseMs: number, nowMs = Date.now(), leaseGeneration?: number): McpToolJob | null {
  const boundedLeaseMs = Math.max(1_000, Math.min(5 * 60_000, Math.floor(leaseMs || 0)));
  const nowIso = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + boundedLeaseMs).toISOString();
  const generationClause = leaseGeneration !== undefined ? ' AND lease_generation = ?' : '';
  const result = db.prepare(`
    UPDATE mcp_tool_jobs SET updated_at = ?, heartbeat_at = ?, lease_expires_at = ?
    WHERE job_id = ? AND status = 'running' AND lease_owner = ?
      AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
      AND cancel_requested_at IS NULL${generationClause}
  `).run(nowIso, nowIso, leaseExpiresAt, jobId, workerId, nowIso, ...(leaseGeneration !== undefined ? [leaseGeneration] : []));
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

export function markJobSuperseded(
  jobId: string,
  supersededByCandidateKey: string,
  supersededByGeneration?: number,
  reason = `Verification superseded by candidate ${supersededByCandidateKey}.`,
  nowMs = Date.now(),
): McpToolJob | null {
  const nowIso = new Date(nowMs).toISOString();
  const superseded = db.transaction(() => {
    const current = getJob(jobId);
    if (!current || TERMINAL_STATUSES.includes(current.status)) return null;
    const startTime = toTimestamp(current.startedAt, current.createdAt || nowIso);
    const result = db.prepare(`
      UPDATE mcp_tool_jobs SET
        status = 'cancelled', updated_at = ?, completed_at = ?, duration_ms = ?,
        failure_summary = ?, cancel_requested_at = ?, cancel_reason = ?, recovery_classification = 'terminal',
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
        superseded_by_candidate_key = ?, superseded_by_generation = ?, superseded_at = ?
      WHERE job_id = ? AND status IN ('queued', 'running') AND superseded_at IS NULL
    `).run(
      nowIso, nowIso, Math.max(0, nowMs - startTime), reason, nowIso, reason,
      supersededByCandidateKey, supersededByGeneration ?? null, nowIso, jobId,
    );
    if (Number(result.changes || 0) !== 1) return null;
    const persisted = getDbJob(jobId);
    if (persisted) {
      writeCompatibilityStatus(persisted);
      upsertRecentJobCache(persisted);
    }
    return persisted;
  })();
  if (superseded) publishJobLifecycleEvent(superseded, 'superseded');
  return superseded;
}

export function markJobConsumerAttached(jobId: string, nowMs = Date.now()): McpToolJob | null {
  const nowIso = new Date(nowMs).toISOString();
  const result = db.prepare(`
    UPDATE mcp_tool_jobs SET detached_at = NULL, updated_at = ?
    WHERE job_id = ? AND status IN ('queued', 'running')
  `).run(nowIso, jobId);
  if (Number(result.changes || 0) !== 1) return getDbJob(jobId);
  const updated = getDbJob(jobId);
  if (updated) upsertRecentJobCache(updated);
  return updated;
}

export function markJobConsumerDetached(jobId: string, nowMs = Date.now()): McpToolJob | null {
  const nowIso = new Date(nowMs).toISOString();
  const result = db.prepare(`
    UPDATE mcp_tool_jobs SET detached_at = COALESCE(detached_at, ?), updated_at = ?
    WHERE job_id = ? AND status IN ('queued', 'running')
  `).run(nowIso, nowIso, jobId);
  if (Number(result.changes || 0) !== 1) return getDbJob(jobId);
  const updated = getDbJob(jobId);
  if (updated) upsertRecentJobCache(updated);
  return updated;
}

function fencedLeaseWrite(jobId: string, guard: JobLeaseGuard | undefined) {
  const job = getDbJob(jobId);
  if (!job) return { allowed: false, job: null as McpToolJob | null };
  if (!guard) return { allowed: true, job };
  const leaseExpiresAtMs = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : NaN;
  const allowed = job.status === 'running'
    && job.leaseOwner === guard.workerId
    && job.leaseGeneration === guard.leaseGeneration
    && Number.isFinite(leaseExpiresAtMs)
    && leaseExpiresAtMs > Date.now();
  if (allowed) return { allowed: true, job };
  db.prepare('UPDATE mcp_tool_jobs SET fenced_write_count = fenced_write_count + 1 WHERE job_id = ?').run(jobId);
  const updated = getDbJob(jobId);
  if (updated) upsertRecentJobCache(updated);
  return { allowed: false, job: updated };
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
    if (!current || current.status !== 'running' || current.cancelRequestedAt || current.supersededAt) return null;
    if (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > nowMs) return null;
    const result = db.prepare(`
      UPDATE mcp_tool_jobs SET
        status = 'queued', updated_at = ?, started_at = NULL, wait_ms = NULL,
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
        recovery_classification = 'retryable',
        failure_summary = 'Server restarted while this retry-safe job was running.'
      WHERE job_id = ? AND status = 'running' AND cancel_requested_at IS NULL
        AND superseded_at IS NULL
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
      AND superseded_at IS NULL
      AND (
        status = 'queued'
        OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
      )
    ORDER BY created_at ASC
  `).all(nowIso) as any[];
  return rows.map(rowToJob);
}

export function getLatestAcceptedGreenGeneration(seriesKey: string): number | undefined {
  const normalized = normalizedJobString(seriesKey);
  if (!normalized) return undefined;
  const row = db.prepare(`
    SELECT MAX(verification_generation) AS generation
    FROM mcp_tool_jobs
    WHERE verification_series_key = ?
      AND verification_generation IS NOT NULL
      AND verification_evidence_intent = 'green'
      AND status = 'succeeded'
      AND superseded_at IS NULL
  `).get(normalized) as { generation?: number | null } | undefined;
  return row?.generation == null ? undefined : Number(row.generation);
}

export type DurableFullGreenEvidence<T = any> = {
  reuseKey: string;
  identity: CommandResultReuseIdentity;
  result: T;
  sourceJobId: string;
  createdAt: number;
  lastUsedAt: number;
  hitCount: number;
};

function parseDurableIdentity(value: unknown): CommandResultReuseIdentity | null {
  try {
    const parsed = JSON.parse(String(value || '{}')) as CommandResultReuseIdentity;
    return parsed && typeof parsed.repositoryScope === 'string' && typeof parsed.semanticKey === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function isReusableFullGreenIdentity(identity: CommandResultReuseIdentity) {
  return identity.reusePolicy === 'exact-revision'
    && identity.coverageScope === 'full'
    && typeof identity.repoRevision === 'string'
    && identity.repoRevision.trim().length > 0;
}

function isReusableFullGreenResult(result: any, reuseKey?: string) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.ok !== true || result.status !== 'succeeded' || result.timedOut === true) return false;
  if (result.stale === true || result.superseded === true) return false;
  if (['stale', 'superseded', 'rejected'].includes(String(result.verificationFreshness || ''))) return false;
  if (reuseKey && result.cache?.key !== reuseKey) return false;
  return true;
}

function removeDurableFullGreenEvidence(reuseKey: string) {
  db.prepare('DELETE FROM durable_full_green_evidence WHERE reuse_key = ?').run(reuseKey);
}

export function rememberDurableFullGreenEvidence(
  reuseKey: string,
  identity: CommandResultReuseIdentity,
  sourceJobId: string,
): DurableFullGreenEvidence | null {
  if (!reuseKey || !sourceJobId || !isReusableFullGreenIdentity(identity)) return null;
  const sourceJob = getDbJob(sourceJobId);
  if (!sourceJob || sourceJob.status !== 'succeeded' || sourceJob.supersededAt || !sourceJob.resultSha256) return null;
  const sourceResult = readJobResult(sourceJobId)?.result;
  if (!isReusableFullGreenResult(sourceResult, reuseKey)) return null;
  if (sourceResult.cache?.hit === true || Number(sourceResult.processSpawns || 0) < 1) return null;
  const now = Date.now();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO durable_full_green_evidence (
        reuse_key, repository_scope, identity_json, source_job_id, result_sha256,
        created_at, last_used_at, hit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(reuse_key) DO UPDATE SET
        repository_scope = excluded.repository_scope,
        identity_json = excluded.identity_json,
        source_job_id = excluded.source_job_id,
        result_sha256 = excluded.result_sha256,
        created_at = excluded.created_at,
        last_used_at = excluded.last_used_at,
        hit_count = 0
    `).run(reuseKey, identity.repositoryScope, JSON.stringify(identity), sourceJobId, sourceJob.resultSha256, now, now);
    db.prepare(`
      DELETE FROM durable_full_green_evidence
      WHERE reuse_key IN (
        SELECT reuse_key FROM durable_full_green_evidence
        ORDER BY last_used_at DESC, created_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(MAX_DURABLE_FULL_GREEN_EVIDENCE);
  })();
  return { reuseKey, identity: { ...identity }, result: sourceResult, sourceJobId, createdAt: now, lastUsedAt: now, hitCount: 0 };
}

export function getDurableFullGreenEvidence<T>(reuseKey: string): DurableFullGreenEvidence<T> | null {
  const row = db.prepare(`
    SELECT reuse_key, identity_json, source_job_id, result_sha256, created_at, last_used_at, hit_count
    FROM durable_full_green_evidence
    WHERE reuse_key = ?
  `).get(reuseKey) as any;
  if (!row) return null;
  const identity = parseDurableIdentity(row.identity_json);
  const sourceJob = getDbJob(String(row.source_job_id || ''));
  const resultPath = sourceJob ? path.join(sourceJob.artifactDir, 'result.json') : '';
  const resultMeta = resultPath ? fileMetadata(resultPath) : { bytes: 0, sha256: undefined as string | undefined };
  const payload = sourceJob ? readJobResult(sourceJob.jobId)?.result : null;
  if (
    !identity || !isReusableFullGreenIdentity(identity)
    || !sourceJob || sourceJob.status !== 'succeeded' || sourceJob.supersededAt
    || !sourceJob.resultSha256 || sourceJob.resultSha256 !== row.result_sha256
    || !resultMeta.sha256 || resultMeta.sha256 !== row.result_sha256
    || !isReusableFullGreenResult(payload, reuseKey)
  ) {
    removeDurableFullGreenEvidence(reuseKey);
    return null;
  }
  const lastUsedAt = Date.now();
  db.prepare(`
    UPDATE durable_full_green_evidence
    SET last_used_at = ?, hit_count = hit_count + 1
    WHERE reuse_key = ?
  `).run(lastUsedAt, reuseKey);
  return {
    reuseKey,
    identity,
    result: payload as T,
    sourceJobId: sourceJob.jobId,
    createdAt: Number(row.created_at || lastUsedAt),
    lastUsedAt,
    hitCount: Number(row.hit_count || 0) + 1,
  };
}

export function listDurableFullGreenEvidenceIdentities(repositoryScope: string, limit = 32): CommandResultReuseIdentity[] {
  const rows = db.prepare(`
    SELECT identity_json
    FROM durable_full_green_evidence
    WHERE repository_scope = ?
    ORDER BY last_used_at DESC
    LIMIT ?
  `).all(repositoryScope, Math.max(1, Math.min(128, Math.floor(limit || 32)))) as any[];
  return rows.map((row) => parseDurableIdentity(row.identity_json)).filter((identity): identity is CommandResultReuseIdentity => Boolean(identity));
}

export function clearDurableFullGreenEvidenceForTests() {
  const result = db.prepare('DELETE FROM durable_full_green_evidence').run();
  return Number(result.changes || 0);
}

export function getDurableFullGreenEvidenceStats() {
  const row = db.prepare('SELECT COUNT(*) AS count FROM durable_full_green_evidence').get() as any;
  return { entries: Number(row?.count || 0), maxEntries: MAX_DURABLE_FULL_GREEN_EVIDENCE };
}

export function appendJobLog(jobId: string, stream: 'stdout' | 'stderr', data: string, guard?: JobLeaseGuard) {
  return db.transaction(() => {
    const lease = fencedLeaseWrite(jobId, guard);
    if (!lease.allowed || !lease.job) return false;
    fs.mkdirSync(lease.job.artifactDir, { recursive: true });
    const filePath = path.join(lease.job.artifactDir, `${stream}.log`);
    fs.appendFileSync(filePath, redactCredentialText(data));
    const bytes = fs.statSync(filePath).size;
    db.prepare(`UPDATE mcp_tool_jobs SET ${stream === 'stdout' ? 'stdout_bytes' : 'stderr_bytes'} = ? WHERE job_id = ?`).run(bytes, jobId);
    const updated = getDbJob(jobId);
    if (updated) upsertRecentJobCache(updated);
    return true;
  })();
}

export function writeJobResult(jobId: string, result: any, guard?: JobLeaseGuard) {
  return db.transaction(() => {
    const lease = fencedLeaseWrite(jobId, guard);
    if (!lease.allowed || !lease.job) return false;
    fs.mkdirSync(lease.job.artifactDir, { recursive: true });
    const safeResult = redactValue(result);
    const resultPath = path.join(lease.job.artifactDir, 'result.json');
    fs.writeFileSync(resultPath, JSON.stringify(safeResult, null, 2));
    const resultMeta = fileMetadata(resultPath);

    let patchMeta = { bytes: 0, sha256: undefined as string | undefined };
    if (safeResult?.patch) {
      const patchPath = path.join(lease.job.artifactDir, 'patch.diff');
      fs.writeFileSync(patchPath, safeResult.patch);
      patchMeta = fileMetadata(patchPath);
    }

    db.prepare(`
      UPDATE mcp_tool_jobs SET result_bytes = ?, result_sha256 = ?, patch_bytes = ?, patch_sha256 = ?
      WHERE job_id = ?
    `).run(resultMeta.bytes, resultMeta.sha256 || null, patchMeta.bytes, patchMeta.sha256 || null, jobId);
    const updated = getDbJob(jobId);
    if (updated) upsertRecentJobCache(updated);
    return true;
  })();
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
      SUM(CASE WHEN status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at > ? THEN 1 ELSE 0 END) AS healthy_running,
      SUM(CASE WHEN status IN ('queued', 'running') AND detached_at IS NOT NULL THEN 1 ELSE 0 END) AS detached,
      SUM(CASE WHEN status IN ('failed', 'timed_out') THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN recovery_classification IN ('resumable', 'retryable', 'interrupted') THEN 1 ELSE 0 END) AS recovered,
      SUM(CASE WHEN status = 'running' AND lease_owner IS NOT NULL AND (lease_expires_at IS NULL OR lease_expires_at <= ?) THEN 1 ELSE 0 END) AS stale_running,
      SUM(fenced_write_count) AS fenced_late_writes
    FROM mcp_tool_jobs
  `).get(nowIso, nowIso) as any;
  const oldestLease = db.prepare(`
    SELECT MIN(heartbeat_at) AS oldest_heartbeat FROM mcp_tool_jobs WHERE status = 'running' AND heartbeat_at IS NOT NULL
  `).get() as any;
  const oldestHeartbeatMs = oldestLease?.oldest_heartbeat ? Date.parse(oldestLease.oldest_heartbeat) : NaN;
  return {
    queued: Number(counts?.queued || 0),
    running: Number(counts?.running || 0),
    healthyRunning: Number(counts?.healthy_running || 0),
    detached: Number(counts?.detached || 0),
    failed: Number(counts?.failed || 0),
    cancelled: Number(counts?.cancelled || 0),
    recovered: Number(counts?.recovered || 0),
    staleRunning: Number(counts?.stale_running || 0),
    fencedLateWrites: Number(counts?.fenced_late_writes || 0),
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
      db.prepare('DELETE FROM durable_full_green_evidence WHERE source_job_id = ?').run(row.job_id);
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
