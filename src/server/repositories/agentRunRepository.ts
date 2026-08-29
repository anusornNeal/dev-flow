import db from '../../db/index';

export const AGENT_RUN_STATUSES = ['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AgentRunStatus = typeof AGENT_RUN_STATUSES[number];

export const AGENT_NEUTRAL_ORCHESTRATION_ACTIONS = ['IMPLEMENT_TASK', 'RESOLVE_FAILURE', 'RESOLVE_CONFLICT', 'REVIEW_TASK', 'INVESTIGATE'] as const;
export const AGENT_NEUTRAL_RESULT_STATES = ['HANDOFF_READY', 'BLOCKED', 'NEEDS_CONTEXT', 'COMPLETE'] as const;
export const AGENT_EXECUTION_ADAPTERS = ['devflow-managed', 'worker-native', 'legacy-launcher'] as const;

export type AgentNeutralOrchestrationAction = typeof AGENT_NEUTRAL_ORCHESTRATION_ACTIONS[number];
export type AgentNeutralOrchestrationResultState = typeof AGENT_NEUTRAL_RESULT_STATES[number];
export type AgentExecutionAdapter = typeof AGENT_EXECUTION_ADAPTERS[number];
export type AgentOrchestrationEvidenceAuthority = 'orchestration-only';

export type AgentNeutralOrchestrationEnvelope = {
  version: 'agent-neutral-orchestration.v1';
  projectId: string;
  taskId: string;
  action: AgentNeutralOrchestrationAction;
  adapter: AgentExecutionAdapter;
  canonicalStateOwner: 'devflow';
  repositoryExecutionOwner: 'devflow' | 'worker';
  disposableWorker: true;
  contextRef: string | null;
};

export type AgentNeutralOrchestrationResult = {
  version: 'agent-neutral-orchestration-result.v1';
  projectId: string;
  taskId: string;
  action: AgentNeutralOrchestrationAction;
  state: AgentNeutralOrchestrationResultState;
  summary: string;
  evidenceAuthority: AgentOrchestrationEvidenceAuthority;
  workerReplaceable: true;
  runId: string | null;
};

export function createAgentNeutralOrchestrationEnvelope(input: {
  projectId: string;
  taskId: string;
  action: AgentNeutralOrchestrationAction;
  adapter: AgentExecutionAdapter;
  contextRef?: string | null;
}): AgentNeutralOrchestrationEnvelope {
  return {
    version: 'agent-neutral-orchestration.v1',
    projectId: String(input.projectId || '').trim(),
    taskId: String(input.taskId || '').trim(),
    action: input.action,
    adapter: input.adapter,
    canonicalStateOwner: 'devflow',
    repositoryExecutionOwner: input.adapter === 'worker-native' ? 'worker' : 'devflow',
    disposableWorker: true,
    contextRef: String(input.contextRef || '').trim() || null,
  };
}

export function createAgentNeutralOrchestrationResult(input: {
  projectId: string;
  taskId: string;
  action: AgentNeutralOrchestrationAction;
  state: AgentNeutralOrchestrationResultState;
  summary: string;
  runId?: string | null;
}): AgentNeutralOrchestrationResult {
  return {
    version: 'agent-neutral-orchestration-result.v1',
    projectId: String(input.projectId || '').trim(),
    taskId: String(input.taskId || '').trim(),
    action: input.action,
    state: input.state,
    summary: String(input.summary || '').trim(),
    evidenceAuthority: 'orchestration-only',
    workerReplaceable: true,
    runId: String(input.runId || '').trim() || null,
  };
}

export interface AgentRun {
  id: string;
  taskId: string;
  projectId: string;
  agent: string;
  model?: string | null;
  effort?: string | null;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  promptPath?: string | null;
  contextRef?: string | null;
  logPath?: string | null;
  errorMessage?: string | null;
  retryOfRunId?: string | null;
  triggerSource?: string | null;
}

function normalizeRun(row: any): AgentRun | null {
  if (!row) return null;
  const status = String(row.status || '');
  if (!(AGENT_RUN_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`INVALID_AGENT_RUN_STATUS:${status || '<empty>'}`);
  }
  const nullableString = (value: unknown): string | null => value == null ? null : String(value);
  return {
    id: String(row.id),
    taskId: String(row.taskId),
    projectId: String(row.projectId),
    agent: String(row.agent),
    model: nullableString(row.model),
    effort: nullableString(row.effort),
    status: status as AgentRunStatus,
    createdAt: String(row.createdAt),
    startedAt: nullableString(row.startedAt),
    endedAt: nullableString(row.endedAt),
    promptPath: nullableString(row.promptPath),
    contextRef: nullableString(row.contextRef),
    logPath: nullableString(row.logPath),
    errorMessage: nullableString(row.errorMessage),
    retryOfRunId: nullableString(row.retryOfRunId),
    triggerSource: nullableString(row.triggerSource),
  };
}

function normalizeRuns(rows: any[]): AgentRun[] {
  return rows.map((row) => normalizeRun(row)!).filter(Boolean);
}

/** Read-only cold-history access. Legacy agent_runs rows are retained for audit compatibility. */
export function getAgentRun(runId: string): AgentRun | null {
  return normalizeRun(db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId));
}

export function listAgentRunsForTask(taskId: string): AgentRun[] {
  return normalizeRuns(db.prepare('SELECT * FROM agent_runs WHERE taskId = ? ORDER BY createdAt DESC').all(taskId) as any[]);
}

export function getLatestAgentRunForTask(taskId: string): AgentRun | null {
  return normalizeRun(db.prepare('SELECT * FROM agent_runs WHERE taskId = ? ORDER BY createdAt DESC LIMIT 1').get(taskId));
}
