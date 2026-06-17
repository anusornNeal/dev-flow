export type RunStatus = 'success' | 'failed' | 'cancelled' | 'running';

export interface AgentRunLike {
  id: string;
  status: string;
  taskId: string;
  createdAt: string;
  [key: string]: unknown;
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['success', 'failed', 'cancelled', 'running']);

export function normalizeRunStatus(status: string | undefined | null): RunStatus {
  if (!status) return 'failed';
  return KNOWN_STATUSES.has(status) ? (status as RunStatus) : 'failed';
}

export function canRetryRun(run: AgentRunLike): boolean {
  return normalizeRunStatus(run.status) === 'failed';
}

export function canCancelRun(run: AgentRunLike): boolean {
  return normalizeRunStatus(run.status) === 'running';
}

export interface CompletionInput {
  status: 'success' | 'failed' | 'cancelled';
  summary: string;
  changedFiles?: string[];
  notes?: string;
}

export interface CompletionValidation {
  ok: boolean;
  reason?: string;
}

export function validateCompletion(input: CompletionInput): CompletionValidation {
  if (!input.summary || input.summary.trim().length === 0) {
    return { ok: false, reason: 'Completion summary is required.' };
  }
  if (!KNOWN_STATUSES.has(input.status)) {
    return { ok: false, reason: `Unknown completion status: ${input.status}` };
  }
  return { ok: true };
}
