import type { Task, TaskLiveWorkPhase, TaskLiveWorkProjection } from '../../types.js';
import { queryExecutionSessions, type ExecutionLifecycleStage, type ExecutionSessionRecord } from '../repositories/executionSessionRepository.js';
import { getLatestExecutionCheckpoint, type ExecutionCheckpointSnapshot } from './executionCheckpointService.js';

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

function externalAgentProjection(task: Task): TaskLiveWorkProjection | null {
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
  if (!claim) return externalAgentProjection(task);

  const activeExecutions = inputs.activeExecutions || [];
  const matching = activeExecutions.filter((entry) => entry.status === 'active' && entry.workspaceId === claim.workspaceId);
  const session = matching.length === 1 && activeExecutions.length === 1 ? matching[0] : null;
  if (!session) return externalAgentProjection(task);

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
