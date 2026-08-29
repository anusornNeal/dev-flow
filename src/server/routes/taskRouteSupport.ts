import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { VALID_AGENTS, LEGACY_VALID_EFFORTS_FALLBACK, VALID_MODELS, VALID_STATUSES } from '../constants';
import { getLatestAgentRunForTask, listAgentRunsForTask, type AgentRun } from '../repositories/agentRunRepository';
import { deleteTasksByIds, generateDisplayId, saveTask, getTasks } from '../repositories/taskRepository.js';
import { listAttachmentsForTask } from '../repositories/attachmentRepository';
import { extractImages, extractDesignImages, findProjectByIdentifier, findTaskByIdentifier, getAgentTaskContext, normalizeAgentCompletionPayload, normalizeTaskCategoryAndTags, applyTaskCategoryAndTagsUpdate, renderTaskPrompt, resolveProjectIdFromRepo, validateAgentCompletionPayload, validateAgentParams, validateTaskPayload } from '../services/taskService';
import { validateTaskQualityForMutation } from '../services/taskQualityService';
import { createApiError, sendApiError } from '../services/api';
import { draftTaskFromJiraBundle } from '../services/compositeAuthoringService';
import { acquireLock, releaseLock, withIdempotency, withSyncLock, getIdempotencyResult, createPendingIdempotencyWithFingerprint, resolvePendingIdempotency, rejectPendingIdempotency, buildIdempotencyFingerprint } from '../services/lockAndIdempotencyService';
import { validateEnum, validateString } from '../validation';
import { isValidTransition, getValidationErrorMessage } from '../../lib/statusTransitions';
import { applyChecklistToggle as applyChecklistToggleUseCase, getBugSummary, validateTaskPatch as validateTaskPatchUseCase } from '../useCases/taskUseCases';
import type { AgentCompletionPayload, AgentCompletionStatus, TaskStatus } from '../../types';
import { registerTaskImportFileRoute } from './taskImportFileRoute';
import { buildTaskGitWarnings, validateRecordedReviewSubmission } from '../services/taskGitWorkflowService';
import { mutateTaskStatusWithLifecycle, taskHasLifecycleOwnership } from '../services/taskClaimService.js';
import { projectTaskBoardLiveWork } from '../services/taskBoardLiveWorkProjectionService.js';

export function withAgentOrchestrationLock<T>(taskId: string, action: () => T): T {
  return withSyncLock(`agent-orchestration-${taskId}`, action);
}

type TaskReadMode = 'minimal' | 'summary' | 'board' | 'standard' | 'full' | 'agent-context' | 'debug';
type MutationResponseMode = 'standard' | 'summary' | 'ack';

function normalizeFlag(value: unknown) {
  return value === true || String(value).toLowerCase() === 'true';
}

export function parseTaskReadMode(value: unknown, fallback: TaskReadMode = 'standard'): TaskReadMode {
  const mode = String(value || fallback) as TaskReadMode;
  return ['minimal', 'summary', 'board', 'standard', 'full', 'agent-context', 'debug'].includes(mode) ? mode : fallback;
}

function parseMutationResponseMode(value: unknown): MutationResponseMode {
  const mode = String(value || 'standard') as MutationResponseMode;
  return ['standard', 'summary', 'ack'].includes(mode) ? mode : 'standard';
}

export function getTaskIndexByIdentifier(tasks: any[], targetId: string) {
  return tasks.findIndex((task) => task.id === targetId || task.displayId === targetId);
}

function bugSummaryFields(task: any) {
  const summary = getBugSummary(task);
  return {
    unresolvedBugCount: summary.unresolvedBugCount,
    latestUnresolvedBug: summary.latestUnresolvedBug ? {
      id: summary.latestUnresolvedBug.id,
      title: summary.latestUnresolvedBug.title,
      status: summary.latestUnresolvedBug.status,
      severity: summary.latestUnresolvedBug.severity,
      updatedAt: summary.latestUnresolvedBug.updatedAt,
    } : null,
  };
}

export function toTaskResponse(task: any, mode: TaskReadMode) {
  if (mode === 'minimal') {
    return {
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      status: task.status,
      projectId: task.projectId,
    };
  }

  if (mode === 'summary') {
    return {
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      status: task.status,
      priority: task.priority,
      projectId: task.projectId,
      parentId: task.parentId,
      agent: task.agent,
      prerequisiteTaskIds: task.prerequisiteTaskIds,
      model: task.model,
      effort: task.effort,
      updatedAt: task.updatedAt,
      archivedAt: task.archivedAt ?? null,
      latestAgentRun: task.latestAgentRun,
      ...bugSummaryFields(task),
    };
  }

  if (mode === 'board') {
    return {
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      status: task.status,
      priority: task.priority,
      category: task.category,
      projectId: task.projectId,
      parentId: task.parentId,
      branch: task.branch,
      prerequisiteTaskIds: task.prerequisiteTaskIds,
      tags: task.tags,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      archivedAt: task.archivedAt ?? null,
      targetFiles: task.targetFiles,
      checklist: task.checklist,
      images: task.images,
      specUrl: task.specUrl,
      agent: task.agent,
      activeAgent: task.activeAgent,
      liveWork: projectTaskBoardLiveWork(task),
      latestAgentRun: task.latestAgentRun,
      agentRuns: task.agentRuns,
      model: task.model,
      effort: task.effort,
      repo: task.repo,
      sourceUrl: task.sourceUrl,
      hasUiDesign: Boolean(task.hasUiDesign),
      ...bugSummaryFields(task),
    };
  }

  const workflowWarnings = buildTaskGitWarnings(task);
  if (mode === 'standard') {
    return {
      ...task,
      attachments: listAttachmentsForTask(task.id),
      logs: undefined,
      workflowWarnings,
    };
  }

  return {
    ...task,
    attachments: listAttachmentsForTask(task.id),
    workflowWarnings,
  };
}

export function toMutationResponse(req: express.Request, task: any, standardPayload: any, extra?: Record<string, any>) {
  const responseMode = parseMutationResponseMode(req.query.responseMode);
  const routing = {
    ...(standardPayload?.workspace?.workspaceId ? { workspaceId: standardPayload.workspace.workspaceId } : {}),
    ...(standardPayload?.executionSessionId ? { executionSessionId: standardPayload.executionSessionId } : {}),
    ...(standardPayload?.claim?.ownershipEpochId ? { ownershipEpochId: standardPayload.claim.ownershipEpochId } : {}),
  };
  if (responseMode === 'ack') {
    return {
      success: true,
      responseMode,
      taskId: task.id,
      displayId: task.displayId,
      status: task.status,
      ...routing,
      ...(extra || {}),
    };
  }
  if (responseMode === 'summary') {
    return {
      success: true,
      responseMode,
      task: toTaskResponse(task, 'summary'),
      ...routing,
      ...(extra || {}),
    };
  }
  return standardPayload;
}

export function toMutationListResponse(req: express.Request, tasks: any[], standardPayload: any, extra?: Record<string, any>) {
  const responseMode = parseMutationResponseMode(req.query.responseMode);
  if (responseMode === 'ack') {
    return {
      success: true,
      responseMode,
      count: tasks.length,
      tasks: tasks.map((task) => ({
        id: task.id,
        displayId: task.displayId,
        status: task.status,
      })),
      ...(extra || {}),
    };
  }
  if (responseMode === 'summary') {
    return {
      success: true,
      responseMode,
      count: tasks.length,
      tasks: tasks.map((task) => toTaskResponse(task, 'summary')),
      ...(extra || {}),
    };
  }
  return standardPayload;
}

function resolveTaskListProjectId(deps: ApiRouteDeps, req: express.Request) {
  const project = findProjectByIdentifier(deps.state, {
    projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
    projectName: typeof req.query.projectName === 'string' ? req.query.projectName : undefined,
    repo: typeof req.query.repo === 'string' ? req.query.repo : undefined,
    repoUrl: typeof req.query.repoUrl === 'string' ? req.query.repoUrl : undefined,
    localPath: typeof req.query.localPath === 'string' ? req.query.localPath : undefined,
  });
  return project?.id || null;
}

export function resolveTaskBoardListQuery(deps: ApiRouteDeps, req: express.Request) {
  const resolvedProjectId = resolveTaskListProjectId(deps, req);
  const projectId = resolvedProjectId || (typeof req.query.projectId === 'string' ? req.query.projectId : '');
  const requestedParentId = typeof req.query.parentId === 'string' ? req.query.parentId : '';
  const parentTask = requestedParentId ? findTaskByIdentifier(deps.state, requestedParentId) : null;
  return {
    projectId: projectId || undefined,
    parentId: requestedParentId ? (parentTask?.id || requestedParentId) : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    query: typeof req.query.q === 'string' ? req.query.q.trim() : undefined,
    archived: normalizeFlag(req.query.archived),
    limit: Number.isFinite(Number(req.query.limit)) ? Math.max(1, Math.min(500, Number(req.query.limit))) : 25,
    offset: Number.isFinite(Number(req.query.offset)) ? Math.max(0, Math.floor(Number(req.query.offset))) : 0,
  };
}

export function filterTasksForList(deps: ApiRouteDeps, req: express.Request) {
  let tasks = [...getTasks()];
  const resolvedProjectId = resolveTaskListProjectId(deps, req);
  const projectId = resolvedProjectId || (typeof req.query.projectId === 'string' ? req.query.projectId : '');
  const parentId = typeof req.query.parentId === 'string' ? req.query.parentId : '';
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const query = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

  if (projectId) {
    tasks = tasks.filter((task) => task.projectId === projectId);
  }
  if (parentId) {
    const parentTask = findTaskByIdentifier(deps.state, parentId);
    tasks = tasks.filter((task) => task.parentId === (parentTask?.id || parentId));
  }
  if (status) {
    tasks = tasks.filter((task) => task.status === status);
  }
  if (query) {
    tasks = tasks.filter((task) => {
      const haystack = [
        task.id,
        task.displayId,
        task.title,
        task.description,
        task.reasoning,
        task.acceptanceCriteria,
        task.verification,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  return tasks;
}

export function createTaskLogEntry(message: string, type: string = 'update') {
  return {
    id: `log-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
    timestamp: new Date().toISOString(),
    message,
    type,
  };
}

export function appendTaskLog(task: any, message: string, type: string = 'update') {
  const lastLog = Array.isArray(task.logs) ? task.logs[task.logs.length - 1] : null;
  if (lastLog?.message === message && lastLog?.type === type) return;
  task.logs = [...(task.logs || []), createTaskLogEntry(message, type)];
}

export function stripRequestControlFields<T extends Record<string, any>>(input: T): T {
  const copy = { ...input };
  delete copy.idempotencyKey;
  delete copy.resourceLockOverride;
  return copy;
}

function taskRequiresManualEvidence(task: any) {
  const haystack = [
    task?.description,
    task?.acceptanceCriteria,
    task?.verification,
    ...(Array.isArray(task?.targetFiles) ? task.targetFiles : []),
  ].filter(Boolean).join(' ').toLowerCase();
  return /evidence|prompt\.md|agent\.log/.test(haystack);
}

function taskHasManualEvidence(task: any) {
  const messages = (task.logs || []).map((entry: any) => String(entry?.message || ''));
  const hasPromptExcerpt = messages.some((message: string) => /prompt\.md/i.test(message));
  const hasAgentLogExcerpt = messages.some((message: string) => /agent\.log/i.test(message));
  return hasPromptExcerpt && hasAgentLogExcerpt;
}

export interface TaskMoveWorkflowBlocker {
  code: string;
  message: string;
  bypassable: true;
  details?: unknown;
}

export function getTaskMoveWorkflowBlockers(task: any, deps: ApiRouteDeps, nextStatus: string): TaskMoveWorkflowBlocker[] {
  if (!['ready-for-review', 'done'].includes(nextStatus)) return [];
  const evidenceValidation = validateRecordedReviewSubmission(task);
  const blockers: TaskMoveWorkflowBlocker[] = evidenceValidation.blockers.map((blocker) => ({
    ...blocker,
    bypassable: true,
  }));

  const children = getTasks().filter((entry) => entry.parentId === task.id);
  for (const child of children) {
    if (!['ready-for-review', 'done'].includes(child.status)) {
      blockers.push({
        code: 'CHILD_TASK_BLOCKING',
        message: `${child.displayId || child.id} is still ${child.status}.`,
        bypassable: true,
        details: { childId: child.id, displayId: child.displayId || null, status: child.status },
      });
      continue;
    }
    if (taskRequiresManualEvidence(child) && !taskHasManualEvidence(child)) {
      blockers.push({
        code: 'CHILD_EVIDENCE_MISSING',
        message: `${child.displayId || child.id} is missing visible prompt.md and agent.log evidence in task logs.`,
        bypassable: true,
        details: { childId: child.id, displayId: child.displayId || null },
      });
    }
  }

  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = `${blocker.code}:${blocker.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateParentReviewMove(task: any, deps: ApiRouteDeps, nextStatus: string) {
  const blockers = getTaskMoveWorkflowBlockers(task, deps, nextStatus);
  if (blockers.length === 0) return null;
  return `Task ${task.displayId || task.id} cannot move to ${nextStatus} yet: ${blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join(' ')}`;
}

function clearActiveAgentIfSettled(task: any) {
  if (['backlog', 'done', 'ready-for-review'].includes(task.status)) task.activeAgent = undefined;
}

export function syncTaskAgentStateForStatus(task: any, previousStatus?: string) {
  if (task.status === 'backlog') {
    if (previousStatus !== 'backlog') {
      appendTaskLog(task, 'Manual reset: cleared compatibility active-agent projection after moving task to BACKLOG.', 'update');
    }
    applyRunSummaryToTask(task, getLatestAgentRunForTask(task.id));
    task.activeAgent = undefined;
    return;
  }

  clearActiveAgentIfSettled(task);
  applyRunSummaryToTask(task, getLatestAgentRunForTask(task.id));
}

export function persistTaskMutationWithLifecycle(currentTask: any, candidateTask: any, reason: string) {
  const statusChanged = candidateTask.status !== currentTask.status;
  if (!statusChanged) {
    syncTaskAgentStateForStatus(candidateTask, currentTask.status);
    saveTask(candidateTask);
    return candidateTask;
  }
  const originalLogIds = new Set((Array.isArray(currentTask.logs) ? currentTask.logs : []).map((entry: any) => String(entry?.id || '')));
  const extraLogs = (Array.isArray(candidateTask.logs) ? candidateTask.logs : []).filter((entry: any) => !originalLogIds.has(String(entry?.id || '')));
  return mutateTaskStatusWithLifecycle(currentTask.id, candidateTask.status as TaskStatus, (base) => {
    const next = {
      ...base,
      ...candidateTask,
      claim: base.claim,
      logs: [...(Array.isArray(base.logs) ? base.logs : []), ...extraLogs],
      updatedAt: candidateTask.updatedAt || new Date().toISOString(),
    };
    syncTaskAgentStateForStatus(next, currentTask.status);
    return next;
  }, { reason }).task;
}

export function canOverrideTaskLock(task: any, body: any, query?: any, agentRequestValue?: any) {
  const isAgentRequest = String(agentRequestValue).toLowerCase() === 'true';
  const emergencyBody = body?.emergency === true || String(body?.emergency).toLowerCase() === 'true';
  const emergencyQuery = String(query?.emergency).toLowerCase() === 'true';
  return isAgentRequest || emergencyBody || emergencyQuery;
}

export function applyRunSummaryToTask(task: any, run: AgentRun | null) {
  const latestRun = run || getLatestAgentRunForTask(task.id);
  const allRuns = listAgentRunsForTask(task.id);
  task.activeAgent = undefined;
  task.latestAgentRun = latestRun ? {
    id: latestRun.id,
    status: latestRun.status,
    agent: latestRun.agent,
    errorMessage: latestRun.errorMessage,
    createdAt: latestRun.createdAt,
    startedAt: latestRun.startedAt,
    endedAt: latestRun.endedAt,
  } : undefined;
  task.agentRuns = allRuns.map((r) => ({
    id: r.id,
    status: r.status,
    logFile: r.logPath,
  }));
}


