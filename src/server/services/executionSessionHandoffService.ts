import { randomUUID } from 'node:crypto';
import type { AppState } from '../types.js';
import { listExecutionSessionEvidence, type ExecutionSessionEvidenceRecord } from '../repositories/executionSessionRepository.js';
import { findTaskByIdentifier } from './taskService.js';
import {
  getExecutionSessionState,
  recordExecutionSessionEvidence,
  resumeExecutionSession,
} from './executionSessionService.js';
import {
  compactVerificationReferences,
  enrichExecutionCheckpointFromHandoff,
  getLatestExecutionCheckpoint,
} from './executionCheckpointService.js';

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

export type ExecutionCommitRoute = {
  tool: 'commit_task_owned_changes';
  taskId: string;
  workspaceId: string;
  executionSessionId: string;
};

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
  commitRoute: ExecutionCommitRoute | null;
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

function canonicalCommitRoute(session: { id: string; taskId?: string | null; workspaceId?: string | null }): ExecutionCommitRoute | null {
  const taskId = compactString(session.taskId);
  const workspaceId = compactString(session.workspaceId);
  if (!taskId || !workspaceId) return null;
  return {
    tool: 'commit_task_owned_changes',
    taskId,
    workspaceId,
    executionSessionId: session.id,
  };
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
  const sourceEvidence = evidence.filter((entry) => entry.kind !== 'handoff' && entry.kind !== 'checkpoint').map(evidenceRef);
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
    commitRoute: canonicalCommitRoute(session),
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
  enrichExecutionCheckpointFromHandoff(sessionId, {
    completedWork: snapshot.completedWork,
    pendingNextWork: snapshot.pendingNextWork,
    decisions: snapshot.decisions,
    blockers: [...snapshot.dependencies, ...snapshot.risks],
  }, now);
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
  const latestCheckpoint = getLatestExecutionCheckpoint(sessionId);
  const progress = taskProgress(state, resumed.session.taskId);
  const fileEvidence = resumed.evidence.filter((entry) => entry.kind === 'file');
  const staleEvidence = fileEvidence.filter((entry) => entry.stale).map(evidenceRef);
  const reusableEvidence = fileEvidence.filter((entry) => !entry.stale).map(evidenceRef);
  const requiresFreshRead = [...new Set([
    ...resumed.session.changedFiles,
    ...staleEvidence.map((entry) => entry.path).filter((entry): entry is string => Boolean(entry)),
  ])].sort();
  const currentRepoRevision = resumed.currentRepoRevision || resumed.session.repoRevision;
  const checkpointFresh = !latestCheckpoint?.sourceRepoRevision || !currentRepoRevision || latestCheckpoint.sourceRepoRevision === currentRepoRevision;
  const contextFresh = !latestCheckpoint || latestCheckpoint.contextHandle === resumed.session.contextHandle;
  const verificationReferences = latestCheckpoint?.verificationReferences?.length
    ? latestCheckpoint.verificationReferences
    : compactVerificationReferences(resumed.session.verification);
  const verificationFreshness: 'fresh' | 'stale' | 'missing' = verificationReferences.length === 0
    ? 'missing'
    : checkpointFresh && contextFresh && staleEvidence.length === 0 ? 'fresh' : 'stale';
  let validity: 'valid' | 'stale' | 'terminal' | 'workspace-mismatch' = staleEvidence.length > 0 || !checkpointFresh || !contextFresh ? 'stale' : 'valid';
  if (!resumed.resumable && resumed.reason === 'SESSION_TERMINAL') validity = 'terminal';
  if (!resumed.resumable && resumed.reason === 'WORKSPACE_MISMATCH') validity = 'workspace-mismatch';

  const warnings: string[] = [];
  if (staleEvidence.length > 0) warnings.push(`Fresh-read required for stale targets: ${staleEvidence.map((entry) => entry.path).filter(Boolean).join(', ')}.`);
  if (!checkpointFresh) warnings.push('Automatic checkpoint was recorded against an older repository revision; revalidate affected evidence before mutation.');
  if (!contextFresh) warnings.push('Context handle changed after the latest checkpoint; refresh context before relying on checkpointed decisions.');
  if ((latestCheckpoint?.pendingOperations.length || 0) > 0) warnings.push('Pending durable operations must be inspected by operation id; do not replay lifecycle-affecting mutations solely because the prior client response was lost.');
  if (validity === 'terminal') warnings.push(`Execution session is terminal (${resumed.session.status}); review evidence is available but active mutation is disabled.`);
  if (validity === 'workspace-mismatch') warnings.push('Requested workspace does not match the logical workspace associated with this execution session.');
  const receivingAgent = compactString(options.receivingAgent);
  if (receivingAgent && latestHandoff?.toAgent && receivingAgent !== latestHandoff.toAgent) {
    warnings.push(`Latest handoff targets '${latestHandoff.toAgent}', while the receiving agent is '${receivingAgent}'.`);
  }

  const recoveryBlockers: Array<{ code: string; message: string; replacementExecutionAllowed: false; operationId?: string }> = [];
  if (validity === 'workspace-mismatch') recoveryBlockers.push({
    code: 'WORKSPACE_MISMATCH',
    message: 'Resume must use the same logical workspace; do not create a replacement execution automatically.',
    replacementExecutionAllowed: false,
  });
  if (validity === 'terminal') recoveryBlockers.push({
    code: 'SESSION_TERMINAL',
    message: `Execution session is terminal (${resumed.session.status}) and cannot resume active mutation.`,
    replacementExecutionAllowed: false,
  });
  if (!checkpointFresh || !contextFresh || staleEvidence.length > 0) recoveryBlockers.push({
    code: 'FRESHNESS_REVALIDATION_REQUIRED',
    message: 'Checkpoint/context/evidence freshness must be restored before lifecycle-affecting mutation continues.',
    replacementExecutionAllowed: false,
  });
  for (const pending of latestCheckpoint?.pendingOperations || []) recoveryBlockers.push({
    code: 'PENDING_DURABLE_OPERATION',
    message: 'Inspect the durable operation outcome before deciding whether any mutation is still required.',
    replacementExecutionAllowed: false,
    operationId: pending.operationId,
  });

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
      currentRepoRevision,
      contextHandle: resumed.session.contextHandle,
    },
    task: latestHandoff?.task || progress.task,
    commitRoute: canonicalCommitRoute(resumed.session),
    stage: resumed.session.lifecycle.stage,
    lifecycle: resumed.session.lifecycle,
    lastCompletedStage: latestHandoff?.lastCompletedStage || latestCheckpoint?.stage || progress.completed.at(-1) || null,
    completedWork: latestHandoff?.completedWork?.length ? latestHandoff.completedWork : latestCheckpoint?.completedWork?.length ? latestCheckpoint.completedWork : progress.completed,
    pendingNextWork: latestHandoff?.pendingNextWork?.length ? latestHandoff.pendingNextWork : latestCheckpoint?.pendingNextWork?.length ? latestCheckpoint.pendingNextWork : progress.pending,
    decisions: latestHandoff?.decisions?.length ? latestHandoff.decisions : latestCheckpoint?.decisions || [],
    blockers: latestCheckpoint?.blockers || [],
    changedFiles: [...resumed.session.changedFiles],
    verification: [...resumed.session.verification],
    verificationReferences,
    contextHandleLineage: latestCheckpoint?.contextHandleLineage || (resumed.session.contextHandle ? [resumed.session.contextHandle] : []),
    pendingOperations: latestCheckpoint?.pendingOperations || [],
    checkpoint: latestCheckpoint,
    recoveryBlockers,
    freshness: {
      checkpoint: checkpointFresh ? 'fresh' : 'stale',
      context: contextFresh ? 'fresh' : 'stale',
      evidence: staleEvidence.length === 0 ? 'fresh' : 'stale',
      verification: verificationFreshness,
    },
    handoff: latestHandoff,
    reusableEvidence,
    staleEvidence,
    requiresFreshRead,
    warnings,
  };
}
