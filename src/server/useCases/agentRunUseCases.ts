export type AgentRunLifecycleStatus = 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type CompletionStatus = 'success' | 'succeeded' | 'failed' | 'cancelled';

export interface AgentRunLike {
  id: string;
  status: string;
  taskId: string;
  createdAt: string;
  [key: string]: unknown;
}

const ACTIVE_STATUSES: ReadonlySet<AgentRunLifecycleStatus> = new Set(['queued', 'starting', 'running']);
const TERMINAL_STATUSES: ReadonlySet<AgentRunLifecycleStatus> = new Set(['succeeded', 'failed', 'cancelled']);
const KNOWN_STATUSES: ReadonlySet<string> = new Set([...ACTIVE_STATUSES, ...TERMINAL_STATUSES, 'success']);

export function normalizeRunStatus(status: string | undefined | null): AgentRunLifecycleStatus {
  if (!status) return 'failed';
  if (status === 'success') return 'succeeded';
  return KNOWN_STATUSES.has(status) ? (status as AgentRunLifecycleStatus) : 'failed';
}

export function isActiveRun(run: AgentRunLike): boolean {
  return ACTIVE_STATUSES.has(normalizeRunStatus(run.status));
}

export function isTerminalRun(run: AgentRunLike): boolean {
  return TERMINAL_STATUSES.has(normalizeRunStatus(run.status));
}

export function canRetryRun(run: AgentRunLike): boolean {
  return normalizeRunStatus(run.status) === 'failed';
}

export function canCancelRun(run: AgentRunLike): boolean {
  return isActiveRun(run);
}

export function canApplyCompletion(run: AgentRunLike, expectedRunId?: string | null): boolean {
  if (expectedRunId && run.id !== expectedRunId) return false;
  return isActiveRun(run);
}

export interface CompletionInput {
  status: CompletionStatus;
  summary: string;
  changedFiles?: string[];
  notes?: string;
}

export interface CompletionValidation {
  ok: boolean;
  reason?: string;
}

export function normalizeCompletionStatus(status: CompletionStatus): 'success' | 'failed' | 'cancelled' {
  return status === 'succeeded' ? 'success' : status;
}

export function validateCompletion(input: CompletionInput): CompletionValidation {
  if (!input.summary || input.summary.trim().length === 0) {
    return { ok: false, reason: 'Completion summary is required.' };
  }
  if (!['success', 'succeeded', 'failed', 'cancelled'].includes(input.status)) {
    return { ok: false, reason: `Unknown completion status: ${input.status}` };
  }
  return { ok: true };
}
