import db, { withDbTransaction } from '../../db/index.js';

export const EXECUTION_SESSION_STATUSES = ['active', 'completed', 'cancelled', 'expired'] as const;
export type ExecutionSessionStatus = typeof EXECUTION_SESSION_STATUSES[number];

export const EXECUTION_LIFECYCLE_STAGES = ['compatibility', 'created', 'context-ready', 'plan-recorded', 'implementing', 'verifying', 'repairing', 'verification-infra-blocked', 'committed', 'finalized'] as const;
export type ExecutionLifecycleStage = typeof EXECUTION_LIFECYCLE_STAGES[number];

export interface ExecutionLifecycleTransition {
  evidenceId: string;
  fromStage: ExecutionLifecycleStage | null;
  toStage: ExecutionLifecycleStage;
  reasonCode: string;
  originEvidenceId: string;
  operationId: string | null;
  evidenceKind: string;
  evidenceStatus: 'completed';
  sequence: number;
  observedAt: string;
}

export interface ExecutionLifecycleState {
  stage: ExecutionLifecycleStage;
  legacyCompatibility: boolean;
  lastTransition: ExecutionLifecycleTransition | null;
}

export interface ExecutionSessionRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  workspaceId: string | null;
  branch: string | null;
  baseRevision: string | null;
  repoRevision: string | null;
  status: ExecutionSessionStatus;
  lifecycle: ExecutionLifecycleState;
  contextHandle: string | null;
  changedFiles: string[];
  verification: unknown[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  endedAt: string | null;
}

export interface ExecutionSessionEvidenceRecord {
  id: string;
  sessionId: string;
  kind: string;
  path: string | null;
  repoRevision: string | null;
  fileRevision: string | null;
  revisionIdentity: string | null;
  contextHandle: string | null;
  stale: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExecutionSessionRecordInput extends Omit<ExecutionSessionRecord, 'changedFiles' | 'verification' | 'lifecycle'> {
  changedFiles?: string[];
  verification?: unknown[];
}

export interface SaveExecutionSessionEvidenceInput extends Omit<ExecutionSessionEvidenceRecord, 'stale' | 'metadata'> {
  stale?: boolean;
  metadata?: Record<string, unknown>;
}

function parseArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function asLifecycleStage(value: unknown): ExecutionLifecycleStage | null {
  const normalized = String(value || '');
  return (EXECUTION_LIFECYCLE_STAGES as readonly string[]).includes(normalized) ? normalized as ExecutionLifecycleStage : null;
}

export function getExecutionLifecycleStateForSession(sessionId: string): ExecutionLifecycleState {
  const row = db.prepare(`SELECT * FROM execution_session_evidence WHERE sessionId = ? AND kind = 'lifecycle-transition' ORDER BY rowid DESC LIMIT 1`).get(sessionId);
  const evidence = normalizeEvidence(row);
  if (!evidence) return { stage: 'compatibility', legacyCompatibility: true, lastTransition: null };
  const metadata = evidence.metadata || {};
  const toStage = asLifecycleStage(metadata.toStage);
  if (!toStage || toStage === 'compatibility') return { stage: 'compatibility', legacyCompatibility: true, lastTransition: null };
  return {
    stage: toStage,
    legacyCompatibility: false,
    lastTransition: {
      evidenceId: evidence.id,
      fromStage: asLifecycleStage(metadata.fromStage),
      toStage,
      reasonCode: typeof metadata.reasonCode === 'string' ? metadata.reasonCode : '',
      originEvidenceId: typeof metadata.originEvidenceId === 'string' ? metadata.originEvidenceId : '',
      operationId: typeof metadata.operationId === 'string' && metadata.operationId ? metadata.operationId : null,
      evidenceKind: typeof metadata.evidenceKind === 'string' ? metadata.evidenceKind : '',
      evidenceStatus: 'completed',
      sequence: Number.isFinite(Number(metadata.sequence)) ? Number(metadata.sequence) : 0,
      observedAt: typeof metadata.observedAt === 'string' && metadata.observedAt ? metadata.observedAt : evidence.createdAt,
    },
  };
}

function normalizeSession(row: any): ExecutionSessionRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    taskId: row.taskId == null ? null : String(row.taskId),
    workspaceId: row.workspaceId == null ? null : String(row.workspaceId),
    branch: row.branch == null ? null : String(row.branch),
    baseRevision: row.baseRevision == null ? null : String(row.baseRevision),
    repoRevision: row.repoRevision == null ? null : String(row.repoRevision),
    status: row.status as ExecutionSessionStatus,
    lifecycle: getExecutionLifecycleStateForSession(String(row.id)),
    contextHandle: row.contextHandle == null ? null : String(row.contextHandle),
    changedFiles: parseArray(row.changedFilesJson).map(String),
    verification: parseArray(row.verificationJson),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    expiresAt: row.expiresAt == null ? null : String(row.expiresAt),
    endedAt: row.endedAt == null ? null : String(row.endedAt),
  };
}

function normalizeEvidence(row: any): ExecutionSessionEvidenceRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    kind: String(row.kind),
    path: row.path == null ? null : String(row.path),
    repoRevision: row.repoRevision == null ? null : String(row.repoRevision),
    fileRevision: row.fileRevision == null ? null : String(row.fileRevision),
    revisionIdentity: row.revisionIdentity == null ? null : String(row.revisionIdentity),
    contextHandle: row.contextHandle == null ? null : String(row.contextHandle),
    stale: Number(row.stale) === 1,
    metadata: parseObject(row.metadataJson),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function createExecutionSessionRecord(input: CreateExecutionSessionRecordInput) {
  db.prepare(`
    INSERT INTO execution_sessions (
      id, projectId, taskId, workspaceId, branch, baseRevision, repoRevision, status,
      contextHandle, changedFilesJson, verificationJson, createdAt, updatedAt, expiresAt, endedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.taskId,
    input.workspaceId,
    input.branch,
    input.baseRevision,
    input.repoRevision,
    input.status,
    input.contextHandle,
    JSON.stringify(input.changedFiles || []),
    JSON.stringify(input.verification || []),
    input.createdAt,
    input.updatedAt,
    input.expiresAt,
    input.endedAt,
  );
  return getExecutionSessionById(input.id)!;
}

export function getExecutionSessionById(id: string): ExecutionSessionRecord | null {
  return normalizeSession(db.prepare('SELECT * FROM execution_sessions WHERE id = ?').get(id));
}

export function listExecutionSessionsForTask(taskId: string): ExecutionSessionRecord[] {
  return (db.prepare('SELECT * FROM execution_sessions WHERE taskId = ? ORDER BY updatedAt DESC').all(taskId) as any[])
    .map(normalizeSession)
    .filter((entry): entry is ExecutionSessionRecord => Boolean(entry));
}

export function listExecutionSessionsForWorkspace(workspaceId: string): ExecutionSessionRecord[] {
  return (db.prepare('SELECT * FROM execution_sessions WHERE workspaceId = ? ORDER BY updatedAt DESC').all(workspaceId) as any[])
    .map(normalizeSession)
    .filter((entry): entry is ExecutionSessionRecord => Boolean(entry));
}

export function queryExecutionSessions(args: {
  projectId?: string;
  taskId?: string;
  workspaceId?: string;
  status?: ExecutionSessionStatus;
  limit?: number;
  offset?: number;
} = {}) {
  const requestedLimit = Number(args.limit);
  const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 50));
  const requestedOffset = Number(args.offset);
  const offset = Math.max(0, Math.min(10_000, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0));
  const clauses: string[] = [];
  const values: string[] = [];
  if (args.projectId) { clauses.push('projectId = ?'); values.push(String(args.projectId)); }
  if (args.taskId) { clauses.push('taskId = ?'); values.push(String(args.taskId)); }
  if (args.workspaceId) { clauses.push('workspaceId = ?'); values.push(String(args.workspaceId)); }
  if (args.status) { clauses.push('status = ?'); values.push(String(args.status)); }
  const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM execution_sessions' + where).get(...values) as any;
  const total = Number(countRow?.count || 0);
  const rows = db.prepare('SELECT * FROM execution_sessions' + where + ' ORDER BY updatedAt DESC LIMIT ? OFFSET ?').all(...values, limit, offset) as any[];
  return {
    sessions: rows.map(normalizeSession).filter((entry): entry is ExecutionSessionRecord => Boolean(entry)),
    total,
    limit,
    offset,
    truncated: total > offset + limit,
  };
}

export function updateExecutionSessionRecord(
  id: string,
  patch: Partial<Pick<ExecutionSessionRecord, 'workspaceId' | 'branch' | 'baseRevision' | 'repoRevision' | 'status' | 'contextHandle' | 'changedFiles' | 'verification' | 'updatedAt' | 'expiresAt' | 'endedAt'>>,
) {
  const current = getExecutionSessionById(id);
  if (!current) return null;
  const next: ExecutionSessionRecord = { ...current, ...patch };
  db.prepare(`
    UPDATE execution_sessions SET
      workspaceId = ?, branch = ?, baseRevision = ?, repoRevision = ?, status = ?, contextHandle = ?,
      changedFilesJson = ?, verificationJson = ?, updatedAt = ?, expiresAt = ?, endedAt = ?
    WHERE id = ?
  `).run(
    next.workspaceId,
    next.branch,
    next.baseRevision,
    next.repoRevision,
    next.status,
    next.contextHandle,
    JSON.stringify(next.changedFiles || []),
    JSON.stringify(next.verification || []),
    next.updatedAt,
    next.expiresAt,
    next.endedAt,
    id,
  );
  return getExecutionSessionById(id);
}

export function saveExecutionSessionEvidence(input: SaveExecutionSessionEvidenceInput) {
  db.prepare(`
    INSERT INTO execution_session_evidence (
      id, sessionId, kind, path, repoRevision, fileRevision, revisionIdentity, contextHandle,
      stale, metadataJson, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      path = excluded.path,
      repoRevision = excluded.repoRevision,
      fileRevision = excluded.fileRevision,
      revisionIdentity = excluded.revisionIdentity,
      contextHandle = excluded.contextHandle,
      stale = excluded.stale,
      metadataJson = excluded.metadataJson,
      updatedAt = excluded.updatedAt
  `).run(
    input.id,
    input.sessionId,
    input.kind,
    input.path,
    input.repoRevision,
    input.fileRevision,
    input.revisionIdentity,
    input.contextHandle,
    input.stale ? 1 : 0,
    JSON.stringify(input.metadata || {}),
    input.createdAt,
    input.updatedAt,
  );
  return getExecutionSessionEvidenceById(input.id)!;
}

export function getExecutionSessionEvidenceById(id: string) {
  return normalizeEvidence(db.prepare('SELECT * FROM execution_session_evidence WHERE id = ?').get(id));
}

export function listExecutionSessionEvidence(sessionId: string): ExecutionSessionEvidenceRecord[] {
  return (db.prepare('SELECT * FROM execution_session_evidence WHERE sessionId = ? ORDER BY createdAt ASC, id ASC').all(sessionId) as any[])
    .map(normalizeEvidence)
    .filter((entry): entry is ExecutionSessionEvidenceRecord => Boolean(entry));
}

export function queryExecutionSessionEvidenceForProject(projectIdValue: string, kindValue: string, limitValue = 20): ExecutionSessionEvidenceRecord[] {
  const projectId = String(projectIdValue || '').trim();
  const kind = String(kindValue || '').trim();
  if (!projectId || !kind) return [];
  const numericLimit = Number(limitValue);
  const limit = Math.max(1, Math.min(100, Number.isFinite(numericLimit) ? Math.floor(numericLimit) : 20));
  const rows = db.prepare(`
    SELECT evidence.*
    FROM execution_session_evidence evidence
    INNER JOIN execution_sessions session ON session.id = evidence.sessionId
    WHERE session.projectId = ? AND evidence.kind = ?
    ORDER BY evidence.updatedAt DESC, evidence.createdAt DESC, evidence.id DESC
    LIMIT ?
  `).all(projectId, kind, limit) as any[];
  return rows.map(normalizeEvidence).filter((entry): entry is ExecutionSessionEvidenceRecord => Boolean(entry));
}

export function setExecutionSessionEvidenceStale(id: string, stale: boolean, updatedAt = new Date().toISOString()) {
  db.prepare('UPDATE execution_session_evidence SET stale = ?, updatedAt = ? WHERE id = ?').run(stale ? 1 : 0, updatedAt, id);
  return getExecutionSessionEvidenceById(id);
}

export function replaceExecutionSessionEvidenceStaleness(sessionId: string, states: Array<{ id: string; stale: boolean }>, updatedAt = new Date().toISOString()) {
  return withDbTransaction(() => {
    const statement = db.prepare('UPDATE execution_session_evidence SET stale = ?, updatedAt = ? WHERE id = ? AND sessionId = ?');
    for (const state of states) statement.run(state.stale ? 1 : 0, updatedAt, state.id, sessionId);
    return listExecutionSessionEvidence(sessionId);
  });
}

export function markExpiredExecutionSessionsForTaskWorkspace(taskIdValue: string, workspaceIdValue: string, nowIso: string) {
  const taskId = String(taskIdValue || '').trim();
  const workspaceId = String(workspaceIdValue || '').trim();
  if (!taskId || !workspaceId) return [] as string[];
  const rows = db.prepare(`
    SELECT id FROM execution_sessions
    WHERE taskId = ? AND workspaceId = ? AND status = 'active'
      AND expiresAt IS NOT NULL AND expiresAt <= ?
    ORDER BY updatedAt ASC, id ASC
  `).all(taskId, workspaceId, nowIso) as Array<{ id: string }>;
  if (rows.length === 0) return [] as string[];
  db.prepare(`
    UPDATE execution_sessions
    SET status = 'expired', updatedAt = ?, endedAt = ?
    WHERE taskId = ? AND workspaceId = ? AND status = 'active'
      AND expiresAt IS NOT NULL AND expiresAt <= ?
  `).run(nowIso, nowIso, taskId, workspaceId, nowIso);
  return rows.map((row) => String(row.id));
}

export function markExpiredExecutionSessions(nowIso: string) {
  const result = db.prepare(`
    UPDATE execution_sessions
    SET status = 'expired', updatedAt = ?, endedAt = ?
    WHERE status = 'active' AND expiresAt IS NOT NULL AND expiresAt <= ?
  `).run(nowIso, nowIso, nowIso);
  return Number(result.changes || 0);
}
