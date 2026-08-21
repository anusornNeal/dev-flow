// DVF-0685: commit readiness consumes authoritative reusable verification coverage.
import type { AppState } from '../types.js';
import { getTaskByIdentifier } from '../repositories/taskRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import { createApiError } from './api.js';
import {
  getExecutionOwnershipState,
  getExecutionSessionState,
  getExecutionVerificationBatchState,
  getExecutionVerificationCoverageEvidence,
  recordExecutionReconciliationEvidence,
  recordExecutionSessionEvidence,
  type ExecutionVerificationBatchState,
} from './executionSessionService.js';
import { commitGitChanges } from './gitService.js';
import { renderTaskCommitMessage } from './projectGitWorkflowPolicyService.js';
import { resolveSessionWorkspace } from './sessionWorkspaceService.js';
import { computeLifecycleAuthoritySnapshot } from './lifecycleAuthorityService.js';
import { getProjectCommandExecutionIdentity } from './projectCommandService.js';
import { buildVerificationCoverageIdentity } from './verificationBatchService.js';

export type TaskCommitPlanBlocker = {
  code: string;
  message: string;
  details?: unknown;
};

export type TaskCommitPlan = {
  taskId: string;
  executionSessionId: string;
  workspaceId: string;
  ownedChangedFiles: string[];
  unrelatedChangedFiles: string[];
  scopeDrift: string[];
  ownershipDrift: Array<{ path: string; knownFileRevision: string; currentFileRevision: string }>;
  verifiedOwnershipDrift: Array<{ path: string; knownFileRevision: string; currentFileRevision: string }>;
  verificationFresh: boolean | null;
  verificationState: 'authoritative-fresh' | 'missing' | 'stale';
  verificationRecordedAt: string | null;
  verificationCoverage: {
    status: 'covered' | 'missing' | 'stale';
    reusable: boolean;
    coveredCommands: string[];
    staleCommands: string[];
  };
  commitAllowed: boolean;
  blockers: TaskCommitPlanBlocker[];
};

function requireTaskId(value: unknown) {
  const identifier = String(value || '').trim();
  if (!identifier) throw createApiError(400, 'TASK_ID_REQUIRED', 'taskId is required for a task-aware commit plan.');
  const task = getTaskByIdentifier(identifier, 'full');
  return (task?.id || identifier) as string;
}

function requireWorkspaceId(value: unknown) {
  const workspaceId = String(value || '').trim();
  if (!workspaceId) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'workspaceId is required for a task-aware commit plan.');
  return workspaceId;
}

function resolveVerificationState(verificationFresh: boolean | null): TaskCommitPlan['verificationState'] {
  return verificationFresh === true ? 'authoritative-fresh' : verificationFresh === null ? 'missing' : 'stale';
}

export type TaskVerificationCoverageResolution = {
  status: 'covered' | 'missing' | 'stale';
  policy: string;
  recordedAt: string | null;
  reusable: boolean;
  coveredCommands: string[];
  staleCommands: string[];
  staleDetails: Array<{ command: string; changedFields: string[] }>;
};

export function resolveTaskVerificationCoverage(
  state: AppState,
  input: {
    task: any;
    executionSessionId: string;
    verificationFresh: boolean | null;
    workspaceId?: string;
    localPath?: string;
  },
): TaskVerificationCoverageResolution {
  const evidence = getExecutionVerificationCoverageEvidence(input.executionSessionId);
  if (!evidence) {
    return {
      status: input.verificationFresh === true ? 'covered' as const : 'missing' as const,
      policy: 'legacy',
      recordedAt: null,
      reusable: false,
      coveredCommands: [] as string[],
      staleCommands: [] as string[],
      staleDetails: [],
    };
  }
  if (evidence.policy === 'operator-break-glass') {
    return {
      status: 'missing',
      policy: evidence.policy,
      recordedAt: evidence.recordedAt || null,
      reusable: false,
      coveredCommands: [],
      staleCommands: [],
      staleDetails: [],
    };
  }
  if (evidence.policy === 'no-checks-required') {
    return {
      status: input.verificationFresh === true ? 'covered' as const : 'stale' as const,
      policy: evidence.policy,
      recordedAt: evidence.recordedAt || null,
      reusable: input.verificationFresh === true,
      coveredCommands: [] as string[],
      staleCommands: [] as string[],
      staleDetails: [],
    };
  }
  if (evidence.coverage.length === 0) {
    return {
      status: input.verificationFresh === true ? 'covered' as const : 'missing' as const,
      policy: evidence.policy,
      recordedAt: evidence.recordedAt || null,
      reusable: false,
      coveredCommands: [] as string[],
      staleCommands: [] as string[],
      staleDetails: [],
    };
  }
  const coveredCommands: string[] = [];
  const staleCommands: string[] = [];
  const staleDetails: Array<{ command: string; changedFields: string[] }> = [];
  for (const stored of evidence.coverage) {
    const identityArgs = {
      projectId: input.task.projectId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.localPath ? { localPath: input.localPath } : {}),
      command: stored.command,
      affectedInputPaths: [...stored.affectedInputPaths],
    };
    let currentExecution = null;
    try {
      currentExecution = getProjectCommandExecutionIdentity(state, identityArgs);
    } catch (error: any) {
      const errorCode = String(error?.code || error?.payload?.code || '');
      if (errorCode !== 'COMMAND_TARGETS_REQUIRED') throw error;
      if (stored.affectedInputPaths.length > 0) {
        try {
          currentExecution = getProjectCommandExecutionIdentity(state, {
            ...identityArgs,
            targets: [...stored.affectedInputPaths],
          });
        } catch (targetError: any) {
          const targetErrorCode = String(targetError?.code || targetError?.payload?.code || '');
          if (!targetErrorCode.startsWith('COMMAND_TARGET')) throw targetError;
        }
      }
    }
    const current = buildVerificationCoverageIdentity(currentExecution);
    if (current?.key === stored.key) {
      coveredCommands.push(stored.command);
    } else {
      staleCommands.push(stored.command);
      const changedFields = current ? [
        'semanticKey', 'commandConfigFingerprint', 'affectedInputFingerprint', 'dependencyFingerprint',
        'environmentFingerprint', 'platform', 'arch', 'runtime',
      ].filter((field) => (current as any)?.[field] !== (stored as any)?.[field]) : ['affectedInputPaths'];
      staleDetails.push({ command: stored.command, changedFields });
    }
  }
  return {
    status: staleCommands.length === 0 ? 'covered' as const : 'stale' as const,
    policy: evidence.policy,
    recordedAt: evidence.recordedAt || null,
    reusable: staleCommands.length === 0,
    coveredCommands: Array.from(new Set(coveredCommands)),
    staleCommands: Array.from(new Set(staleCommands)),
    staleDetails,
  };
}

function buildBlockers(input: {
  sessionStatus: string;
  ownedChangedFiles: string[];
  ownershipDrift: TaskCommitPlan['ownershipDrift'];
  verificationFresh: boolean | null;
  verificationState: TaskCommitPlan['verificationState'];
  authorityOwnershipActive: boolean;
  verificationBatch: ExecutionVerificationBatchState | null;
  verificationRecordedAt: string | null;
  verificationCoverage: { status: 'covered' | 'missing' | 'stale'; reusable: boolean; staleCommands: string[] };
  verificationSatisfied: boolean;
}) {
  const blockers: TaskCommitPlanBlocker[] = [];
  if (!input.authorityOwnershipActive) {
    blockers.push({ code: 'LIFECYCLE_AUTHORITY_NOT_OWNED', message: 'Task-aware commit requires a unique active claim/ownership-epoch/execution authority.' });
  }
  if (input.sessionStatus !== 'active') {
    blockers.push({ code: 'EXECUTION_SESSION_NOT_ACTIVE', message: 'Task-aware commit requires an active execution session.' });
  }
  if (input.ownedChangedFiles.length === 0) {
    blockers.push({ code: 'TASK_COMMIT_NO_OWNED_CHANGES', message: 'No current working-tree changes belong to this execution session.' });
  }
  if (input.ownershipDrift.length > 0 && !input.verificationSatisfied) {
    blockers.push({
      code: 'EXECUTION_OWNERSHIP_DRIFT',
      message: `${input.ownershipDrift.length} owned file(s) changed outside the last known execution revision.`,
      details: { files: input.ownershipDrift },
    });
  }
  if (input.verificationBatch?.status === 'pending') {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE',
      message: `Verification batch '${input.verificationBatch.batchId}' still has pending required checks.`,
      details: { batchId: input.verificationBatch.batchId, pending: input.verificationBatch.pending },
    });
  } else if (input.verificationBatch?.status === 'failed') {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_BATCH_FAILED',
      message: `Verification batch '${input.verificationBatch.batchId}' contains failed required checks.`,
      details: { batchId: input.verificationBatch.batchId, failed: input.verificationBatch.failed },
    });
  } else if (input.verificationBatch?.status === 'stale') {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_BATCH_STALE',
      message: `Verification batch '${input.verificationBatch.batchId}' is stale for the current execution ownership revision.`,
      details: { batchId: input.verificationBatch.batchId, stale: input.verificationBatch.stale },
    });
  }
  if (input.verificationCoverage.status === 'stale') {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_COVERAGE_STALE',
      message: 'Authoritative verification no longer covers the current affected inputs, dependencies, command configuration, or environment.',
      details: { staleCommands: input.verificationCoverage.staleCommands },
    });
  }
  if (!input.verificationSatisfied) {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_NOT_FRESH',
      message: input.verificationState === 'missing'
        ? 'Authoritative execution verification is missing for the current owned file revisions.'
        : 'Authoritative execution verification is stale for the current owned file revisions.',
      details: {
        verificationState: input.verificationState,
        verificationFresh: input.verificationFresh,
        verificationRecordedAt: input.verificationRecordedAt,
        ownershipDriftCount: input.ownershipDrift.length,
      },
    });
  }
  return blockers;
}

export function buildTaskCommitPlan(_state: AppState, args: Record<string, any>): TaskCommitPlan {
  const taskId = requireTaskId(args.taskId);
  const workspaceId = requireWorkspaceId(args.workspaceId);
  const workspace = resolveSessionWorkspace(workspaceId);
  if (!workspace) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });

  const authority = computeLifecycleAuthoritySnapshot(taskId, { workspaceId });
  if (authority.hardBlockers.length > 0) {
    throw createApiError(409, 'TASK_LIFECYCLE_AUTHORITY_CONFLICT', 'Task commit authority is ambiguous or violates a hard lifecycle identity invariant.', {
      affectedId: taskId,
      details: { workspaceId, classification: authority.classification, blockers: authority.hardBlockers },
    });
  }
  const taskWorkspaceSessions = listExecutionSessionsForTask(taskId).filter((entry) => entry.workspaceId === workspaceId);
  const currentSessionId = authority.execution.current?.id || null;
  const session = currentSessionId
    ? taskWorkspaceSessions.find((entry) => entry.id === currentSessionId) || null
    : taskWorkspaceSessions.length === 1 && taskWorkspaceSessions[0].status !== 'active'
      ? taskWorkspaceSessions[0]
      : null;
  if (!session) {
    throw createApiError(409, 'TASK_EXECUTION_SESSION_NOT_FOUND', 'No unique current execution authority or single terminal diagnostic session for this task owns the selected workspace.', {
      affectedId: taskId,
      details: { workspaceId, authorityClassification: authority.classification, activeSessionIds: authority.execution.activeSessionIds },
    });
  }

  const ownership = getExecutionOwnershipState(session.id, { repoRoot: workspace.root });
  const verificationCoverage = resolveTaskVerificationCoverage(_state, {
    task: getTaskByIdentifier(taskId, 'full') || authority.task,
    workspaceId,
    executionSessionId: session.id,
    verificationFresh: ownership.verificationFresh,
  });
  const verificationSatisfied = verificationCoverage.status === 'covered'
    && (ownership.verificationFresh === true || verificationCoverage.reusable);
  const verificationState = verificationCoverage.status === 'stale'
    ? 'stale'
    : verificationSatisfied
      ? 'authoritative-fresh'
      : resolveVerificationState(ownership.verificationFresh);
  const verificationRecordedAt = ownership.verificationRecordedAt || null;
  const verificationBatch = getExecutionVerificationBatchState(session.id);
  const blockers = buildBlockers({
    authorityOwnershipActive: authority.mutation.ownershipAuthorized,
    sessionStatus: session.status,
    ownedChangedFiles: ownership.ownedChanges,
    ownershipDrift: ownership.ownershipDrift,
    verificationFresh: ownership.verificationFresh,
    verificationState,
    verificationRecordedAt,
    verificationBatch,
    verificationCoverage,
    verificationSatisfied,
  });
  return {
    taskId,
    executionSessionId: session.id,
    workspaceId,
    ownedChangedFiles: ownership.ownedChanges,
    unrelatedChangedFiles: ownership.unrelatedChanges,
    scopeDrift: ownership.scopeDrift,
    ownershipDrift: ownership.ownershipDrift,
    verifiedOwnershipDrift: ownership.verifiedOwnershipDrift,
    verificationFresh: ownership.verificationFresh,
    verificationState,
    verificationRecordedAt,
    verificationCoverage,
    commitAllowed: blockers.length === 0,
    blockers,
  };
}

const VERIFICATION_DEBT_BYPASS_BLOCKERS = new Set([
  'EXECUTION_VERIFICATION_BATCH_FAILED',
  'EXECUTION_VERIFICATION_NOT_FRESH',
]);

const OWNER_BREAK_GLASS_BYPASS_BLOCKERS = new Set([
  'LIFECYCLE_AUTHORITY_NOT_OWNED',
  'EXECUTION_SESSION_NOT_ACTIVE',
  'EXECUTION_OWNERSHIP_DRIFT',
  'EXECUTION_VERIFICATION_BATCH_INCOMPLETE',
  'EXECUTION_VERIFICATION_BATCH_FAILED',
  'EXECUTION_VERIFICATION_BATCH_STALE',
  'EXECUTION_VERIFICATION_NOT_FRESH',
]);

function latestInfrastructureFailure(executionSessionId: string) {
  return [...getExecutionSessionState(executionSessionId).evidence]
    .reverse()
    .find((entry: any) => entry.kind === 'verification-result'
      && entry.metadata?.outcome === 'failed'
      && entry.metadata?.failureClass === 'infrastructure') || null;
}

function requireVerificationDebtAuthorization(plan: TaskCommitPlan, args: Record<string, any>) {
  if (args.preserveVerificationDebt !== true) return null;
  if (args.emergency !== true) {
    throw createApiError(409, 'VERIFICATION_DEBT_EMERGENCY_AUTHORIZATION_REQUIRED', 'Verification-debt commit requires explicit emergency authorization.');
  }
  const reason = String(args.reason || '').trim();
  const actorLabel = String(args.actorLabel || '').trim();
  if (!reason || !actorLabel) {
    throw createApiError(400, 'VERIFICATION_DEBT_AUDIT_CONTEXT_REQUIRED', 'Verification-debt commit requires non-empty reason and actorLabel audit context.');
  }
  const session = getExecutionSessionState(plan.executionSessionId).session;
  if (session.status !== 'active' || session.lifecycle.stage !== 'verification-infra-blocked') {
    throw createApiError(409, 'VERIFICATION_DEBT_INFRA_BLOCKED_STAGE_REQUIRED', 'Verification-debt commit is allowed only for an active execution in verification-infra-blocked stage.', {
      details: { sessionStatus: session.status, lifecycleStage: session.lifecycle.stage },
    });
  }
  const failureEvidence = latestInfrastructureFailure(plan.executionSessionId);
  if (!failureEvidence) {
    throw createApiError(409, 'VERIFICATION_DEBT_INFRA_EVIDENCE_REQUIRED', 'Verification-debt commit requires recorded infrastructure-failure evidence for this execution.');
  }
  const nonVerificationBlockers = plan.blockers.filter((entry) => !VERIFICATION_DEBT_BYPASS_BLOCKERS.has(entry.code));
  if (nonVerificationBlockers.length > 0) {
    throw createApiError(409, 'VERIFICATION_DEBT_HARD_BLOCKER', 'Verification-debt commit cannot bypass ownership, scope, pending-batch, or lifecycle authority blockers.', {
      details: { blockers: nonVerificationBlockers, allBlockers: plan.blockers },
    });
  }
  return { reason, actorLabel, failureEvidence };
}

function requireOwnerBreakGlassAuthorization(plan: TaskCommitPlan, args: Record<string, any>) {
  const authority = args.ownerBreakGlass;
  if (!authority) return null;
  const operationId = String(authority.operationId || '').trim();
  const reason = String(authority.reason || '').trim();
  const actorLabel = String(authority.actorLabel || '').trim();
  const expectedOwnedFingerprint = String(authority.expectedOwnedFingerprint || '').trim();
  if (!operationId || !reason || !actorLabel || !expectedOwnedFingerprint) {
    throw createApiError(400, 'OWNER_BREAK_GLASS_AUDIT_CONTEXT_REQUIRED', 'Owner break-glass commit requires operationId, reason, actorLabel, and expectedOwnedFingerprint.');
  }
  const workspace = resolveSessionWorkspace(plan.workspaceId);
  if (!workspace) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${plan.workspaceId}' was not found.`, { affectedId: plan.workspaceId });
  const ownership = getExecutionOwnershipState(plan.executionSessionId, { repoRoot: workspace.root });
  if (ownership.ownedFingerprint !== expectedOwnedFingerprint) {
    throw createApiError(409, 'OWNER_BREAK_GLASS_OWNED_FINGERPRINT_MISMATCH', 'Owner break-glass authorization no longer matches the exact current owned diff.', {
      details: { expectedOwnedFingerprint, actualOwnedFingerprint: ownership.ownedFingerprint },
    });
  }
  const nonBypassable = plan.blockers.filter((entry) => !OWNER_BREAK_GLASS_BYPASS_BLOCKERS.has(entry.code));
  if (nonBypassable.length > 0) {
    throw createApiError(409, 'OWNER_BREAK_GLASS_HARD_BLOCKER', 'Owner break-glass cannot bypass physical, identity, or no-owned-change blockers.', {
      details: { blockers: nonBypassable, allBlockers: plan.blockers },
    });
  }
  return {
    operationId,
    reason,
    actorLabel,
    expectedOwnedFingerprint,
    bypassedGates: plan.blockers.map((entry) => entry.code),
  };
}

export function commitTaskOwnedChanges(state: AppState, args: Record<string, any>) {
  const plan = buildTaskCommitPlan(state, args);
  const debtAuthorization = requireVerificationDebtAuthorization(plan, args);
  const ownerAuthorization = requireOwnerBreakGlassAuthorization(plan, args);
  if (!plan.commitAllowed && !debtAuthorization && !ownerAuthorization) {
    throw createApiError(409, 'TASK_COMMIT_PLAN_BLOCKED', 'Task-owned commit is blocked until all commit-plan blockers are resolved.', {
      affectedId: plan.taskId,
      details: { workspaceId: plan.workspaceId, blockers: plan.blockers },
    });
  }
  const workspace = resolveSessionWorkspace(plan.workspaceId)!;
  const task = getTaskByIdentifier(args.taskId, 'full') || { id: plan.taskId };
  const message = renderTaskCommitMessage(args.message, task as any, { gitWorkflowPolicy: workspace.gitWorkflowPolicy } as any);
  const ownershipBeforeCommit = debtAuthorization || ownerAuthorization
    ? getExecutionOwnershipState(plan.executionSessionId, { repoRoot: workspace.root })
    : null;
  const batchBeforeCommit = debtAuthorization ? getExecutionVerificationBatchState(plan.executionSessionId) : null;
  const result = commitGitChanges(state, {
    localPath: workspace.root,
    message,
    files: plan.ownedChangedFiles,
    stageAll: false,
    dryRun: args.dryRun === true,
  }, { taskAware: true });
  const { root: _physicalRoot, ...safeResult } = result as any;
  let verificationDebt: Record<string, unknown> | null = null;
  if (debtAuthorization && args.dryRun !== true) {
    const commitHash = String((safeResult as any).commitHash || (safeResult as any).hash || '').trim();
    const debtEvidenceId = `verification-debt:${commitHash || plan.executionSessionId}`;
    const failureMetadata = (debtAuthorization.failureEvidence as any).metadata || {};
    verificationDebt = {
      status: 'outstanding',
      commitHash: commitHash || null,
      candidateId: String(args.expectedCandidateId || failureMetadata.candidateId || '').trim() || null,
      repoRevision: ownershipBeforeCommit?.repoRevision || null,
      ownedFingerprint: ownershipBeforeCommit?.ownedFingerprint || null,
      verificationBatchId: batchBeforeCommit?.batchId || null,
      failedChecks: batchBeforeCommit?.failed || [],
      failureEvidenceId: debtAuthorization.failureEvidence.id,
      failureClass: 'infrastructure',
      authorization: {
        emergency: true,
        reason: debtAuthorization.reason,
        actorLabel: debtAuthorization.actorLabel,
      },
      recordedAt: new Date().toISOString(),
    };
    recordExecutionSessionEvidence(plan.executionSessionId, [{
      evidenceId: debtEvidenceId,
      kind: 'verification-debt',
      revisionIdentity: commitHash || plan.executionSessionId,
      metadata: verificationDebt,
    }]);
    (verificationDebt as any).evidenceId = debtEvidenceId;
  }
  if (ownerAuthorization && args.dryRun !== true) {
    const commitHash = String((safeResult as any).commitHash || (safeResult as any).hash || '').trim() || null;
    recordExecutionReconciliationEvidence(plan.executionSessionId, 'operator-break-glass-commit', {
      ownerBreakGlass: true,
      operationId: ownerAuthorization.operationId,
      reason: ownerAuthorization.reason,
      actorLabel: ownerAuthorization.actorLabel,
      commitHash,
      repoRevision: ownershipBeforeCommit?.repoRevision || null,
      ownedFingerprint: ownershipBeforeCommit?.ownedFingerprint || ownerAuthorization.expectedOwnedFingerprint,
      bypassedGates: ownerAuthorization.bypassedGates,
    });
  }

  return {
    ...safeResult,
    taskId: plan.taskId,
    executionSessionId: plan.executionSessionId,
    workspaceId: plan.workspaceId,
    committedFiles: plan.ownedChangedFiles,
    unrelatedChangesPreserved: plan.unrelatedChangedFiles,
    verificationDebtPreserved: Boolean(debtAuthorization && args.dryRun !== true),
    verificationDebt,
    ownerBreakGlassApplied: Boolean(ownerAuthorization && args.dryRun !== true),
    bypassedGates: ownerAuthorization?.bypassedGates || [],
  };
}
