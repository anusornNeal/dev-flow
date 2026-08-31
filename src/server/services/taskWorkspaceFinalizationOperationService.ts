import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AppState } from '../types.js';
import { getProject } from '../repositories/projectRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import {
  createTaskFinalizationOperation,
  getLatestTaskFinalizationOperation,
  getTaskFinalizationOperation,
  updateTaskFinalizationOperation,
  type TaskFinalizationOperationRecord,
} from '../repositories/taskFinalizationOperationRepository.js';
import { createApiError } from './api.js';
import { getExecutionSessionOwnershipEpoch } from './executionSessionService.js';
import { evaluateExecutionContinuation } from './executionContinuationService.js';
import { computeLifecycleAuthoritySnapshot } from './lifecycleAuthorityService.js';
import { getRepoRevisionForRoot } from './repoRevisionService.js';
import { getSessionWorkspaceMetadataForRecovery } from './sessionWorkspaceService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';
import {
  integrateWorkspaceCommits,
  reconstructRecordedWorkspaceIntegration,
  type WorkspaceIntegrationSuccess,
} from './workspaceIntegrationService.js';
import type { TaskWorkspaceFinalizationCheck } from './taskWorkspaceFinalizationVerificationService.js';

const recordedIntegrationValidationMetrics = {
  durableHeadMatch: 0,
  reconstructed: 0,
};

export function __resetRecordedIntegrationValidationMetricsForTests() {
  recordedIntegrationValidationMetrics.durableHeadMatch = 0;
  recordedIntegrationValidationMetrics.reconstructed = 0;
}

export function __getRecordedIntegrationValidationMetricsForTests() {
  return { ...recordedIntegrationValidationMetrics };
}

export type DetachedIntegratedFinalizationEvidence = {
  sourceHead: string;
  baseRevision: string;
  baseBranch: string;
  executionSessionId: string | null;
  ownershipEpochId: string | null;
  candidateId?: string | null;
  candidateRepoRevision?: string | null;
  ownedFingerprint?: string | null;
  integration: WorkspaceIntegrationSuccess;
};

function finalizationOperationIdentity(input: {
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
  completedChecklistIds: string[];
}) {
  const digest = crypto.createHash('sha256');
  for (const value of [
    input.taskId,
    input.workspaceId,
    input.executionSessionId || '',
    input.ownershipEpochId || '',
    input.sourceHead,
    input.baseRevision,
    input.baseBranch,
    input.candidateId || '',
    input.candidateRepoRevision || '',
    input.ownedFingerprint || '',
    ...input.completedChecklistIds,
  ]) {
    digest.update(String(value));
    digest.update('\0');
  }
  return `finalize-${digest.digest('hex').slice(0, 32)}`;
}

export function operationFailure(error: any, phase: string, boundary?: string) {
  return {
    phase,
    ...(boundary ? { boundary } : {}),
    code: String(error?.payload?.code || error?.code || 'TASK_FINALIZATION_FAILED').slice(0, 160),
    message: String(error?.payload?.message || error?.message || 'Task finalization failed.').slice(0, 500),
    observedAt: new Date().toISOString(),
  };
}

export function updateOperation(
  operation: TaskFinalizationOperationRecord,
  patch: Parameters<typeof updateTaskFinalizationOperation>[1],
) {
  return updateTaskFinalizationOperation(operation.id, {
    ...patch,
    updatedAt: new Date().toISOString(),
  }) || operation;
}

export function executionContinuationForOperation(
  state: AppState,
  operation: TaskFinalizationOperationRecord,
) {
  if (!operation.executionSessionId) return null;
  try {
    return evaluateExecutionContinuation(state, operation.executionSessionId, {
      workspaceId: operation.workspaceId,
    });
  } catch {
    return null;
  }
}

export function operationContinuation(
  state: AppState,
  operation: TaskFinalizationOperationRecord,
  code: 'POST_INTEGRATION_FINALIZATION_REQUIRED' | 'POST_INTEGRATION_VERIFICATION_REQUIRED',
  message: string,
  context: Record<string, unknown> = {},
) {
  const current = getTaskFinalizationOperation(operation.id) || operation;
  const executionContinuation = executionContinuationForOperation(state, operation);
  return {
    status: 'continuation' as const,
    code,
    message,
    operation: current,
    ...(executionContinuation ? { executionContinuation } : {}),
    continuation: {
      code,
      operationId: operation.id,
      phase: current.phase,
      error: current.failure || undefined,
      nextAction: {
        action: 'RETRY_FINALIZE_TASK_WORKSPACE' as const,
        tool: 'finalize_task_workspace' as const,
        operationId: operation.id,
        reintegrate: false as const,
      },
    },
    ...context,
  };
}

function assertTaskFinalizationBranchAuthority(task: any, baseBranch: string, workspaceId: string) {
  const taskBranch = String(task?.branch || '').trim();
  if (!taskBranch || taskBranch === baseBranch) return;
  throw createApiError(
    409,
    'TASK_WORKSPACE_BRANCH_AUTHORITY_MISMATCH',
    `Task '${task.displayId || task.id}' targets '${taskBranch}', but finalization is frozen to '${baseBranch}'.`,
    {
      affectedId: task.id,
      details: { taskBranch, workspaceBaseBranch: baseBranch, workspaceId },
    },
  );
}

export function freezeNewFinalizationOperation(
  task: any,
  workspaceId: string,
  submittedChecks: TaskWorkspaceFinalizationCheck[],
  completedChecklistIds: string[],
) {
  const metadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
  if (!metadata) {
    throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, {
      affectedId: workspaceId,
    });
  }
  if (metadata.projectId !== task.projectId) {
    throw createApiError(409, 'TASK_WORKSPACE_PROJECT_MISMATCH', 'Task and workspace belong to different projects.', {
      affectedId: task.id,
      details: { taskProjectId: task.projectId, workspaceProjectId: metadata.projectId },
    });
  }
  assertTaskFinalizationBranchAuthority(task, metadata.baseBranch, workspaceId);

  const inspection = inspectWorkspaceRecovery(workspaceId);
  if (inspection.dirtyFiles.length > 0) {
    return { blocked: { status: 'needs-recovery' as const, code: 'WORKSPACE_DIRTY' as const, inspection } };
  }
  if (inspection.disposition === 'stale-registry' || inspection.disposition === 'needs-recovery') {
    return {
      blocked: {
        status: 'needs-recovery' as const,
        code: 'WORKSPACE_RECOVERY_REQUIRED' as const,
        inspection,
      },
    };
  }
  const sourceHead = String(inspection.sourceHead || '').trim();
  if (!sourceHead) {
    throw createApiError(
      409,
      'FINALIZATION_SOURCE_HEAD_REQUIRED',
      'A committed source HEAD is required before finalization.',
      { affectedId: workspaceId },
    );
  }

  const active = listExecutionSessionsForTask(task.id).filter((entry) => entry.status === 'active');
  const scoped = active.filter((entry) => entry.workspaceId === workspaceId);
  const foreign = active.filter((entry) => entry.workspaceId !== workspaceId);
  if (scoped.length > 1 || foreign.length > 0) {
    throw createApiError(
      409,
      'TASK_FINALIZATION_EXECUTION_AMBIGUOUS',
      'Finalization requires one bounded execution authority for the selected workspace.',
      {
        affectedId: task.id,
        details: {
          workspaceId,
          scopedExecutionSessionIds: scoped.map((entry) => entry.id),
          foreignExecutionSessionIds: foreign.map((entry) => entry.id),
        },
      },
    );
  }
  const execution = scoped[0] || null;
  const ownershipEpochId = execution
    ? getExecutionSessionOwnershipEpoch(execution.id).ownershipEpochId
    : String(task.claim?.ownershipEpochId || '').trim() || null;
  let authority: ReturnType<typeof computeLifecycleAuthoritySnapshot> | null = null;
  try {
    authority = computeLifecycleAuthoritySnapshot(task.id, { workspaceId });
  } catch {}
  const candidate = authority?.verification.candidate || null;
  const frozen = {
    taskId: task.id,
    workspaceId,
    executionSessionId: execution?.id || null,
    ownershipEpochId: ownershipEpochId || null,
    sourceHead,
    baseRevision: metadata.baseRevision,
    baseBranch: metadata.baseBranch,
    candidateId: candidate?.candidateId || null,
    candidateRepoRevision: candidate?.repoRevision || null,
    ownedFingerprint: authority?.verification.ownedFingerprint || null,
  };
  const id = finalizationOperationIdentity({ ...frozen, completedChecklistIds });
  const now = new Date().toISOString();
  const operation = createTaskFinalizationOperation({
    id,
    projectId: task.projectId,
    ...frozen,
    phase: 'frozen',
    status: 'active',
    verification: { submittedChecks, completedChecklistIds },
    createdAt: now,
    updatedAt: now,
  });
  return { operation, metadata, inspection };
}

export function freezeDetachedIntegratedFinalizationOperation(
  task: any,
  workspaceId: string,
  submittedChecks: TaskWorkspaceFinalizationCheck[],
  completedChecklistIds: string[],
  detached: DetachedIntegratedFinalizationEvidence,
) {
  const metadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
  if (metadata && fs.existsSync(metadata.root)) {
    throw createApiError(
      409,
      'DETACHED_FINALIZATION_LIVE_WORKSPACE',
      'Detached integrated finalization is allowed only when the selected managed workspace root is unavailable.',
      { affectedId: workspaceId },
    );
  }
  const integration = detached.integration;
  assertTaskFinalizationBranchAuthority(task, detached.baseBranch, workspaceId);

  if (
    integration.workspaceId !== workspaceId
    || integration.sourceHead !== detached.sourceHead
    || integration.baseRevision !== detached.baseRevision
    || integration.baseBranch !== detached.baseBranch
    || integration.status !== 'succeeded'
    || integration.alreadyIntegrated !== true
    || integration.patchEquivalent === true
  ) {
    throw createApiError(
      409,
      'DETACHED_FINALIZATION_EVIDENCE_MISMATCH',
      'Detached finalization requires exact already-integrated evidence bound to the selected task/workspace/base revision.',
      { affectedId: workspaceId, details: { integration } },
    );
  }
  const frozen = {
    taskId: task.id,
    workspaceId,
    executionSessionId: detached.executionSessionId || null,
    ownershipEpochId: detached.ownershipEpochId || null,
    sourceHead: detached.sourceHead,
    baseRevision: detached.baseRevision,
    baseBranch: detached.baseBranch,
    candidateId: detached.candidateId || null,
    candidateRepoRevision: detached.candidateRepoRevision || null,
    ownedFingerprint: detached.ownedFingerprint || null,
  };
  const id = finalizationOperationIdentity({ ...frozen, completedChecklistIds });
  const now = new Date().toISOString();
  const operation = createTaskFinalizationOperation({
    id,
    projectId: task.projectId,
    ...frozen,
    phase: 'frozen',
    status: 'active',
    integration: integration as any,
    verification: {
      submittedChecks,
      completedChecklistIds,
      detachedIntegrated: true,
      detachedEvidence: {
        sourceHead: detached.sourceHead,
        baseRevision: detached.baseRevision,
        baseBranch: detached.baseBranch,
        executionSessionId: detached.executionSessionId || null,
        ownershipEpochId: detached.ownershipEpochId || null,
      },
    },
    createdAt: now,
    updatedAt: now,
  });
  return { operation };
}

export function isDetachedIntegratedOperation(operation: TaskFinalizationOperationRecord | null | undefined) {
  return operation?.verification?.detachedIntegrated === true;
}

export function assertOperationStillBound(
  operation: TaskFinalizationOperationRecord,
  task: any,
  metadata: ReturnType<typeof getSessionWorkspaceMetadataForRecovery>,
) {
  if (operation.taskId !== task.id || operation.projectId !== task.projectId) {
    throw createApiError(409, 'FINALIZATION_OPERATION_TASK_MISMATCH', 'Finalization operation is bound to another task/project.', {
      affectedId: operation.id,
      details: { operationTaskId: operation.taskId, taskId: task.id },
    });
  }
  if (operation.status === 'completed') return;

  assertTaskFinalizationBranchAuthority(task, operation.baseBranch, operation.workspaceId);
  const latest = getLatestTaskFinalizationOperation(task.id, operation.workspaceId);
  if (latest && latest.id !== operation.id && latest.status !== 'completed') {
    throw createApiError(409, 'FINALIZATION_OPERATION_IDENTITY_CHANGED', 'Another incomplete finalization operation supersedes the requested frozen operation.', {
      affectedId: latest.id,
      details: { existingOperationId: latest.id, requestedOperationId: operation.id },
    });
  }

  const sessions = listExecutionSessionsForTask(task.id);
  const sourceExecution = operation.executionSessionId
    ? sessions.find((entry) => entry.id === operation.executionSessionId) || null
    : null;
  if (operation.executionSessionId && (!sourceExecution
    || sourceExecution.taskId !== task.id
    || sourceExecution.projectId !== task.projectId
    || sourceExecution.workspaceId !== operation.workspaceId)) {
    throw createApiError(409, 'FINALIZATION_OPERATION_EXECUTION_MISMATCH', 'Frozen finalization execution identity no longer matches the selected task/workspace.', {
      affectedId: operation.id,
      details: { executionSessionId: operation.executionSessionId, workspaceId: operation.workspaceId },
    });
  }
  if (operation.ownershipEpochId && sourceExecution) {
    const observedEpoch = getExecutionSessionOwnershipEpoch(sourceExecution.id).ownershipEpochId;
    if (observedEpoch !== operation.ownershipEpochId) {
      throw createApiError(409, 'FINALIZATION_OPERATION_OWNERSHIP_MISMATCH', 'Frozen finalization ownership epoch no longer matches the originating execution.', {
        affectedId: operation.id,
        details: { expectedOwnershipEpochId: operation.ownershipEpochId, observedOwnershipEpochId: observedEpoch },
      });
    }
  }
  const conflictingActive = sessions.filter((entry) => entry.status === 'active' && entry.id !== operation.executionSessionId);
  if (conflictingActive.length > 0) {
    throw createApiError(409, 'FINALIZATION_OPERATION_SUPERSEDED_BY_EXECUTION', 'A live execution supersedes the frozen finalization authority.', {
      affectedId: operation.id,
      details: { executionSessionIds: conflictingActive.map((entry) => entry.id), workspaceId: operation.workspaceId },
    });
  }

  if (metadata) {
    if (metadata.projectId !== operation.projectId || metadata.baseBranch !== operation.baseBranch) {
      throw createApiError(
        409,
        'FINALIZATION_OPERATION_WORKSPACE_MISMATCH',
        'Finalization workspace/project/base binding changed after the operation was frozen.',
        {
          affectedId: operation.id,
          details: { workspaceId: operation.workspaceId, baseBranch: operation.baseBranch },
        },
      );
    }
    const inspection = inspectWorkspaceRecovery(operation.workspaceId);
    if (inspection.dirtyFiles.length > 0) {
      throw createApiError(409, 'FINALIZATION_OPERATION_WORKSPACE_DIRTY', 'Frozen finalization cannot resume while the managed workspace has dirty files.', {
        affectedId: operation.id,
        details: { workspaceId: operation.workspaceId, dirtyFiles: inspection.dirtyFiles },
      });
    }
    if (operation.phase === 'frozen') {
      const observedSourceHead = String(inspection.sourceHead || '').trim();
      if (observedSourceHead && observedSourceHead !== operation.sourceHead) {
        const project = getProject(operation.projectId);
        const reconstructed = project?.localPath
          ? (() => {
              try {
                return reconstructRecordedWorkspaceIntegration({
                  workspaceId: operation.workspaceId,
                  projectRoot: project.localPath!,
                  baseBranch: operation.baseBranch,
                  sourceBranch: metadata.branch,
                  baseRevision: operation.baseRevision,
                  sourceHead: operation.sourceHead,
                  strategy: metadata.gitWorkflowPolicy?.integrationStrategy || 'rebase-ff',
                });
              } catch {
                return null;
              }
            })()
          : null;
        if (!reconstructed) {
          throw createApiError(
            409,
            'FINALIZATION_OPERATION_SOURCE_CHANGED',
            'Workspace source HEAD changed after finalization identity was frozen.',
            {
              affectedId: operation.id,
              details: { expectedSourceHead: operation.sourceHead, observedSourceHead },
            },
          );
        }
      }
    }
  }
}

export function validateRecordedIntegration(
  operation: TaskFinalizationOperationRecord,
  integration: WorkspaceIntegrationSuccess,
) {
  const project = getProject(operation.projectId);
  if (!project?.localPath) {
    throw createApiError(
      409,
      'FINALIZATION_PROJECT_ROOT_REQUIRED',
      'Project root is unavailable for recorded integration verification.',
      { affectedId: operation.id },
    );
  }
  const current = getRepoRevisionForRoot(project.localPath);
  if (current.head === integration.baseHeadAfter) {
    recordedIntegrationValidationMetrics.durableHeadMatch += 1;
    return integration;
  }
  recordedIntegrationValidationMetrics.reconstructed += 1;
  return reconstructRecordedWorkspaceIntegration({
    workspaceId: operation.workspaceId,
    projectRoot: project.localPath,
    baseBranch: operation.baseBranch,
    sourceBranch: getSessionWorkspaceMetadataForRecovery(operation.workspaceId)?.branch || 'removed-workspace',
    baseRevision: operation.baseRevision,
    sourceHead: operation.sourceHead,
    strategy: integration.strategy,
  });
}

export function recoverRecordedIntegration(operation: TaskFinalizationOperationRecord, task: any) {
  if (operation.integration) return operation.integration as unknown as WorkspaceIntegrationSuccess;
  const metadata = getSessionWorkspaceMetadataForRecovery(operation.workspaceId);
  const project = getProject(operation.projectId);
  if (!project?.localPath) {
    throw createApiError(
      409,
      'FINALIZATION_PROJECT_ROOT_REQUIRED',
      'Project root is unavailable for finalization integration recovery.',
      { affectedId: operation.id },
    );
  }
  if (metadata) {
    try {
      return reconstructRecordedWorkspaceIntegration({
        workspaceId: operation.workspaceId,
        projectRoot: project.localPath,
        baseBranch: operation.baseBranch,
        sourceBranch: metadata.branch,
        baseRevision: operation.baseRevision,
        sourceHead: operation.sourceHead,
        strategy: metadata.gitWorkflowPolicy?.integrationStrategy || 'rebase-ff',
      });
    } catch {}
    const integration = integrateWorkspaceCommits(operation.workspaceId, { task });
    if (integration.status === 'conflict') return integration as any;
    if (integration.sourceHead !== operation.sourceHead) {
      try {
        return reconstructRecordedWorkspaceIntegration({
          workspaceId: operation.workspaceId,
          projectRoot: project.localPath,
          baseBranch: operation.baseBranch,
          sourceBranch: metadata.branch,
          baseRevision: operation.baseRevision,
          sourceHead: operation.sourceHead,
          strategy: integration.strategy,
        });
      } catch {
        throw createApiError(
          409,
          'FINALIZATION_OPERATION_SOURCE_CHANGED',
          'Integration retry resolved a different source revision than the frozen finalization operation.',
          {
            affectedId: operation.id,
            details: {
              expectedSourceHead: operation.sourceHead,
              observedSourceHead: integration.sourceHead,
            },
          },
        );
      }
    }
    return integration;
  }
  return reconstructRecordedWorkspaceIntegration({
    workspaceId: operation.workspaceId,
    projectRoot: project.localPath,
    baseBranch: operation.baseBranch,
    sourceBranch: 'removed-workspace',
    baseRevision: operation.baseRevision,
    sourceHead: operation.sourceHead,
    strategy: 'rebase-ff',
  });
}
