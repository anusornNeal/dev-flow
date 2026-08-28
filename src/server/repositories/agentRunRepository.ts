import db, { withDbTransaction } from '../../db/index';

export const AGENT_RUN_STATUSES = ['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const ACTIVE_AGENT_RUN_STATUSES = ['queued', 'starting', 'running'] as const;

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

export interface ActiveProjectAgentRunSummary {
  runId: string;
  taskId: string;
  agent: string;
  status: AgentRunStatus;
  createdAt: string;
}

type CreateAgentRunInput = Pick<AgentRun, 'taskId' | 'projectId' | 'agent'> & Partial<Pick<AgentRun, 'model' | 'effort' | 'promptPath' | 'contextRef' | 'logPath' | 'retryOfRunId' | 'triggerSource'>>;

const TERMINAL_AGENT_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set(['succeeded', 'failed', 'cancelled']);

const ALLOWED_AGENT_RUN_TRANSITIONS: Record<AgentRunStatus, ReadonlySet<AgentRunStatus>> = {
  queued: new Set(['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled']),
  starting: new Set(['starting', 'running', 'succeeded', 'failed', 'cancelled']),
  running: new Set(['running', 'succeeded', 'failed', 'cancelled']),
  succeeded: new Set(['succeeded']),
  failed: new Set(['failed']),
  cancelled: new Set(['cancelled']),
};

function createRunId() {
  return `run-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
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

export function canTransitionAgentRunStatus(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return ALLOWED_AGENT_RUN_TRANSITIONS[from]?.has(to) ?? false;
}

export function createAgentRun(input: CreateAgentRunInput): AgentRun {
  return withDbTransaction(() => {
    const run: AgentRun = {
      id: createRunId(),
      taskId: input.taskId,
      projectId: input.projectId,
      agent: input.agent,
      model: input.model || null,
      effort: input.effort || null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      promptPath: input.promptPath || null,
      contextRef: input.contextRef || null,
      logPath: input.logPath || null,
      errorMessage: null,
      retryOfRunId: input.retryOfRunId || null,
      triggerSource: input.triggerSource || null,
    };

    db.prepare(`
      INSERT INTO agent_runs (
        id, taskId, projectId, agent, model, effort, status, createdAt, startedAt, endedAt,
        promptPath, contextRef, logPath, errorMessage, retryOfRunId, triggerSource
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.taskId, run.projectId, run.agent, run.model, run.effort, run.status, run.createdAt, run.startedAt, run.endedAt,
      run.promptPath, run.contextRef, run.logPath, run.errorMessage, run.retryOfRunId, run.triggerSource,
    );

    return run;
  });
}

export function getAgentRun(runId: string): AgentRun | null {
  return normalizeRun(db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId));
}

export function listAgentRunsForTask(taskId: string): AgentRun[] {
  return normalizeRuns(db.prepare('SELECT * FROM agent_runs WHERE taskId = ? ORDER BY createdAt DESC').all(taskId) as any[]);
}

export function getLatestAgentRunForTask(taskId: string): AgentRun | null {
  return normalizeRun(db.prepare('SELECT * FROM agent_runs WHERE taskId = ? ORDER BY createdAt DESC LIMIT 1').get(taskId));
}

export function getActiveRunForTask(taskId: string): AgentRun | null {
  return normalizeRun(db.prepare(`
    SELECT * FROM agent_runs
    WHERE taskId = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
    ORDER BY createdAt DESC
    LIMIT 1
  `).get(taskId, ...ACTIVE_AGENT_RUN_STATUSES));
}

export function findActiveRunByTaskId(taskId: string, agent?: string | null): AgentRun | null {
  if (agent) {
    return normalizeRun(db.prepare(`
      SELECT * FROM agent_runs
      WHERE taskId = ? AND agent = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
      ORDER BY createdAt DESC
      LIMIT 1
    `).get(taskId, agent, ...ACTIVE_AGENT_RUN_STATUSES));
  }

  return getActiveRunForTask(taskId);
}

export function getActiveRunForProject(projectId: string): AgentRun | null {
  return normalizeRun(db.prepare(`
    SELECT * FROM agent_runs
    WHERE projectId = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
    ORDER BY createdAt ASC
    LIMIT 1
  `).get(projectId, ...ACTIVE_AGENT_RUN_STATUSES));
}

export function getActiveRunForProjectAndAgent(projectId: string, agent: string): AgentRun | null {
  return normalizeRun(db.prepare(`
    SELECT * FROM agent_runs
    WHERE projectId = ? AND agent = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
    ORDER BY createdAt ASC
    LIMIT 1
  `).get(projectId, agent, ...ACTIVE_AGENT_RUN_STATUSES));
}

export function listActiveRunsForProject(projectId: string): AgentRun[] {
  return normalizeRuns(db.prepare(`
    SELECT * FROM agent_runs
    WHERE projectId = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
    ORDER BY createdAt ASC
  `).all(projectId, ...ACTIVE_AGENT_RUN_STATUSES) as any[]);
}

export function listActiveRunSummariesForProject(projectId: string): ActiveProjectAgentRunSummary[] {
  return listActiveRunsForProject(projectId).map((run) => ({
    runId: run.id,
    taskId: run.taskId,
    agent: run.agent,
    status: run.status,
    createdAt: run.createdAt,
  }));
}

export function updateAgentRunStatus(
  runId: string,
  status: AgentRunStatus,
  patch: Partial<Pick<AgentRun, 'startedAt' | 'endedAt' | 'errorMessage' | 'promptPath' | 'contextRef' | 'logPath'>> = {},
): AgentRun | null {
  return withDbTransaction(() => {
    const existing = getAgentRun(runId);
    if (!existing) return null;

    if (!canTransitionAgentRunStatus(existing.status, status)) {
      return existing;
    }

    const isTerminalStatus = TERMINAL_AGENT_RUN_STATUSES.has(status);
    const endedAt = isTerminalStatus
      ? patch.endedAt || existing.endedAt || new Date().toISOString()
      : patch.endedAt !== undefined ? patch.endedAt : existing.endedAt;

    const result = db.prepare(`
      UPDATE agent_runs
      SET status = ?, startedAt = ?, endedAt = ?, promptPath = ?, contextRef = ?, logPath = ?, errorMessage = ?
      WHERE id = ? AND status = ?
    `).run(
      status,
      patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
      endedAt,
      patch.promptPath !== undefined ? patch.promptPath : existing.promptPath,
      patch.contextRef !== undefined ? patch.contextRef : existing.contextRef,
      patch.logPath !== undefined ? patch.logPath : existing.logPath,
      patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage,
      runId,
      existing.status,
    );

    if (result.changes === 0) {
      return getAgentRun(runId);
    }

    return getAgentRun(runId);
  });
}

export function cancelActiveRunsForTask(taskId: string, reason = 'cancelled manually'): number {
  return withDbTransaction(() => {
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE agent_runs
      SET status = 'cancelled', endedAt = ?, errorMessage = ?
      WHERE taskId = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
    `).run(now, reason, taskId, ...ACTIVE_AGENT_RUN_STATUSES);
    return result.changes;
  });
}

export function cancelStaleActiveRuns(cutoffIso: string, reason = 'stale run cancelled'): number {
  return withDbTransaction(() => {
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE agent_runs
      SET status = 'cancelled', endedAt = ?, errorMessage = ?
      WHERE status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
        AND COALESCE(startedAt, createdAt) < ?
    `).run(now, reason, ...ACTIVE_AGENT_RUN_STATUSES, cutoffIso);
    return result.changes;
  });
}
