import type { AppState } from '../types.js';
import { getExecutionSessionById, listExecutionSessionEvidence } from '../repositories/executionSessionRepository.js';
import { getTaskByIdentifier } from '../repositories/taskRepository.js';
import { getLatestTaskFinalizationOperation } from '../repositories/taskFinalizationOperationRepository.js';
import { getJob } from '../repositories/mcpToolJobRepository.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import { getSessionWorkspaceMetadataForRecovery } from './sessionWorkspaceService.js';
import { getRepoRevisionForRoot } from './repoRevisionService.js';
import { computeLifecycleAuthoritySnapshot } from './lifecycleAuthorityService.js';
import { createApiError } from './api.js';

export type ExecutionContinuationNextAction =
  | {
      action: 'query-pending-jobs';
      tool: 'get_tool_job_result';
      jobIds: string[];
      operationIds: string[];
      replay: false;
    }
  | {
      action: 'retry-finalization';
      tool: 'finalize_task_workspace';
      operationId: string;
      workspaceId: string;
      reintegrate: false;
    }
  | {
      action: 'finalize-task-workspace';
      tool: 'finalize_task_workspace';
      workspaceId: string;
    }
  | {
      action: 'recover-execution';
      tool: 'get_recovery_handoff';
      workspaceId?: string;
      replacementExecutionAllowed: false;
    }
  | null;

export type ExecutionContinuationResult = {
  executionSessionId: string;
  terminal: boolean;
  continuationRequired: boolean;
  blocked: boolean;
  reasonCodes: string[];
  nextAction: ExecutionContinuationNextAction;
  pendingOperations: Array<{
    operationId: string;
    evidenceId: string;
    kind: string;
    checkpointStatus: 'accepted' | 'running';
    jobId: string | null;
    jobStatus: string | null;
    toolName: string | null;
    observedAt: string;
  }>;
  task: { id: string; displayId: string; status: string; incompleteChecklistItems: string[] } | null;
  execution: { status: string; stage: string; workspaceId: string | null };
  finalization: { operationId: string; status: string; phase: string; workspaceId: string } | null;
  blockers: Array<{ code: string; message: string; affectedId?: string | null }>;
  boardLoop: { requested: boolean; eligibilityDeferred: boolean };
};

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function blockerMessage(entry: any) {
  return String(entry?.message || entry?.summary || entry?.code || 'Execution continuation is blocked.');
}

export function evaluateExecutionContinuation(
  _state: AppState,
  executionSessionId: string,
  options: {
    workspaceId?: string | null;
    repoRoot?: string;
    boardLoopRequested?: boolean;
  } = {},
): ExecutionContinuationResult {
  const sessionId = String(executionSessionId || '').trim();
  const session = getExecutionSessionById(sessionId);
  if (!session) {
    throw createApiError(404, 'EXECUTION_SESSION_NOT_FOUND', `Execution session '${sessionId}' was not found.`, { affectedId: sessionId });
  }

  const task = session.taskId ? getTaskByIdentifier(session.taskId, 'full') : undefined;
  const checkpoint = getLatestExecutionCheckpoint(session.id);
  const finalization = task ? getLatestTaskFinalizationOperation(task.id, session.workspaceId || undefined) : null;
  const evidence = listExecutionSessionEvidence(session.id);
  const staleEvidence = evidence.filter((entry) => entry.stale);
  const expectedWorkspaceId = String(options.workspaceId || '').trim() || null;
  const workspaceMismatch = Boolean(expectedWorkspaceId && session.workspaceId && expectedWorkspaceId !== session.workspaceId);
  const workspaceMissing = Boolean(session.workspaceId && !getSessionWorkspaceMetadataForRecovery(session.workspaceId));
  let repoRevisionMismatch = false;
  if (options.repoRoot && checkpoint?.sourceRepoRevision) {
    try {
      repoRevisionMismatch = getRepoRevisionForRoot(options.repoRoot).token !== checkpoint.sourceRepoRevision;
    } catch {
      repoRevisionMismatch = true;
    }
  }

  const pendingOperations = (checkpoint?.pendingOperations || []).map((entry) => {
    const job = getJob(entry.operationId);
    return {
      operationId: entry.operationId,
      evidenceId: entry.evidenceId,
      kind: entry.kind,
      checkpointStatus: entry.status,
      jobId: job?.jobId || null,
      jobStatus: job?.status || null,
      toolName: job?.toolName || null,
      observedAt: entry.observedAt,
    };
  }).sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.operationId.localeCompare(right.operationId));

  const incompleteChecklistItems = Array.isArray(task?.checklist)
    ? task.checklist.filter((entry: any) => !entry?.completed).map((entry: any) => String(entry?.text || entry?.id || '').trim()).filter(Boolean)
    : [];

  const blockers: Array<{ code: string; message: string; affectedId?: string | null }> = [];
  if (workspaceMismatch) blockers.push({ code: 'EXECUTION_WORKSPACE_MISMATCH', message: 'Requested workspace does not match the execution-bound workspace.', affectedId: expectedWorkspaceId });
  if (workspaceMissing) blockers.push({ code: 'EXECUTION_WORKSPACE_REVALIDATION_REQUIRED', message: 'The execution-bound managed workspace is unavailable or stale and must be recovered before mutation continues.', affectedId: session.workspaceId });
  if (staleEvidence.length > 0 || repoRevisionMismatch) blockers.push({
    code: 'EXECUTION_EVIDENCE_REVALIDATION_REQUIRED',
    message: 'Revision-bound execution evidence is stale or no longer matches the current repository candidate.',
    affectedId: staleEvidence[0]?.id || session.id,
  });

  let authority: ReturnType<typeof computeLifecycleAuthoritySnapshot> | null = null;
  if (task) {
    try {
      authority = computeLifecycleAuthoritySnapshot(task.id, { workspaceId: session.workspaceId || undefined });
    } catch {}
  }
  for (const entry of authority?.hardBlockers || []) blockers.push({
    code: String((entry as any)?.code || 'EXECUTION_HARD_BLOCKER'),
    message: blockerMessage(entry),
    affectedId: (entry as any)?.affectedId == null ? null : String((entry as any).affectedId),
  });

  const base = {
    executionSessionId: session.id,
    pendingOperations,
    task: task ? {
      id: task.id,
      displayId: task.displayId,
      status: task.status,
      incompleteChecklistItems,
    } : null,
    execution: { status: session.status, stage: session.lifecycle.stage, workspaceId: session.workspaceId },
    finalization: finalization ? {
      operationId: finalization.id,
      status: finalization.status,
      phase: finalization.phase,
      workspaceId: finalization.workspaceId,
    } : null,
    blockers,
    boardLoop: { requested: options.boardLoopRequested === true, eligibilityDeferred: options.boardLoopRequested === true },
  };

  if (pendingOperations.length > 0) {
    const jobIds = pendingOperations.map((entry) => entry.jobId).filter((entry): entry is string => Boolean(entry));
    if (jobIds.length !== pendingOperations.length) {
      blockers.push({
        code: 'PENDING_OPERATION_JOB_UNAVAILABLE',
        message: 'A checkpointed durable operation no longer has a queryable job record; recover the existing execution instead of replaying the mutation.',
        affectedId: pendingOperations.find((entry) => !entry.jobId)?.operationId || session.id,
      });
      return {
        ...base,
        terminal: false,
        continuationRequired: true,
        blocked: true,
        reasonCodes: unique(['PENDING_DURABLE_OPERATION', 'PENDING_OPERATION_JOB_UNAVAILABLE', ...blockers.map((entry) => entry.code)]),
        nextAction: {
          action: 'recover-execution',
          tool: 'get_recovery_handoff',
          ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
          replacementExecutionAllowed: false,
        },
      };
    }
    return {
      ...base,
      terminal: false,
      continuationRequired: true,
      blocked: false,
      reasonCodes: unique(['PENDING_DURABLE_OPERATION', ...blockers.map((entry) => entry.code)]),
      nextAction: {
        action: 'query-pending-jobs',
        tool: 'get_tool_job_result',
        jobIds,
        operationIds: pendingOperations.map((entry) => entry.operationId),
        replay: false,
      },
    };
  }

  if (finalization && finalization.status !== 'completed') {
    return {
      ...base,
      terminal: false,
      continuationRequired: true,
      blocked: false,
      reasonCodes: unique([
        finalization.status === 'cleanup-pending' ? 'FINALIZATION_CLEANUP_PENDING' : 'FINALIZATION_CONTINUATION_REQUIRED',
        `FINALIZATION_PHASE_${String(finalization.phase).toUpperCase().replace(/-/g, '_')}`,
        ...blockers.map((entry) => entry.code),
      ]),
      nextAction: {
        action: 'retry-finalization',
        tool: 'finalize_task_workspace',
        operationId: finalization.id,
        workspaceId: finalization.workspaceId,
        reintegrate: false,
      },
    };
  }

  if (blockers.length > 0) {
    return {
      ...base,
      terminal: false,
      continuationRequired: true,
      blocked: true,
      reasonCodes: unique(blockers.map((entry) => entry.code)),
      nextAction: {
        action: 'recover-execution',
        tool: 'get_recovery_handoff',
        ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
        replacementExecutionAllowed: false,
      },
    };
  }

  const taskDone = !task || task.status === 'done';
  const executionTerminal = session.status !== 'active';
  if (taskDone && executionTerminal) {
    return {
      ...base,
      terminal: true,
      continuationRequired: false,
      blocked: false,
      reasonCodes: ['EXECUTION_SCOPE_TERMINAL'],
      nextAction: null,
    };
  }

  if (executionTerminal && !taskDone) {
    return {
      ...base,
      terminal: false,
      continuationRequired: true,
      blocked: true,
      reasonCodes: ['EXECUTION_TERMINAL_TASK_INCOMPLETE'],
      nextAction: {
        action: 'recover-execution',
        tool: 'get_recovery_handoff',
        ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
        replacementExecutionAllowed: false,
      },
    };
  }

  if (session.lifecycle.stage === 'committed' && session.workspaceId) {
    return {
      ...base,
      terminal: false,
      continuationRequired: true,
      blocked: false,
      reasonCodes: unique(['COMMIT_IS_NON_TERMINAL', taskDone ? '' : 'TASK_NOT_DONE']),
      nextAction: {
        action: 'finalize-task-workspace',
        tool: 'finalize_task_workspace',
        workspaceId: session.workspaceId,
      },
    };
  }

  const reasonCodes = [
    ...(incompleteChecklistItems.length > 0 ? ['TASK_CHECKLIST_INCOMPLETE'] : []),
    ...(!taskDone ? ['TASK_NOT_DONE'] : []),
    ...(session.lifecycle.stage === 'verifying' ? ['VERIFICATION_IS_NON_TERMINAL'] : []),
    ...(session.lifecycle.stage === 'finalized' ? ['EXECUTION_TERMINALIZATION_PENDING'] : []),
  ];

  return {
    ...base,
    terminal: false,
    continuationRequired: true,
    blocked: false,
    reasonCodes: unique(reasonCodes.length > 0 ? reasonCodes : ['EXECUTION_STILL_ACTIVE']),
    nextAction: session.lifecycle.stage === 'finalized'
      ? {
          action: 'recover-execution',
          tool: 'get_recovery_handoff',
          ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
          replacementExecutionAllowed: false,
        }
      : null,
  };
}
