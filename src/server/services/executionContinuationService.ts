import type { AppState } from '../types.js';
import { getExecutionSessionById, listExecutionSessionEvidence, queryExecutionSessionEvidenceForProject, saveExecutionSessionEvidence, updateExecutionSessionRecord } from '../repositories/executionSessionRepository.js';
import { getTaskByIdentifier } from '../repositories/taskRepository.js';
import { getLatestTaskFinalizationOperation } from '../repositories/taskFinalizationOperationRepository.js';
import { getJob, listRecentJobs, readJobResult } from '../repositories/mcpToolJobRepository.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import { getSessionWorkspaceMetadataForRecovery } from './sessionWorkspaceService.js';
import { getRepoRevisionForRoot } from './repoRevisionService.js';
import { computeLifecycleAuthoritySnapshot } from './lifecycleAuthorityService.js';
import { createApiError } from './api.js';
import { classifyBackgroundPipelineJob } from './mcpToolJobScheduler.js';

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
  autonomousTail: {
    state: 'not-started' | 'queued' | 'running' | 'completed' | 'attention';
    jobId: string | null;
    triggerJobId: string | null;
    reasonCode: string | null;
    message: string | null;
  };
  backgroundPipeline: {
    state: 'none' | 'in-flight' | 'completed' | 'attention';
    phase: 'none' | 'verification' | 'execution-tail';
    jobId: string | null;
    reasonCode: string | null;
    message: string | null;
  };
  boardLoop: {
    requested: boolean;
    eligibilityDeferred: boolean;
    status: 'none' | 'active' | 'terminal';
    loopId: string | null;
    projectId: string | null;
    requestedTaskId: string | null;
    selectionPolicy: BoardLoopSelectionPolicy;
    stopEligible: boolean;
    reasonCodes: string[];
    startedAt: string | null;
    updatedAt: string | null;
    executionSessionId: string | null;
  };
};

const BOARD_LOOP_EVIDENCE_KIND = 'board-loop-intent';

export type BoardLoopSelectionPolicy = 'todo-only' | 'include-backlog';
export const DEFAULT_BOARD_LOOP_SELECTION_POLICY: BoardLoopSelectionPolicy = 'todo-only';

export function normalizeBoardLoopSelectionPolicy(value: unknown): BoardLoopSelectionPolicy {
  return value === 'include-backlog' ? 'include-backlog' : DEFAULT_BOARD_LOOP_SELECTION_POLICY;
}

export type BoardLoopIntent = {
  loopId: string;
  projectId: string;
  requestedTaskId: string | null;
  selectionPolicy: BoardLoopSelectionPolicy;
  partitionCount: number | null;
  partitionIndex: number | null;
  status: 'active' | 'terminal';
  startedAt: string;
  updatedAt: string;
  stopEligible: boolean;
  reasonCodes: string[];
  executionSessionId: string;
};

function normalizeBoardLoopIntent(entry: any): BoardLoopIntent | null {
  if (!entry || entry.kind !== BOARD_LOOP_EVIDENCE_KIND) return null;
  const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
  const loopId = String((metadata as any).loopId || '').trim();
  const projectId = String((metadata as any).projectId || '').trim();
  const status = String((metadata as any).status || '').trim();
  if (!loopId || !projectId || (status !== 'active' && status !== 'terminal')) return null;
  return {
    loopId,
    projectId,
    requestedTaskId: String((metadata as any).requestedTaskId || '').trim() || null,
    selectionPolicy: normalizeBoardLoopSelectionPolicy((metadata as any).selectionPolicy),
    partitionCount: Number.isInteger((metadata as any).partitionCount) ? Number((metadata as any).partitionCount) : null,
    partitionIndex: Number.isInteger((metadata as any).partitionIndex) ? Number((metadata as any).partitionIndex) : null,
    status,
    startedAt: String((metadata as any).startedAt || entry.createdAt || '').trim(),
    updatedAt: String((metadata as any).updatedAt || entry.updatedAt || '').trim(),
    stopEligible: (metadata as any).stopEligible === true,
    reasonCodes: Array.isArray((metadata as any).reasonCodes) ? (metadata as any).reasonCodes.map((value: unknown) => String(value || '').trim()).filter(Boolean).slice(0, 20) : [],
    executionSessionId: String(entry.sessionId || '').trim(),
  };
}

export function persistBoardLoopIntent(executionSessionId: string, input: {
  loopId: string;
  projectId: string;
  requestedTaskId?: string | null;
  selectionPolicy?: BoardLoopSelectionPolicy;
  partitionCount?: number | null;
  partitionIndex?: number | null;
  status: 'active' | 'terminal';
  startedAt: string;
  stopEligible?: boolean;
  reasonCodes?: string[];
  updatedAt?: string;
}) {
  const sessionId = String(executionSessionId || '').trim();
  const session = getExecutionSessionById(sessionId);
  if (!session) throw createApiError(404, 'EXECUTION_SESSION_NOT_FOUND', `Execution session '${sessionId}' was not found.`, { affectedId: sessionId });
  const projectId = String(input?.projectId || '').trim();
  if (!projectId || projectId !== session.projectId) {
    throw createApiError(409, 'BOARD_LOOP_PROJECT_MISMATCH', 'Board-loop intent must remain pinned to the execution session project.', {
      affectedId: session.id,
      details: { executionProjectId: session.projectId, requestedProjectId: projectId || null },
    });
  }
  const loopId = String(input?.loopId || '').trim();
  if (!loopId) throw createApiError(400, 'BOARD_LOOP_ID_REQUIRED', 'loopId is required to persist board-loop intent.');
  const now = String(input.updatedAt || new Date().toISOString());
  const startedAt = String(input.startedAt || now);
  const metadata = {
    loopId,
    projectId,
    requestedTaskId: String(input.requestedTaskId || '').trim() || null,
    selectionPolicy: normalizeBoardLoopSelectionPolicy(input.selectionPolicy),
    partitionCount: Number.isInteger(input.partitionCount) ? Number(input.partitionCount) : null,
    partitionIndex: Number.isInteger(input.partitionIndex) ? Number(input.partitionIndex) : null,
    status: input.status,
    startedAt,
    updatedAt: now,
    stopEligible: input.stopEligible === true,
    reasonCodes: Array.isArray(input.reasonCodes) ? input.reasonCodes.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 20) : [],
  };
  const saved = saveExecutionSessionEvidence({
    id: `board-loop-intent:${session.id}:${loopId}`,
    sessionId: session.id,
    kind: BOARD_LOOP_EVIDENCE_KIND,
    path: null,
    repoRevision: null,
    fileRevision: null,
    revisionIdentity: null,
    contextHandle: null,
    stale: false,
    metadata,
    createdAt: now,
    updatedAt: now,
  });
  updateExecutionSessionRecord(session.id, { updatedAt: now });
  return normalizeBoardLoopIntent(saved)!;
}

export function getBoardLoopIntentForExecution(executionSessionId: string) {
  const entries = listExecutionSessionEvidence(String(executionSessionId || '').trim())
    .filter((entry) => entry.kind === BOARD_LOOP_EVIDENCE_KIND)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  for (const entry of entries) {
    const intent = normalizeBoardLoopIntent(entry);
    if (intent) return intent;
  }
  return null;
}

export function getProjectBoardLoopIntent(projectIdValue: string) {
  const projectId = String(projectIdValue || '').trim();
  if (!projectId) return null;
  for (const entry of queryExecutionSessionEvidenceForProject(projectId, BOARD_LOOP_EVIDENCE_KIND, 50)) {
    const intent = normalizeBoardLoopIntent(entry);
    if (intent) return intent;
  }
  return null;
}

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
  const persistedBoardLoop = getBoardLoopIntentForExecution(session.id);
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

  const tailJobs = listRecentJobs(200)
    .filter((job) => job.toolName === 'continue_task_execution_tail' && String(job.args?.__executionJobBinding?.executionSessionId || '').trim() === session.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const latestTailJob = tailJobs[0] || null;
  const latestTailResult = latestTailJob ? readJobResult(latestTailJob.jobId)?.result : null;
  const autonomousTailState: ExecutionContinuationResult['autonomousTail']['state'] = !latestTailJob
    ? 'not-started'
    : latestTailJob.status === 'queued'
      ? 'queued'
      : latestTailJob.status === 'running'
        ? 'running'
        : latestTailJob.status === 'succeeded' && latestTailResult?.status === 'completed'
          ? 'completed'
          : 'attention';
  const autonomousTail = {
    state: autonomousTailState,
    jobId: latestTailJob?.jobId || null,
    triggerJobId: latestTailJob ? String(latestTailJob.args?.triggerJobId || '').trim() || null : null,
    reasonCode: autonomousTailState === 'attention' ? String(latestTailResult?.code || latestTailJob?.failureSummary || 'AUTONOMOUS_TAIL_ATTENTION_REQUIRED').slice(0, 160) : null,
    message: autonomousTailState === 'attention' ? String(latestTailResult?.message || latestTailJob?.failureSummary || 'Autonomous execution tail requires attention.').slice(0, 500) : null,
  };
  if (autonomousTail.state === 'attention') {
    blockers.push({
      code: autonomousTail.reasonCode || 'AUTONOMOUS_TAIL_ATTENTION_REQUIRED',
      message: autonomousTail.message || 'Autonomous execution tail requires attention.',
      affectedId: autonomousTail.jobId,
    });
  }

  const latestVerificationPipeline = listRecentJobs(200)
    .filter((job) => job.toolName === 'run_project_command' && String(job.args?.__executionJobBinding?.executionSessionId || '').trim() === session.id)
    .map((job) => ({ job, disposition: classifyBackgroundPipelineJob(job) }))
    .filter((entry) => entry.disposition.pipelineCapable)
    .sort((left, right) => right.job.updatedAt.localeCompare(left.job.updatedAt))[0] || null;
  const verificationPipelineState = latestVerificationPipeline?.disposition.state === 'not-pipeline'
    ? 'none'
    : latestVerificationPipeline?.disposition.state || 'none';
  const backgroundPipeline: ExecutionContinuationResult['backgroundPipeline'] = autonomousTail.state === 'queued' || autonomousTail.state === 'running'
    ? { state: 'in-flight', phase: 'execution-tail', jobId: autonomousTail.jobId, reasonCode: null, message: null }
    : autonomousTail.state === 'attention'
      ? { state: 'attention', phase: 'execution-tail', jobId: autonomousTail.jobId, reasonCode: autonomousTail.reasonCode, message: autonomousTail.message }
      : autonomousTail.state === 'completed'
        ? { state: 'completed', phase: 'execution-tail', jobId: autonomousTail.jobId, reasonCode: null, message: null }
        : latestVerificationPipeline
          ? {
              state: verificationPipelineState,
              phase: 'verification',
              jobId: latestVerificationPipeline.job.jobId,
              reasonCode: latestVerificationPipeline.disposition.reasonCode,
              message: verificationPipelineState === 'attention'
                ? String(latestVerificationPipeline.job.failureSummary || 'Background verification requires attention.').slice(0, 500)
                : null,
            }
          : { state: 'none', phase: 'none', jobId: null, reasonCode: null, message: null };
  if (backgroundPipeline.state === 'attention' && autonomousTail.state !== 'attention') {
    blockers.push({
      code: backgroundPipeline.reasonCode || 'BACKGROUND_VERIFICATION_ATTENTION_REQUIRED',
      message: backgroundPipeline.message || 'Background verification requires attention.',
      affectedId: backgroundPipeline.jobId,
    });
  }

  const boardLoop: ExecutionContinuationResult['boardLoop'] = persistedBoardLoop ? {
    requested: true,
    eligibilityDeferred: persistedBoardLoop.status === 'active',
    status: persistedBoardLoop.status,
    loopId: persistedBoardLoop.loopId,
    projectId: persistedBoardLoop.projectId,
    requestedTaskId: persistedBoardLoop.requestedTaskId,
    selectionPolicy: persistedBoardLoop.selectionPolicy,
    stopEligible: persistedBoardLoop.stopEligible,
    reasonCodes: persistedBoardLoop.reasonCodes,
    startedAt: persistedBoardLoop.startedAt,
    updatedAt: persistedBoardLoop.updatedAt,
    executionSessionId: persistedBoardLoop.executionSessionId,
  } : {
    requested: options.boardLoopRequested === true,
    eligibilityDeferred: options.boardLoopRequested === true,
    status: options.boardLoopRequested === true ? 'active' : 'none',
    loopId: null,
    projectId: session.projectId || null,
    requestedTaskId: null,
    selectionPolicy: DEFAULT_BOARD_LOOP_SELECTION_POLICY,
    stopEligible: false,
    reasonCodes: [],
    startedAt: null,
    updatedAt: null,
    executionSessionId: null,
  };

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
    boardLoop,
    autonomousTail,
    backgroundPipeline,
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
