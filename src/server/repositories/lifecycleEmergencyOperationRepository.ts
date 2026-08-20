import db from '../../db/index.js';

export type LifecycleEmergencyOperationStatus = 'active' | 'completed' | 'rejected' | 'partial';

export type LifecycleEmergencyOperationRecord = {
  id: string;
  requestDigest: string;
  action: string;
  projectId: string;
  taskId: string;
  workspaceId: string | null;
  executionSessionId: string | null;
  ownershipEpochId: string | null;
  actorLabel: string;
  reason: string;
  status: LifecycleEmergencyOperationStatus;
  request: Record<string, unknown>;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown> | null;
  bypassedGates: string[];
  hardChecks: Array<Record<string, unknown>>;
  evidence: Record<string, unknown>;
  wipDisposition: string;
  result: Record<string, unknown> | null;
  failure: Record<string, unknown> | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

function parseObject(value: unknown, fallback: Record<string, unknown> | null = null) {
  if (value == null || value === '') return fallback;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : fallback;
  } catch {
    return fallback;
  }
}

function parseArray(value: unknown) {
  if (value == null || value === '') return [] as unknown[];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [] as unknown[];
  }
}

function normalize(row: any): LifecycleEmergencyOperationRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    requestDigest: String(row.requestDigest),
    action: String(row.action),
    projectId: String(row.projectId),
    taskId: String(row.taskId),
    workspaceId: row.workspaceId == null ? null : String(row.workspaceId),
    executionSessionId: row.executionSessionId == null ? null : String(row.executionSessionId),
    ownershipEpochId: row.ownershipEpochId == null ? null : String(row.ownershipEpochId),
    actorLabel: String(row.actorLabel),
    reason: String(row.reason),
    status: row.status as LifecycleEmergencyOperationStatus,
    request: parseObject(row.requestJson, {}) || {},
    beforeSnapshot: parseObject(row.beforeSnapshotJson),
    afterSnapshot: parseObject(row.afterSnapshotJson),
    bypassedGates: parseArray(row.bypassedGatesJson).map(String),
    hardChecks: parseArray(row.hardChecksJson).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as Array<Record<string, unknown>>,
    evidence: parseObject(row.evidenceJson, {}) || {},
    wipDisposition: String(row.wipDisposition || 'preserved'),
    result: parseObject(row.resultJson),
    failure: parseObject(row.failureJson),
    retryCount: Number(row.retryCount || 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    completedAt: row.completedAt == null ? null : String(row.completedAt),
  };
}

export function getLifecycleEmergencyOperation(id: string) {
  return normalize(db.prepare('SELECT * FROM lifecycle_emergency_operations WHERE id = ?').get(id));
}

export function listLifecycleEmergencyOperations(args: { projectId?: string; taskId?: string; status?: LifecycleEmergencyOperationStatus; limit?: number } = {}) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (args.projectId) { clauses.push('projectId = ?'); values.push(args.projectId); }
  if (args.taskId) { clauses.push('taskId = ?'); values.push(args.taskId); }
  if (args.status) { clauses.push('status = ?'); values.push(args.status); }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit) || 20)));
  return (db.prepare(`SELECT * FROM lifecycle_emergency_operations${where} ORDER BY updatedAt DESC, rowid DESC LIMIT ?`).all(...values, limit) as any[])
    .map(normalize)
    .filter((entry): entry is LifecycleEmergencyOperationRecord => Boolean(entry));
}

export function createLifecycleEmergencyOperation(input: LifecycleEmergencyOperationRecord) {
  db.prepare(`
    INSERT OR IGNORE INTO lifecycle_emergency_operations (
      id, requestDigest, action, projectId, taskId, workspaceId, executionSessionId, ownershipEpochId,
      actorLabel, reason, status, requestJson, beforeSnapshotJson, afterSnapshotJson, bypassedGatesJson,
      hardChecksJson, evidenceJson, wipDisposition, resultJson, failureJson, retryCount, createdAt, updatedAt, completedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id, input.requestDigest, input.action, input.projectId, input.taskId, input.workspaceId,
    input.executionSessionId, input.ownershipEpochId, input.actorLabel, input.reason, input.status,
    JSON.stringify(input.request || {}), input.beforeSnapshot ? JSON.stringify(input.beforeSnapshot) : null,
    input.afterSnapshot ? JSON.stringify(input.afterSnapshot) : null, JSON.stringify(input.bypassedGates || []),
    JSON.stringify(input.hardChecks || []), JSON.stringify(input.evidence || {}), input.wipDisposition,
    input.result ? JSON.stringify(input.result) : null, input.failure ? JSON.stringify(input.failure) : null,
    input.retryCount, input.createdAt, input.updatedAt, input.completedAt,
  );
  return getLifecycleEmergencyOperation(input.id)!;
}

export function updateLifecycleEmergencyOperation(id: string, patch: Partial<Pick<LifecycleEmergencyOperationRecord,
  'status' | 'afterSnapshot' | 'bypassedGates' | 'hardChecks' | 'evidence' | 'wipDisposition' | 'result' | 'failure' | 'retryCount' | 'updatedAt' | 'completedAt'>>) {
  const current = getLifecycleEmergencyOperation(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare(`
    UPDATE lifecycle_emergency_operations SET
      status = ?, afterSnapshotJson = ?, bypassedGatesJson = ?, hardChecksJson = ?, evidenceJson = ?,
      wipDisposition = ?, resultJson = ?, failureJson = ?, retryCount = ?, updatedAt = ?, completedAt = ?
    WHERE id = ?
  `).run(
    next.status,
    next.afterSnapshot ? JSON.stringify(next.afterSnapshot) : null,
    JSON.stringify(next.bypassedGates || []),
    JSON.stringify(next.hardChecks || []),
    JSON.stringify(next.evidence || {}),
    next.wipDisposition,
    next.result ? JSON.stringify(next.result) : null,
    next.failure ? JSON.stringify(next.failure) : null,
    next.retryCount,
    next.updatedAt,
    next.completedAt,
    id,
  );
  return getLifecycleEmergencyOperation(id);
}
