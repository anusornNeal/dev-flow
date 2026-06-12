import db from '../../db/index';

export const AGENT_RUN_STATUSES = ['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const ACTIVE_AGENT_RUN_STATUSES = ['queued', 'starting', 'running'] as const;

export type AgentRunStatus = typeof AGENT_RUN_STATUSES[number];

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

type CreateAgentRunInput = Pick<AgentRun, 'taskId' | 'projectId' | 'agent'> & Partial<Pick<AgentRun, 'model' | 'effort' | 'promptPath' | 'contextRef' | 'logPath' | 'retryOfRunId' | 'triggerSource'>>;

function createRunId() {
  return `run-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function normalizeRun(row: any): AgentRun | null {
  if (!row) return null;
  return row as AgentRun;
}

export function createAgentRun(input: CreateAgentRunInput): AgentRun {
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
}

export function getAgentRun(runId: string): AgentRun | null {
  return normalizeRun(db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId));
}

export function listAgentRunsForTask(taskId: string): AgentRun[] {
  return db.prepare('SELECT * FROM agent_runs WHERE taskId = ? ORDER BY createdAt DESC').all(taskId) as AgentRun[];
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

export function getActiveRunForProject(projectId: string): AgentRun | null {
  return normalizeRun(db.prepare(`
    SELECT * FROM agent_runs
    WHERE projectId = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
    ORDER BY createdAt ASC
    LIMIT 1
  `).get(projectId, ...ACTIVE_AGENT_RUN_STATUSES));
}

export function updateAgentRunStatus(
  runId: string,
  status: AgentRunStatus,
  patch: Partial<Pick<AgentRun, 'startedAt' | 'endedAt' | 'errorMessage' | 'promptPath' | 'contextRef' | 'logPath'>> = {},
): AgentRun | null {
  const existing = getAgentRun(runId);
  if (!existing) return null;

  const endedAt = ['succeeded', 'failed', 'cancelled'].includes(status)
    ? patch.endedAt || existing.endedAt || new Date().toISOString()
    : patch.endedAt !== undefined ? patch.endedAt : existing.endedAt;

  db.prepare(`
    UPDATE agent_runs
    SET status = ?, startedAt = ?, endedAt = ?, promptPath = ?, contextRef = ?, logPath = ?, errorMessage = ?
    WHERE id = ?
  `).run(
    status,
    patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
    endedAt,
    patch.promptPath !== undefined ? patch.promptPath : existing.promptPath,
    patch.contextRef !== undefined ? patch.contextRef : existing.contextRef,
    patch.logPath !== undefined ? patch.logPath : existing.logPath,
    patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage,
    runId,
  );

  return getAgentRun(runId);
}

export function cancelActiveRunsForTask(taskId: string, reason = 'cancelled manually'): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE agent_runs
    SET status = 'cancelled', endedAt = ?, errorMessage = ?
    WHERE taskId = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
  `).run(now, reason, taskId, ...ACTIVE_AGENT_RUN_STATUSES);
  return result.changes;
}
