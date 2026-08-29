import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AppState } from '../types.js';
import { getProject } from '../repositories/projectRepository.js';
import { getTaskByIdentifier, saveTask } from '../repositories/taskRepository.js';
import { getExecutionSessionById, listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import {
  createLifecycleEmergencyOperation,
  getLifecycleEmergencyOperation,
  listLifecycleEmergencyOperations,
  updateLifecycleEmergencyOperation,
  type LifecycleEmergencyOperationRecord,
} from '../repositories/lifecycleEmergencyOperationRepository.js';
import { createApiError } from './api.js';
import { computeLifecycleAuthoritySnapshot } from './lifecycleAuthorityService.js';
import {
  classifySessionWorkspaceTaskMatch,
  cleanupSessionWorkspace,
  getSessionWorkspaceMetadataForRecovery,
} from './sessionWorkspaceService.js';
import {
  cancelExecutionSession,
  getExecutionOwnershipState,
  getExecutionSessionOwnershipEpoch,
  getExecutionSessionState,
  recordExecutionLifecycleTransition,
  recordExecutionReconciliationEvidence,
  recordExecutionSessionEvidence,
  recordExecutionVerificationEvidence,
} from './executionSessionService.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import { claimTaskForSession, releaseTaskClaim } from './taskClaimService.js';
import { buildTaskCommitPlan, commitTaskOwnedChanges } from './taskCommitPlanService.js';
import { finalizeTaskWorkspace, type TaskWorkspaceFinalizationCheck } from './taskWorkspaceFinalizationService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';
import { reconstructRecordedWorkspaceIntegration } from './workspaceIntegrationService.js';
import { withSyncLock } from './lockAndIdempotencyService.js';
import { getGitCommitEvidenceForRoot, getGitWorkspaceSnapshotForRoot } from './gitLocalService.js';
import { renderTaskCommitMessage, resolveProjectGitWorkflowPolicy, taskCommitSubjectMatchesPolicy } from './projectGitWorkflowPolicyService.js';

export const BREAK_GLASS_ACTIONS = [
  'finalize-as-integrated',
  'reconcile-integrated-detached',
  'supersede-execution',
  'supersede-task-work',
  'discard-wip',
] as const;

export type BreakGlassLifecycleAction = typeof BREAK_GLASS_ACTIONS[number];

export type BreakGlassLifecycleInput = {
  operationId: string;
  action: string;
  reason: string;
  actorLabel: string;
  projectId: string;
  taskId: string;
  workspaceId?: string;
  executionSessionId?: string;
  ownershipEpochId?: string;
  expectedCandidateId?: string;
  expectedOwnedFingerprint?: string;
  expectedCommit?: string;
  replacementSessionId?: string;
  replacement?: {
    taskId?: string;
    executionSessionId?: string;
    workspaceId?: string;
    commit?: string;
  };
  noReplacement?: boolean;
  message?: string;
  checks?: TaskWorkspaceFinalizationCheck[];
  finalizationOperationId?: string;
  destructiveAck?: boolean;
};

const SOFT_COMMIT_BLOCKERS = new Set([
  'EXECUTION_VERIFICATION_BATCH_INCOMPLETE',
  'EXECUTION_VERIFICATION_BATCH_FAILED',
  'EXECUTION_VERIFICATION_BATCH_STALE',
  'EXECUTION_VERIFICATION_NOT_FRESH',
  'EXECUTION_OWNERSHIP_DRIFT',
]);

function clean(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function stableDigest(value: unknown) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sessionIdHash(sessionId: string) {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

export type BreakGlassFaultBoundary = 'after-commit-side-effect' | 'after-rotation-side-effect' | 'after-discard-side-effect' | 'after-detached-green-settlement' | 'after-detached-finalization-side-effect';
let breakGlassFaultBoundaryForTests: BreakGlassFaultBoundary | null = null;

export function __setBreakGlassFaultBoundaryForTests(boundary: BreakGlassFaultBoundary | null) {
  breakGlassFaultBoundaryForTests = boundary;
}

function injectBreakGlassFault(boundary: BreakGlassFaultBoundary) {
  if (breakGlassFaultBoundaryForTests !== boundary) return;
  const error = new Error(`Injected break-glass response loss at ${boundary}.`) as Error & { code?: string };
  error.code = 'BREAK_GLASS_FAULT_INJECTED';
  throw error;
}

function compactAuthority(snapshot: ReturnType<typeof computeLifecycleAuthoritySnapshot>) {
  return {
    version: snapshot.version,
    task: { id: snapshot.task.id, displayId: snapshot.task.displayId, status: snapshot.task.status, projectId: snapshot.task.projectId },
    classification: snapshot.classification,
    claim: snapshot.claim,
    execution: snapshot.execution,
    workspace: snapshot.workspace,
    verification: {
      authoritative: snapshot.verification.authoritative,
      fresh: snapshot.verification.fresh,
      ownedFingerprint: snapshot.verification.ownedFingerprint,
      ownedChanges: snapshot.verification.ownedChanges.slice(0, 100),
      unrelatedChanges: snapshot.verification.unrelatedChanges.slice(0, 100),
      candidate: snapshot.verification.candidate,
      batch: snapshot.verification.batch,
    },
    mutation: snapshot.mutation,
    hardBlockers: snapshot.hardBlockers.slice(0, 20),
    softDrift: snapshot.softDrift.slice(0, 20),
  };
}

function failureRecord(error: any) {
  return {
    code: clean(error?.payload?.code || error?.code || 'BREAK_GLASS_FAILED', 160),
    message: clean(error?.payload?.message || error?.message || String(error || 'Break-glass action failed.'), 500),
    details: error?.payload?.details || error?.details || undefined,
    observedAt: new Date().toISOString(),
  };
}

function requireInput(input: BreakGlassLifecycleInput) {
  const operationId = clean(input?.operationId, 200);
  const reason = clean(input?.reason, 500);
  const actorLabel = clean(input?.actorLabel, 100);
  const projectId = clean(input?.projectId, 200);
  const taskId = clean(input?.taskId, 200);
  const action = clean(input?.action, 100) as BreakGlassLifecycleAction;
  if (!operationId) throw createApiError(400, 'BREAK_GLASS_OPERATION_ID_REQUIRED', 'operationId is required for break-glass lifecycle recovery.');
  if (!reason) throw createApiError(400, 'BREAK_GLASS_REASON_REQUIRED', 'A human/operator reason is required for break-glass lifecycle recovery.');
  if (!actorLabel) throw createApiError(400, 'BREAK_GLASS_ACTOR_REQUIRED', 'actorLabel is required for break-glass lifecycle recovery.');
  if (!projectId) throw createApiError(400, 'PROJECT_ID_REQUIRED', 'projectId is required for break-glass lifecycle recovery.');
  if (!taskId) throw createApiError(400, 'TASK_ID_REQUIRED', 'taskId is required for break-glass lifecycle recovery.');
  if (!BREAK_GLASS_ACTIONS.includes(action)) throw createApiError(400, 'BREAK_GLASS_ACTION_INVALID', `Unsupported break-glass action '${action || '<empty>'}'.`);
  return { operationId, reason, actorLabel, projectId, taskId, action };
}

function expectedWorkspace(task: any, input: BreakGlassLifecycleInput, required = true) {
  const workspaceId = clean(input.workspaceId, 200);
  if (!workspaceId) {
    if (required) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', `workspaceId is required for break-glass action '${input.action}'.`);
    return null;
  }
  const workspace = getSessionWorkspaceMetadataForRecovery(workspaceId);
  if (!workspace) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
  if (workspace.projectId !== task.projectId || classifySessionWorkspaceTaskMatch(workspace, task.projectId, task.displayId) !== 'exact') {
    throw createApiError(409, 'BREAK_GLASS_WORKSPACE_IDENTITY_MISMATCH', 'Break-glass workspace must be an exact persisted task/project identity match.', {
      affectedId: workspaceId,
      details: { taskId: task.id, taskDisplayId: task.displayId, taskProjectId: task.projectId, workspaceProjectId: workspace.projectId, workspaceTaskDisplayId: workspace.taskDisplayId || null },
    });
  }
  return workspace;
}

function validateExpectedExecution(task: any, input: BreakGlassLifecycleInput) {
  const expectedId = clean(input.executionSessionId, 200);
  if (!expectedId) return null;
  const session = getExecutionSessionById(expectedId);
  if (!session || session.taskId !== task.id || session.projectId !== task.projectId || (input.workspaceId && session.workspaceId !== input.workspaceId)) {
    throw createApiError(409, 'BREAK_GLASS_EXECUTION_IDENTITY_MISMATCH', 'Expected execution identity does not match the selected project/task/workspace.', {
      affectedId: expectedId,
      details: { projectId: task.projectId, taskId: task.id, workspaceId: input.workspaceId || null },
    });
  }
  const expectedEpoch = clean(input.ownershipEpochId, 200);
  const actualEpoch = getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId;
  if (expectedEpoch && expectedEpoch !== actualEpoch) {
    throw createApiError(409, 'BREAK_GLASS_OWNERSHIP_EPOCH_MISMATCH', 'Expected ownership epoch no longer matches the selected execution.', {
      affectedId: session.id,
      details: { expectedOwnershipEpochId: expectedEpoch, actualOwnershipEpochId: actualEpoch || null },
    });
  }
  return session;
}

function resolveSupersedeExecutionWorkspace(task: any, input: BreakGlassLifecycleInput) {
  const targeted = validateExpectedExecution(task, input);
  if (!targeted) throw createApiError(400, 'EXECUTION_SESSION_ID_REQUIRED', 'supersede-execution requires executionSessionId.');
  const requestedWorkspaceId = clean(input.workspaceId, 200);
  const recordedWorkspaceId = clean(targeted.workspaceId, 200);
  const recordedWorkspace = recordedWorkspaceId ? getSessionWorkspaceMetadataForRecovery(recordedWorkspaceId) : null;

  if (requestedWorkspaceId) {
    if (recordedWorkspace) return { targeted, workspace: expectedWorkspace(task, input, true), missingWorkspace: null };
    return {
      targeted,
      workspace: null,
      missingWorkspace: {
        executionSessionId: targeted.id,
        recordedWorkspaceId: recordedWorkspaceId || null,
        requestedWorkspaceId,
        workspaceMetadataAvailable: false,
      },
    };
  }

  if (recordedWorkspace) {
    throw createApiError(400, 'WORKSPACE_ID_REQUIRED', "workspaceId is required for break-glass action 'supersede-execution' while the managed workspace remains available.");
  }
  return {
    targeted,
    workspace: null,
    missingWorkspace: {
      executionSessionId: targeted.id,
      recordedWorkspaceId: recordedWorkspaceId || null,
      requestedWorkspaceId: null,
      workspaceMetadataAvailable: false,
    },
  };
}

function assertCurrentCandidate(authority: ReturnType<typeof computeLifecycleAuthoritySnapshot>, input: BreakGlassLifecycleInput) {
  const expectedCandidateId = clean(input.expectedCandidateId, 200);
  const expectedOwnedFingerprint = clean(input.expectedOwnedFingerprint, 300);
  if (expectedCandidateId && authority.verification.candidate?.candidateId !== expectedCandidateId) {
    throw createApiError(409, 'BREAK_GLASS_CANDIDATE_MISMATCH', 'Expected verification candidate no longer matches current lifecycle authority.', {
      details: { expectedCandidateId, actualCandidateId: authority.verification.candidate?.candidateId || null },
    });
  }
  if (expectedOwnedFingerprint && authority.verification.ownedFingerprint !== expectedOwnedFingerprint) {
    throw createApiError(409, 'BREAK_GLASS_OWNED_FINGERPRINT_MISMATCH', 'Expected owned-file fingerprint no longer matches current lifecycle authority.', {
      details: { expectedOwnedFingerprint, actualOwnedFingerprint: authority.verification.ownedFingerprint || null },
    });
  }
}

function pendingOperations(sessionId: string | null | undefined) {
  if (!sessionId) return [] as any[];
  return (getLatestExecutionCheckpoint(sessionId)?.pendingOperations || []).filter((entry) => entry.status === 'accepted' || entry.status === 'running');
}

function hardSafetyChecks(authority: ReturnType<typeof computeLifecycleAuthoritySnapshot>, input: BreakGlassLifecycleInput) {
  const checks: Array<Record<string, unknown>> = [];
  for (const blocker of authority.hardBlockers) {
    const targetedSupersession = input.action === 'supersede-execution'
      && blocker.code === 'MULTIPLE_ACTIVE_EXECUTIONS'
      && Boolean(clean(input.executionSessionId));
    const detachedMissingWorkspace = input.action === 'reconcile-integrated-detached'
      && blocker.code === 'WORKSPACE_METADATA_MISSING';
    const staleExecutionMissingWorkspace = input.action === 'supersede-execution'
      && blocker.code === 'WORKSPACE_METADATA_MISSING'
      && Boolean(clean(input.executionSessionId))
      && authority.claim.active !== true;
    const passed = targetedSupersession || detachedMissingWorkspace || staleExecutionMissingWorkspace;
    checks.push({
      code: blocker.code,
      passed,
      message: blocker.message,
      bypass: targetedSupersession
        ? 'explicit-targeted-supersession'
        : detachedMissingWorkspace
          ? 'detached-integrated-exact-proof'
          : staleExecutionMissingWorkspace
            ? 'exact-stale-execution-missing-workspace'
            : null,
    });
    if (!passed) {
      throw createApiError(409, 'BREAK_GLASS_HARD_SAFETY_BLOCKED', 'Break-glass cannot bypass repository/workspace/cross-worker identity safety.', {
        details: { action: input.action, blocker },
      });
    }
  }
  if (checks.length === 0) checks.push({ code: 'LIFECYCLE_HARD_IDENTITY_INVARIANTS', passed: true });
  return checks;
}

function updateAudit(operation: LifecycleEmergencyOperationRecord, patch: Parameters<typeof updateLifecycleEmergencyOperation>[1]) {
  return updateLifecycleEmergencyOperation(operation.id, { ...patch, updatedAt: new Date().toISOString() }) || operation;
}

function completion(operation: LifecycleEmergencyOperationRecord, taskId: string, workspaceId: string | undefined, result: Record<string, unknown>, evidence: Record<string, unknown>, bypassedGates: string[], hardChecks: Array<Record<string, unknown>>, wipDisposition: string) {
  const after = compactAuthority(computeLifecycleAuthoritySnapshot(taskId, { workspaceId }));
  return updateAudit(operation, {
    status: 'completed',
    afterSnapshot: after,
    result,
    evidence,
    bypassedGates,
    hardChecks,
    wipDisposition,
    failure: null,
    completedAt: new Date().toISOString(),
  });
}

function rejected(operation: LifecycleEmergencyOperationRecord, error: any, hardChecks: Array<Record<string, unknown>> = []) {
  let afterSnapshot: Record<string, unknown> | null = operation.beforeSnapshot;
  try { afterSnapshot = compactAuthority(computeLifecycleAuthoritySnapshot(operation.taskId, { workspaceId: operation.workspaceId || undefined })); } catch {}
  return updateAudit(operation, {
    status: 'rejected',
    afterSnapshot,
    hardChecks,
    failure: failureRecord(error),
    result: { rejected: true },
    completedAt: new Date().toISOString(),
  });
}

function executeCommitBreakGlass(
  state: AppState,
  operation: LifecycleEmergencyOperationRecord,
  input: BreakGlassLifecycleInput,
  task: any,
  workspace: NonNullable<ReturnType<typeof expectedWorkspace>>,
  _authority: ReturnType<typeof computeLifecycleAuthoritySnapshot>,
  hardChecks: Array<Record<string, unknown>>,
) {
  const plan = buildTaskCommitPlan(state, { taskId: task.id, workspaceId: workspace.workspaceId });
  const rawMessage = clean(input.message, 500) || 'chore: operator break-glass recovery';
  const expectedSubject = renderTaskCommitMessage(rawMessage, task, { gitWorkflowPolicy: workspace.gitWorkflowPolicy } as any);
  const priorIntent = (operation.evidence as any)?.commitIntent as any;
  const snapshot = getGitWorkspaceSnapshotForRoot(workspace.root);
  const execution = getExecutionSessionById(plan.executionSessionId);
  const preserveVerificationDebt = execution?.status === 'active' && execution.lifecycle.stage === 'verification-infra-blocked';
  if (plan.ownedChangedFiles.length === 0 && priorIntent) {
    const headEvidence = getGitCommitEvidenceForRoot(workspace.root, snapshot.head);
    const expectedFiles = [...(Array.isArray(priorIntent.ownedFiles) ? priorIntent.ownedFiles : [])].sort();
    const recovered = snapshot.head !== priorIntent.headBefore
      && headEvidence.parents[0] === priorIntent.headBefore
      && headEvidence.subject === priorIntent.expectedSubject
      && JSON.stringify(headEvidence.files) === JSON.stringify(expectedFiles);
    if (!recovered) {
      throw createApiError(409, 'BREAK_GLASS_COMMIT_OUTCOME_AMBIGUOUS', 'Emergency commit has no live owned diff and the current HEAD cannot be proven as the previously authorized exact commit.', {
        details: { head: snapshot.head, priorIntent, headEvidence },
      });
    }
    return completion(operation, task.id, workspace.workspaceId, {
      action: input.action,
      commit: headEvidence.commit,
      committedFiles: expectedFiles,
      unrelatedChangesPreserved: Array.isArray(priorIntent.unrelatedChanges) ? priorIntent.unrelatedChanges : [],
      verificationDebtPreserved: priorIntent.verificationDebtMode === true,
      recoveredAfterResponseLoss: true,
    }, operation.evidence || {}, priorIntent.bypassedGates || [], hardChecks, 'preserved-unrelated');
  }
  const allowedDebtBlockers = new Set(['EXECUTION_VERIFICATION_BATCH_FAILED', 'EXECUTION_VERIFICATION_NOT_FRESH']);
  const nonSoft = plan.blockers.filter((entry) => preserveVerificationDebt
    ? !allowedDebtBlockers.has(entry.code)
    : !SOFT_COMMIT_BLOCKERS.has(entry.code));
  if (nonSoft.length > 0) {
    throw createApiError(409, 'BREAK_GLASS_COMMIT_HARD_BLOCKER', 'Emergency commit may bypass only verification/freshness policy blockers.', {
      details: { blockers: nonSoft, allBlockers: plan.blockers },
    });
  }
  if (plan.ownedChangedFiles.length === 0) throw createApiError(409, 'TASK_COMMIT_NO_OWNED_CHANGES', 'No task-owned diff exists to commit.');
  const expectedOwnedFingerprint = clean(input.expectedOwnedFingerprint, 300);
  const ownership = getExecutionOwnershipState(plan.executionSessionId, { repoRoot: workspace.root });
  if (expectedOwnedFingerprint && expectedOwnedFingerprint !== ownership.ownedFingerprint) {
    throw createApiError(409, 'BREAK_GLASS_OWNED_FINGERPRINT_MISMATCH', 'Emergency commit fingerprint is stale.', {
      details: { expectedOwnedFingerprint, actualOwnedFingerprint: ownership.ownedFingerprint },
    });
  }
  if (priorIntent && (snapshot.head !== priorIntent.headBefore || ownership.ownedFingerprint !== priorIntent.ownedFingerprint)) {
    throw createApiError(409, 'BREAK_GLASS_COMMIT_INTENT_STALE', 'Emergency commit intent no longer matches the frozen HEAD/fingerprint.', {
      details: { currentHead: snapshot.head, currentOwnedFingerprint: ownership.ownedFingerprint, priorIntent },
    });
  }
  const candidateId = clean(input.expectedCandidateId, 200) || `break-glass:${operation.id}`;
  const bypassedGates = plan.blockers.map((entry) => entry.code);
  operation = updateAudit(operation, {
    evidence: {
      ...(operation.evidence || {}),
      commitIntent: {
        headBefore: snapshot.head,
        expectedSubject,
        ownedFiles: [...plan.ownedChangedFiles].sort(),
        unrelatedChanges: [...plan.unrelatedChangedFiles].sort(),
        repoRevision: ownership.repoRevision,
        ownedFingerprint: ownership.ownedFingerprint,
        candidateId,
        bypassedGates,
        verificationDebtMode: preserveVerificationDebt,
      },
    },
    bypassedGates,
    hardChecks,
    wipDisposition: 'preserved-unrelated',
  });
  if (preserveVerificationDebt) {
    const committed = commitTaskOwnedChanges(state, {
      taskId: task.id,
      workspaceId: workspace.workspaceId,
      message: rawMessage,
      preserveVerificationDebt: true,
      emergency: true,
      reason: input.reason,
      actorLabel: input.actorLabel,
      expectedCandidateId: candidateId,
    });
    const commitHash = (committed as any).commitHash || (committed as any).hash || null;
    injectBreakGlassFault('after-commit-side-effect');
    return completion(operation, task.id, workspace.workspaceId, {
      action: input.action,
      commit: commitHash,
      committedFiles: (committed as any).committedFiles || plan.ownedChangedFiles,
      unrelatedChangesPreserved: (committed as any).unrelatedChangesPreserved || plan.unrelatedChangedFiles,
      verificationDebtPreserved: (committed as any).verificationDebtPreserved === true,
      verificationDebt: (committed as any).verificationDebt || null,
    }, {
      ...(operation.evidence || {}),
      commit: commitHash,
      candidateId,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      verificationDebt: (committed as any).verificationDebt || null,
      planBlockersBypassed: bypassedGates,
    }, bypassedGates, hardChecks, 'preserved-unrelated');
  }

  const committed = commitTaskOwnedChanges(state, {
    taskId: task.id,
    workspaceId: workspace.workspaceId,
    message: rawMessage,
    ownerBreakGlass: {
      operationId: operation.id,
      reason: input.reason,
      actorLabel: input.actorLabel,
      expectedOwnedFingerprint: ownership.ownedFingerprint,
    },
  });
  const commitHash = (committed as any).commitHash || (committed as any).hash || null;
  injectBreakGlassFault('after-commit-side-effect');
  return completion(operation, task.id, workspace.workspaceId, {
    action: input.action,
    commit: commitHash,
    committedFiles: (committed as any).committedFiles || plan.ownedChangedFiles,
    unrelatedChangesPreserved: (committed as any).unrelatedChangesPreserved || plan.unrelatedChangedFiles,
    verificationDebtPreserved: false,
  }, {
    ...(operation.evidence || {}),
    commit: commitHash,
    candidateId,
    repoRevision: ownership.repoRevision,
    ownedFingerprint: ownership.ownedFingerprint,
    planBlockersBypassed: bypassedGates,
  }, bypassedGates, hardChecks, 'preserved-unrelated');
}

function normalizeRecoveryScopePath(value: unknown) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function recoveryPathCovered(filePath: string, scope: string[]) {
  const normalized = normalizeRecoveryScopePath(filePath);
  return scope.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

function executionRecoveryEvidence(sessionId: string) {
  const evidence = getExecutionSessionState(sessionId).evidence;
  const settledDebtIds = new Set(
    evidence
      .filter((entry: any) => entry.kind === 'verification-debt-settlement' && entry.metadata?.status === 'settled')
      .map((entry: any) => String(entry.metadata?.debtEvidenceId || '').trim())
      .filter(Boolean),
  );
  const outstandingDebts = evidence.filter((entry: any) => entry.kind === 'verification-debt'
    && entry.metadata?.status === 'outstanding'
    && !settledDebtIds.has(entry.id));
  const latestFailure = [...evidence].reverse().find((entry: any) => entry.kind === 'verification-result'
    && entry.metadata?.outcome === 'failed'
    && entry.metadata?.terminal === true) || null;
  const ownedPaths = evidence
    .filter((entry: any) => entry.kind === 'owned-change' && entry.path)
    .map((entry: any) => normalizeRecoveryScopePath(entry.path))
    .filter(Boolean);
  return { outstandingDebts, latestFailure, ownedPaths };
}

function executeDetachedIntegratedRecovery(
  state: AppState,
  operation: LifecycleEmergencyOperationRecord,
  input: BreakGlassLifecycleInput,
  task: any,
  hardChecks: Array<Record<string, unknown>>,
) {
  const workspaceId = clean(input.workspaceId, 200);
  const expectedCommit = clean(input.expectedCommit, 200);
  if (!workspaceId) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'reconcile-integrated-detached requires the exact historical workspaceId.');
  if (!expectedCommit) throw createApiError(400, 'BREAK_GLASS_EXPECTED_COMMIT_REQUIRED', 'reconcile-integrated-detached requires expectedCommit.');
  const project = getProject(task.projectId);
  if (!project?.localPath) throw createApiError(409, 'PROJECT_LOCAL_PATH_REQUIRED', 'Project local root is required to prove detached integrated Git evidence.');

  const liveMetadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
  if (liveMetadata && fs.existsSync(liveMetadata.root)) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_WORKSPACE_STILL_LIVE', 'Detached integrated recovery is forbidden while the selected managed workspace root is still available; use normal finalization.', {
      details: { workspaceId },
    });
  }

  const sessions = listExecutionSessionsForTask(task.id);
  const active = sessions.filter((entry) => entry.status === 'active');
  if (active.length > 1) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_EXECUTION_AMBIGUOUS', 'Detached integrated recovery requires at most one active execution authority.', {
      details: { executionSessionIds: active.map((entry) => entry.id), workspaceIds: active.map((entry) => entry.workspaceId) },
    });
  }
  if (active.length === 1 && !clean(input.executionSessionId, 200)) {
    throw createApiError(400, 'EXECUTION_SESSION_ID_REQUIRED', 'Active detached recovery requires the exact executionSessionId.');
  }
  if (active.length === 1 && !clean(input.ownershipEpochId, 200)) {
    throw createApiError(400, 'OWNERSHIP_EPOCH_ID_REQUIRED', 'Active detached recovery requires the exact ownershipEpochId.');
  }

  const requestedExecutionId = clean(input.executionSessionId, 200);
  const matchingWorkspaceSessions = sessions.filter((entry) => entry.workspaceId === workspaceId);
  const selected = requestedExecutionId
    ? validateExpectedExecution(task, input)
    : matchingWorkspaceSessions.length === 1 ? matchingWorkspaceSessions[0] : null;
  if (!selected) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_EXECUTION_AMBIGUOUS', 'Detached integrated recovery requires one exact historical execution bound to the lost workspace.', {
      details: { workspaceId, matchingExecutionSessionIds: matchingWorkspaceSessions.map((entry) => entry.id) },
    });
  }
  if (selected.projectId !== task.projectId || selected.taskId !== task.id || selected.workspaceId !== workspaceId) {
    throw createApiError(409, 'BREAK_GLASS_EXECUTION_IDENTITY_MISMATCH', 'Historical execution does not match the selected project/task/workspace identity.');
  }
  if (active.length === 1 && active[0].id !== selected.id) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_EXECUTION_AMBIGUOUS', 'Requested historical execution is not the unique active execution authority.');
  }
  const pending = pendingOperations(selected.id);
  if (pending.length > 0) {
    throw createApiError(409, 'BREAK_GLASS_PENDING_OPERATION', 'Detached integrated recovery cannot run while the selected execution has unresolved durable work.', {
      details: { pendingOperations: pending },
    });
  }

  const actualEpoch = String(getExecutionSessionOwnershipEpoch(selected.id).ownershipEpochId || '').trim();
  if (active.length === 1 && actualEpoch !== clean(input.ownershipEpochId, 200)) {
    throw createApiError(409, 'BREAK_GLASS_OWNERSHIP_EPOCH_MISMATCH', 'Active detached recovery ownership epoch no longer matches the selected execution.', {
      details: { expectedOwnershipEpochId: clean(input.ownershipEpochId, 200), actualOwnershipEpochId: actualEpoch || null },
    });
  }
  if (task.claim?.workspaceId && task.claim.workspaceId !== workspaceId) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_CLAIM_WORKSPACE_MISMATCH', 'Task claim points at a different workspace than detached recovery.', {
      details: { claimWorkspaceId: task.claim.workspaceId, workspaceId },
    });
  }
  if (task.claim?.ownershipEpochId && actualEpoch && task.claim.ownershipEpochId !== actualEpoch) {
    throw createApiError(409, 'BREAK_GLASS_OWNERSHIP_EPOCH_MISMATCH', 'Task claim and historical execution ownership epochs disagree.');
  }

  const baseRevision = String(selected.baseRevision || '').trim();
  if (!baseRevision) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_BASE_REVISION_MISSING', 'Historical execution lacks the frozen base revision required to prove its integrated diff.');
  }
  const baseSnapshot = getGitWorkspaceSnapshotForRoot(project.localPath);
  if (baseSnapshot.files.length > 0) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_BASE_DIRTY', 'Configured local base must be clean before detached integrated recovery.', {
      details: { changedFiles: baseSnapshot.files.map((entry) => entry.path).slice(0, 100) },
    });
  }
  const commitEvidence = getGitCommitEvidenceForRoot(project.localPath, expectedCommit);
  const repositoryPolicy = resolveProjectGitWorkflowPolicy(project, { repositoryRoot: project.localPath });
  if (!taskCommitSubjectMatchesPolicy(commitEvidence.subject, task, { gitWorkflowPolicy: repositoryPolicy } as any)) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_COMMIT_TASK_MISMATCH', 'Expected commit subject does not match the selected task/ticket policy.', {
      details: { expectedCommit: commitEvidence.commit, subject: commitEvidence.subject },
    });
  }
  const integration = reconstructRecordedWorkspaceIntegration({
    workspaceId,
    projectRoot: project.localPath,
    baseBranch: baseSnapshot.branch,
    sourceBranch: selected.branch || 'lost-workspace',
    baseRevision,
    sourceHead: commitEvidence.commit,
    strategy: repositoryPolicy.integrationStrategy,
  });
  if (integration.patchEquivalent === true) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_EXACT_ANCESTOR_REQUIRED', 'Detached integrated recovery requires expectedCommit itself to be an ancestor of the configured local base; patch equivalence is insufficient.');
  }
  if (integration.changedFiles.length === 0) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_DIFF_AMBIGUOUS', 'Expected integrated commit has no provable task diff from the historical execution base revision.');
  }

  let recovery = executionRecoveryEvidence(selected.id);
  const scope = Array.from(new Set([
    ...(Array.isArray(task.targetFiles) ? task.targetFiles : []),
    ...(Array.isArray(task.claim?.reservedPaths) ? task.claim.reservedPaths : []),
    ...(Array.isArray(selected.changedFiles) ? selected.changedFiles : []),
    ...recovery.ownedPaths,
  ].map(normalizeRecoveryScopePath).filter(Boolean)));
  if (scope.length === 0) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_SCOPE_AMBIGUOUS', 'No authoritative task-owned scope survives for detached integrated recovery.');
  }
  const outOfScope = integration.changedFiles.filter((entry) => !recoveryPathCovered(entry, scope));
  if (outOfScope.length > 0) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_DIFF_OUT_OF_SCOPE', 'Integrated commit changes paths outside authoritative task-owned scope.', {
      details: { outOfScope, authoritativeScope: scope },
    });
  }

  const latestFailureClass = String((recovery.latestFailure as any)?.metadata?.failureClass || '').trim();
  if (latestFailureClass === 'code') {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_CODE_FAILURE_REPAIR_REQUIRED', 'A prior code/assertion verification failure cannot be reclassified as infrastructure for detached recovery; normal repair evidence is required.', {
      details: { failureEvidenceId: recovery.latestFailure?.id || null },
    });
  }
  if (recovery.outstandingDebts.length > 1) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_VERIFICATION_DEBT_AMBIGUOUS', 'Multiple outstanding verification debts exist for the selected execution.', {
      details: { debtEvidenceIds: recovery.outstandingDebts.map((entry) => entry.id) },
    });
  }
  if (selected.status !== 'active' && selected.status !== 'completed') {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_EXECUTION_TERMINAL_INVALID', `Execution '${selected.id}' is terminal (${selected.status}) and cannot represent successful integrated recovery.`);
  }

  const checks = Array.isArray(input.checks) ? input.checks : [];
  const needsDebtCreation = recovery.outstandingDebts.length === 0 && latestFailureClass === 'infrastructure';
  const needsGreenBinding = selected.status === 'active'
    && (needsDebtCreation || recovery.outstandingDebts.length === 1);
  const revisionBoundGreen = checks.filter((check) => check?.status === 'passed' && String(check.repoRevision || '').trim() === integration.baseHeadAfter);
  if (needsGreenBinding && revisionBoundGreen.length === 0) {
    throw createApiError(409, 'BREAK_GLASS_DETACHED_GREEN_VERIFICATION_REQUIRED', 'Detached integrated recovery requires authoritative GREEN verification bound to the current configured base revision before debt settlement/finalization.', {
      details: { requiredRepoRevision: integration.baseHeadAfter },
    });
  }

  operation = updateAudit(operation, {
    evidence: {
      ...(operation.evidence || {}),
      detachedIntent: {
        workspaceId,
        executionSessionId: selected.id,
        ownershipEpochId: actualEpoch || null,
        expectedCommit: commitEvidence.commit,
        baseRevision,
        baseBranch: integration.baseBranch,
        integratedRevision: integration.baseHeadAfter,
        changedFiles: integration.changedFiles,
        authoritativeScope: scope,
        verificationDebtEvidenceId: recovery.outstandingDebts[0]?.id || null,
      },
    },
    hardChecks,
    bypassedGates: ['WORKSPACE_METADATA_OR_ROOT_MISSING'],
    wipDisposition: 'already-integrated-workspace-unavailable',
  });

  if (needsDebtCreation) {
    const debtEvidenceId = `verification-debt:detached:${operation.id}`;
    recordExecutionSessionEvidence(selected.id, [{
      evidenceId: debtEvidenceId,
      kind: 'verification-debt',
      revisionIdentity: commitEvidence.commit,
      metadata: {
        status: 'outstanding',
        commitHash: commitEvidence.commit,
        candidateId: `detached-integrated:${operation.id}`,
        failureEvidenceId: recovery.latestFailure?.id || null,
        failureClass: 'infrastructure',
        authorization: { emergency: true, reason: input.reason, actorLabel: input.actorLabel },
        recordedAt: new Date().toISOString(),
      },
    }]);
    recovery = executionRecoveryEvidence(selected.id);
  }

  let ownership = getExecutionOwnershipState(selected.id, { repoRoot: project.localPath });
  if (needsGreenBinding) {
    const candidateId = `detached-integrated:${operation.id}:${integration.baseHeadAfter}`;
    const bound = recordExecutionVerificationEvidence(selected.id, revisionBoundGreen, {
      repoRoot: project.localPath,
      provenance: {
        policy: 'checks-passed',
        expectedRepoRevision: ownership.repoRevision,
        expectedOwnedFingerprint: ownership.ownedFingerprint,
        candidateId,
        candidateRepoRevision: ownership.repoRevision,
        executionKey: `detached-integrated:${operation.id}`,
      },
    });
    if (bound.ownership.verificationFresh !== true) {
      throw createApiError(409, 'BREAK_GLASS_DETACHED_GREEN_BINDING_NOT_FRESH', 'GREEN verification could not be bound authoritatively to the current integrated candidate.');
    }
    ownership = bound.ownership;
    recovery = executionRecoveryEvidence(selected.id);
    const debt = recovery.outstandingDebts[0] || null;
    if (debt) {
      recordExecutionSessionEvidence(selected.id, [{
        evidenceId: `detached:${operation.id}:verification-debt-settlement`,
        kind: 'verification-debt-settlement',
        revisionIdentity: integration.baseHeadAfter,
        metadata: {
          status: 'settled',
          debtEvidenceId: debt.id,
          commitHash: commitEvidence.commit,
          operationId: operation.id,
          repoRevision: integration.baseHeadAfter,
          settledAt: new Date().toISOString(),
        },
      }]);
    }
    injectBreakGlassFault('after-detached-green-settlement');
  }

  const finalized = finalizeTaskWorkspace(state, {
    taskId: task.id,
    workspaceId,
    operationId: clean(input.finalizationOperationId, 200) || undefined,
    checks,
    requireChecklistComplete: false,
    detachedIntegrated: {
      sourceHead: commitEvidence.commit,
      baseRevision,
      baseBranch: integration.baseBranch,
      executionSessionId: selected.id,
      ownershipEpochId: actualEpoch || null,
      candidateId: `detached-integrated:${operation.id}`,
      candidateRepoRevision: integration.baseHeadAfter,
      ownedFingerprint: ownership.ownedFingerprint,
      integration,
    },
  });
  injectBreakGlassFault('after-detached-finalization-side-effect');
  if (finalized.status !== 'completed') {
    return updateAudit(operation, {
      status: 'partial',
      result: { action: input.action, finalization: finalized as any },
      evidence: {
        ...(operation.evidence || {}),
        expectedCommit: commitEvidence.commit,
        integratedRevision: integration.baseHeadAfter,
        finalizationOperationId: finalized.operation?.id || null,
      },
      hardChecks,
      wipDisposition: 'already-integrated-workspace-unavailable',
      afterSnapshot: compactAuthority(computeLifecycleAuthoritySnapshot(task.id, { workspaceId })),
      failure: { code: finalized.code || 'FINALIZATION_CONTINUATION_REQUIRED', message: finalized.message || 'Detached finalization requires continuation.', observedAt: new Date().toISOString() },
    });
  }
  return completion(operation, task.id, workspaceId, {
    action: input.action,
    finalizationStatus: finalized.status,
    finalizationOperationId: finalized.operation?.id || null,
    integratedRevision: integration.baseHeadAfter,
    verificationDebtSettled: executionRecoveryEvidence(selected.id).outstandingDebts.length === 0,
  }, {
    ...(operation.evidence || {}),
    expectedCommit: commitEvidence.commit,
    integratedRevision: integration.baseHeadAfter,
    changedFiles: integration.changedFiles,
  }, ['WORKSPACE_METADATA_OR_ROOT_MISSING'], hardChecks, 'already-integrated-workspace-unavailable');
}

function executeFinalizeAsIntegrated(state: AppState, operation: LifecycleEmergencyOperationRecord, input: BreakGlassLifecycleInput, task: any, workspace: NonNullable<ReturnType<typeof expectedWorkspace>>, hardChecks: Array<Record<string, unknown>>) {
  const expectedCommit = clean(input.expectedCommit, 200);
  if (!expectedCommit) throw createApiError(400, 'BREAK_GLASS_EXPECTED_COMMIT_REQUIRED', 'finalize-as-integrated requires expectedCommit.');
  const project = getProject(task.projectId);
  if (!project?.localPath) throw createApiError(409, 'PROJECT_LOCAL_PATH_REQUIRED', 'Project local root is required to prove integrated Git evidence.');
  const inspection = inspectWorkspaceRecovery(workspace.workspaceId);
  if (inspection.sourceHead !== expectedCommit) {
    throw createApiError(409, 'BREAK_GLASS_SOURCE_COMMIT_MISMATCH', 'Expected commit does not match the exact managed workspace source HEAD.', {
      details: { expectedCommit, sourceHead: inspection.sourceHead || null },
    });
  }
  const reconstructed = reconstructRecordedWorkspaceIntegration({
    workspaceId: workspace.workspaceId,
    projectRoot: project.localPath,
    baseBranch: workspace.baseBranch,
    sourceBranch: workspace.branch,
    baseRevision: workspace.baseRevision,
    sourceHead: expectedCommit,
    strategy: workspace.gitWorkflowPolicy?.integrationStrategy || 'rebase-ff',
  });
  const finalized = finalizeTaskWorkspace(state, {
    taskId: task.id,
    workspaceId: workspace.workspaceId,
    operationId: clean(input.finalizationOperationId, 200) || undefined,
    checks: Array.isArray(input.checks) ? input.checks : [],
    requireChecklistComplete: false,
  });
  if (finalized.status !== 'completed' && finalized.status !== 'cleanup-pending') {
    return updateAudit(operation, {
      status: 'partial',
      result: { action: input.action, finalization: finalized as any },
      evidence: { expectedCommit, integratedRevision: reconstructed.baseHeadAfter, finalizationOperationId: finalized.operation?.id || null },
      hardChecks,
      wipDisposition: 'preserved',
      afterSnapshot: compactAuthority(computeLifecycleAuthoritySnapshot(task.id, { workspaceId: workspace.workspaceId })),
      failure: { code: finalized.code || 'FINALIZATION_CONTINUATION_REQUIRED', message: finalized.message || 'Finalization requires continuation.', observedAt: new Date().toISOString() },
    });
  }
  return completion(operation, task.id, workspace.workspaceId, {
    action: input.action,
    finalizationStatus: finalized.status,
    finalizationOperationId: finalized.operation?.id || null,
    integratedRevision: reconstructed.baseHeadAfter,
  }, { expectedCommit, integratedRevision: reconstructed.baseHeadAfter }, [], hardChecks, finalized.status === 'cleanup-pending' ? 'cleanup-pending' : 'cleaned-or-safe');
}

function executeSupersede(operation: LifecycleEmergencyOperationRecord, input: BreakGlassLifecycleInput, task: any, workspace: ReturnType<typeof expectedWorkspace>, hardChecks: Array<Record<string, unknown>>) {
  const replacement = input.replacement || {};
  if (!input.noReplacement && !clean(replacement.taskId) && !clean(replacement.executionSessionId) && !clean(replacement.workspaceId) && !clean(replacement.commit)) {
    throw createApiError(400, 'BREAK_GLASS_REPLACEMENT_REQUIRED', 'Supersession requires an explicit replacement identity or noReplacement=true.');
  }
  const targeted = validateExpectedExecution(task, input);
  if (input.action === 'supersede-execution') {
    if (!targeted) throw createApiError(400, 'EXECUTION_SESSION_ID_REQUIRED', 'supersede-execution requires executionSessionId.');
    const pending = pendingOperations(targeted.id);
    if (pending.length > 0) throw createApiError(409, 'BREAK_GLASS_PENDING_OPERATION', 'Target execution has unresolved durable work and cannot be superseded yet.', { details: { pendingOperations: pending } });
    if (targeted.status === 'active') cancelExecutionSession(targeted.id);
    recordExecutionReconciliationEvidence(targeted.id, 'operator-break-glass-superseded', { operationId: operation.id, replacement, noReplacement: input.noReplacement === true, reason: input.reason });
  } else {
    if (task.claim) releaseTaskClaim(task.id, { sessionId: '', emergency: true, nextStatus: 'todo' });
  }
  const freshTask = getTaskByIdentifier(task.id, 'full') || task;
  const now = new Date().toISOString();
  const logId = `log-break-glass-supersede-${operation.id}`;
  if (!(freshTask.logs || []).some((entry: any) => entry.id === logId)) {
    saveTask({
      ...freshTask,
      logs: [...(freshTask.logs || []), { id: logId, timestamp: now, message: `Audited break-glass supersession: ${input.reason}`, type: 'update' }],
      updatedAt: now,
    });
  }
  const missingWorkspaceSupersession = input.action === 'supersede-execution' && targeted && !workspace
    ? {
        executionSessionId: targeted.id,
        recordedWorkspaceId: clean(targeted.workspaceId, 200) || null,
        requestedWorkspaceId: clean(input.workspaceId, 200) || null,
        workspaceMetadataAvailable: false,
      }
    : null;
  return completion(operation, task.id, workspace?.workspaceId, {
    action: input.action,
    supersededExecutionSessionId: targeted?.id || null,
    replacement,
    noReplacement: input.noReplacement === true,
  }, {
    ...(operation.evidence || {}),
    replacement,
    noReplacement: input.noReplacement === true,
    ...(missingWorkspaceSupersession ? { missingWorkspaceSupersession } : {}),
  }, missingWorkspaceSupersession ? ['SUPERSESSION_POLICY', 'WORKSPACE_METADATA_MISSING'] : ['SUPERSESSION_POLICY'], hardChecks, 'preserved');
}

export function executeBreakGlassLifecycle(state: AppState, input: BreakGlassLifecycleInput) {
  const required = requireInput(input);
  const task = getTaskByIdentifier(required.taskId, 'full');
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${required.taskId}' was not found.`, { affectedId: required.taskId });
  const normalizedRequest = {
    ...input,
    operationId: required.operationId,
    reason: required.reason,
    actorLabel: required.actorLabel,
    projectId: required.projectId,
    taskId: task.id,
    action: required.action,
  };
  const requestDigest = stableDigest(normalizedRequest);

  return withSyncLock(`break-glass:${task.id}:${required.operationId}`, () => {
    const existing = getLifecycleEmergencyOperation(required.operationId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw createApiError(409, 'BREAK_GLASS_OPERATION_REPLAY_MISMATCH', 'operationId was already used for a different break-glass request.', { affectedId: existing.id });
      }
      if (existing.status === 'completed' || existing.status === 'rejected') return { replayed: true, operation: existing, result: existing.result };
    }

    let before: ReturnType<typeof computeLifecycleAuthoritySnapshot>;
    const requestedWorkspaceId = clean(input.workspaceId, 200);
    const missingSupersedeWorkspace = input.action === 'supersede-execution'
      && requestedWorkspaceId
      && !getSessionWorkspaceMetadataForRecovery(requestedWorkspaceId);
    try {
      before = computeLifecycleAuthoritySnapshot(task.id, {
        workspaceId: missingSupersedeWorkspace ? undefined : input.workspaceId,
      });
    } catch (error) { throw error; }
    let operation = existing || createLifecycleEmergencyOperation({
      id: required.operationId,
      requestDigest,
      action: required.action,
      projectId: task.projectId,
      taskId: task.id,
      workspaceId: clean(input.workspaceId, 200) || null,
      executionSessionId: clean(input.executionSessionId, 200) || null,
      ownershipEpochId: clean(input.ownershipEpochId, 200) || null,
      actorLabel: required.actorLabel,
      reason: required.reason,
      status: 'active',
      request: normalizedRequest as any,
      beforeSnapshot: compactAuthority(before),
      afterSnapshot: null,
      bypassedGates: [],
      hardChecks: [],
      evidence: {},
      wipDisposition: 'preserved',
      result: null,
      failure: null,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    });
    if (existing) operation = updateAudit(operation, { retryCount: operation.retryCount + 1, failure: null });

    let hardChecks: Array<Record<string, unknown>> = [];
    try {
      if (task.projectId !== required.projectId) throw createApiError(409, 'BREAK_GLASS_PROJECT_IDENTITY_MISMATCH', 'Selected task belongs to a different project than the break-glass request.', { details: { requestedProjectId: required.projectId, actualProjectId: task.projectId } });
      const project = getProject(task.projectId);
      if (!project) throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${task.projectId}' was not found.`);
      const priorDiscardIntent = (operation.evidence as any)?.discardIntent;
      if (input.action === 'discard-wip' && input.destructiveAck === true && priorDiscardIntent && requestedWorkspaceId && !getSessionWorkspaceMetadataForRecovery(requestedWorkspaceId)) {
        return { replayed: false, operation: completion(operation, task.id, undefined, {
          action: input.action,
          cleanup: { removed: true, workspaceId: requestedWorkspaceId, recoveredAfterResponseLoss: true },
        }, operation.evidence || {}, operation.bypassedGates || ['DIRTY_WIP_PRESERVATION'], operation.hardChecks || [], 'discarded-explicitly') };
      }
      const workspaceRequired = !['supersede-task-work', 'supersede-execution', 'reconcile-integrated-detached'].includes(input.action);
      const supersedeExecutionContext = input.action === 'supersede-execution'
        ? resolveSupersedeExecutionWorkspace(task, input)
        : null;
      const workspace = input.action === 'reconcile-integrated-detached'
        ? null
        : supersedeExecutionContext
          ? supersedeExecutionContext.workspace
          : expectedWorkspace(task, input, workspaceRequired);
      const authority = computeLifecycleAuthoritySnapshot(task.id, { workspaceId: workspace?.workspaceId || input.workspaceId });
      assertCurrentCandidate(authority, input);
      hardChecks = hardSafetyChecks(authority, input);
      if (!supersedeExecutionContext) validateExpectedExecution(task, input);

      if (input.action === 'commit-current-owned-diff') {
        if (!workspace) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'Emergency commit requires workspaceId.');
        return { replayed: false, operation: executeCommitBreakGlass(state, operation, input, task, workspace, authority, hardChecks) };
      }

      if (input.action === 'release-ownership-preserve-wip') {
        const targeted = validateExpectedExecution(task, input);
        if (targeted && pendingOperations(targeted.id).length > 0) throw createApiError(409, 'BREAK_GLASS_PENDING_OPERATION', 'Cannot release ownership while the targeted execution has unresolved durable work.');
        const released = releaseTaskClaim(task.id, { sessionId: '', emergency: true, nextStatus: 'todo' });
        return { replayed: false, operation: completion(operation, task.id, workspace?.workspaceId, { action: input.action, released: released.released }, {}, ['CLAIM_OWNER_OR_PRESENTATION_POLICY'], hardChecks, 'preserved') };
      }

      if (input.action === 'rotate-execution-preserve-wip') {
        if (!workspace) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'Execution rotation requires workspaceId.');
        const targeted = validateExpectedExecution(task, input);
        if (!targeted) throw createApiError(400, 'EXECUTION_SESSION_ID_REQUIRED', 'Execution rotation requires executionSessionId.');
        const pending = pendingOperations(targeted.id);
        if (pending.length > 0) throw createApiError(409, 'BREAK_GLASS_PENDING_OPERATION', 'Cannot rotate an execution with unresolved durable work.', { details: { pendingOperations: pending } });
        const replacementSessionId = clean(input.replacementSessionId, 300);
        if (!replacementSessionId) throw createApiError(400, 'BREAK_GLASS_REPLACEMENT_SESSION_REQUIRED', 'rotate-execution-preserve-wip requires replacementSessionId.');
        const replacementHash = sessionIdHash(replacementSessionId);
        const currentTask = getTaskByIdentifier(task.id, 'full') || task;
        const currentAuthority = computeLifecycleAuthoritySnapshot(task.id, { workspaceId: workspace.workspaceId });
        const priorRotationIntent = (operation.evidence as any)?.rotationIntent;
        if (priorRotationIntent && targeted.status !== 'active'
          && currentTask.claim?.workspaceId === workspace.workspaceId
          && currentTask.claim?.sessionIdHash === replacementHash
          && currentAuthority.execution.current?.id
          && currentAuthority.execution.current.id !== targeted.id) {
          return { replayed: false, operation: completion(operation, task.id, workspace.workspaceId, {
            action: input.action,
            oldExecutionSessionId: targeted.id,
            replacementExecutionSessionId: currentAuthority.execution.current.id,
            replacementWorkspaceId: workspace.workspaceId,
            replacementOwnershipEpochId: currentTask.claim.ownershipEpochId,
            recoveredAfterResponseLoss: true,
          }, operation.evidence || {}, ['EXECUTION_STAGE_OR_CLAIM_OWNER_POLICY'], hardChecks, 'preserved') };
        }
        operation = updateAudit(operation, {
          evidence: {
            ...(operation.evidence || {}),
            rotationIntent: {
              oldExecutionSessionId: targeted.id,
              oldOwnershipEpochId: getExecutionSessionOwnershipEpoch(targeted.id).ownershipEpochId,
              workspaceId: workspace.workspaceId,
              replacementSessionHash: replacementHash,
            },
          },
          bypassedGates: ['EXECUTION_STAGE_OR_CLAIM_OWNER_POLICY'],
          hardChecks,
          wipDisposition: 'preserved',
        });
        if (currentTask.claim) releaseTaskClaim(task.id, { sessionId: '', emergency: true, nextStatus: 'todo' });
        const claimed = claimTaskForSession(task.id, { sessionId: replacementSessionId, ownerKind: 'chat', ownerLabel: input.actorLabel });
        if (claimed.workspace.workspaceId !== workspace.workspaceId) {
          throw createApiError(409, 'BREAK_GLASS_ROTATION_WORKSPACE_CHANGED', 'Execution rotation must reuse the exact preserved managed workspace.', { details: { expectedWorkspaceId: workspace.workspaceId, actualWorkspaceId: claimed.workspace.workspaceId } });
        }
        const replacementAuthority = computeLifecycleAuthoritySnapshot(task.id, { workspaceId: workspace.workspaceId });
        injectBreakGlassFault('after-rotation-side-effect');
        return { replayed: false, operation: completion(operation, task.id, workspace.workspaceId, {
          action: input.action,
          oldExecutionSessionId: targeted.id,
          replacementExecutionSessionId: replacementAuthority.execution.current?.id || null,
          replacementWorkspaceId: claimed.workspace.workspaceId,
          replacementOwnershipEpochId: claimed.claim.ownershipEpochId,
        }, operation.evidence || {}, ['EXECUTION_STAGE_OR_CLAIM_OWNER_POLICY'], hardChecks, 'preserved') };
      }

      if (input.action === 'reconcile-integrated-detached') {
        return { replayed: false, operation: executeDetachedIntegratedRecovery(state, operation, input, task, hardChecks) };
      }

      if (input.action === 'finalize-as-integrated') {
        if (!workspace) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'finalize-as-integrated requires workspaceId.');
        return { replayed: false, operation: executeFinalizeAsIntegrated(state, operation, input, task, workspace, hardChecks) };
      }

      if (input.action === 'supersede-execution' || input.action === 'supersede-task-work') {
        return { replayed: false, operation: executeSupersede(operation, input, task, workspace, hardChecks) };
      }

      if (input.action === 'discard-wip') {
        if (!workspace) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'discard-wip requires workspaceId.');
        if (input.destructiveAck !== true) throw createApiError(409, 'BREAK_GLASS_DESTRUCTIVE_ACK_REQUIRED', 'discard-wip requires destructiveAck=true in addition to emergency intent.');
        const targeted = validateExpectedExecution(task, input);
        if (targeted && pendingOperations(targeted.id).length > 0) throw createApiError(409, 'BREAK_GLASS_PENDING_OPERATION', 'Cannot discard WIP while the targeted execution has unresolved durable work.');
        const inspection = inspectWorkspaceRecovery(workspace.workspaceId);
        const discardedEvidence = {
          workspaceId: workspace.workspaceId,
          dirtyFiles: inspection.dirtyFiles.slice(0, 200),
          sourceHead: inspection.sourceHead || null,
          baseHead: inspection.baseHead || null,
          disposition: inspection.disposition,
        };
        operation = updateAudit(operation, {
          evidence: { ...(operation.evidence || {}), discardIntent: discardedEvidence },
          bypassedGates: ['DIRTY_WIP_PRESERVATION'],
          hardChecks,
          wipDisposition: 'discard-authorized-pending',
        });
        if (task.claim) releaseTaskClaim(task.id, { sessionId: '', emergency: true, nextStatus: 'todo' });
        try {
          const cleanup = cleanupSessionWorkspace(workspace.workspaceId, { force: true });
          injectBreakGlassFault('after-discard-side-effect');
          return { replayed: false, operation: completion(operation, task.id, undefined, { action: input.action, cleanup }, operation.evidence || {}, ['DIRTY_WIP_PRESERVATION'], hardChecks, 'discarded-explicitly') };
        } catch (cleanupError: any) {
          if (cleanupError?.code === 'BREAK_GLASS_FAULT_INJECTED') throw cleanupError;
          operation = updateAudit(operation, {
            status: 'partial',
            afterSnapshot: compactAuthority(computeLifecycleAuthoritySnapshot(task.id)),
            failure: failureRecord(cleanupError),
            result: { action: input.action, cleanupPending: true, workspaceId: workspace.workspaceId },
          });
          return { replayed: false, operation };
        }
      }

      throw createApiError(400, 'BREAK_GLASS_ACTION_INVALID', `Unsupported break-glass action '${input.action}'.`);
    } catch (error: any) {
      if (error?.code === 'BREAK_GLASS_FAULT_INJECTED') throw error;
      operation = rejected(operation, error, hardChecks);
      throw createApiError(error?.status || error?.payload?.status || 409, error?.payload?.code || error?.code || 'BREAK_GLASS_FAILED', error?.payload?.message || error?.message || 'Break-glass lifecycle action failed.', {
        affectedId: task.id,
        details: { ...(error?.payload?.details || error?.details || {}), operationId: operation.id, auditStatus: operation.status },
      });
    }
  });
}

export function getBreakGlassLifecycleOperation(operationId: string) {
  const id = clean(operationId, 200);
  if (!id) throw createApiError(400, 'BREAK_GLASS_OPERATION_ID_REQUIRED', 'operationId is required.');
  const operation = getLifecycleEmergencyOperation(id);
  if (!operation) throw createApiError(404, 'BREAK_GLASS_OPERATION_NOT_FOUND', `Break-glass operation '${id}' was not found.`, { affectedId: id });
  return operation;
}

export function listBreakGlassLifecycleOperations(args: { projectId?: string; taskId?: string; status?: any; limit?: number } = {}) {
  return listLifecycleEmergencyOperations(args);
}
