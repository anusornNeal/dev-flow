import { getTaskByIdentifier, getTasksByProjectId } from '../repositories/taskRepository.js';
import {
  listExecutionSessionEvidence,
  listExecutionSessionsForTask,
  listExecutionSessionsForWorkspace,
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
  getSessionWorkspaceMetadataForRecovery,
  type SessionWorkspace,
} from './sessionWorkspaceService.js';
import {
  createLifecycleGuardrailAssessment,
  type LifecycleGuardrailIssue,
  type LifecycleGuardrailOperation,
} from './lifecycleGuardrailModel.js';

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
  };
}
