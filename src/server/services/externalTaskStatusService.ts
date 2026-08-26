import crypto from 'node:crypto';
import type { TaskStatus } from '../../types.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import { AGENT_NEUTRAL_ORCHESTRATION_ACTIONS, AGENT_NEUTRAL_RESULT_STATES, type AgentNeutralOrchestrationAction, type AgentNeutralOrchestrationResultState } from '../repositories/agentRunRepository.js';
import { getTaskByIdentifier, saveTask } from '../repositories/taskRepository.js';
import { createApiError } from './api.js';
import { withSyncLock } from './lockAndIdempotencyService.js';

// This service owns board presentation only; managed execution authority remains read-only here.
const EXTERNAL_TARGET_STATUSES = new Set<TaskStatus>(['in-progress', 'ready-for-review', 'done']);
const EXTERNAL_STATUS_LOG_PREFIX = '[external-task-status:v1] ';
export const EXTERNAL_NATIVE_HEARTBEAT_STALE_MS = 30 * 60 * 1000;
const METADATA_LIMITS = {
  summary: 4_000,
  commit: 1_000,
  verification: 8_000,
  idempotencyKey: 512,
  worker: 128,
  contextRef: 1_000,
} as const;

export type ExternalTaskStatusInput = {
  status: TaskStatus;
  summary?: string;
  commit?: string;
  verification?: string;
  worker?: string;
  action?: AgentNeutralOrchestrationAction;
  resultState?: AgentNeutralOrchestrationResultState;
  contextRef?: string;
  idempotencyKey?: string;
  allowManagedAuthorityOverlap?: boolean;
};

export type ExternalTaskStatusWarning = {
  code: 'MANAGED_AUTHORITY_PRESERVED';
  message: string;
  details: {
    activeClaim: boolean;
    executionSessionIds: string[];
  };
};

export type ExternalTaskStatusResult = {
  success: true;
  task: any;
  sourceStatus: TaskStatus;
  targetStatus: TaskStatus;
  changed: boolean;
  replayed: boolean;
  operationId: string;
  warnings: ExternalTaskStatusWarning[];
  externalMetadata: {
    summary?: string;
    commit?: string;
    verification?: string;
    worker?: string;
    action?: AgentNeutralOrchestrationAction;
    resultState?: AgentNeutralOrchestrationResultState;
    contextRef?: string;
  };
};

type ExternalStatusOperationRecord = {
  schema: 'external-task-status.v1';
  operationId: string;
  keyHash?: string;
  requestFingerprint: string;
  sourceStatus: TaskStatus;
  targetStatus: TaskStatus;
  changed: boolean;
  recordedAt: string;
  metadata: ExternalTaskStatusResult['externalMetadata'];
  managedAuthorityOverlap: boolean;
  warnings: ExternalTaskStatusWarning[];
};

type ExternalTaskStatusTestHooks = {
  beforeSave?: (nextTask: any, record: ExternalStatusOperationRecord) => void;
  afterSave?: (savedTask: any, record: ExternalStatusOperationRecord) => void;
};

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeOptionalText(value: unknown, field: keyof typeof METADATA_LIMITS): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw createApiError(400, 'EXTERNAL_STATUS_INVALID_METADATA', `${field} must be a string when supplied.`, { affectedId: field });
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (Buffer.byteLength(normalized, 'utf8') > METADATA_LIMITS[field]) {
    throw createApiError(400, 'EXTERNAL_STATUS_METADATA_TOO_LARGE', `${field} exceeds the ${METADATA_LIMITS[field]} byte limit.`, { affectedId: field });
  }
  return normalized;
}

function normalizeInput(raw: ExternalTaskStatusInput) {
  const status = String(raw?.status || '').trim() as TaskStatus;
  if (!EXTERNAL_TARGET_STATUSES.has(status)) {
    throw createApiError(400, 'EXTERNAL_STATUS_INVALID_TARGET', 'status must be one of: in-progress, ready-for-review, done.', { affectedId: status || undefined });
  }
  if (raw.allowManagedAuthorityOverlap !== undefined && typeof raw.allowManagedAuthorityOverlap !== 'boolean') {
    throw createApiError(400, 'EXTERNAL_STATUS_INVALID_OVERLAP_OVERRIDE', 'allowManagedAuthorityOverlap must be a boolean when supplied.');
  }
  const idempotencyKey = normalizeOptionalText(raw.idempotencyKey, 'idempotencyKey');
  const worker = normalizeOptionalText(raw.worker, 'worker');
  const contextRef = normalizeOptionalText(raw.contextRef, 'contextRef');
  const action = raw.action == null ? undefined : String(raw.action).trim() as AgentNeutralOrchestrationAction;
  const resultState = raw.resultState == null ? undefined : String(raw.resultState).trim() as AgentNeutralOrchestrationResultState;
  if (action && !(AGENT_NEUTRAL_ORCHESTRATION_ACTIONS as readonly string[]).includes(action)) {
    throw createApiError(400, 'EXTERNAL_STATUS_INVALID_ACTION', `action must be one of: ${AGENT_NEUTRAL_ORCHESTRATION_ACTIONS.join(', ')}.`, { affectedId: action });
  }
  if (resultState && !(AGENT_NEUTRAL_RESULT_STATES as readonly string[]).includes(resultState)) {
    throw createApiError(400, 'EXTERNAL_STATUS_INVALID_RESULT_STATE', `resultState must be one of: ${AGENT_NEUTRAL_RESULT_STATES.join(', ')}.`, { affectedId: resultState });
  }
  if (resultState && !action) {
    throw createApiError(400, 'EXTERNAL_STATUS_ACTION_REQUIRED', 'action is required when resultState is supplied.');
  }
  if (resultState === 'COMPLETE' && status === 'in-progress') {
    throw createApiError(400, 'EXTERNAL_STATUS_RESULT_STATUS_MISMATCH', 'COMPLETE must report ready-for-review or done rather than in-progress.');
  }
  if (resultState && resultState !== 'COMPLETE' && status !== 'in-progress') {
    throw createApiError(400, 'EXTERNAL_STATUS_RESULT_STATUS_MISMATCH', `${resultState} must keep board status in-progress so scheduler attention can preserve the unfinished scope.`);
  }
  return {
    status,
    summary: normalizeOptionalText(raw.summary, 'summary'),
    commit: normalizeOptionalText(raw.commit, 'commit'),
    verification: normalizeOptionalText(raw.verification, 'verification'),
    worker,
    action,
    resultState,
    contextRef,
    idempotencyKey,
    allowManagedAuthorityOverlap: raw.allowManagedAuthorityOverlap === true,
  };
}

function activeClaim(task: any, nowMs = Date.now()) {
  const claim = task?.claim;
  if (!claim || typeof claim !== 'object') return false;
  const expiresAt = Date.parse(String(claim.expiresAt || ''));
  return Boolean(claim.sessionIdHash && claim.workspaceId && Number.isFinite(expiresAt) && expiresAt > nowMs);
}

function managedAuthorityFor(task: any) {
  const executionSessionIds = listExecutionSessionsForTask(task.id)
    .filter((session) => session.status === 'active')
    .map((session) => session.id)
    .sort();
  return {
    activeClaim: activeClaim(task),
    executionSessionIds,
    active: activeClaim(task) || executionSessionIds.length > 0,
  };
}

function normalizedFingerprint(taskId: string, input: ReturnType<typeof normalizeInput>) {
  return sha256(JSON.stringify({
    schema: 'external-task-status.v1',
    taskId,
    status: input.status,
    summary: input.summary ?? null,
    commit: input.commit ?? null,
    verification: input.verification ?? null,
    worker: input.worker ?? null,
    action: input.action ?? null,
    resultState: input.resultState ?? null,
    contextRef: input.contextRef ?? null,
    allowManagedAuthorityOverlap: input.allowManagedAuthorityOverlap,
  }));
}

function operationLogId(keyHash?: string) {
  return keyHash ? `external-task-status-op-${keyHash}` : `external-task-status-op-${crypto.randomUUID()}`;
}

function parseOperationRecord(log: any): ExternalStatusOperationRecord | null {
  if (!log || typeof log.message !== 'string' || !log.message.startsWith(EXTERNAL_STATUS_LOG_PREFIX)) return null;
  try {
    const parsed = JSON.parse(log.message.slice(EXTERNAL_STATUS_LOG_PREFIX.length));
    if (!parsed || parsed.schema !== 'external-task-status.v1' || typeof parsed.requestFingerprint !== 'string') return null;
    return parsed as ExternalStatusOperationRecord;
  } catch {
    return null;
  }
}

export function getLatestExternalTaskStatusRecord(task: any): ExternalStatusOperationRecord | null {
  const logs = Array.isArray(task?.logs) ? task.logs : [];
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const record = parseOperationRecord(logs[index]);
    if (record) return record;
  }
  return null;
}

export function isExternalTaskStatusRecordStale(record: Pick<ExternalStatusOperationRecord, 'recordedAt'> | null | undefined, nowMs = Date.now()) {
  if (!record) return true;
  const recordedAtMs = Date.parse(String(record.recordedAt || ''));
  if (!Number.isFinite(recordedAtMs)) return true;
  return nowMs - recordedAtMs > EXTERNAL_NATIVE_HEARTBEAT_STALE_MS;
}

function findReplay(task: any, keyHash: string) {
  const expectedLogId = operationLogId(keyHash);
  const log = (Array.isArray(task?.logs) ? task.logs : []).find((entry: any) => entry?.id === expectedLogId);
  return parseOperationRecord(log);
}

function resultFromRecord(task: any, record: ExternalStatusOperationRecord, replayed: boolean): ExternalTaskStatusResult {
  return {
    success: true,
    task,
    sourceStatus: record.sourceStatus,
    targetStatus: record.targetStatus,
    changed: record.changed,
    replayed,
    operationId: record.operationId,
    warnings: record.warnings || [],
    externalMetadata: record.metadata || {},
  };
}

export function updateExternalTaskStatus(
  taskIdentifier: string,
  rawInput: ExternalTaskStatusInput,
  hooks: ExternalTaskStatusTestHooks = {},
): ExternalTaskStatusResult {
  const identifier = String(taskIdentifier || '').trim();
  if (!identifier) throw createApiError(400, 'EXTERNAL_STATUS_TASK_ID_REQUIRED', 'taskId is required.');
  const input = normalizeInput(rawInput || ({} as ExternalTaskStatusInput));
  const resolvedTask = getTaskByIdentifier(identifier, 'full');
  if (!resolvedTask) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${identifier}' was not found.`, { affectedId: identifier });

  return withSyncLock(`external-task-status:${resolvedTask.id}`, () => {
    const task = getTaskByIdentifier(resolvedTask.id, 'full');
    if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${identifier}' was not found.`, { affectedId: identifier });

    const keyHash = input.idempotencyKey ? sha256(input.idempotencyKey) : undefined;
    const requestFingerprint = normalizedFingerprint(task.id, input);
    if (keyHash) {
      const replay = findReplay(task, keyHash);
      if (replay) {
        if (replay.requestFingerprint !== requestFingerprint) {
          throw createApiError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used for a different external task status request.', { affectedId: task.id });
        }
        return resultFromRecord(task, replay, true);
      }
    }

    const authority = managedAuthorityFor(task);
    if (authority.active && !input.allowManagedAuthorityOverlap) {
      throw createApiError(409, 'EXTERNAL_STATUS_MANAGED_AUTHORITY_CONFLICT', 'The task has active managed DevFlow authority. Retry only with allowManagedAuthorityOverlap=true when a status-only board update is intentionally required.', {
        affectedId: task.id,
        details: { activeClaim: authority.activeClaim, executionSessionIds: authority.executionSessionIds },
      });
    }

    const warnings: ExternalTaskStatusWarning[] = authority.active
      ? [{
        code: 'MANAGED_AUTHORITY_PRESERVED',
        message: 'External status changed only the board presentation/audit metadata; active DevFlow claim/execution authority was preserved unchanged.',
        details: { activeClaim: authority.activeClaim, executionSessionIds: authority.executionSessionIds },
      }]
      : [];
    const sourceStatus = task.status as TaskStatus;
    const targetStatus = input.status;
    const recordedAt = new Date().toISOString();
    const operationId = operationLogId(keyHash);
    const record: ExternalStatusOperationRecord = {
      schema: 'external-task-status.v1',
      operationId,
      ...(keyHash ? { keyHash } : {}),
      requestFingerprint,
      sourceStatus,
      targetStatus,
      changed: sourceStatus !== targetStatus,
      recordedAt,
      metadata: {
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.commit ? { commit: input.commit } : {}),
        ...(input.verification ? { verification: input.verification } : {}),
        ...(input.worker ? { worker: input.worker } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.resultState ? { resultState: input.resultState } : {}),
        ...(input.contextRef ? { contextRef: input.contextRef } : {}),
      },
      managedAuthorityOverlap: authority.active,
      warnings,
    };
    const nextTask = {
      ...task,
      status: targetStatus,
      updatedAt: recordedAt,
      logs: [...(Array.isArray(task.logs) ? task.logs : []), {
        id: operationId,
        timestamp: recordedAt,
        type: 'comment',
        message: `${EXTERNAL_STATUS_LOG_PREFIX}${JSON.stringify(record)}`,
      }],
    };

    hooks.beforeSave?.(nextTask, record);
    saveTask(nextTask);
    hooks.afterSave?.(nextTask, record);
    return resultFromRecord(nextTask, record, false);
  });
}
