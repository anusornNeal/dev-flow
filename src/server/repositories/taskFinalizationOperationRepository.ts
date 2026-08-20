import db from '../../db/index.js';

export type TaskFinalizationOperationStatus = 'active' | 'blocked' | 'cleanup-pending' | 'completed';
export type TaskFinalizationOperationPhase =
  | 'frozen'
  | 'integrated'
  | 'verification-pending'
  | 'verification-cleared'
  | 'evidence-recorded'
  | 'execution-terminalized'
  | 'task-projected'
  | 'cleanup-pending'
  | 'completed';

export type TaskFinalizationOperationRecord = {
  id: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  executionSessionId: string | null;
  ownershipEpochId: string | null;
  sourceHead: string;
  baseRevision: string;
  baseBranch: string;
  candidateId: string | null;
  candidateRepoRevision: string | null;
  ownedFingerprint: string | null;
  phase: TaskFinalizationOperationPhase;
  status: TaskFinalizationOperationStatus;
  integration: Record<string, unknown> | null;
  verification: Record<string, unknown>;
  gitEvidence: Record<string, unknown> | null;
  cleanup: Record<string, unknown> | null;
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

function normalize(row: any): TaskFinalizationOperationRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    taskId: String(row.taskId),
    workspaceId: String(row.workspaceId),
    executionSessionId: row.executionSessionId == null ? null : String(row.executionSessionId),
    ownershipEpochId: row.ownershipEpochId == null ? null : String(row.ownershipEpochId),
    sourceHead: String(row.sourceHead),
    baseRevision: String(row.baseRevision),
    baseBranch: String(row.baseBranch),
    candidateId: row.candidateId == null ? null : String(row.candidateId),
    candidateRepoRevision: row.candidateRepoRevision == null ? null : String(row.candidateRepoRevision),
    ownedFingerprint: row.ownedFingerprint == null ? null : String(row.ownedFingerprint),
    phase: row.phase as TaskFinalizationOperationPhase,
    status: row.status as TaskFinalizationOperationStatus,
    integration: parseObject(row.integrationJson),
    verification: parseObject(row.verificationJson, {}) || {},
    gitEvidence: parseObject(row.gitEvidenceJson),
    cleanup: parseObject(row.cleanupJson),
    failure: parseObject(row.failureJson),
    retryCount: Number(row.retryCount || 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    completedAt: row.completedAt == null ? null : String(row.completedAt),
  };
}

export function getTaskFinalizationOperation(id: string) {
  return normalize(db.prepare('SELECT * FROM task_finalization_operations WHERE id = ?').get(id));
}

export function getLatestTaskFinalizationOperation(taskId: string, workspaceId?: string) {
  const cleanTaskId = String(taskId || '').trim();
  const cleanWorkspaceId = String(workspaceId || '').trim();
  if (!cleanTaskId) return null;
  const row = cleanWorkspaceId
    ? db.prepare('SELECT * FROM task_finalization_operations WHERE taskId = ? AND workspaceId = ? ORDER BY updatedAt DESC, rowid DESC LIMIT 1').get(cleanTaskId, cleanWorkspaceId)
    : db.prepare('SELECT * FROM task_finalization_operations WHERE taskId = ? ORDER BY updatedAt DESC, rowid DESC LIMIT 1').get(cleanTaskId);
  return normalize(row);
}

export function listTaskFinalizationOperationsForProject(projectId: string, limit = 50) {
  const bounded = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  return (db.prepare('SELECT * FROM task_finalization_operations WHERE projectId = ? ORDER BY updatedAt DESC, rowid DESC LIMIT ?').all(projectId, bounded) as any[])
    .map(normalize)
    .filter((entry): entry is TaskFinalizationOperationRecord => Boolean(entry));
}

export function createTaskFinalizationOperation(input: Omit<TaskFinalizationOperationRecord, 'integration' | 'verification' | 'gitEvidence' | 'cleanup' | 'failure' | 'retryCount' | 'completedAt'> & {
  integration?: Record<string, unknown> | null;
  verification?: Record<string, unknown>;
  gitEvidence?: Record<string, unknown> | null;
  cleanup?: Record<string, unknown> | null;
  failure?: Record<string, unknown> | null;
  retryCount?: number;
  completedAt?: string | null;
}) {
  db.prepare(`
    INSERT OR IGNORE INTO task_finalization_operations (
      id, projectId, taskId, workspaceId, executionSessionId, ownershipEpochId,
      sourceHead, baseRevision, baseBranch, candidateId, candidateRepoRevision, ownedFingerprint,
      phase, status, integrationJson, verificationJson, gitEvidenceJson, cleanupJson,
      failureJson, retryCount, createdAt, updatedAt, completedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.taskId,
    input.workspaceId,
    input.executionSessionId,
    input.ownershipEpochId,
    input.sourceHead,
    input.baseRevision,
    input.baseBranch,
    input.candidateId,
    input.candidateRepoRevision,
    input.ownedFingerprint,
    input.phase,
    input.status,
    input.integration ? JSON.stringify(input.integration) : null,
    JSON.stringify(input.verification || {}),
    input.gitEvidence ? JSON.stringify(input.gitEvidence) : null,
    input.cleanup ? JSON.stringify(input.cleanup) : null,
    input.failure ? JSON.stringify(input.failure) : null,
    input.retryCount || 0,
    input.createdAt,
    input.updatedAt,
    input.completedAt || null,
  );
  return getTaskFinalizationOperation(input.id)!;
}

export function updateTaskFinalizationOperation(
  id: string,
  patch: Partial<Pick<TaskFinalizationOperationRecord,
    'phase' | 'status' | 'integration' | 'verification' | 'gitEvidence' | 'cleanup' | 'failure' | 'retryCount' | 'updatedAt' | 'completedAt'>>,
) {
  const current = getTaskFinalizationOperation(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare(`
    UPDATE task_finalization_operations SET
      phase = ?, status = ?, integrationJson = ?, verificationJson = ?, gitEvidenceJson = ?,
      cleanupJson = ?, failureJson = ?, retryCount = ?, updatedAt = ?, completedAt = ?
    WHERE id = ?
  `).run(
    next.phase,
    next.status,
    next.integration ? JSON.stringify(next.integration) : null,
    JSON.stringify(next.verification || {}),
    next.gitEvidence ? JSON.stringify(next.gitEvidence) : null,
    next.cleanup ? JSON.stringify(next.cleanup) : null,
    next.failure ? JSON.stringify(next.failure) : null,
    next.retryCount,
    next.updatedAt,
    next.completedAt,
    id,
  );
  return getTaskFinalizationOperation(id);
}
