// DVF-0685: commit readiness consumes authoritative reusable verification coverage.
import type { AppState } from '../types.js';
import { getTaskByIdentifier } from '../repositories/taskRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import { createApiError } from './api.js';
import {
  getExecutionOwnershipState,
  getExecutionSessionState,
  getExecutionVerificationBatchLiveOperations,
  getExecutionVerificationBatchState,
  getExecutionVerificationCoverageEvidence,
  recordExecutionSessionEvidence,
  type ExecutionVerificationBatchState,
} from './executionSessionService.js';
import { commitGitChanges, getGitLog } from './gitService.js';
import { renderTaskCommitMessage } from './projectGitWorkflowPolicyService.js';
import { resolveSessionWorkspace } from './sessionWorkspaceService.js';
import { computeLifecycleAuthoritySnapshot } from './lifecycleAuthorityService.js';
import { getProjectCommandExecutionIdentity } from './projectCommandService.js';
import { buildVerificationCoverageIdentity } from './verificationBatchService.js';
import { summarizeQualityDebt, type TaskQualityDebtSummary } from './qualityDebtService.js';

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
  commitDisposition: 'commit-required' | 'already-committed' | 'ambiguous-no-changes';
  alreadyCommitted: null | {
    commitHash: string;
    evidenceId: string;
    nextTool: 'finalize_task_workspace';
  };
  nextAction: null | {
    tool: 'commit_task_owned_changes' | 'finalize_task_workspace';
    taskId: string;
    workspaceId: string;
  };
  commitAllowed: boolean;
  blockers: TaskCommitPlanBlocker[];
  debts: TaskCommitPlanBlocker[];
  qualityDebt: TaskQualityDebtSummary;
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
      ...(stored.targets?.length ? { targets: [...stored.targets] } : {}),
      affectedInputPaths: [...stored.affectedInputPaths],
    };
    let currentExecution = null;
    try {
      currentExecution = getProjectCommandExecutionIdentity(state, identityArgs);
    } catch (error: any) {
      const errorCode = String(error?.code || error?.payload?.code || '');
      if (errorCode === 'COMMAND_TARGETS_REQUIRED' && !stored.targets?.length && stored.affectedInputPaths.length > 0) {
        try {
          currentExecution = getProjectCommandExecutionIdentity(state, {
            ...identityArgs,
            targets: [...stored.affectedInputPaths],
          });
        } catch (targetError: any) {
          const targetErrorCode = String(targetError?.code || targetError?.payload?.code || '');
          if (!targetErrorCode.startsWith('COMMAND_TARGET')) throw targetError;
        }
      } else if (!errorCode.startsWith('COMMAND_TARGET')) {
        throw error;
      }
    }
    const current = buildVerificationCoverageIdentity(currentExecution);
    if (current?.key === stored.key) {
      coveredCommands.push(stored.command);
    } else {
      staleCommands.push(stored.command);
      const changedFields = current ? [
        ...((JSON.stringify(current.targets ?? []) !== JSON.stringify(stored.targets ?? [])) ? ['targets'] : []),
        ...[
          'semanticKey', 'commandConfigFingerprint', 'affectedInputFingerprint', 'dependencyFingerprint',
          'environmentFingerprint', 'platform', 'arch', 'runtime',
        ].filter((field) => (current as any)?.[field] !== (stored as any)?.[field]),
      ] : ['affectedInputPaths'];
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

function resolveAlreadyCommittedProof(
  state: AppState,
  input: {
    task: any;
    sessionId: string;
    workspaceId: string;
    workspaceRoot: string;
    ownedChangedFiles: string[];
    unrelatedChangedFiles: string[];
    scopeDrift: string[];
    ownershipDrift: TaskCommitPlan['ownershipDrift'];
  },
): TaskCommitPlan['alreadyCommitted'] {
  if (input.ownedChangedFiles.length > 0 || input.unrelatedChangedFiles.length > 0 || input.scopeDrift.length > 0 || input.ownershipDrift.length > 0) return null;
  const evidence = [...getExecutionSessionState(input.sessionId).evidence].reverse().find((entry: any) => {
    if (entry.kind !== 'task-owned-commit' && entry.kind !== 'git-commit-result') return false;
    const metadata = entry.metadata || {};
    return metadata.owned === true
      && String(metadata.taskId || '') === String(input.task.id || '')
      && String(metadata.workspaceId || '') === input.workspaceId
      && String(metadata.executionSessionId || '') === input.sessionId
      && String(metadata.commitHash || '').trim().length > 0;
  });
  if (!evidence) return null;
  const commitHash = String(evidence.metadata?.commitHash || '').trim();
  const head = getGitLog(state, { localPath: input.workspaceRoot, limit: 1 }).commits[0];
  if (!head?.hash || head.hash !== commitHash) return null;
  return {
    commitHash,
    evidenceId: evidence.id,
    nextTool: 'finalize_task_workspace',
  };
}

function buildBlockers(input: {
  sessionStatus: string;
  ownedChangedFiles: string[];
  ownershipDrift: TaskCommitPlan['ownershipDrift'];
  authorityOwnershipActive: boolean;
  verificationBatch: ExecutionVerificationBatchState | null;
  verificationBatchLiveOperations: Array<{ operationId: string; status: string; jobStatus: string }>;
  alreadyCommitted: boolean;
}) {
  const blockers: TaskCommitPlanBlocker[] = [];
  if (!input.authorityOwnershipActive) {
    blockers.push({ code: 'LIFECYCLE_AUTHORITY_NOT_OWNED', message: 'Task-aware commit requires a unique active claim/ownership-epoch/execution authority.' });
  }
  if (input.sessionStatus !== 'active') {
    blockers.push({ code: 'EXECUTION_SESSION_NOT_ACTIVE', message: 'Task-aware commit requires an active execution session.' });
  }
  if (input.ownedChangedFiles.length === 0 && !input.alreadyCommitted) {
    blockers.push({ code: 'TASK_COMMIT_NO_OWNED_CHANGES', message: 'No current working-tree changes belong to this execution session and no task-owned commit evidence matches the current HEAD.' });
  }
  if (input.ownershipDrift.length > 0) {
    blockers.push({
      code: 'EXECUTION_OWNERSHIP_DRIFT',
      message: `${input.ownershipDrift.length} owned file(s) changed outside the last known execution revision and must be explicitly reconciled before commit.`,
      details: {
        files: input.ownershipDrift,
        nextAction: 'reconcile_task_owned_revision_drift',
        nextTool: 'reconcile_task_owned_revision_drift',
      },
    });
  }
  if (input.verificationBatch?.status === 'pending' && input.verificationBatchLiveOperations.length > 0) {
    blockers.push({
      code: 'EXECUTION_VERIFICATION_BATCH_LIVE_MEMBERS',
      message: `Verification batch '${input.verificationBatch.batchId}' still has live durable member operations that may write execution evidence.`,
      details: { batchId: input.verificationBatch.batchId, pending: input.verificationBatch.pending, liveOperations: input.verificationBatchLiveOperations },
    });
  }
  return blockers;
}

function buildDebts(input: {
  ownershipDrift: TaskCommitPlan['ownershipDrift'];
  verificationFresh: boolean | null;
  verificationState: TaskCommitPlan['verificationState'];
  verificationBatch: ExecutionVerificationBatchState | null;
  verificationRecordedAt: string | null;
  verificationCoverage: { status: 'covered' | 'missing' | 'stale'; reusable: boolean; staleCommands: string[] };
  verificationSatisfied: boolean;
}) {
  const debts: TaskCommitPlanBlocker[] = [];
  if (input.verificationBatch?.status === 'pending') {
    debts.push({
      code: 'EXECUTION_VERIFICATION_BATCH_PENDING',
      message: `Verification batch '${input.verificationBatch.batchId}' is incomplete quality state; without live member operations it does not mechanically block commit.`,
      details: { batchId: input.verificationBatch.batchId, pending: input.verificationBatch.pending },
    });
  } else if (input.verificationBatch?.status === 'superseded') {
    debts.push({
      code: 'EXECUTION_VERIFICATION_BATCH_SUPERSEDED',
      message: `Verification batch '${input.verificationBatch.batchId}' was superseded and remains historical audit debt.`,
      details: { batchId: input.verificationBatch.batchId, supersededByBatchId: input.verificationBatch.supersededByBatchId, supersessionReason: input.verificationBatch.supersessionReason },
    });
  }
  if (input.verificationBatch?.status === 'failed') {
    debts.push({
      code: 'EXECUTION_VERIFICATION_BATCH_FAILED',
      message: `Verification batch '${input.verificationBatch.batchId}' contains failed required checks.`,
      details: { batchId: input.verificationBatch.batchId, failed: input.verificationBatch.failed },
    });
  } else if (input.verificationBatch?.status === 'stale') {
    debts.push({
      code: 'EXECUTION_VERIFICATION_BATCH_STALE',
      message: `Verification batch '${input.verificationBatch.batchId}' is stale for the current execution ownership revision.`,
      details: { batchId: input.verificationBatch.batchId, stale: input.verificationBatch.stale },
    });
  }
  if (input.verificationCoverage.status === 'stale') {
    debts.push({
      code: 'EXECUTION_VERIFICATION_COVERAGE_STALE',
      message: 'Authoritative verification no longer covers the current affected inputs, dependencies, command configuration, or environment.',
      details: { staleCommands: input.verificationCoverage.staleCommands },
    });
  }
  if (!input.verificationSatisfied) {
    debts.push({
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
  return debts;
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
  const task = getTaskByIdentifier(taskId, 'full') || authority.task;
  const alreadyCommitted = resolveAlreadyCommittedProof(_state, {
    task,
    sessionId: session.id,
    workspaceId,
    workspaceRoot: workspace.root,
    ownedChangedFiles: ownership.ownedChanges,
    unrelatedChangedFiles: ownership.unrelatedChanges,
    scopeDrift: ownership.scopeDrift,
    ownershipDrift: ownership.ownershipDrift,
  });
  const verificationCoverage = resolveTaskVerificationCoverage(_state, {
    task,
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
  const verificationBatchLiveOperations = verificationBatch?.status === 'pending'
    ? getExecutionVerificationBatchLiveOperations(session.id, verificationBatch.batchId)
    : [];
  const blockers = buildBlockers({
    authorityOwnershipActive: authority.mutation.ownershipAuthorized,
    sessionStatus: session.status,
    ownedChangedFiles: ownership.ownedChanges,
    ownershipDrift: ownership.ownershipDrift,
    verificationBatch,
    verificationBatchLiveOperations,
    alreadyCommitted: Boolean(alreadyCommitted),
  });
  const debts = buildDebts({
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
    commitDisposition: alreadyCommitted
      ? 'already-committed'
      : ownership.ownedChanges.length > 0
        ? 'commit-required'
        : 'ambiguous-no-changes',
    alreadyCommitted,
    nextAction: alreadyCommitted
      ? { tool: 'finalize_task_workspace', taskId, workspaceId }
      : ownership.ownedChanges.length > 0
        ? { tool: 'commit_task_owned_changes', taskId, workspaceId }
        : null,
    commitAllowed: blockers.length === 0,
    blockers,
    debts,
    qualityDebt: summarizeQualityDebt(debts),
  };
}

export function commitTaskOwnedChanges(state: AppState, args: Record<string, any>) {
  const plan = buildTaskCommitPlan(state, args);
  if (plan.commitDisposition === 'already-committed' && plan.alreadyCommitted) {
    return {
      status: 'already-committed',
      alreadyCommitted: true,
      idempotent: true,
      hash: plan.alreadyCommitted.commitHash,
      commitHash: plan.alreadyCommitted.commitHash,
      taskId: plan.taskId,
      executionSessionId: plan.executionSessionId,
      workspaceId: plan.workspaceId,
      committedFiles: [],
      unrelatedChangesPreserved: plan.unrelatedChangedFiles,
      verificationDebtPreserved: false,
      verificationDebt: null,
      nextAction: plan.nextAction,
      ownerBreakGlassApplied: false,
      bypassedGates: [],
    };
  }
  if (!plan.commitAllowed) {
    throw createApiError(409, 'TASK_COMMIT_PLAN_BLOCKED', 'Task-owned commit is blocked until all commit-plan blockers are resolved.', {
      affectedId: plan.taskId,
      details: { workspaceId: plan.workspaceId, blockers: plan.blockers },
    });
  }
  const workspace = resolveSessionWorkspace(plan.workspaceId)!;
  const task = getTaskByIdentifier(args.taskId, 'full') || { id: plan.taskId };
  const message = renderTaskCommitMessage(args.message, task as any, { gitWorkflowPolicy: workspace.gitWorkflowPolicy } as any);
  const ownershipBeforeCommit = plan.debts.length > 0
    ? getExecutionOwnershipState(plan.executionSessionId, { repoRoot: workspace.root })
    : null;
  const batchBeforeCommit = plan.debts.length > 0 ? getExecutionVerificationBatchState(plan.executionSessionId) : null;
  const result = commitGitChanges(state, {
    localPath: workspace.root,
    message,
    files: plan.ownedChangedFiles,
    stageAll: false,
    dryRun: args.dryRun === true,
  }, { taskAware: true });
  const { root: _physicalRoot, ...safeResult } = result as any;
  let verificationDebt: Record<string, unknown> | null = null;
  if (plan.debts.length > 0 && args.dryRun !== true) {
    const commitHash = String((safeResult as any).commitHash || (safeResult as any).hash || '').trim();
    const debtEvidenceId = `verification-debt:${commitHash || plan.executionSessionId}`;
    verificationDebt = {
      status: 'outstanding',
      commitHash: commitHash || null,
      repoRevision: ownershipBeforeCommit?.repoRevision || null,
      ownedFingerprint: ownershipBeforeCommit?.ownedFingerprint || null,
      verificationBatchId: batchBeforeCommit?.batchId || null,
      failedChecks: batchBeforeCommit?.failed || [],
      verificationState: plan.verificationState,
      verificationFresh: plan.verificationFresh,
      verificationCoverage: plan.verificationCoverage,
      debtCodes: plan.debts.map((entry) => entry.code),
      debts: plan.debts,
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
  if (args.dryRun !== true) {
    const commitHash = String((safeResult as any).commitHash || (safeResult as any).hash || '').trim();
    if (commitHash) {
      recordExecutionSessionEvidence(plan.executionSessionId, [{
        evidenceId: `task-owned-commit:${commitHash}`,
        kind: 'task-owned-commit',
        revisionIdentity: commitHash,
        metadata: {
          commitHash,
          taskId: plan.taskId,
          workspaceId: plan.workspaceId,
          executionSessionId: plan.executionSessionId,
          tool: 'commit_task_owned_changes',
          owned: true,
          recordedAt: new Date().toISOString(),
        },
      }]);
    }
  }
  return {
    ...safeResult,
    taskId: plan.taskId,
    executionSessionId: plan.executionSessionId,
    workspaceId: plan.workspaceId,
    committedFiles: plan.ownedChangedFiles,
    unrelatedChangesPreserved: plan.unrelatedChangedFiles,
    verificationDebtPreserved: Boolean(plan.debts.length > 0 && args.dryRun !== true),
    verificationDebt,
    ownerBreakGlassApplied: false,
    bypassedGates: [],
  };
}
