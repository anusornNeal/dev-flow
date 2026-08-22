import { getTaskByIdentifier, getTasksByProjectId } from '../repositories/taskRepository.js';
import {
  listExecutionSessionEvidence,
  listExecutionSessionsForTask,
  listExecutionSessionsForWorkspace,
  queryExecutionSessions,
  type ExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import { createApiError } from './api.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import {
  getExecutionOwnershipState,
  getExecutionSessionOwnershipEpoch,
  getExecutionVerificationBatchState,
  type ExecutionVerificationBatchState,
} from './executionSessionService.js';
import {
  classifySessionWorkspaceTaskMatch,
  findSessionWorkspaceRecoveryCandidatesForTask,
  getSessionWorkspaceMetadataForRecovery,
  type SessionWorkspace,
} from './sessionWorkspaceService.js';
import {
  createLifecycleGuardrailAssessment,
  type LifecycleGuardrailIssue,
  type LifecycleGuardrailOperation,
} from './lifecycleGuardrailModel.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';

/**
 * Read-only lifecycle truth model. It never reconciles, rotates, expires, touches, or writes
 * lifecycle state. Hard blockers represent identity/ownership ambiguity that must fail closed;
 * soft drift represents recoverable projection/workflow divergence. Consumers may project task
 * presentation from this snapshot, but task.status never grants or revokes lifecycle authority.
 */
export const LIFECYCLE_AUTHORITY_VERSION = 'lifecycle-authority.v1' as const;

export type LifecycleAuthorityClassification = 'healthy' | 'projection-drift' | 'recoverable' | 'ambiguous' | 'hard-conflict';
export type LifecycleAuthorityReason = {
  code: string;
  message: string;
  details?: unknown;
};

export type LiveWorkAuthorityClassification =
  | 'live-authoritative'
  | 'live-durable-operation'
  | 'safe-orphan'
  | 'recoverable-wip'
  | 'terminal-history'
  | 'ambiguous-authority'
  | 'invalid-workspace-authority'
  | 'cross-project-conflict';

export type LiveWorkAuthorityIssue = LifecycleAuthorityReason & {
  severity: 'hard' | 'debt' | 'info';
  appliesTo: LifecycleGuardrailOperation[];
};

const AUTHORITY_SAFETY_OPERATIONS: LifecycleGuardrailOperation[] = [
  'mutation', 'verification', 'commit', 'integration', 'finalization', 'status', 'restart', 'cleanup',
];
const PENDING_OPERATION_SAFETY_OPERATIONS: LifecycleGuardrailOperation[] = [
  'mutation', 'commit', 'integration', 'finalization', 'status', 'restart', 'cleanup',
];

function authorityHardBlocker(entry: LifecycleAuthorityReason): LifecycleGuardrailIssue {
  return { ...entry, category: 'ownership', appliesTo: AUTHORITY_SAFETY_OPERATIONS };
}

function authorityWarning(entry: LifecycleAuthorityReason): LifecycleGuardrailIssue {
  return {
    ...entry,
    category: entry.code.includes('STATUS') || entry.code.includes('DONE') ? 'workflow' : 'metadata',
  };
}

function verificationDebt(code: string, message: string, details?: unknown): LifecycleGuardrailIssue {
  return { code, category: 'verification', message, ...(details === undefined ? {} : { details }) };
}


function clean(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function activeClaim(task: any, nowMs: number) {
  const claim = task?.claim;
  const workspaceId = clean(claim?.workspaceId);
  const ownershipEpochId = clean(claim?.ownershipEpochId);
  const expiresAt = clean(claim?.expiresAt);
  const expiresAtMs = Date.parse(expiresAt);
  const active = Boolean(workspaceId && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs);
  return {
    present: Boolean(claim && workspaceId),
    active,
    expired: Boolean(claim && workspaceId && Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs),
    workspaceId: workspaceId || null,
    ownershipEpochId: ownershipEpochId || null,
    ownerKind: clean(claim?.ownerKind) || null,
    ownerLabel: clean(claim?.ownerLabel) || null,
    expiresAt: expiresAt || null,
  };
}

function activeSessionsForTask(taskId: string) {
  return listExecutionSessionsForTask(taskId).filter((entry) => entry.status === 'active');
}

function compactExecution(session: ExecutionSessionRecord | null) {
  if (!session) return null;
  return {
    id: session.id,
    projectId: session.projectId,
    taskId: session.taskId,
    workspaceId: session.workspaceId,
    status: session.status,
    lifecycleStage: session.lifecycle.stage,
    repoRevision: session.repoRevision,
    contextHandle: session.contextHandle,
    ownershipEpochId: getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId,
  };
}

function latestVerificationCandidate(sessionId: string) {
  const evidence = listExecutionSessionEvidence(sessionId)
    .filter((entry) => entry.kind === 'verification-binding' && !clean(entry.metadata?.invalidatedAt));
  const latest = evidence.at(-1);
  if (!latest) return null;
  const candidateId = clean(latest.metadata?.candidateId);
  const repoRevision = clean(latest.metadata?.candidateRepoRevision);
  const executionKey = clean(latest.metadata?.executionKey);
  if (!candidateId || !repoRevision || !executionKey) return null;
  return { candidateId, repoRevision, executionKey };
}

function pendingOperationsForSession(sessionId: string | null) {
  if (!sessionId) return [] as Array<{ operationId: string; evidenceId: string; kind: string; status: string }>;
  const checkpoint = getLatestExecutionCheckpoint(sessionId);
  return (checkpoint?.pendingOperations || [])
    .filter((entry) => entry.status === 'accepted' || entry.status === 'running')
    .map((entry) => ({
      operationId: String(entry.operationId),
      evidenceId: String(entry.evidenceId),
      kind: String(entry.kind),
      status: String(entry.status),
    }));
}

const LIVE_WORK_OPERATIONS: LifecycleGuardrailOperation[] = [
  'mutation', 'verification', 'commit', 'integration', 'finalization', 'status', 'restart', 'cleanup',
];
const LIVE_WORK_CONFLICTING_OPERATIONS: LifecycleGuardrailOperation[] = [
  'mutation', 'commit', 'integration', 'finalization', 'status', 'restart', 'cleanup',
];

function liveWorkIssue(
  code: string,
  severity: LiveWorkAuthorityIssue['severity'],
  message: string,
  appliesTo: LifecycleGuardrailOperation[],
  details?: unknown,
): LiveWorkAuthorityIssue {
  return { code, severity, message, appliesTo, ...(details === undefined ? {} : { details }) };
}

function liveWorkOperationProjection(issues: LiveWorkAuthorityIssue[]) {
  return Object.fromEntries(LIVE_WORK_OPERATIONS.map((operation) => {
    const relevant = issues.filter((issue) => issue.appliesTo.includes(operation));
    return [operation, {
      hardBlocked: relevant.some((issue) => issue.severity === 'hard'),
      debt: relevant.some((issue) => issue.severity === 'debt'),
      reasonCodes: [...new Set(relevant.map((issue) => issue.code))],
    }];
  })) as Record<LifecycleGuardrailOperation, { hardBlocked: boolean; debt: boolean; reasonCodes: string[] }>;
}

export function classifyLifecycleLiveWorkAuthority(
  taskIdValue: string,
  options: {
    workspaceId?: string;
    now?: Date;
    workspaceInspections?: ReadonlyMap<string, ReturnType<typeof inspectWorkspaceRecovery>>;
    deferWorkspaceInspection?: boolean;
  } = {},
) {
  const task = getTaskByIdentifier(String(taskIdValue || '').trim(), 'full');
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskIdValue}' was not found.`, { affectedId: taskIdValue });
  const now = options.now || new Date();
  const claim = activeClaim(task, now.getTime());
  const executionPage = queryExecutionSessions({ taskId: task.id, limit: 100 });
  const executions = executionPage.sessions;
  const activeExecutions = executions.filter((entry) => entry.status === 'active');
  const pendingOperations = executions.flatMap((session) => pendingOperationsForSession(session.id).map((operation) => ({
    ...operation,
    executionSessionId: session.id,
    executionStatus: session.status,
    workspaceId: session.workspaceId,
  })));
  const issues: LiveWorkAuthorityIssue[] = [];
  const candidateWorkspaceIds = new Set<string>();
  const explicitWorkspaceId = clean(options.workspaceId);
  if (explicitWorkspaceId) candidateWorkspaceIds.add(explicitWorkspaceId);
  if (claim.active && claim.workspaceId) candidateWorkspaceIds.add(claim.workspaceId);
  for (const session of activeExecutions) if (clean(session.workspaceId)) candidateWorkspaceIds.add(clean(session.workspaceId));
  for (const operation of pendingOperations) if (clean(operation.workspaceId)) candidateWorkspaceIds.add(clean(operation.workspaceId));

  if (candidateWorkspaceIds.size === 0) {
    const discovery = findSessionWorkspaceRecoveryCandidatesForTask(task.projectId, task.displayId || task.id, 50);
    if (discovery.truncated) {
      issues.push(liveWorkIssue('TASK_WORKSPACE_DISCOVERY_TRUNCATED', 'hard', 'Bounded workspace discovery cannot prove a unique task recovery authority.', LIVE_WORK_OPERATIONS, {
        visibleWorkspaceIds: discovery.workspaces.map((entry) => entry.workspaceId).slice(0, 20),
      }));
    } else if (discovery.exactMatches.length > 1) {
      issues.push(liveWorkIssue('MULTIPLE_EXACT_TASK_WORKSPACES', 'hard', 'More than one exact managed workspace matches the task.', LIVE_WORK_OPERATIONS, {
        workspaceIds: discovery.exactMatches.map((entry) => entry.workspaceId).slice(0, 20),
      }));
    } else if (discovery.exactMatches.length === 1) {
      candidateWorkspaceIds.add(discovery.exactMatches[0].workspaceId);
    } else if (discovery.legacyMatches.length > 0) {
      issues.push(liveWorkIssue('LEGACY_TASK_WORKSPACE_IDENTITY_AMBIGUOUS', 'hard', 'Only legacy-compatible workspace identity is available for the task.', LIVE_WORK_OPERATIONS, {
        workspaceIds: discovery.legacyMatches.map((entry) => entry.workspaceId).slice(0, 20),
      }));
    }
  }

  if (executionPage.truncated) {
    issues.push(liveWorkIssue('TASK_EXECUTION_SCAN_TRUNCATED', 'hard', 'The bounded execution scan cannot prove unique task authority.', LIVE_WORK_OPERATIONS, {
      total: executionPage.total,
      visible: executions.length,
    }));
  }
  if (activeExecutions.length > 1) {
    issues.push(liveWorkIssue('MULTIPLE_ACTIVE_EXECUTIONS', 'hard', 'More than one active execution exists for the task.', LIVE_WORK_OPERATIONS, {
      executionSessionIds: activeExecutions.map((entry) => entry.id).slice(0, 20),
    }));
  }
  const activeWorkspaceIds = [...new Set(activeExecutions.map((entry) => clean(entry.workspaceId)).filter(Boolean))];
  if (activeWorkspaceIds.length > 1) {
    issues.push(liveWorkIssue('TASK_ACTIVE_ACROSS_WORKSPACES', 'hard', 'Active task executions span more than one managed workspace.', LIVE_WORK_OPERATIONS, {
      workspaceIds: activeWorkspaceIds.slice(0, 20),
    }));
  }
  const foreignProjectExecutions = executions.filter((entry) => entry.projectId !== task.projectId);
  if (foreignProjectExecutions.length > 0) {
    issues.push(liveWorkIssue('EXECUTION_PROJECT_IDENTITY_CONFLICT', 'hard', 'Execution rows for the task carry a foreign project identity.', LIVE_WORK_OPERATIONS, {
      executionSessionIds: foreignProjectExecutions.map((entry) => entry.id).slice(0, 20),
      projectIds: [...new Set(foreignProjectExecutions.map((entry) => entry.projectId))].slice(0, 20),
    }));
  }

  const workspaceEvidence = [...candidateWorkspaceIds].slice(0, 20).map((workspaceId) => {
    const metadata = workspaceForAuthority(workspaceId);
    const inspectionDeferred = options.deferWorkspaceInspection === true && !options.workspaceInspections?.has(workspaceId);
    let inspection: ReturnType<typeof inspectWorkspaceRecovery> | null = options.workspaceInspections?.get(workspaceId) || null;
    if (!inspection && !inspectionDeferred) {
      try { inspection = inspectWorkspaceRecovery(workspaceId); } catch { inspection = null; }
    }
    if (!metadata || (!inspectionDeferred && (!inspection || inspection.disposition === 'stale-registry'))) {
      issues.push(liveWorkIssue('WORKSPACE_AUTHORITY_INVALID', 'hard', 'Managed workspace authority cannot be proven from durable metadata and Git identity.', LIVE_WORK_OPERATIONS, {
        workspaceId,
        reason: inspection?.reason || (inspectionDeferred ? 'inspection-deferred' : 'metadata-or-inspection-unavailable'),
      }));
    } else {
      if (inspectionDeferred) {
        issues.push(liveWorkIssue('WORKSPACE_RECOVERY_INSPECTION_DEFERRED', 'hard', 'Git-backed recovery inspection was deferred; destructive cleanup remains fenced until exact workspace inspection.', ['cleanup'], { workspaceId }));
      }
      if (metadata.projectId !== task.projectId) {
        issues.push(liveWorkIssue('WORKSPACE_PROJECT_MISMATCH', 'hard', 'Managed workspace belongs to another project.', LIVE_WORK_OPERATIONS, {
          workspaceId,
          taskProjectId: task.projectId,
          workspaceProjectId: metadata.projectId,
        }));
      }
      const match = classifySessionWorkspaceTaskMatch(metadata, task.projectId, task.displayId);
      if (match === 'incompatible') {
        issues.push(liveWorkIssue('WORKSPACE_TASK_IDENTITY_MISMATCH', 'hard', 'Managed workspace identity does not match the task.', LIVE_WORK_OPERATIONS, {
          workspaceId,
          taskDisplayId: task.displayId,
        }));
      } else if (match === 'legacy-compatible') {
        issues.push(liveWorkIssue('WORKSPACE_LEGACY_TASK_IDENTITY', 'debt', 'Managed workspace identity is legacy-compatible rather than exact.', ['mutation', 'commit', 'integration', 'finalization', 'status', 'cleanup'], { workspaceId }));
      }
      const workspaceExecutions = queryExecutionSessions({ workspaceId, status: 'active', limit: 100 });
      const foreignTaskExecutions = workspaceExecutions.sessions.filter((entry) => entry.taskId && entry.taskId !== task.id);
      if (workspaceExecutions.truncated || workspaceExecutions.sessions.length > 1) {
        issues.push(liveWorkIssue('MULTIPLE_ACTIVE_EXECUTIONS_FOR_WORKSPACE', 'hard', 'Managed workspace has multiple active execution rows.', LIVE_WORK_OPERATIONS, {
          workspaceId,
          executionSessionIds: workspaceExecutions.sessions.map((entry) => entry.id).slice(0, 20),
        }));
      }
      if (foreignTaskExecutions.length > 0) {
        issues.push(liveWorkIssue('WORKSPACE_ACTIVE_TASK_CONFLICT', 'hard', 'Managed workspace has active execution authority for another task.', LIVE_WORK_OPERATIONS, {
          workspaceId,
          executionSessionIds: foreignTaskExecutions.map((entry) => entry.id).slice(0, 20),
        }));
      }
    }
    return {
      workspaceId,
      found: Boolean(metadata),
      projectId: metadata?.projectId || null,
      taskDisplayId: metadata?.taskDisplayId || null,
      state: metadata?.state || null,
      disposition: inspection?.disposition || null,
      inspectionDeferred,
      reason: inspection?.reason || null,
      dirtyFiles: inspection?.dirtyFiles.slice(0, 20) || [],
      uniqueCommits: inspection?.uniqueCommits.slice(0, 20) || [],
    };
  });

  const uniqueActive = activeExecutions.length === 1 ? activeExecutions[0] : null;
  if (claim.active && !uniqueActive) {
    issues.push(liveWorkIssue('ACTIVE_CLAIM_MISSING_EXECUTION', 'hard', 'A live claim exists without one matching active execution.', LIVE_WORK_CONFLICTING_OPERATIONS, {
      workspaceId: claim.workspaceId,
      ownershipEpochId: claim.ownershipEpochId,
    }));
  }
  if (claim.active && uniqueActive) {
    const executionEpoch = getExecutionSessionOwnershipEpoch(uniqueActive.id).ownershipEpochId;
    if (uniqueActive.workspaceId !== claim.workspaceId) {
      issues.push(liveWorkIssue('CLAIM_EXECUTION_WORKSPACE_MISMATCH', 'hard', 'Live claim and execution point at different workspaces.', LIVE_WORK_OPERATIONS, {
        claimWorkspaceId: claim.workspaceId,
        executionWorkspaceId: uniqueActive.workspaceId,
        executionSessionId: uniqueActive.id,
      }));
    }
    if (!claim.ownershipEpochId || !executionEpoch || claim.ownershipEpochId !== executionEpoch) {
      issues.push(liveWorkIssue('OWNERSHIP_EPOCH_MISMATCH', 'hard', 'Live claim and execution do not share one authoritative ownership epoch.', LIVE_WORK_OPERATIONS, {
        claimOwnershipEpochId: claim.ownershipEpochId,
        executionOwnershipEpochId: executionEpoch,
        executionSessionId: uniqueActive.id,
      }));
    }
  }

  if (pendingOperations.length > 0) {
    issues.push(liveWorkIssue('LIVE_DURABLE_OPERATION', 'hard', 'Accepted or running durable work is a live concurrency fence even when claim/execution projection drifted.', LIVE_WORK_CONFLICTING_OPERATIONS, {
      operationIds: pendingOperations.map((entry) => entry.operationId).slice(0, 20),
    }));
  }

  const hasInvalidWorkspace = issues.some((entry) => entry.code === 'WORKSPACE_AUTHORITY_INVALID');
  const hasCrossProjectConflict = issues.some((entry) => entry.code === 'EXECUTION_PROJECT_IDENTITY_CONFLICT' || entry.code === 'WORKSPACE_PROJECT_MISMATCH' || entry.code === 'WORKSPACE_ACTIVE_TASK_CONFLICT' || entry.code === 'WORKSPACE_TASK_IDENTITY_MISMATCH');
  const hasAmbiguity = issues.some((entry) => [
    'TASK_EXECUTION_SCAN_TRUNCATED', 'MULTIPLE_ACTIVE_EXECUTIONS', 'TASK_ACTIVE_ACROSS_WORKSPACES', 'MULTIPLE_ACTIVE_EXECUTIONS_FOR_WORKSPACE',
    'MULTIPLE_EXACT_TASK_WORKSPACES', 'LEGACY_TASK_WORKSPACE_IDENTITY_AMBIGUOUS', 'ACTIVE_CLAIM_MISSING_EXECUTION',
    'CLAIM_EXECUTION_WORKSPACE_MISMATCH', 'OWNERSHIP_EPOCH_MISMATCH',
  ].includes(entry.code));
  const recoverableWorkspace = workspaceEvidence.find((entry) => entry.disposition === 'needs-recovery' || entry.disposition === 'committed-not-integrated' || entry.state === 'integration-required');
  const liveClaimExecution = Boolean(
    claim.active
    && uniqueActive
    && uniqueActive.workspaceId === claim.workspaceId
    && claim.ownershipEpochId
    && getExecutionSessionOwnershipEpoch(uniqueActive.id).ownershipEpochId === claim.ownershipEpochId,
  );

  let classification: LiveWorkAuthorityClassification;
  if (hasCrossProjectConflict) classification = 'cross-project-conflict';
  else if (hasInvalidWorkspace) classification = 'invalid-workspace-authority';
  else if (hasAmbiguity) classification = 'ambiguous-authority';
  else if (pendingOperations.length > 0) classification = 'live-durable-operation';
  else if (liveClaimExecution) classification = 'live-authoritative';
  else if (recoverableWorkspace) classification = 'recoverable-wip';
  else if (activeExecutions.length > 0) classification = 'safe-orphan';
  else classification = 'terminal-history';

  if (classification === 'live-authoritative') {
    issues.push(liveWorkIssue('LIVE_AUTHORITATIVE_WORK', 'hard', 'A live claim and execution share one authoritative workspace and ownership epoch.', ['restart', 'cleanup'], {
      executionSessionId: uniqueActive?.id,
      workspaceId: claim.workspaceId,
    }));
  } else if (classification === 'safe-orphan') {
    issues.push(liveWorkIssue('SAFE_ORPHAN_EXECUTION', 'debt', 'An active execution row remains without live claim or durable operation authority.', ['status', 'restart', 'cleanup'], {
      executionSessionIds: activeExecutions.map((entry) => entry.id).slice(0, 20),
    }));
  } else if (classification === 'recoverable-wip') {
    issues.push(liveWorkIssue('RECOVERABLE_WIP_REQUIRES_RECOVERY', 'debt', 'Task-compatible workspace WIP remains without live claim authority and must be preserved for recovery.', ['mutation', 'commit', 'integration', 'finalization', 'status'], {
      workspaceId: recoverableWorkspace?.workspaceId,
      disposition: recoverableWorkspace?.disposition,
      dirtyFiles: recoverableWorkspace?.dirtyFiles,
    }));
    issues.push(liveWorkIssue('RECOVERABLE_WIP_CLEANUP_FENCE', 'hard', 'Recoverable workspace WIP must not be destructively cleaned before explicit recovery.', ['cleanup'], {
      workspaceId: recoverableWorkspace?.workspaceId,
    }));
  }

  const boundedIssues = issues.slice(0, 50);
  return {
    version: 'live-work-authority.v1' as const,
    generatedAt: now.toISOString(),
    classification,
    task: { id: task.id, displayId: task.displayId, projectId: task.projectId, status: task.status },
    claim,
    execution: {
      total: executionPage.total,
      truncated: executionPage.truncated,
      activeSessionIds: activeExecutions.map((entry) => entry.id).slice(0, 20),
      activeWorkspaceIds: activeWorkspaceIds.slice(0, 20),
    },
    durableOperations: {
      count: pendingOperations.length,
      operationIds: pendingOperations.map((entry) => entry.operationId).slice(0, 20),
      executionSessionIds: [...new Set(pendingOperations.map((entry) => entry.executionSessionId))].slice(0, 20),
    },
    workspaces: workspaceEvidence,
    reasons: boundedIssues,
    hardReasonCodes: [...new Set(boundedIssues.filter((entry) => entry.severity === 'hard').map((entry) => entry.code))],
    debtReasonCodes: [...new Set(boundedIssues.filter((entry) => entry.severity === 'debt').map((entry) => entry.code))],
    operations: liveWorkOperationProjection(boundedIssues),
  };
}

function childProjection(task: any, nowMs: number) {
  const children = getTasksByProjectId(task.projectId).filter((candidate) => candidate.parentId === task.id);
  const activeChildren = children.filter((candidate) => {
    if (activeClaim(candidate, nowMs).active) return true;
    return activeSessionsForTask(candidate.id).length > 0;
  });
  return {
    childCount: children.length,
    activeChildCount: activeChildren.length,
    activeChildIds: activeChildren.map((candidate) => candidate.id).sort(),
    valid: activeChildren.length > 0 && !task.claim && activeSessionsForTask(task.id).length === 0,
  };
}

function workspaceForAuthority(workspaceId: string | null) {
  if (!workspaceId) return null;
  return getSessionWorkspaceMetadataForRecovery(workspaceId);
}

function verificationAuthority(
  current: ExecutionSessionRecord | null,
  workspace: SessionWorkspace | null,
): {
  batch: ExecutionVerificationBatchState | null;
  fresh: boolean | null;
  authoritative: boolean;
  ownedFingerprint: string | null;
  ownedChanges: string[];
  unrelatedChanges: string[];
  candidate: ReturnType<typeof latestVerificationCandidate>;
  errorCode: string | null;
} {
  if (!current) {
    return { batch: null, fresh: null, authoritative: false, ownedFingerprint: null, ownedChanges: [], unrelatedChanges: [], candidate: null, errorCode: null };
  }
  const batch = getExecutionVerificationBatchState(current.id);
  if (!workspace?.root) {
    return { batch, fresh: null, authoritative: false, ownedFingerprint: null, ownedChanges: [], unrelatedChanges: [], candidate: latestVerificationCandidate(current.id), errorCode: 'WORKSPACE_ROOT_UNAVAILABLE' };
  }
  try {
    const ownership = getExecutionOwnershipState(current.id, { repoRoot: workspace.root });
    return {
      batch,
      fresh: ownership.verificationFresh,
      authoritative: ownership.verificationFresh === true && (!batch || batch.status === 'complete'),
      ownedFingerprint: ownership.ownedFingerprint,
      ownedChanges: ownership.ownedChanges,
      unrelatedChanges: ownership.unrelatedChanges,
      candidate: latestVerificationCandidate(current.id),
      errorCode: null,
    };
  } catch (error: any) {
    return {
      batch,
      fresh: null,
      authoritative: false,
      ownedFingerprint: null,
      ownedChanges: [],
      unrelatedChanges: [],
      candidate: latestVerificationCandidate(current.id),
      errorCode: clean(error?.code) || 'EXECUTION_OWNERSHIP_UNAVAILABLE',
    };
  }
}

export function computeLifecycleAuthoritySnapshot(
  taskIdValue: string,
  options: { workspaceId?: string; now?: Date } = {},
) {
  const task = getTaskByIdentifier(String(taskIdValue || '').trim(), 'full');
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskIdValue}' was not found.`, { affectedId: taskIdValue });
  const now = options.now || new Date();
  const nowMs = now.getTime();
  const claim = activeClaim(task, nowMs);
  const activeExecutions = activeSessionsForTask(task.id);
  const activeSessionIds = activeExecutions.map((entry) => entry.id).sort();
  const activeWorkspaceIds = [...new Set(activeExecutions.map((entry) => clean(entry.workspaceId)).filter(Boolean))].sort();
  const selectedWorkspaceId = clean(options.workspaceId)
    || (claim.active ? clean(claim.workspaceId) : '')
    || (activeWorkspaceIds.length === 1 ? activeWorkspaceIds[0] : '');
  const workspace = workspaceForAuthority(selectedWorkspaceId || null);
  const workspaceActiveSessions = selectedWorkspaceId
    ? listExecutionSessionsForWorkspace(selectedWorkspaceId).filter((entry) => entry.status === 'active')
    : [];
  const foreignWorkspaceExecutions = workspaceActiveSessions.filter((entry) => entry.taskId && entry.taskId !== task.id);
  const hardBlockers: LifecycleAuthorityReason[] = [];
  const softDrift: LifecycleAuthorityReason[] = [];
  const info: LifecycleAuthorityReason[] = [];
  const uniqueExecution = activeExecutions.length === 1 ? activeExecutions[0] : null;

  if (activeExecutions.length > 1) {
    hardBlockers.push({
      code: 'MULTIPLE_ACTIVE_EXECUTIONS',
      message: 'More than one active execution exists for the task; DevFlow cannot select a current authority by timestamp.',
      details: { executionSessionIds: activeSessionIds, workspaceIds: activeWorkspaceIds },
    });
  }
  if (activeWorkspaceIds.length > 1) {
    hardBlockers.push({
      code: 'TASK_ACTIVE_ACROSS_WORKSPACES',
      message: 'The task has active execution ownership across more than one workspace.',
      details: { workspaceIds: activeWorkspaceIds, executionSessionIds: activeSessionIds },
    });
  }
  if (foreignWorkspaceExecutions.length > 0) {
    hardBlockers.push({
      code: 'WORKSPACE_ACTIVE_TASK_CONFLICT',
      message: 'The selected workspace has active execution ownership for another task.',
      details: { workspaceId: selectedWorkspaceId, executionSessionIds: foreignWorkspaceExecutions.map((entry) => entry.id) },
    });
  }
  if (selectedWorkspaceId && claim.active && claim.workspaceId !== selectedWorkspaceId) {
    hardBlockers.push({
      code: 'SELECTED_WORKSPACE_CLAIM_MISMATCH',
      message: 'The selected workspace does not match the active claim workspace.',
      details: { selectedWorkspaceId, claimWorkspaceId: claim.workspaceId },
    });
  }
  if (selectedWorkspaceId && uniqueExecution && uniqueExecution.workspaceId !== selectedWorkspaceId) {
    hardBlockers.push({
      code: 'SELECTED_WORKSPACE_EXECUTION_MISMATCH',
      message: 'The selected workspace does not match the unique active execution workspace.',
      details: { selectedWorkspaceId, executionWorkspaceId: uniqueExecution.workspaceId, executionSessionId: uniqueExecution.id },
    });
  }
  if (workspace && workspace.projectId !== task.projectId) {
    hardBlockers.push({
      code: 'WORKSPACE_PROJECT_MISMATCH',
      message: 'The selected workspace belongs to another project.',
      details: { taskProjectId: task.projectId, workspaceProjectId: workspace.projectId, workspaceId: selectedWorkspaceId },
    });
  }
  const workspaceTaskMatch = workspace ? classifySessionWorkspaceTaskMatch(workspace, task.projectId, task.displayId) : null;
  if (workspace) {
    if (workspaceTaskMatch === 'incompatible') {
      hardBlockers.push({
        code: 'WORKSPACE_TASK_IDENTITY_MISMATCH',
        message: 'The selected workspace does not match the task identity.',
        details: { workspaceId: selectedWorkspaceId, taskDisplayId: task.displayId },
      });
    } else if (workspaceTaskMatch === 'legacy-compatible') {
      softDrift.push({
        code: 'WORKSPACE_LEGACY_TASK_IDENTITY',
        message: 'The workspace is only legacy-compatible with the task identity.',
        details: { workspaceId: selectedWorkspaceId },
      });
    }
  } else if (selectedWorkspaceId) {
    hardBlockers.push({
      code: 'WORKSPACE_METADATA_MISSING',
      message: 'The authoritative task/execution points at workspace metadata that cannot be read, so workspace identity cannot be proven.',
      details: { workspaceId: selectedWorkspaceId },
    });
  }

  if (claim.active && uniqueExecution && claim.workspaceId !== uniqueExecution.workspaceId) {
    hardBlockers.push({
      code: 'CLAIM_EXECUTION_WORKSPACE_MISMATCH',
      message: 'The active claim and active execution point at different workspaces.',
      details: { claimWorkspaceId: claim.workspaceId, executionWorkspaceId: uniqueExecution.workspaceId, executionSessionId: uniqueExecution.id },
    });
  }
  if (claim.active && uniqueExecution) {
    const executionEpoch = getExecutionSessionOwnershipEpoch(uniqueExecution.id).ownershipEpochId;
    if (!claim.ownershipEpochId) {
      softDrift.push({ code: 'LEGACY_CLAIM_OWNERSHIP_EPOCH_MISSING', message: 'The active claim has no durable ownership epoch.' });
    } else if (executionEpoch !== claim.ownershipEpochId) {
      hardBlockers.push({
        code: 'OWNERSHIP_EPOCH_MISMATCH',
        message: 'The active claim and execution are bound to different ownership epochs.',
        details: { claimOwnershipEpochId: claim.ownershipEpochId, executionOwnershipEpochId: executionEpoch, executionSessionId: uniqueExecution.id },
      });
    }
  }

  const uniqueExecutionEpoch = uniqueExecution ? getExecutionSessionOwnershipEpoch(uniqueExecution.id).ownershipEpochId : null;
  const current = hardBlockers.length === 0 && uniqueExecution ? uniqueExecution : null;
  if (claim.active && activeExecutions.length === 0) {
    softDrift.push({
      code: 'ACTIVE_CLAIM_MISSING_EXECUTION',
      message: 'An active claim exists without a matching active execution.',
      details: { workspaceId: claim.workspaceId, ownershipEpochId: claim.ownershipEpochId },
    });
  }
  if (!claim.active && activeExecutions.length > 0) {
    softDrift.push({
      code: 'ORPHAN_ACTIVE_EXECUTION',
      message: 'Active execution ownership exists without a currently active claim.',
      details: { executionSessionIds: activeSessionIds },
    });
  }

  const pendingOperations = pendingOperationsForSession(current?.id || null);
  if (pendingOperations.length > 0) {
    softDrift.push({
      code: 'TASK_PENDING_OPERATIONS',
      message: 'The current execution has unresolved durable operations.',
      details: { operationIds: pendingOperations.map((entry) => entry.operationId) },
    });
  }
  if (task.status === 'done' && activeExecutions.length > 0) {
    softDrift.push({
      code: 'TASK_DONE_WITH_LIVE_EXECUTION',
      message: 'Task presentation is done while execution ownership remains active.',
      details: { executionSessionIds: activeSessionIds },
    });
  }

  const parentProjection = childProjection(task, nowMs);
  const expectedStatus = parentProjection.valid
    ? 'in-progress'
    : claim.active || activeExecutions.length > 0
      ? 'in-progress'
      : task.status;
  if (parentProjection.valid) {
    info.push({
      code: 'PARENT_ACTIVE_CHILD_PROJECTION',
      message: 'The parent is validly projected in-progress by active child ownership without owning a parent execution.',
      details: { activeChildIds: parentProjection.activeChildIds },
    });
  } else if (expectedStatus !== task.status && task.status !== 'done') {
    softDrift.push({
      code: 'TASK_STATUS_PROJECTION_DRIFT',
      message: `Task presentation status '${task.status}' differs from lifecycle authority projection '${expectedStatus}'.`,
      details: { currentStatus: task.status, expectedStatus },
    });
  }

  const verification = verificationAuthority(current, workspace);
  if (verification.batch?.status === 'pending') {
    softDrift.push({
      code: 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE',
      message: 'Sequential verification is incomplete for the current execution authority.',
      details: { batchId: verification.batch.batchId, pending: verification.batch.pending },
    });
  } else if (verification.batch?.status === 'failed') {
    softDrift.push({
      code: 'EXECUTION_VERIFICATION_BATCH_FAILED',
      message: 'Sequential verification contains a failed required check.',
      details: { batchId: verification.batch.batchId, failed: verification.batch.failed },
    });
  } else if (verification.batch?.status === 'stale') {
    softDrift.push({
      code: 'EXECUTION_VERIFICATION_BATCH_STALE',
      message: 'Sequential verification is stale for the current execution authority.',
      details: { batchId: verification.batch.batchId, stale: verification.batch.stale },
    });
  }
  if (verification.errorCode) {
    softDrift.push({ code: verification.errorCode, message: 'Execution ownership/verification could not be read authoritatively from the selected workspace.' });
  }

  const ownsAuthority = Boolean(
    claim.active
    && current
    && hardBlockers.length === 0
    && claim.ownershipEpochId
    && uniqueExecutionEpoch === claim.ownershipEpochId
    && workspace
    && workspaceTaskMatch === 'exact',
  );
  const mutationAuthorized = ownsAuthority && pendingOperations.length === 0;
  const commitReasonCodes: string[] = [];
  if (!ownsAuthority) commitReasonCodes.push('LIFECYCLE_AUTHORITY_NOT_OWNED');
  if (pendingOperations.length > 0) commitReasonCodes.push('TASK_PENDING_OPERATIONS');
  if (verification.errorCode) commitReasonCodes.push(verification.errorCode);
  if (verification.ownedChanges.length === 0) commitReasonCodes.push('TASK_COMMIT_NO_OWNED_CHANGES');
  const commitReady = Boolean(current
    && ownsAuthority
    && pendingOperations.length === 0
    && !verification.errorCode
    && verification.ownedChanges.length > 0
    && commitReasonCodes.length === 0);

  const latestTerminal = listExecutionSessionsForTask(task.id).find((entry) => entry.status !== 'active') || null;
  const safelyTerminal = task.status === 'done'
    && !claim.active
    && activeExecutions.length === 0
    && pendingOperations.length === 0
    && hardBlockers.length === 0;

  let classification: LifecycleAuthorityClassification = 'healthy';
  const guardrailDebts: LifecycleGuardrailIssue[] = [];
  if (verification.batch?.status === 'pending') {
    guardrailDebts.push(verificationDebt('EXECUTION_VERIFICATION_BATCH_INCOMPLETE', 'Sequential verification is incomplete.', {
      batchId: verification.batch.batchId,
      pending: verification.batch.pending,
    }));
  } else if (verification.batch?.status === 'failed') {
    guardrailDebts.push(verificationDebt('EXECUTION_VERIFICATION_BATCH_FAILED', 'Sequential verification contains a failed required check.', {
      batchId: verification.batch.batchId,
      failed: verification.batch.failed,
    }));
  } else if (verification.batch?.status === 'stale') {
    guardrailDebts.push(verificationDebt('EXECUTION_VERIFICATION_BATCH_STALE', 'Sequential verification is stale.', {
      batchId: verification.batch.batchId,
      stale: verification.batch.stale,
    }));
  }
  if (current && verification.fresh === false) {
    guardrailDebts.push(verificationDebt('EXECUTION_VERIFICATION_NOT_FRESH', 'Verification evidence is stale for the current owned content.'));
  } else if (current && verification.fresh === null && !verification.errorCode) {
    guardrailDebts.push(verificationDebt('EXECUTION_VERIFICATION_EVIDENCE_MISSING', 'No current authoritative verification evidence is recorded.'));
  }

  const guardrailHardBlockers: LifecycleGuardrailIssue[] = hardBlockers.map(authorityHardBlocker);
  if (pendingOperations.length > 0) {
    guardrailHardBlockers.push({
      code: 'TASK_PENDING_OPERATIONS',
      category: 'concurrency',
      message: 'A live durable operation may race a conflicting state-changing operation.',
      appliesTo: PENDING_OPERATION_SAFETY_OPERATIONS,
      details: { operationIds: pendingOperations.map((entry) => entry.operationId) },
    });
  }
  if (verification.errorCode) {
    guardrailHardBlockers.push({
      code: verification.errorCode,
      category: 'ownership',
      message: 'Task-owned commit scope cannot be proven from the selected workspace.',
      appliesTo: ['commit'],
    });
  }
  const guardrails = createLifecycleGuardrailAssessment({
    hardBlockers: guardrailHardBlockers,
    debts: guardrailDebts,
    warnings: softDrift
      .filter((entry) => entry.code !== 'TASK_PENDING_OPERATIONS' && !entry.code.startsWith('EXECUTION_VERIFICATION_') && entry.code !== verification.errorCode)
      .map(authorityWarning),
  });


  if (hardBlockers.some((entry) => entry.code === 'MULTIPLE_ACTIVE_EXECUTIONS' || entry.code === 'TASK_ACTIVE_ACROSS_WORKSPACES' || entry.code === 'WORKSPACE_ACTIVE_TASK_CONFLICT')) {
    classification = 'ambiguous';
  } else if (hardBlockers.length > 0) {
    classification = 'hard-conflict';
  } else if (softDrift.length === 1 && softDrift[0].code === 'TASK_STATUS_PROJECTION_DRIFT') {
    classification = 'projection-drift';
  } else if (softDrift.length > 0) {
    classification = 'recoverable';
  }

  return {
    version: LIFECYCLE_AUTHORITY_VERSION,
    generatedAt: now.toISOString(),
    task: {
      id: task.id,
      displayId: task.displayId,
      projectId: task.projectId,
      status: task.status,
      parentId: task.parentId || null,
    },
    presentation: { status: task.status, expectedStatus },
    parentProjection,
    claim,
    workspace: {
      selectedWorkspaceId: selectedWorkspaceId || null,
      found: Boolean(workspace),
      projectId: workspace?.projectId || null,
      taskDisplayId: workspace?.taskDisplayId || null,
      state: workspace?.state || null,
    },
    execution: {
      activeSessionIds,
      activeWorkspaceIds,
      current: compactExecution(current),
      latestTerminal: compactExecution(latestTerminal),
    },
    pending: {
      operations: pendingOperations,
      operationIds: pendingOperations.map((entry) => entry.operationId),
    },
    verification: {
      batch: verification.batch,
      fresh: verification.fresh,
      authoritative: verification.authoritative,
      candidate: verification.candidate,
      ownedFingerprint: verification.ownedFingerprint,
      ownedChanges: verification.ownedChanges,
      unrelatedChanges: verification.unrelatedChanges,
    },
    mutation: {
      authorized: mutationAuthorized,
      ownershipAuthorized: ownsAuthority,
      reasonCodes: [
        ...(hardBlockers.length > 0 ? hardBlockers.map((entry) => entry.code) : []),
        ...(!claim.active ? ['ACTIVE_CLAIM_REQUIRED'] : []),
        ...(!current ? ['CURRENT_EXECUTION_REQUIRED'] : []),
        ...(pendingOperations.length > 0 ? ['TASK_PENDING_OPERATIONS'] : []),
      ],
    },
    commit: {
      ready: commitReady,
      reasonCodes: [...new Set(commitReasonCodes)],
    },
    finalization: {
      taskDone: task.status === 'done',
      latestTerminalExecutionId: latestTerminal?.id || null,
      latestTerminalLifecycleStage: latestTerminal?.lifecycle.stage || null,
      gitEvidencePresent: Boolean(task.gitEvidence),
      gitEvidence: task.gitEvidence ? {
        evidenceSource: task.gitEvidence.evidenceSource || null,
        workspaceId: task.gitEvidence.workspaceId || null,
        branch: task.gitEvidence.branch,
        commit: task.gitEvidence.commit,
        pushed: task.gitEvidence.pushed,
        workingTreeClean: task.gitEvidence.workingTreeClean,
        recordedAt: task.gitEvidence.recordedAt,
      } : null,
      safelyTerminal,
    },
    hardBlockers,
    softDrift,
    guardrails,
    info,
    classification,
    liveWorkAuthority: classifyLifecycleLiveWorkAuthority(task.id, { workspaceId: selectedWorkspaceId || undefined, now }),
  };
}
