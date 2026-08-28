import type { Task, TaskLiveWorkPhase, TaskLiveWorkProjection } from '../../types.js';
import { queryExecutionSessions, queryLatestExecutionSessionEvidence, type ExecutionLifecycleStage, type ExecutionSessionRecord } from '../repositories/executionSessionRepository.js';
import { getLatestExecutionCheckpoint, type ExecutionCheckpointSnapshot } from './executionCheckpointService.js';
import { getLatestExternalTaskStatusRecord, isExternalTaskStatusRecordStale } from './externalTaskStatusService.js';
import { queryAgentOfficeTaskPage } from '../repositories/taskRepository.js';

const ACTIVE_AGENT_RUN_STATUSES = new Set(['queued', 'starting', 'running']);
const MANAGED_PHASE_COUNT = 5;

type ProjectionInputs = {
  now?: Date;
  activeExecutions?: ExecutionSessionRecord[];
  checkpoint?: ExecutionCheckpointSnapshot | null;
};

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function activeClaim(task: Task, nowMs: number) {
  const claim = task.claim;
  if (!claim?.workspaceId || !claim.expiresAt) return null;
  const expiresAtMs = Date.parse(claim.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs ? claim : null;
}

function titleCaseToken(value: unknown) {
  const token = clean(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  return token ? token.charAt(0).toUpperCase() + token.slice(1) : null;
}

function phaseFromLifecycle(stage: ExecutionLifecycleStage): { phase: TaskLiveWorkPhase; label: string; index: number } {
  switch (stage) {
    case 'compatibility':
    case 'created':
    case 'context-ready':
    case 'plan-recorded':
      return { phase: 'inspecting', label: stage === 'plan-recorded' ? 'Planning' : 'Inspecting', index: 0 };
    case 'implementing':
      return { phase: 'editing', label: 'Editing', index: 1 };
    case 'repairing':
      return { phase: 'editing', label: 'Repairing', index: 1 };
    case 'verifying':
      return { phase: 'verifying', label: 'Verifying', index: 2 };
    case 'verification-infra-blocked':
      return { phase: 'blocked', label: 'Blocked', index: 2 };
    case 'committed':
      return { phase: 'integrating', label: 'Integrating', index: 4 };
    case 'finalized':
      return { phase: 'finalizing', label: 'Finalizing', index: 4 };
    default:
      return { phase: 'working', label: 'Working', index: 1 };
  }
}

function phaseFromOperation(kind: string | null) {
  const normalized = clean(kind).toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('finaliz') || normalized.includes('cleanup')) {
    return { phase: 'finalizing' as const, label: 'Finalizing', index: 4 };
  }
  if (normalized.includes('integrat') || normalized.includes('rebase') || normalized.includes('merge')) {
    return { phase: 'integrating' as const, label: 'Integrating', index: 4 };
  }
  if (normalized.includes('commit')) {
    return { phase: 'committing' as const, label: 'Committing', index: 3 };
  }
  if (normalized.includes('verif') || normalized.includes('test') || normalized.includes('typecheck') || normalized.includes('lint')) {
    return { phase: 'verifying' as const, label: 'Verifying', index: 2 };
  }
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('apply') || normalized.includes('delete') || normalized.includes('move')) {
    return { phase: 'editing' as const, label: 'Editing', index: 1 };
  }
  if (normalized.includes('read') || normalized.includes('search') || normalized.includes('context') || normalized.includes('atlas') || normalized.includes('inspect')) {
    return { phase: 'inspecting' as const, label: 'Inspecting', index: 0 };
  }
  return null;
}

function externalNativeProjection(task: Task, nowMs: number): TaskLiveWorkProjection | null {
  const record = getLatestExternalTaskStatusRecord(task);
  if (!record || record.targetStatus !== 'in-progress' || record.managedAuthorityOverlap) return null;
  const metadata = record.metadata || {};
  const ownerLabel = clean(metadata.worker || task.agent) || 'External worker';
  const resultState = clean(metadata.resultState);
  const stale = !resultState && isExternalTaskStatusRecordStale(record, nowMs);
  const needsAttention = stale || resultState === 'BLOCKED' || resultState === 'NEEDS_CONTEXT';
  const handoffReady = resultState === 'HANDOFF_READY';
  const phaseLabel = stale
    ? 'Disconnected'
    : resultState === 'BLOCKED'
      ? 'Blocked'
      : resultState === 'NEEDS_CONTEXT'
        ? 'Needs context'
        : handoffReady
          ? 'Handoff ready'
          : 'Working';
  return {
    source: 'agent',
    ownerLabel,
    ownerKind: 'agent',
    phase: needsAttention ? 'blocked' : 'working',
    phaseLabel,
    activity: clean(metadata.summary) || titleCaseToken(metadata.action) || null,
    phaseIndex: 1,
    phaseCount: MANAGED_PHASE_COUNT,
    blocked: needsAttention,
    startedAt: record.recordedAt,
    updatedAt: record.recordedAt,
  };
}

function externalAgentProjection(task: Task, nowMs = Date.now()): TaskLiveWorkProjection | null {
  const native = externalNativeProjection(task, nowMs);
  if (native) return native;
  const run = task.latestAgentRun;
  const runActive = Boolean(run && ACTIVE_AGENT_RUN_STATUSES.has(run.status));
  if (!runActive && !task.activeAgent) return null;
  const ownerLabel = clean(run?.agent || task.activeAgent || task.agent);
  if (!ownerLabel) return null;
  const starting = run?.status === 'queued' || run?.status === 'starting';
  return {
    source: 'agent',
    ownerLabel,
    phase: starting ? 'inspecting' : 'working',
    phaseLabel: starting ? 'Starting' : 'Working',
    activity: null,
    phaseIndex: starting ? 0 : 1,
    phaseCount: MANAGED_PHASE_COUNT,
    blocked: false,
    startedAt: run?.startedAt || run?.createdAt || null,
    updatedAt: run?.startedAt || run?.createdAt || task.updatedAt,
  };
}

export function deriveTaskBoardLiveWorkProjection(task: Task, inputs: ProjectionInputs = {}): TaskLiveWorkProjection | null {
  if (task.status === 'done' || task.status === 'ready-for-review') return null;
  const now = inputs.now || new Date();
  const claim = activeClaim(task, now.getTime());
  if (!claim) return externalAgentProjection(task, now.getTime());

  const activeExecutions = inputs.activeExecutions || [];
  const matching = activeExecutions.filter((entry) => entry.status === 'active' && entry.workspaceId === claim.workspaceId);
  const session = matching.length === 1 && activeExecutions.length === 1 ? matching[0] : null;
  if (!session) return externalAgentProjection(task, now.getTime());

  const checkpoint = inputs.checkpoint || null;
  const latestOperation = checkpoint?.pendingOperations?.at(-1) || null;
  const lifecyclePhase = phaseFromLifecycle(session.lifecycle.stage);
  const operationPhase = phaseFromOperation(latestOperation?.kind || null);
  const hasCheckpointBlocker = Boolean(checkpoint?.blockers?.length);
  const selectedPhase = hasCheckpointBlocker
    ? { phase: 'blocked' as const, label: 'Blocked', index: lifecyclePhase.index }
    : operationPhase || lifecyclePhase;
  const activity = clean(checkpoint?.blockers?.[0])
    || clean(checkpoint?.pendingNextWork?.[0])
    || titleCaseToken(latestOperation?.kind)
    || titleCaseToken(checkpoint?.reasonCode)
    || null;

  return {
    source: 'managed',
    ownerLabel: claim.ownerLabel,
    ownerKind: claim.ownerKind,
    phase: selectedPhase.phase,
    phaseLabel: selectedPhase.label,
    activity,
    phaseIndex: selectedPhase.index,
    phaseCount: MANAGED_PHASE_COUNT,
    blocked: selectedPhase.phase === 'blocked',
    startedAt: claim.claimedAt,
    updatedAt: checkpoint?.updatedAt || session.updatedAt || claim.claimedAt,
  };
}

export function projectTaskBoardLiveWork(task: Task, now = new Date()): TaskLiveWorkProjection | null {
  if (task.status === 'done' || task.status === 'ready-for-review') return null;
  const claim = activeClaim(task, now.getTime());
  if (!claim) return externalAgentProjection(task);
  const activeExecutions = queryExecutionSessions({ taskId: task.id, status: 'active', limit: 2 }).sessions;
  const matching = activeExecutions.filter((entry) => entry.workspaceId === claim.workspaceId);
  const session = matching.length === 1 && activeExecutions.length === 1 ? matching[0] : null;
  const checkpoint = session ? getLatestExecutionCheckpoint(session.id) : null;
  return deriveTaskBoardLiveWorkProjection(task, { now, activeExecutions, checkpoint });
}

export type AgentOfficePipelineStage = 'waiting-verification' | 'verifying' | 'finalizing' | 'integrating' | 'cleanup';
export type AgentOfficeWorkerSource = 'devflow-managed' | 'worker-native' | 'legacy-agent';

const AGENT_OFFICE_QUEUE_STATES = ['ready', 'execution', 'attention', 'blocked'] as const;

function boundedAgentOfficeLimit(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 20;
  return Math.max(1, Math.min(50, Math.floor(numeric)));
}

function ageFrom(value: unknown, nowMs: number) {
  const startedAtMs = Date.parse(clean(value));
  return Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : null;
}

function checkpointMapFromEvidence(evidenceRecords: any[]) {
  const bySession = new Map<string, ExecutionCheckpointSnapshot>();
  for (const evidence of evidenceRecords) {
    const snapshot = evidence.metadata?.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
    const typed = snapshot as ExecutionCheckpointSnapshot;
    if (!typed.executionSessionId || !typed.stage || bySession.has(typed.executionSessionId)) continue;
    bySession.set(typed.executionSessionId, typed);
  }
  return bySession;
}

function pipelineStageFor(session: ExecutionSessionRecord, checkpoint: ExecutionCheckpointSnapshot | null) {
  const operation = checkpoint?.pendingOperations?.at(-1) || null;
  const kind = clean(operation?.kind).toLowerCase();
  if (kind.includes('cleanup')) return { stage: 'cleanup' as const, operation };
  if (kind.includes('finaliz')) return { stage: 'finalizing' as const, operation };
  if (kind.includes('integrat') || kind.includes('rebase') || kind.includes('merge')) return { stage: 'integrating' as const, operation };
  if (kind.includes('verif') || kind.includes('test') || kind.includes('typecheck') || kind.includes('lint')) {
    return { stage: (operation?.status === 'accepted' ? 'waiting-verification' : 'verifying') as AgentOfficePipelineStage, operation };
  }
  if (session.lifecycle.stage === 'verifying') return { stage: 'verifying' as const, operation };
  if (session.lifecycle.stage === 'verification-infra-blocked') return { stage: 'waiting-verification' as const, operation };
  if (session.lifecycle.stage === 'committed') return { stage: 'integrating' as const, operation };
  if (session.lifecycle.stage === 'finalized') return { stage: 'finalizing' as const, operation };
  return null;
}

function compactOfficeReason(reason: any) {
  return {
    code: clean(reason?.code).slice(0, 160),
    message: clean(reason?.message).slice(0, 240),
  };
}

type AgentOfficeQueueState = (typeof AGENT_OFFICE_QUEUE_STATES)[number];

function officeProject(task: any) {
  return { projectId: String(task.projectId || ''), projectName: clean(task.projectName) || String(task.projectId || '') };
}

function officeScope(task: any) {
  return (Array.isArray(task.targetFiles) ? task.targetFiles : []).map((value: unknown) => clean(value).replace(/\\/g, '/').toLowerCase()).filter(Boolean);
}

function officeQueueFor(task: any, live: TaskLiveWorkProjection | null, taskById: Map<string, any>, parentIds: Set<string>, activeClaimed: any[], nowMs: number) {
  const reasons: Array<{ code: string; message: string }> = [];
  const status = String(task.status || '');
  if (status === 'ready-for-review') return { state: 'attention' as AgentOfficeQueueState, reasons: [{ code: 'TASK_REVIEW_ATTENTION_REQUIRED', message: 'Waiting for review.' }] };
  if (status === 'in-progress') {
    if (!live) return { state: 'attention' as AgentOfficeQueueState, reasons: [{ code: 'TASK_LIVE_WORK_MISSING', message: 'No coherent live worker/session.' }] };
    const attention = live.blocked || live.phaseLabel === 'Disconnected';
    return { state: (attention ? 'attention' : 'execution') as AgentOfficeQueueState, reasons: [{ code: attention ? 'TASK_LIVE_WORK_ATTENTION' : 'TASK_LIVE_WORK_ACTIVE', message: live.phaseLabel }] };
  }
  if (status === 'backlog' || status === 'todo') {
    if (live) return { state: (live.blocked ? 'attention' : 'execution') as AgentOfficeQueueState, reasons: [{ code: 'TASK_BACKGROUND_WORK_ACTIVE', message: live.phaseLabel }] };
    if (activeClaim(task, nowMs)) reasons.push({ code: 'TASK_CLAIM_STATUS_DRIFT', message: 'Active claim outside in-progress.' });
    if (parentIds.has(String(task.id))) reasons.push({ code: 'TASK_PARENT_COORDINATION_SCOPE', message: 'Parent/program scope.' });
    if ((Array.isArray(task.tags) ? task.tags : []).some((tag: unknown) => clean(tag).toLowerCase() === 'final-gate')) reasons.push({ code: 'TASK_FINAL_GATE', message: 'Explicit final gate.' });
    const prerequisiteBlocked = (Array.isArray(task.prerequisiteTaskIds) ? task.prerequisiteTaskIds : []).some((id: unknown) => {
      const prerequisite = taskById.get(String(id || ''));
      return Boolean(prerequisite && prerequisite.status !== 'done');
    });
    if (prerequisiteBlocked) reasons.push({ code: 'TASK_PREREQUISITES_BLOCKING', message: 'Prerequisite not done.' });
    const scope = officeScope(task);
    if (scope.length === 0) reasons.push({ code: 'TASK_SCOPE_UNBOUNDED', message: 'No target-file scope.' });
    const conflict = scope.length > 0 && activeClaimed.some((other) => other.id !== task.id && other.projectId === task.projectId && officeScope(other).some((path) => scope.some((own) => path === own || path.startsWith(`${own}/`) || own.startsWith(`${path}/`))));
    if (conflict) reasons.push({ code: 'TASK_SCOPE_CONFLICT', message: 'Overlaps active claimed scope.' });
    return { state: (reasons.length ? 'blocked' : 'ready') as AgentOfficeQueueState, reasons };
  }
  return { state: 'blocked' as AgentOfficeQueueState, reasons: [{ code: 'TASK_STATUS_NOT_ORCHESTRATABLE', message: status }] };
}

function compactOfficeQueueEntry(entry: any) {
  return {
    projectId: String(entry.projectId || ''),
    projectName: clean(entry.projectName) || String(entry.projectId || ''),
    taskId: String(entry.taskId || ''),
    displayId: entry.displayId || null,
    title: clean(entry.title).slice(0, 240),
    taskStatus: entry.taskStatus,
    reasons: (Array.isArray(entry.reasons) ? entry.reasons : []).slice(0, 4).map(compactOfficeReason),
  };
}

export function getAgentOfficeMonitoringProjection(options: { limit?: unknown } = {}) {
  const limit = boundedAgentOfficeLimit(options.limit);
  const now = new Date();
  const nowMs = now.getTime();
  const taskPage = queryAgentOfficeTaskPage({ limit: 500 });
  const tasks = taskPage.items as any[];
  const taskById = new Map(tasks.map((task) => [String(task.id), task]));
  const parentIds = new Set(tasks.map((task) => String(task.parentId || '')).filter(Boolean));
  const activeClaimed = tasks.filter((task) => Boolean(activeClaim(task, nowMs)));
  const activeExecutionPage = queryExecutionSessions({ status: 'active', limit: 100 });
  const activeByTask = new Map<string, ExecutionSessionRecord[]>();
  for (const session of activeExecutionPage.sessions) {
    if (!session.taskId || !taskById.has(session.taskId)) continue;
    const current = activeByTask.get(session.taskId) || [];
    current.push(session);
    activeByTask.set(session.taskId, current);
  }
  const checkpointPage = queryLatestExecutionSessionEvidence('checkpoint', 100, 'active');
  const checkpoints = checkpointMapFromEvidence(checkpointPage.evidence);
  const contexts = tasks.map((task) => {
    const activeExecutions = activeByTask.get(task.id) || [];
    const checkpoint = activeExecutions.length === 1 ? checkpoints.get(activeExecutions[0].id) || null : null;
    const live = deriveTaskBoardLiveWorkProjection(task, { now, activeExecutions, checkpoint });
    const queue = officeQueueFor(task, live, taskById, parentIds, activeClaimed, nowMs);
    return { task, live, queue };
  });

  const workerRows = contexts.flatMap(({ task, live, queue }) => {
    if (!live) return [];
    const externalRecord = getLatestExternalTaskStatusRecord(task);
    const externalNative = externalRecord?.targetStatus === 'in-progress' && !externalRecord.managedAuthorityOverlap ? externalRecord : null;
    const source: AgentOfficeWorkerSource = live.source === 'managed' ? 'devflow-managed' : externalNative ? 'worker-native' : 'legacy-agent';
    const resultState = clean(externalNative?.metadata?.resultState);
    const stale = live.phaseLabel === 'Disconnected' || Boolean(externalNative && !resultState && isExternalTaskStatusRecordStale(externalNative, nowMs));
    const reasonCodes = queue.reasons.map((reason) => clean(reason.code)).filter(Boolean).slice(0, 6);
    const failure = reasonCodes.some((code) => /FAIL|ERROR|INFRA|BLOCK/.test(code));
    const indicator = stale ? 'disconnected' : live.blocked ? 'blocked' : queue.state === 'attention' ? 'attention' : null;
    return [{
      ...officeProject(task), taskId: task.id, displayId: task.displayId || null,
      title: clean(task.title).slice(0, 240), ownerLabel: live.ownerLabel, ownerKind: live.ownerKind || null, source,
      action: clean(externalNative?.metadata?.action) || clean(live.activity) || live.phaseLabel,
      phase: live.phase, phaseLabel: live.phaseLabel, queueState: queue.state,
      ageMs: ageFrom(live.startedAt, nowMs), updatedAt: live.updatedAt || null,
      stale, failure, indicator, reasonCodes,
    }];
  }).sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
    || left.projectId.localeCompare(right.projectId) || left.taskId.localeCompare(right.taskId));

  const pipelineRows = activeExecutionPage.sessions.flatMap((session) => {
    if (!session.taskId) return [];
    const task = taskById.get(session.taskId);
    if (!task) return [];
    const checkpoint = checkpoints.get(session.id) || null;
    const classified = pipelineStageFor(session, checkpoint);
    if (!classified) return [];
    const operation = classified.operation;
    return [{
      ...officeProject(task),
      taskId: task.id,
      displayId: task.displayId || null,
      title: clean(task.title).slice(0, 240),
      executionSessionId: session.id,
      ownerLabel: task.claim?.workspaceId === session.workspaceId ? task.claim.ownerLabel : null,
      stage: classified.stage,
      lifecycleStage: session.lifecycle.stage,
      operationKind: operation?.kind || null,
      operationStatus: operation?.status || null,
      blocked: Boolean(checkpoint?.blockers?.length) || session.lifecycle.stage === 'verification-infra-blocked',
      activity: clean(checkpoint?.blockers?.[0]) || clean(checkpoint?.pendingNextWork?.[0]) || titleCaseToken(operation?.kind) || null,
      updatedAt: checkpoint?.updatedAt || session.updatedAt,
    }];
  }).sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
    || left.projectId.localeCompare(right.projectId) || left.taskId.localeCompare(right.taskId));

  const queueContexts = [...contexts].sort((left, right) => String(left.task.projectId).localeCompare(String(right.task.projectId)) || String(left.task.id).localeCompare(String(right.task.id)));
  const queueCounts = Object.fromEntries(AGENT_OFFICE_QUEUE_STATES.map((state) => [state, queueContexts.filter((entry) => entry.queue.state === state).length])) as Record<AgentOfficeQueueState, number>;
  const queueItems = Object.fromEntries(AGENT_OFFICE_QUEUE_STATES.map((state) => [state,
    queueContexts.filter((entry) => entry.queue.state === state).slice(0, limit).map((entry) => compactOfficeQueueEntry({
      ...officeProject(entry.task), taskId: entry.task.id, displayId: entry.task.displayId,
      title: entry.task.title, taskStatus: entry.task.status, reasons: entry.queue.reasons,
    })),
  ])) as Record<AgentOfficeQueueState, ReturnType<typeof compactOfficeQueueEntry>[]>;
  const queueTruncated = Object.fromEntries(AGENT_OFFICE_QUEUE_STATES.map((state) => [state, queueCounts[state] > queueItems[state].length])) as Record<AgentOfficeQueueState, boolean>;
  const representedProjects = [...new Map(tasks.map((task) => [String(task.projectId), officeProject(task)])).values()]
    .sort((left, right) => left.projectName.localeCompare(right.projectName) || left.projectId.localeCompare(right.projectId));
  const partial = taskPage.truncated || activeExecutionPage.truncated || checkpointPage.truncated;

  return {
    schema: 'agent-office-monitor.v1',
    scope: 'global' as const,
    projectId: null,
    generatedAt: now.toISOString(),
    limit,
    partial,
    projects: { total: representedProjects.length, items: representedProjects },
    sources: {
      tasks: { total: taskPage.total, returned: tasks.length, limit: taskPage.limit, truncated: taskPage.truncated },
      activeExecutions: { total: activeExecutionPage.total, returned: activeExecutionPage.sessions.length, limit: activeExecutionPage.limit, truncated: activeExecutionPage.truncated },
      checkpoints: { total: checkpointPage.total, returned: checkpointPage.evidence.length, limit: checkpointPage.limit, truncated: checkpointPage.truncated },
    },
    workers: {
      total: workerRows.length,
      items: workerRows.slice(0, limit),
      truncated: workerRows.length > limit,
      sourceTruncated: partial,
    },
    pipeline: {
      total: pipelineRows.length,
      items: pipelineRows.slice(0, limit),
      truncated: pipelineRows.length > limit,
      sourceTruncated: activeExecutionPage.truncated || checkpointPage.truncated,
    },
    queue: {
      counts: queueCounts,
      items: queueItems,
      truncated: queueTruncated,
      sourceTruncated: taskPage.truncated || activeExecutionPage.truncated,
      partial,
    },
  };
}
