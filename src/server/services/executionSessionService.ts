// DVF-0685: reusable verification coverage is keyed to relevant inputs, not repo lineage alone.
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createExecutionSessionRecord,
  getExecutionSessionById,
  listExecutionSessionEvidence,
  listExecutionSessionsForWorkspace,
  queryExecutionSessions,
  markExpiredExecutionSessions,
  markExpiredExecutionSessionsForTaskWorkspace,
  replaceExecutionSessionEvidenceStaleness,
  saveExecutionSessionEvidence,
  updateExecutionSessionRecord,
  type ExecutionSessionEvidenceRecord,
  type ExecutionLifecycleStage,
  type ExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import { getJob } from '../repositories/mcpToolJobRepository.js';
import { getTask, getTaskByIdentifier } from '../repositories/taskRepository.js';
import { getProjects, normalizeProjectNameAlias, normalizeProjectRepoIdentity } from '../repositories/projectRepository.js';
import { getFileRevision, resolveSafePath } from './localFileService.js';
import { buildRepoAffectedInputIdentity, buildRepoEvidenceIdentity, getRepoRevisionForRoot } from './repoRevisionService.js';
import { withDbTransaction } from '../../db/index.js';
import { resolveSessionWorkspace } from './sessionWorkspaceService.js';
import { createApiError } from './api.js';
import {
  getLatestExecutionCheckpoint,
  recordAutomaticExecutionCheckpoint,
  recordExecutionPendingOperationReference,
} from './executionCheckpointService.js';
import { publishServerEvent } from './serverEventService.js';
import {
  buildVerificationCoverageIdentity,
  createVerificationBatch,
  MAX_VERIFICATION_BATCH_CHECKS,
  type VerificationBatchResultStatus,
  type VerificationCoverageIdentity,
} from './verificationBatchService.js';
import {
  bindExecutionSessionOwnershipEpoch,
  getExecutionSessionOwnershipEpoch,
  normalizeExecutionOwnershipEpochId as normalizeOwnershipEpochId,
  saveExecutionOwnershipEpochEvidence,
} from './executionOwnershipEpochService.js';

export { bindExecutionSessionOwnershipEpoch, getExecutionSessionOwnershipEpoch };
export { adoptExecutionOwnedChanges, getExecutionOwnershipState, recordExecutionOwnedChanges };
export {
  captureExecutionVerificationProvenance,
  getExecutionVerificationBatchLiveOperations,
  getExecutionVerificationBatchState,
  getExecutionVerificationBatchStateById,
  getExecutionVerificationCoverageEvidence,
  recordExecutionVerificationBatchResult,
  recordExecutionVerificationEvidence,
};
export type { ExecutionOwnedRevisionReconciliationFile, ExecutionOwnershipState, RecordExecutionOwnedChangesOptions };


import {
  cancelExecutionSession,
  completeExecutionSession,
  createExecutionSession,
  expireExecutionSession,
  expireExecutionSessionsForTaskWorkspace,
  getExecutionSessionState,
  normalizeExecutionWorkspaceIdentity as normalizeWorkspaceIdentity,
  pruneExpiredExecutionSessions,
  recordExecutionLifecycleTransition,
  recordExecutionReconciliationEvidence,
  resumeExecutionSession,
  updateExecutionSessionProgress,
  type CreateExecutionSessionInput,
  type ExecutionLifecycleObservedEvidence,
  type ExecutionLifecycleTransitionInput,
  type ExecutionSessionProgressPatch,
} from './executionSessionStateService.js';
import {
  adoptExecutionOwnedChanges,
  getExecutionOwnershipState,
  reconcileExecutionOwnedRevisionDrift as reconcileExecutionOwnedRevisionDriftPolicy,
  recordExecutionOwnedChanges,
  type ExecutionOwnedRevisionReconciliationFile,
  type ExecutionOwnershipState,
  type RecordExecutionOwnedChangesOptions,
} from './executionOwnedRevisionService.js';

import {
  captureExecutionVerificationProvenance,
  getExecutionVerificationBatchLiveOperations,
  getExecutionVerificationBatchState,
  getExecutionVerificationBatchStateById,
  getExecutionVerificationCoverageEvidence,
  invalidateExecutionVerificationAuthorityForOwnedRevisionReconciliation,
  recordExecutionVerificationBatchResult,
  recordExecutionVerificationEvidence,
} from './executionVerificationAuthorityService.js';


export {
  cancelExecutionSession,
  completeExecutionSession,
  createExecutionSession,
  expireExecutionSession,
  expireExecutionSessionsForTaskWorkspace,
  getExecutionSessionState,
  pruneExpiredExecutionSessions,
  recordExecutionLifecycleTransition,
  recordExecutionReconciliationEvidence,
  resumeExecutionSession,
  updateExecutionSessionProgress,
};
export type {
  CreateExecutionSessionInput,
  ExecutionLifecycleObservedEvidence,
  ExecutionLifecycleTransitionInput,
  ExecutionSessionProgressPatch,
};


export type TaskMutationOwnershipStrategy = 'transactional-owned' | 'plan-only-exempt';
const TASK_MUTATION_OWNERSHIP_STRATEGIES: Readonly<Record<string, TaskMutationOwnershipStrategy>> = Object.freeze({
  write_local_file: 'transactional-owned',
  safe_edit_local_file: 'transactional-owned',
  edit_local_files_batch: 'transactional-owned',
  apply_prepared_edit_plan: 'transactional-owned',
  apply_prepared_edit: 'transactional-owned',
  apply_patch: 'transactional-owned',
  delete_local_path: 'transactional-owned',
  move_local_path: 'transactional-owned',
  apply_and_verify: 'transactional-owned',
  prepare_edit_plan: 'plan-only-exempt',
  prepare_compact_edit: 'plan-only-exempt',
});

export function getTaskMutationOwnershipStrategy(toolName: string) {
  return TASK_MUTATION_OWNERSHIP_STRATEGIES[String(toolName || '').trim()] || null;
}

export interface ExecutionSessionEvidenceInput {
  kind: string;
  evidenceId?: string;
  path?: string | null;
  repoRevision?: string | null;
  fileRevision?: string | null;
  revisionIdentity?: string | null;
  contextHandle?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ExecutionVerificationProvenance {
  policy: 'checks-passed' | 'no-checks-required' | 'operator-break-glass';
  expectedRepoRevision?: string;
  expectedOwnedFingerprint?: string;
  candidateId?: string;
  candidateRepoRevision?: string;
  executionKey?: string;
  coverage?: VerificationCoverageIdentity[];
}

export interface RecordExecutionVerificationOptions {
  repoRoot: string;
  now?: Date;
  provenance?: ExecutionVerificationProvenance;
}

export type TaskExecutionVerificationBindingReason =
  | 'EXECUTION_VERIFICATION_AUTHORITATIVE'
  | 'EXECUTION_VERIFICATION_RESULT_NOT_SUCCEEDED'
  | 'EXECUTION_VERIFICATION_TASK_BINDING_MISSING'
  | 'EXECUTION_VERIFICATION_PROVENANCE_REQUIRED'
  | 'EXECUTION_VERIFICATION_CANDIDATE_REQUIRED'
  | 'EXECUTION_VERIFICATION_REPO_REVISION_STALE'
  | 'EXECUTION_VERIFICATION_CANDIDATE_STALE'
  | 'EXECUTION_VERIFICATION_FINGERPRINT_STALE'
  | 'EXECUTION_VERIFICATION_BINDING_NOT_FRESH'
  | 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE'
  | 'EXECUTION_VERIFICATION_BATCH_FAILED'
  | 'EXECUTION_VERIFICATION_BATCH_STALE'
  | 'EXECUTION_VERIFICATION_BATCH_SUPERSEDED'
  | 'EXECUTION_VERIFICATION_RECOVERY_BATCH_REQUIRED'
  | 'EXECUTION_VERIFICATION_REJECTED';

export interface TaskExecutionVerificationBindingOutcome {
  authoritative: boolean;
  reasonCode: TaskExecutionVerificationBindingReason;
  verificationFresh: boolean | null;
  sessionId?: string;
  repoRevision?: string;
  ownedFingerprint?: string;
  errorCode?: string;
  message?: string;
  details?: unknown;
  session?: ExecutionSessionRecord;
  binding?: ExecutionSessionEvidenceRecord;
  ownership?: ExecutionOwnershipState;
}

export type ExecutionVerificationBatchStatus = 'pending' | 'complete' | 'failed' | 'stale' | 'blocked' | 'superseded';

export type ExecutionVerificationBatchMemberCandidate = {
  candidateId: string;
  repoRevision: string;
  executionKey: string;
  coverage?: VerificationCoverageIdentity;
};

export type ExecutionVerificationBatchState = {
  batchId: string;
  ownershipEpochId: string;
  repoRevision: string;
  ownedFingerprint: string;
  requiredChecks: string[];
  results: Record<string, VerificationBatchResultStatus>;
  memberCandidates: Record<string, ExecutionVerificationBatchMemberCandidate>;
  pending: string[];
  passed: string[];
  failed: string[];
  stale: string[];
  blocked: string[];
  status: ExecutionVerificationBatchStatus;
  canComplete: boolean;
  createdAt: string;
  supersededByBatchId?: string;
  supersessionReason?: string;
  supersededAt?: string;
  updatedAt: string;
};

function executionSessionError(code: string, message: string, details?: unknown) {
  const error = new Error(message) as Error & { code?: string; details?: unknown };
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function taskMutationError(status: number, code: string, message: string, details?: unknown) {
  return createApiError(status, code, message, { details });
}

function requireSession(id: string) {
  const session = getExecutionSessionById(id);
  if (!session) throw executionSessionError('EXECUTION_SESSION_NOT_FOUND', `Execution session '${id}' was not found.`);
  return session;
}

function assertActive(session: ExecutionSessionRecord) {
  if (session.status !== 'active') {
    throw executionSessionError('EXECUTION_SESSION_TERMINAL', `Execution session '${session.id}' is terminal (${session.status}) and cannot mutate as active.`);
  }
}

function normalizeEvidencePath(value?: string | null) {
  if (value == null || String(value).trim() === '') return null;
  const normalized = String(value).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw executionSessionError('EXECUTION_SESSION_EVIDENCE_PATH_INVALID', 'Evidence paths must be repository-relative paths.');
  }
  return normalized;
}

function normalizeStringList(values?: string[]) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim().replace(/\\/g, '/')).filter(Boolean))].sort();
}

function requireRepoRoot(repoRoot?: string) {
  if (!repoRoot) throw executionSessionError('EXECUTION_SESSION_REPO_ROOT_REQUIRED', 'repoRoot is required for execution ownership provenance.');
  return path.resolve(repoRoot);
}

function readStringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' && value ? value : undefined;
}

function evidenceId(sessionId: string, input: { kind: string; path: string | null; contextHandle: string | null }) {
  const digest = crypto.createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(input.kind)
    .update('\0')
    .update(input.path || '')
    .update('\0')
    .update(input.contextHandle || '')
    .digest('hex')
    .slice(0, 24);
  return `evidence-${digest}`;
}

export function recordExecutionSessionEvidence(
  id: string,
  entries: ExecutionSessionEvidenceInput[],
  options: { repoRoot?: string; now?: Date } = {},
) {
  const session = requireSession(id);
  assertActive(session);
  const now = options.now || new Date();
  const nowIso = now.toISOString();
  const root = options.repoRoot ? path.resolve(options.repoRoot) : null;
  const currentRepo = root ? getRepoRevisionForRoot(root) : null;
  const saved: ExecutionSessionEvidenceRecord[] = [];

  for (const entry of entries) {
    const kind = String(entry.kind || '').trim();
    if (!kind) throw executionSessionError('EXECUTION_SESSION_EVIDENCE_KIND_REQUIRED', 'Evidence kind is required.');
    const evidencePath = normalizeEvidencePath(entry.path);
    const contextHandle = entry.contextHandle ? String(entry.contextHandle) : session.contextHandle;
    let fileRevision = entry.fileRevision ? String(entry.fileRevision) : null;
    if (evidencePath && root) {
      const fullPath = resolveSafePath(root, evidencePath);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) fileRevision = getFileRevision(fullPath).token;
      else fileRevision = 'missing';
    }
    if (kind === 'file' && evidencePath && !fileRevision) {
      throw executionSessionError('EXECUTION_SESSION_FILE_REVISION_REQUIRED', `File evidence '${evidencePath}' requires a revision or repoRoot.`);
    }
    const repoRevision = entry.repoRevision ? String(entry.repoRevision) : currentRepo?.token || session.repoRevision;
    const revisionIdentity = entry.revisionIdentity
      ? String(entry.revisionIdentity)
      : evidencePath
        ? buildRepoEvidenceIdentity({ repoRevision, filePath: evidencePath, fileRevision })
        : repoRevision;
    saved.push(saveExecutionSessionEvidence({
      id: entry.evidenceId ? String(entry.evidenceId) : evidenceId(id, { kind, path: evidencePath, contextHandle }),
      sessionId: id,
      kind,
      path: evidencePath,
      repoRevision,
      fileRevision,
      revisionIdentity,
      contextHandle,
      stale: false,
      metadata: entry.metadata || {},
      createdAt: nowIso,
      updatedAt: nowIso,
    }));
  }

  if (currentRepo) {
    updateExecutionSessionRecord(id, {
      repoRevision: currentRepo.token,
      branch: session.branch || currentRepo.branch,
      updatedAt: nowIso,
    });
  }
  return saved;
}

export function getActiveTaskExecutionSessionForWorkspace(workspaceId: string) {
  const normalized = normalizeWorkspaceIdentity(workspaceId);
  if (!normalized) return null;
  const active = listExecutionSessionsForWorkspace(normalized)
    .filter((entry) => entry.status === 'active' && Boolean(entry.taskId));
  if (active.length > 1) {
    throw executionSessionError(
      'EXECUTION_SESSION_WORKSPACE_AMBIGUOUS',
      `Workspace '${normalized}' has multiple active task execution sessions.`,
    );
  }
  return active[0] || null;
}

function normalizeClaimScopePath(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function effectiveTaskClaimScope(task: any, workspaceId: string) {
  const claim = task?.claim;
  const expiresAtMs = Date.parse(String(claim?.expiresAt || ''));
  const activeClaim = Boolean(
    claim?.workspaceId === workspaceId
    && Number.isFinite(expiresAtMs)
    && expiresAtMs > Date.now(),
  );
  if (!activeClaim) {
    throw taskMutationError(409, 'TASK_MUTATION_ACTIVE_CLAIM_REQUIRED', `Task '${task?.displayId || task?.id || '<unknown>'}' has no active claim for workspace '${workspaceId}'.`);
  }
  return new Set<string>([
    ...(Array.isArray(task?.targetFiles) ? task.targetFiles : []),
    ...(Array.isArray((claim as any)?.reservedPaths) ? (claim as any).reservedPaths : []),
  ].map(normalizeClaimScopePath).filter(Boolean));
}

function resolveTaskMutationProjectId(args: Record<string, any>) {
  const directProjectId = String(args?.projectId || '').trim();
  if (directProjectId) return directProjectId;
  const projectName = normalizeProjectNameAlias(args?.projectName);
  const repoIdentity = normalizeProjectRepoIdentity(args?.repo || args?.repoUrl);
  const requestedLocalPath = String(args?.localPath || '').trim();
  const localPathKey = requestedLocalPath ? path.resolve(requestedLocalPath).replace(/\\/g, '/').toLowerCase() : '';
  const matches = getProjects().filter((project: any) => {
    if (projectName && normalizeProjectNameAlias(project?.name) !== projectName) return false;
    if (repoIdentity && normalizeProjectRepoIdentity(project?.repoUrl) !== repoIdentity) return false;
    if (localPathKey) {
      const projectPath = String(project?.localPath || '').trim();
      if (!projectPath || path.resolve(projectPath).replace(/\\/g, '/').toLowerCase() !== localPathKey) return false;
    }
    return Boolean(projectName || repoIdentity || localPathKey);
  });
  return matches.length === 1 ? String(matches[0].id || '').trim() || null : null;
}

export function assertTaskMutationWorkspaceBinding(args: Record<string, any>) {
  const workspaceId = String(args?.workspaceId || '').trim();
  if (workspaceId) return null;
  const capturedBinding = args?.__executionJobBinding && typeof args.__executionJobBinding === 'object'
    ? args.__executionJobBinding as Record<string, unknown>
    : null;
  const capturedWorkspaceId = String(capturedBinding?.workspaceId || '').trim();
  if (capturedWorkspaceId) {
    throw taskMutationError(409, 'TASK_MUTATION_WORKSPACE_REQUIRED', 'Task-owned mutation lost its managed workspace binding and cannot fall back to the shared project checkout.', {
      workspaceId: capturedWorkspaceId,
      taskId: String(capturedBinding?.taskId || '').trim() || null,
      executionSessionId: String(capturedBinding?.executionSessionId || '').trim() || null,
    });
  }
  const projectId = resolveTaskMutationProjectId(args);
  if (!projectId) return null;
  const active = queryExecutionSessions({ projectId, status: 'active', limit: 100 }).sessions
    .filter((entry) => Boolean(entry.taskId && entry.workspaceId));
  if (active.length === 0) return null;
  throw taskMutationError(409, 'TASK_MUTATION_WORKSPACE_REQUIRED', `Project '${projectId}' has active task execution authority; mutation must target the authoritative managed workspace instead of the shared checkout.`, {
    projectId,
    executionSessionIds: active.map((entry) => entry.id),
    taskIds: [...new Set(active.map((entry) => entry.taskId).filter(Boolean))],
    workspaceIds: [...new Set(active.map((entry) => entry.workspaceId).filter(Boolean))],
    nextAction: 'Retry the mutation with the task claim workspaceId. Explicit project-root mutation is allowed only when no active task execution authority exists.',
  });
}

export function getTaskExecutionMutationBinding(args: Record<string, any>) {
  const workspaceId = String(args?.workspaceId || '').trim();
  if (!workspaceId) {
    assertTaskMutationWorkspaceBinding(args);
    return null;
  }
  const workspace = resolveSessionWorkspace(workspaceId);
  if (!workspace) {
    throw taskMutationError(404, 'TASK_MUTATION_WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found for task-bound mutation.`);
  }
  const session = getActiveTaskExecutionSessionForWorkspace(workspaceId);
  const task = workspace.taskDisplayId
    ? getTaskByIdentifier(workspace.taskDisplayId, 'full')
    : session?.taskId
      ? getTask(session.taskId)
      : undefined;
  const taskBound = Boolean(workspace.taskDisplayId || task?.claim?.workspaceId === workspaceId || session?.taskId);
  if (!taskBound) return null;
  if (!session?.taskId) {
    throw taskMutationError(409, 'TASK_MUTATION_EXECUTION_REQUIRED', `Task-bound workspace '${workspaceId}' has no unique active execution session.`);
  }
  if (!task) {
    throw taskMutationError(404, 'TASK_MUTATION_TASK_NOT_FOUND', `Task for workspace '${workspaceId}' was not found.`);
  }
  if (session.taskId !== task.id || session.projectId !== workspace.projectId || task.projectId !== workspace.projectId) {
    throw taskMutationError(409, 'TASK_MUTATION_BINDING_MISMATCH', `Task, execution session, and workspace '${workspaceId}' do not share one authoritative binding.`);
  }
  const capturedJobBinding = args?.__executionJobBinding && typeof args.__executionJobBinding === 'object'
    ? args.__executionJobBinding as Record<string, unknown>
    : null;
  if (capturedJobBinding) {
    const capturedExecutionSessionId = String(capturedJobBinding.executionSessionId || '').trim();
    const capturedTaskId = String(capturedJobBinding.taskId || '').trim();
    const capturedWorkspaceId = String(capturedJobBinding.workspaceId || '').trim();
    const capturedProjectId = String(capturedJobBinding.projectId || '').trim();
    const operationId = String(capturedJobBinding.operationId || '').trim();
    if (!capturedExecutionSessionId || !capturedTaskId || !capturedWorkspaceId || !capturedProjectId || !operationId) {
      throw taskMutationError(409, 'TASK_MUTATION_EXECUTION_BINDING_INVALID', 'Durable job execution binding is incomplete and cannot authorize task mutation.');
    }
    if (
      capturedExecutionSessionId !== session.id
      || capturedTaskId !== task.id
      || capturedWorkspaceId !== workspaceId
      || capturedProjectId !== workspace.projectId
    ) {
      throw taskMutationError(409, 'TASK_MUTATION_EXECUTION_FENCED', `Durable operation '${operationId}' is bound to an obsolete task execution and cannot transfer authority to the current execution.`, {
        operationId,
        capturedExecutionSessionId,
        currentExecutionSessionId: session.id,
        workspaceId,
        taskId: task.id,
      });
    }
  }
  if (task.claim?.workspaceId && task.claim.workspaceId !== workspaceId) {
    throw taskMutationError(409, 'TASK_MUTATION_CLAIM_MISMATCH', `Task '${task.displayId || task.id}' is claimed by a different workspace.`);
  }
  const claimedScope = effectiveTaskClaimScope(task, workspaceId);
  return { workspaceId, workspace, session, task, claimedScope };
}

export function recordTaskExecutionContextReadyIfWorkspaceBound(
  args: Record<string, any>,
  input: { contextHandle: string; repoRevision?: string | null; contextPlanIdentity?: string | null },
) {
  if (!String(args?.workspaceId || '').trim()) return null;
  return recordTaskExecutionContextReady(args, input);
}

export function recordTaskExecutionContextReady(
  args: Record<string, any>,
  input: { contextHandle: string; repoRevision?: string | null; contextPlanIdentity?: string | null },
) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) return null;

  const contextHandle = String(input?.contextHandle || '').trim();
  if (!contextHandle) {
    throw taskMutationError(409, 'TASK_CONTEXT_HANDLE_REQUIRED', `Task '${binding.task.displayId || binding.task.id}' context evidence requires a context handle.`);
  }

  const repoRevision = String(input?.repoRevision || binding.session.repoRevision || '').trim() || null;
  updateExecutionSessionProgress(binding.session.id, { contextHandle, repoRevision });
  recordExecutionSessionEvidence(binding.session.id, [{
    evidenceId: `context-bundle:${contextHandle}`,
    kind: 'context-bundle',
    repoRevision,
    revisionIdentity: repoRevision || contextHandle,
    contextHandle,
    metadata: {
      source: 'repo-context-bundle',
      ...(input?.contextPlanIdentity ? { contextPlanIdentity: String(input.contextPlanIdentity) } : {}),
    },
  }], { repoRoot: binding.workspace.root });

  const current = getActiveTaskExecutionSessionForWorkspace(binding.workspaceId);
  if (current?.lifecycle.stage === 'created') {
    recordExecutionLifecycleTransition(binding.session.id, {
      toStage: 'context-ready',
      reasonCode: 'task-context-acquired',
      evidence: {
        id: `context-ready:${contextHandle}`,
        kind: 'context-bundle',
        status: 'completed',
      },
    });
  }
  return getActiveTaskExecutionSessionForWorkspace(binding.workspaceId);
}

export function authorizeTaskExecutionMutationPaths(args: Record<string, any>, paths: string[]) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) return null;
  const normalizedPaths = Array.from(new Set((paths || []).map(normalizeClaimScopePath).filter(Boolean)));
  const outOfScope = normalizedPaths.filter((entry) => !binding.claimedScope.has(entry));
  if (outOfScope.length > 0) {
    throw taskMutationError(
      409,
      'TASK_SCOPE_EXPANSION_REQUIRED',
      `Task '${binding.task.displayId || binding.task.id}' must expand its claimed scope before mutating: ${outOfScope.join(', ')}`,
      {
        outOfScope,
        effectiveScope: [...binding.claimedScope].sort(),
        workspaceId: binding.workspaceId,
      },
    );
  }
  return { ...binding, normalizedPaths };
}

export function recordTaskExecutionMutationPaths(
  args: Record<string, any>,
  paths: string[],
  source: string,
) {
  const binding = authorizeTaskExecutionMutationPaths(args, paths);
  if (!binding) return null;
  return recordExecutionOwnedChanges(binding.session.id, paths, {
    repoRoot: binding.workspace.root,
    source,
  });
}

export function adoptTaskExecutionOwnedChanges(args: Record<string, any>) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) {
    throw executionSessionError('EXECUTION_ADOPTION_TASK_WORKSPACE_REQUIRED', 'Ownership adoption requires a task-bound managed workspace.');
  }
  const requestedTaskId = String(args?.taskId || '').trim();
  if (!requestedTaskId) {
    throw executionSessionError('EXECUTION_ADOPTION_TASK_REQUIRED', 'Ownership adoption requires the exact owning task id.');
  }
  if (requestedTaskId !== binding.task.id && requestedTaskId !== binding.task.displayId) {
    throw executionSessionError('EXECUTION_ADOPTION_TASK_MISMATCH', 'Requested task does not own the selected execution workspace.');
  }
  const requestedExecutionSessionId = String(args?.executionSessionId || '').trim();
  if (!requestedExecutionSessionId) {
    throw executionSessionError('EXECUTION_ADOPTION_EXECUTION_REQUIRED', 'Ownership adoption requires the exact active executionSessionId.');
  }
  if (requestedExecutionSessionId !== binding.session.id) {
    throw executionSessionError('EXECUTION_ADOPTION_EXECUTION_MISMATCH', 'Requested execution session does not own the selected task workspace.');
  }
  const files = Array.isArray(args.files) ? args.files : [];
  authorizeTaskExecutionMutationPaths(args, files.map((entry: any) => entry?.path));
  try {
    return adoptExecutionOwnedChanges(binding.session.id, files, {
      repoRoot: binding.workspace.root,
      reason: String(args.reason || ''),
    });
  } catch (error: any) {
    if (error?.code) {
      throw taskMutationError(409, String(error.code), error instanceof Error ? error.message : String(error), error?.details);
    }
    throw error;
  }
}

export function reconcileExecutionOwnedRevisionDrift(
  id: string,
  files: ExecutionOwnedRevisionReconciliationFile[],
  options: { repoRoot: string; reason: string; provenance: string; now?: Date },
) {
  return reconcileExecutionOwnedRevisionDriftPolicy(id, files, {
    ...options,
    invalidateVerificationAuthority: invalidateExecutionVerificationAuthorityForOwnedRevisionReconciliation,
  });
}

export function reconcileTaskExecutionOwnedRevisionDrift(args: Record<string, any>) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) {
    throw executionSessionError('EXECUTION_RECONCILIATION_TASK_WORKSPACE_REQUIRED', 'Owned revision reconciliation requires a task-bound managed workspace.');
  }
  const requestedTaskId = String(args?.taskId || '').trim();
  if (!requestedTaskId) {
    throw executionSessionError('EXECUTION_RECONCILIATION_TASK_REQUIRED', 'Owned revision reconciliation requires the exact owning task id.');
  }
  if (requestedTaskId !== binding.task.id && requestedTaskId !== binding.task.displayId) {
    throw executionSessionError('EXECUTION_RECONCILIATION_TASK_MISMATCH', 'Requested task does not own the selected execution workspace.');
  }
  const requestedExecutionSessionId = String(args?.executionSessionId || '').trim();
  if (!requestedExecutionSessionId) {
    throw executionSessionError('EXECUTION_RECONCILIATION_EXECUTION_REQUIRED', 'Owned revision reconciliation requires the exact active executionSessionId.');
  }
  if (requestedExecutionSessionId !== binding.session.id) {
    throw executionSessionError('EXECUTION_RECONCILIATION_EXECUTION_MISMATCH', 'Requested execution session does not own the selected task workspace.');
  }
  const files = Array.isArray(args.files) ? args.files : [];
  authorizeTaskExecutionMutationPaths(args, files.map((entry: any) => entry?.path));
  try {
    return reconcileExecutionOwnedRevisionDrift(binding.session.id, files, {
      repoRoot: binding.workspace.root,
      reason: String(args.reason || ''),
      provenance: String(args.provenance || ''),
    });
  } catch (error: any) {
    if (error?.code) {
      throw taskMutationError(409, String(error.code), error instanceof Error ? error.message : String(error), error?.details);
    }
    throw error;
  }
}

function lifecycleVerificationCoverageIdentity(
  value: any,
  root: string,
  ownedPaths: string[] | undefined,
) {
  if (!value || typeof value !== 'object') return null;
  const paths = Array.isArray(value.affectedInputPaths) ? value.affectedInputPaths.filter(Boolean).map(String) : [];
  if (paths.length > 0 || !ownedPaths?.length) return buildVerificationCoverageIdentity(value);
  const repo = getRepoRevisionForRoot(root);
  const affected = buildRepoAffectedInputIdentity(root, repo, ownedPaths);
  return buildVerificationCoverageIdentity({
    ...value,
    affectedInputFingerprint: affected.fingerprint,
    affectedInputPaths: affected.paths,
  });
}
export function recordTaskExecutionVerificationResult(
  args: Record<string, any>,
  result: any,
  captured?: { repoRevision: string; ownedFingerprint: string; ownedPaths?: string[] } | null,
): TaskExecutionVerificationBindingOutcome {
  const batchRequest = args?.verificationBatch && typeof args.verificationBatch === 'object' && !Array.isArray(args.verificationBatch)
    ? args.verificationBatch as Record<string, unknown>
    : null;
  if (batchRequest) {
    const binding = getTaskExecutionMutationBinding(args);
    if (!binding) {
      return {
        authoritative: false,
        reasonCode: 'EXECUTION_VERIFICATION_TASK_BINDING_MISSING',
        verificationFresh: null,
        message: 'Sequential verification batch result is not bound to an active task execution workspace.',
      };
    }
    const ownership = getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root });
    const memberCandidate = result?.verificationCandidate;
    if (!captured?.repoRevision || !captured?.ownedFingerprint || !memberCandidate?.candidateId || !memberCandidate?.repoRevision || !memberCandidate?.executionKey) {
      return {
        authoritative: false,
        reasonCode: 'EXECUTION_VERIFICATION_CANDIDATE_REQUIRED',
        verificationFresh: ownership.verificationFresh,
        sessionId: binding.session.id,
        repoRevision: ownership.repoRevision,
        ownedFingerprint: ownership.ownedFingerprint,
        ownership,
        message: 'Sequential verification batch members require captured execution provenance and a verification candidate identity.',
      };
    }
    const memberStatus: VerificationBatchResultStatus = result?.verificationCandidate?.current === false
      ? 'stale'
      : result?.verificationBlocker?.reused === true
        ? 'blocked'
        : (!result?.ok || result?.status !== 'succeeded')
          ? 'failed'
          : 'passed';
    try {
      const recorded = recordExecutionVerificationBatchResult(binding.session.id, {
        repoRoot: binding.workspace.root,
        batchId: String(batchRequest.id || ''),
        requiredChecks: Array.isArray(batchRequest.requiredChecks) ? batchRequest.requiredChecks.map(String) : [],
        checkId: String(batchRequest.checkId || args?.command || args?.preset || ''),
        status: memberStatus,
        captured,
        memberCandidate: {
          candidateId: String(memberCandidate.candidateId),
          repoRevision: String(memberCandidate.repoRevision),
          executionKey: String(memberCandidate.executionKey),
          coverage: lifecycleVerificationCoverageIdentity(
            (args as any)?.__verificationCandidate?.executionIdentity,
            binding.workspace.root,
            captured?.ownedPaths,
          ) || undefined,
        },
        supersedesBatchId: String(batchRequest.supersedesBatchId || ''),
        supersessionReason: String(batchRequest.supersessionReason || ''),
      });
      const refreshedOwnership = getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root });
      const reasonCode: TaskExecutionVerificationBindingReason = recorded.authoritative
        ? 'EXECUTION_VERIFICATION_AUTHORITATIVE'
        : (recorded.reasonCode || (recorded.state.status === 'pending'
          ? 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE'
          : recorded.state.status === 'stale'
            ? 'EXECUTION_VERIFICATION_BATCH_STALE'
            : recorded.state.status === 'superseded'
              ? 'EXECUTION_VERIFICATION_BATCH_SUPERSEDED'
              : 'EXECUTION_VERIFICATION_BATCH_FAILED'));
      return {
        authoritative: recorded.authoritative,
        reasonCode,
        verificationFresh: refreshedOwnership.verificationFresh,
        sessionId: binding.session.id,
        repoRevision: refreshedOwnership.repoRevision,
        ownedFingerprint: refreshedOwnership.ownedFingerprint,
        ownership: refreshedOwnership,
        details: { batch: recorded.state, idempotent: recorded.idempotent },
        message: recorded.authoritative
          ? 'All declared sequential verification checks passed on the frozen execution ownership revision.'
          : recorded.state.status === 'pending'
            ? `Verification batch '${recorded.state.batchId}' is incomplete; remaining checks: ${recorded.state.pending.join(', ')}.`
            : recorded.state.status === 'superseded'
              ? `Verification batch '${recorded.state.batchId}' was superseded by '${recorded.state.supersededByBatchId || 'a replacement batch'}' and late results are non-authoritative.`
              : `Verification batch '${recorded.state.batchId}' is ${recorded.state.status} and cannot authorize commit.`,
      };
    } catch (error: any) {
      return {
        authoritative: false,
        reasonCode: error?.code === 'EXECUTION_VERIFICATION_BATCH_STALE'
          ? 'EXECUTION_VERIFICATION_BATCH_STALE'
          : 'EXECUTION_VERIFICATION_REJECTED',
        verificationFresh: getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root }).verificationFresh,
        sessionId: binding.session.id,
        repoRevision: ownership.repoRevision,
        ownedFingerprint: ownership.ownedFingerprint,
        ownership,
        errorCode: typeof error?.code === 'string' ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
        details: error?.details,
      };
    }
  }
  if (!result?.ok || result?.status !== 'succeeded') {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_RESULT_NOT_SUCCEEDED',
      verificationFresh: false,
      message: 'Verification result did not complete successfully and cannot become authoritative evidence.',
    };
  }

  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_TASK_BINDING_MISSING',
      verificationFresh: null,
      message: 'Verification result is not bound to an active task execution workspace.',
    };
  }

  const batchCandidate = result?.verificationBatch?.canComplete === true
    ? result.verificationBatch.candidate
    : null;
  const commandCandidate = result?.verificationCandidate?.current !== false
    ? result.verificationCandidate
    : null;
  const candidate = batchCandidate || commandCandidate;
  const explicitNoChecks = result?.verificationPolicy === 'no-checks-required';
  const ownership = getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root });
  const latestBatch = getExecutionVerificationBatchState(binding.session.id);
  if (latestBatch?.status === 'pending') {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      details: { batch: latestBatch },
      message: `Verification batch '${latestBatch.batchId}' is incomplete and must continue through its declared batch identity.`,
    };
  }
  if (latestBatch?.status === 'failed' || latestBatch?.status === 'stale' || latestBatch?.status === 'blocked' || latestBatch?.status === 'superseded') {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_RECOVERY_BATCH_REQUIRED',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      details: { batch: latestBatch },
      message: `Verification batch '${latestBatch.batchId}' is ${latestBatch.status}; diagnostic verification cannot supersede it. Start a fresh explicit verification recovery batch on the current execution ownership revision.`,
    };
  }

  if (explicitNoChecks && (!captured?.repoRevision || !captured?.ownedFingerprint)) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_PROVENANCE_REQUIRED',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      message: 'No-check-required verification must include the captured execution revision and owned fingerprint.',
    };
  }
  if (!explicitNoChecks && (!candidate?.candidateId || !candidate?.repoRevision || !candidate?.executionKey)) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_CANDIDATE_REQUIRED',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      message: 'Passed task-bound verification requires candidate id, candidate revision, and execution key.',
    };
  }

  const expectedRepoRevision = captured?.repoRevision || candidate?.repoRevision;
  if (expectedRepoRevision && expectedRepoRevision !== ownership.repoRevision) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_REPO_REVISION_STALE',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      details: { expectedRepoRevision, currentRepoRevision: ownership.repoRevision },
      message: 'Captured verification revision no longer matches the live execution workspace.',
    };
  }
  if (candidate?.repoRevision && candidate.repoRevision !== ownership.repoRevision) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_CANDIDATE_STALE',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      details: { candidateRepoRevision: candidate.repoRevision, currentRepoRevision: ownership.repoRevision },
      message: 'Verification candidate revision no longer matches the live execution workspace.',
    };
  }
  if (captured?.ownedFingerprint && captured.ownedFingerprint !== ownership.ownedFingerprint) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_FINGERPRINT_STALE',
      verificationFresh: ownership.verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      ownership,
      details: { expectedOwnedFingerprint: captured.ownedFingerprint, currentOwnedFingerprint: ownership.ownedFingerprint },
      message: 'Captured owned-file fingerprint no longer matches the live execution workspace.',
    };
  }

  const checks = explicitNoChecks
    ? []
    : batchCandidate
      ? (Array.isArray(result.verification)
        ? result.verification.map((entry: any) => ({
          name: String(entry?.command || 'verification'),
          command: String(entry?.command || 'verification'),
          status: entry?.ok === true ? 'passed' : 'failed',
        }))
        : [])
      : [{
        name: String(args?.command || args?.preset || 'run_project_command'),
        command: String(args?.command || args?.preset || 'run_project_command'),
        status: 'passed',
      }];
  const policy: ExecutionVerificationProvenance['policy'] = explicitNoChecks || checks.length === 0
    ? 'no-checks-required'
    : 'checks-passed';

  try {
    const recorded = recordExecutionVerificationEvidence(binding.session.id, checks, {
      repoRoot: binding.workspace.root,
      provenance: {
        policy,
        expectedRepoRevision,
        expectedOwnedFingerprint: captured?.ownedFingerprint,
        candidateId: candidate?.candidateId,
        candidateRepoRevision: candidate?.repoRevision,
        executionKey: candidate?.executionKey,
        coverage: checks.length > 0
          ? [lifecycleVerificationCoverageIdentity(
              (args as any)?.__verificationCandidate?.executionIdentity,
              binding.workspace.root,
              captured?.ownedPaths,
            )].filter((entry): entry is VerificationCoverageIdentity => Boolean(entry))
          : [],
      },
    });
    if (recorded.ownership.verificationFresh !== true) {
      return {
        authoritative: false,
        reasonCode: 'EXECUTION_VERIFICATION_BINDING_NOT_FRESH',
        verificationFresh: recorded.ownership.verificationFresh,
        sessionId: binding.session.id,
        repoRevision: recorded.ownership.repoRevision,
        ownedFingerprint: recorded.ownership.ownedFingerprint,
        ...recorded,
        message: 'Verification evidence was persisted but did not bind freshness to the current owned fingerprint.',
      };
    }
    return {
      authoritative: true,
      reasonCode: 'EXECUTION_VERIFICATION_AUTHORITATIVE',
      verificationFresh: true,
      sessionId: binding.session.id,
      repoRevision: recorded.ownership.repoRevision,
      ownedFingerprint: recorded.ownership.ownedFingerprint,
      ...recorded,
    };
  } catch (error: any) {
    return {
      authoritative: false,
      reasonCode: 'EXECUTION_VERIFICATION_REJECTED',
      verificationFresh: getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root }).verificationFresh,
      sessionId: binding.session.id,
      repoRevision: ownership.repoRevision,
      ownedFingerprint: ownership.ownedFingerprint,
      errorCode: typeof error?.code === 'string' ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
      details: error?.details,
    };
  }
}

export function invalidateTaskExecutionVerificationBinding(
  args: Record<string, any>,
  input: { candidateId: string; executionKey?: string; reason: string; now?: Date },
) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) {
    return {
      invalidated: false as const,
      reasonCode: 'EXECUTION_VERIFICATION_TASK_BINDING_MISSING' as const,
      ownership: null,
    };
  }
  const candidateId = String(input?.candidateId || '').trim();
  const executionKey = String(input?.executionKey || '').trim();
  if (!candidateId) {
    return {
      invalidated: false as const,
      reasonCode: 'EXECUTION_VERIFICATION_CANDIDATE_REQUIRED' as const,
      ownership: getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root }),
    };
  }
  const evidence = listExecutionSessionEvidence(binding.session.id);
  const matched = evidence
    .filter((entry) => entry.kind === 'verification-binding')
    .filter((entry) => readStringMetadata(entry.metadata || {}, 'candidateId') === candidateId)
    .filter((entry) => !executionKey || readStringMetadata(entry.metadata || {}, 'executionKey') === executionKey)
    .at(-1);
  if (!matched) {
    return {
      invalidated: false as const,
      reasonCode: 'EXECUTION_VERIFICATION_BINDING_NOT_FOUND' as const,
      ownership: getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root }),
    };
  }
  const existingInvalidatedAt = readStringMetadata(matched.metadata || {}, 'invalidatedAt');
  if (!existingInvalidatedAt) {
    const invalidatedAt = (input.now || new Date()).toISOString();
    saveExecutionSessionEvidence({
      id: matched.id,
      sessionId: matched.sessionId,
      kind: matched.kind,
      path: matched.path,
      repoRevision: matched.repoRevision,
      fileRevision: matched.fileRevision,
      revisionIdentity: matched.revisionIdentity,
      contextHandle: matched.contextHandle,
      stale: matched.stale,
      metadata: {
        ...(matched.metadata || {}),
        invalidatedAt,
        invalidationReason: String(input.reason || 'verification-result-fenced'),
        authoritative: false,
      },
      createdAt: matched.createdAt,
      updatedAt: invalidatedAt,
    });
  }
  return {
    invalidated: true as const,
    reasonCode: existingInvalidatedAt
      ? 'EXECUTION_VERIFICATION_BINDING_ALREADY_INVALIDATED' as const
      : 'EXECUTION_VERIFICATION_BINDING_INVALIDATED' as const,
    candidateId,
    ownership: getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root }),
  };
}

