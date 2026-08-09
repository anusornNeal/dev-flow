import { randomUUID } from 'node:crypto';
import type { AppState } from '../types.js';
import { listExecutionSessionEvidence, type ExecutionSessionEvidenceRecord } from '../repositories/executionSessionRepository.js';
import { findTaskByIdentifier } from './taskService.js';
import {
  getExecutionSessionState,
  recordExecutionSessionEvidence,
  resumeExecutionSession,
} from './executionSessionService.js';

export interface CreateExecutionHandoffInput {
  fromAgent?: string | null;
  toAgent?: string | null;
  fromProvider?: string | null;
  toProvider?: string | null;
  lastCompletedStage?: string | null;
  completedWork?: string[];
  pendingNextWork?: string[];
  decisions?: string[];
  dependencies?: string[];
  risks?: string[];
  note?: string | null;
}

export interface ExecutionHandoffSnapshot {
  id: string;
  executionSessionId: string;
  createdAt: string;
  fromAgent: string | null;
  toAgent: string | null;
  fromProvider: string | null;
  toProvider: string | null;
  lastCompletedStage: string | null;
  completedWork: string[];
  pendingNextWork: string[];
  decisions: string[];
  dependencies: string[];
  risks: string[];
  note: string | null;
  task: {
    id: string | null;
    displayId: string | null;
    title: string | null;
    status: string | null;
    parentId: string | null;
  };
  identity: {
    projectId: string;
    taskId: string | null;
    workspaceId: string | null;
    branch: string | null;
    baseRevision: string | null;
    repoRevision: string | null;
    contextHandle: string | null;
  };
  changedFiles: string[];
  verification: unknown[];
  evidence: Array<{
    id: string;
    kind: string;
    path: string | null;
    repoRevision: string | null;
    fileRevision: string | null;
    revisionIdentity: string | null;
    stale: boolean;
  }>;
}

function compactString(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function redactWorkspaceRoot(value: string, repoRoot?: string) {
  if (!repoRoot) return value;
  const variants = [repoRoot, repoRoot.replace(/\\/g, '/'), repoRoot.replace(/\//g, '\\')]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let result = value;
  for (const variant of variants) result = result.split(variant).join('[workspace]');
  return result;
}

function normalizeTextList(values: unknown, repoRoot?: string) {
  if (!Array.isArray(values)) return [] as string[];
  return [...new Set(values
    .map((value) => redactWorkspaceRoot(String(value ?? '').trim(), repoRoot))
    .filter(Boolean))];
}

function evidenceRef(entry: ExecutionSessionEvidenceRecord) {
  return {
    id: entry.id,
    kind: entry.kind,
    path: entry.path,
    repoRevision: entry.repoRevision,
    fileRevision: entry.fileRevision,
    revisionIdentity: entry.revisionIdentity,
    stale: entry.stale,
  };
}

function taskProgress(state: AppState, taskId: string | null) {
  const task = taskId ? findTaskByIdentifier(state, taskId) : null;
  const checklist = Array.isArray(task?.checklist) ? task.checklist : [];
  return {
    task: {
      id: task?.id || taskId || null,
      displayId: task?.displayId || null,
      title: task?.title || null,
      status: task?.status || null,
      parentId: task?.parentId || null,
    },
    completed: checklist
      .filter((item: any) => item?.completed === true)
      .map((item: any) => String(item?.text || '').trim())
      .filter(Boolean),
    pending: checklist
      .filter((item: any) => item?.completed !== true)
      .map((item: any) => String(item?.text || '').trim())
      .filter(Boolean),
  };
}

function snapshotFromEvidence(entry: ExecutionSessionEvidenceRecord): ExecutionHandoffSnapshot | null {
  if (entry.kind !== 'handoff') return null;
  const snapshot = entry.metadata?.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const typed = snapshot as unknown as ExecutionHandoffSnapshot;
  if (!typed.id || !typed.executionSessionId) return null;
  return typed;
}

export function listExecutionHandoffSnapshots(sessionId: string) {
  return listExecutionSessionEvidence(sessionId)
    .map(snapshotFromEvidence)
    .filter((entry): entry is ExecutionHandoffSnapshot => Boolean(entry))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id));
}

export function createExecutionHandoffSnapshot(
  state: AppState,
  sessionId: string,
  input: CreateExecutionHandoffInput,
  options: { repoRoot?: string; now?: Date } = {},
): ExecutionHandoffSnapshot {
  const now = options.now || new Date();
  if (options.repoRoot) resumeExecutionSession(sessionId, { repoRoot: options.repoRoot, now });
  const { session, evidence } = getExecutionSessionState(sessionId);
  const progress = taskProgress(state, session.taskId);
  const explicitCompleted = normalizeTextList(input.completedWork, options.repoRoot);
  const explicitPending = normalizeTextList(input.pendingNextWork, options.repoRoot);
  const completedWork = [...new Set([...progress.completed, ...explicitCompleted])];
  const pendingNextWork = explicitPending.length > 0 ? explicitPending : progress.pending;
  const decisions = normalizeTextList(input.decisions, options.repoRoot);
  const dependencies = normalizeTextList(input.dependencies, options.repoRoot);
  const risks = normalizeTextList(input.risks, options.repoRoot);
  const noteValue = compactString(input.note);
  const note = noteValue ? redactWorkspaceRoot(noteValue, options.repoRoot) : null;
  const snapshotId = `handoff-${randomUUID()}`;
  const sourceEvidence = evidence.filter((entry) => entry.kind !== 'handoff').map(evidenceRef);
  const snapshot: ExecutionHandoffSnapshot = {
    id: snapshotId,
    executionSessionId: session.id,
    createdAt: now.toISOString(),
    fromAgent: compactString(input.fromAgent),
    toAgent: compactString(input.toAgent),
    fromProvider: compactString(input.fromProvider),
    toProvider: compactString(input.toProvider),
    lastCompletedStage: compactString(input.lastCompletedStage) || completedWork.at(-1) || null,
    completedWork,
    pendingNextWork,
    decisions,
    dependencies,
    risks,
    note,
    task: progress.task,
    identity: {
      projectId: session.projectId,
      taskId: session.taskId,
      workspaceId: session.workspaceId,
      branch: session.branch,
      baseRevision: session.baseRevision,
      repoRevision: session.repoRevision,
      contextHandle: session.contextHandle,
    },
    changedFiles: [...session.changedFiles],
    verification: [...session.verification],
    evidence: sourceEvidence,
  };

  recordExecutionSessionEvidence(sessionId, [{
    evidenceId: snapshotId,
    kind: 'handoff',
    repoRevision: session.repoRevision,
    metadata: { snapshot },
  }], { repoRoot: options.repoRoot, now });
  return snapshot;
}

export function getExecutionSessionResumeView(
  state: AppState,
  sessionId: string,
  options: { repoRoot?: string; workspaceId?: string | null; receivingAgent?: string | null; now?: Date } = {},
) {
  const resumed = resumeExecutionSession(sessionId, {
    repoRoot: options.repoRoot,
    workspaceId: options.workspaceId,
    now: options.now,
  });
  const latestHandoff = listExecutionHandoffSnapshots(sessionId)[0] || null;
  const progress = taskProgress(state, resumed.session.taskId);
  const fileEvidence = resumed.evidence.filter((entry) => entry.kind === 'file');
  const staleEvidence = fileEvidence.filter((entry) => entry.stale).map(evidenceRef);
  const reusableEvidence = fileEvidence.filter((entry) => !entry.stale).map(evidenceRef);
  const requiresFreshRead = [...new Set([
    ...resumed.session.changedFiles,
    ...staleEvidence.map((entry) => entry.path).filter((entry): entry is string => Boolean(entry)),
  ])].sort();
  let validity: 'valid' | 'stale' | 'terminal' | 'workspace-mismatch' = staleEvidence.length > 0 ? 'stale' : 'valid';
  if (!resumed.resumable && resumed.reason === 'SESSION_TERMINAL') validity = 'terminal';
  if (!resumed.resumable && resumed.reason === 'WORKSPACE_MISMATCH') validity = 'workspace-mismatch';

  const warnings: string[] = [];
  if (staleEvidence.length > 0) warnings.push(`Fresh-read required for stale targets: ${staleEvidence.map((entry) => entry.path).filter(Boolean).join(', ')}.`);
  if (validity === 'terminal') warnings.push(`Execution session is terminal (${resumed.session.status}); review evidence is available but active mutation is disabled.`);
  if (validity === 'workspace-mismatch') warnings.push('Requested workspace does not match the logical workspace associated with this execution session.');
  const receivingAgent = compactString(options.receivingAgent);
  if (receivingAgent && latestHandoff?.toAgent && receivingAgent !== latestHandoff.toAgent) {
    warnings.push(`Latest handoff targets '${latestHandoff.toAgent}', while the receiving agent is '${receivingAgent}'.`);
  }

  return {
    executionSessionId: resumed.session.id,
    resumable: resumed.resumable,
    validity,
    status: resumed.session.status,
    identity: {
      projectId: resumed.session.projectId,
      taskId: resumed.session.taskId,
      workspaceId: resumed.session.workspaceId,
      branch: resumed.session.branch,
      baseRevision: resumed.session.baseRevision,
      repoRevision: resumed.session.repoRevision,
      currentRepoRevision: resumed.currentRepoRevision || resumed.session.repoRevision,
      contextHandle: resumed.session.contextHandle,
    },
    task: latestHandoff?.task || progress.task,
    lastCompletedStage: latestHandoff?.lastCompletedStage || progress.completed.at(-1) || null,
    completedWork: latestHandoff?.completedWork || progress.completed,
    pendingNextWork: latestHandoff?.pendingNextWork || progress.pending,
    changedFiles: [...resumed.session.changedFiles],
    verification: [...resumed.session.verification],
    handoff: latestHandoff,
    reusableEvidence,
    staleEvidence,
    requiresFreshRead,
    warnings,
  };
}
