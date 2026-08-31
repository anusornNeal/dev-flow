import { createHash } from 'node:crypto';
import type { AppState } from '../types';
import { getProject } from '../repositories/projectRepository.js';
import { getTaskByIdentifier, getTasks, getTasksByProjectId } from '../repositories/taskRepository.js';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository.js';
import {
  getLatestTaskFinalizationOperation,
  getTaskFinalizationOperation,
  type TaskFinalizationOperationRecord,
} from '../repositories/taskFinalizationOperationRepository.js';
import { getSessionWorkspaceMetadataForRecovery } from './sessionWorkspaceService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';
import { createApiError } from './api.js';
import { reconcileExecutionLifecycleStage } from './executionLifecycleReconciliationService.js';
import { getProjectRulesContext } from './projectRulesService.js';
import {
  evaluateHarnessPolicy,
  type HarnessPolicy,
  type HarnessPolicyInput,
  type HarnessSoftChoices,
  type HarnessRisk,
  type HarnessWorkKind,
} from './harnessPolicyService.js';
import {
  getTaskExecutionMutationBinding,
  getExecutionOwnershipState,
  getExecutionSessionOwnershipEpoch,
  getExecutionSessionState,
  getExecutionVerificationBatchLiveOperations,
  getExecutionVerificationBatchState,
  recordExecutionSessionEvidence,
  type ExecutionLifecycleTransitionInput,
} from './executionSessionService.js';

export type HarnessExecutionAction = 'mutation' | 'verification' | 'commit' | 'finalization' | 'restart';export type TaskOwnedCommitRoute = {
  tool: 'commit_task_owned_changes';
  taskId: string;
  workspaceId: string;
  executionSessionId: string;
};

export type HarnessExecutionRecovery = {
  strategy: 'switch-tool';
  nextTool: 'commit_task_owned_changes';
  retrySamePayload: false;
  autoApply: false;
  taskId: string;
  workspaceId: string;
  executionSessionId: string;
};


type RestartExecutionBlocker = {
  category: 'execution-session';
  sessionId: string;
  taskId: string | null;
  workspaceId: string | null;
  stage: string;
};

export type HarnessExecutionGuardDecision = {
  guarded: boolean;
  allowed: boolean;
  action: HarnessExecutionAction | null;
  effects?: HarnessExecutionAction[];
  toolName: string;
  reasonCode: string;
  guidance: string[];
  policy: null | Pick<HarnessPolicy, 'version' | 'policyId' | 'inputFingerprint' | 'revisionFingerprint' | 'planningEvidence' | 'verification' | 'restart' | 'finalization'>;
  execution: null | {
    sessionId: string;
    taskId: string | null;
    workspaceId: string | null;
    stage: string;
    transitionEvidenceId: string | null;
    commitRoute: TaskOwnedCommitRoute | null;
  };
  operationId: string;
  restartBlockers?: RestartExecutionBlocker[];
  recovery?: HarnessExecutionRecovery;
};

const MUTATION_TOOLS = new Set([
  'write_local_file',
  'safe_edit_local_file',
  'apply_patch',
  'edit_local_files_batch',
  'apply_prepared_edit_plan',
  'apply_prepared_edit',
  'delete_local_path',
  'move_local_path',
]);
const VERIFICATION_TOOLS = new Set(['run_project_command']);
const COMMIT_TOOLS = new Set(['commit_task_owned_changes', 'commit_git_changes']);
const FINALIZATION_TOOLS = new Set(['finalize_task_workspace']);
const RESTART_TOOLS = new Set(['restart_devflow']);

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => !key.startsWith('__')).map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function boundedString(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 240) : null;
}

export function getHarnessExecutionEffects(toolNameValue: string, _args: Record<string, any> = {}): HarnessExecutionAction[] {
  const toolName = String(toolNameValue || '').trim();
  if (toolName === 'apply_and_verify') {
    // The current composite contract always owns a mutation phase before verification.
    // A future verify-only mode must be introduced explicitly rather than inferred from missing edit args.
    return ['mutation', 'verification'];
  }
  if (MUTATION_TOOLS.has(toolName)) return ['mutation'];
  if (VERIFICATION_TOOLS.has(toolName)) return ['verification'];
  if (COMMIT_TOOLS.has(toolName)) return ['commit'];
  if (FINALIZATION_TOOLS.has(toolName)) return ['finalization'];
  if (RESTART_TOOLS.has(toolName)) return ['restart'];
  return [];
}

function actionForTool(toolName: string, args: Record<string, any> = {}): HarnessExecutionAction | null {
  const effects = getHarnessExecutionEffects(toolName, args);
  return effects.includes('mutation') ? 'mutation' : effects[0] || null;
}

export function isHarnessLifecycleAffectingTool(toolName: string, args: Record<string, any> = {}) {
  return getHarnessExecutionEffects(String(toolName || '').trim(), args).length > 0;
}

function taskRisk(task: any): HarnessRisk {
  if (!task) return 'unknown';
  if (task.priority === 'high') return 'high';
  if (task.priority === 'medium') return 'medium';
  if (task.priority === 'low') return 'low';
  return 'unknown';
}

function taskKind(task: any): HarnessWorkKind {
  if (!task) return 'unknown';
  const tags = Array.isArray(task.tags) ? task.tags.map((entry: unknown) => String(entry).toLowerCase()) : [];
  const targets = Array.isArray(task.targetFiles) ? task.targetFiles : [];
  if (tags.some((entry: string) => /bug|fix|defect/.test(entry))) return 'bug-fix';
  if (tags.some((entry: string) => /ui|ux|frontend/.test(entry)) && targets.length <= 2) return 'small-ui';
  if (targets.length >= 4 || tags.some((entry: string) => /cross-module|architecture|migration/.test(entry))) return 'cross-module';
  if (task.priority === 'high') return 'high-risk';
  return 'unknown';
}

function softChoices(value: unknown): HarnessSoftChoices | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: HarnessSoftChoices = {};
  if (typeof raw.planningEvidenceRequired === 'boolean') result.planningEvidenceRequired = raw.planningEvidenceRequired;
  if (raw.contextSearchBudgetClass === 'compact' || raw.contextSearchBudgetClass === 'standard' || raw.contextSearchBudgetClass === 'expanded') result.contextSearchBudgetClass = raw.contextSearchBudgetClass;
  if (raw.verificationCoverage === 'none' || raw.verificationCoverage === 'targeted' || raw.verificationCoverage === 'broad' || raw.verificationCoverage === 'full') result.verificationCoverage = raw.verificationCoverage;
  if (typeof raw.parallelAllowed === 'boolean') result.parallelAllowed = raw.parallelAllowed;
  return Object.keys(result).length ? result : undefined;
}

function projectRevision(project: any) {
  if (!project) return '<unknown>';
  return fingerprint({
    id: project.id,
    name: project.name,
    repoUrl: project.repoUrl,
    localPath: project.localPath,
    taskIdPrefix: project.taskIdPrefix,
    gitWorkflowPolicy: project.gitWorkflowPolicy,
  });
}

function rulesRevision(project: any) {
  try {
    return fingerprint(getProjectRulesContext(project?.localPath || undefined));
  } catch {
    return '<unknown>';
  }
}

const RESTART_SENSITIVE_EXECUTION_STAGES = new Set(['implementing', 'verifying', 'repairing', 'verification-infra-blocked']);
const MAX_RESTART_BLOCKERS = 10;

function relatedWorkActivity(projectId: string | undefined, taskId: string | undefined) {
  const tasks = projectId ? getTasksByProjectId(projectId) : getTasks();
  const blockers: RestartExecutionBlocker[] = [];
  for (const entry of tasks) {
    if (entry.id === taskId || !entry.claim?.workspaceId) continue;
    let relatedBinding: ReturnType<typeof getTaskExecutionMutationBinding> | null = null;
    try {
      relatedBinding = getTaskExecutionMutationBinding({ workspaceId: entry.claim.workspaceId });
    } catch {
      continue;
    }
    if (!relatedBinding || !RESTART_SENSITIVE_EXECUTION_STAGES.has(relatedBinding.session.lifecycle.stage)) continue;
    blockers.push({
      category: 'execution-session',
      sessionId: relatedBinding.session.id,
      taskId: relatedBinding.session.taskId,
      workspaceId: relatedBinding.workspaceId,
      stage: relatedBinding.session.lifecycle.stage,
    });
    if (blockers.length >= MAX_RESTART_BLOCKERS) break;
  }
  return { active: blockers.length > 0, blockers };
}

function resolveExplicitPolicy(args: Record<string, any>, task: any) {
  const envelope = args?.harnessPolicy && typeof args.harnessPolicy === 'object' ? args.harnessPolicy : {};
  return {
    user: softChoices(envelope.userExplicit || args?.harnessPolicyOverride),
    task: softChoices(envelope.taskExplicit || task?.harnessPolicy?.explicit),
    taskDefaults: softChoices(task?.harnessPolicy?.defaults),
    userRevision: boundedString(envelope.userRevision) || fingerprint(softChoices(envelope.userExplicit || args?.harnessPolicyOverride) || {}),
  };
}

function candidatePathValues(args: Record<string, any>) {
  const values: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
  };
  push(args?.filePath);
  push(args?.path);
  if (Array.isArray(args?.files)) for (const entry of args.files) push(typeof entry === 'string' ? entry : entry?.filePath || entry?.path);
  return values;
}

function pathsLookSafe(args: Record<string, any>) {
  const paths = candidatePathValues(args);
  return paths.every((entry) => {
    const normalized = entry.replace(/\\/g, '/');
    return !/^[a-zA-Z]:\//.test(normalized)
      && !normalized.startsWith('/')
      && normalized !== '..'
      && !normalized.startsWith('../')
      && !normalized.includes('/../');
  });
}

function operationIdentity(toolName: string, args: Record<string, any>) {
  const explicit = boundedString(args?.harnessOperationId || args?.operationId || args?.jobId || args?.editPlanId);
  if (explicit) return explicit;
  const verificationRevision = getHarnessExecutionEffects(toolName, args).includes('verification')
    ? boundedString(args?.__verificationCandidate?.repoRevision || args?.__projectCommandAdmissionIdentity?.repoRevision)
    : null;
  return `guard-op-${fingerprint({
    toolName,
    args,
    ...(verificationRevision ? { verificationRevision } : {}),
  }).slice(0, 32)}`;
}

function resolveTaskWithoutBinding(args: Record<string, any>) {
  const taskId = boundedString(args?.taskId);
  return taskId ? getTaskByIdentifier(taskId, 'full') : undefined;
}
function assertDurableFinalizationResumeGuard(args: Record<string, any>): TaskFinalizationOperationRecord | null {
  const operationId = boundedString(args?.operationId);
  if (!operationId) return null;
  const taskId = boundedString(args?.taskId);
  const workspaceId = boundedString(args?.workspaceId);
  if (!taskId || !workspaceId) {
    throw createApiError(409, 'FINALIZATION_RESUME_IDENTITY_REQUIRED', 'Exact durable finalization resume requires taskId, workspaceId, and operationId.');
  }
  const task = getTaskByIdentifier(taskId, 'full');
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskId}' was not found.`, { affectedId: taskId });
  const operation = getTaskFinalizationOperation(operationId);
  if (!operation) {
    throw createApiError(404, 'FINALIZATION_OPERATION_NOT_FOUND', `Finalization operation '${operationId}' was not found.`, { affectedId: operationId });
  }
  if (operation.taskId !== task.id || operation.projectId !== task.projectId || operation.workspaceId !== workspaceId) {
    throw createApiError(409, 'FINALIZATION_OPERATION_SELECTOR_MISMATCH', 'Requested finalization operation does not match the selected task/workspace.', {
      affectedId: operation.id,
      details: { operationTaskId: operation.taskId, taskId: task.id, operationWorkspaceId: operation.workspaceId, workspaceId },
    });
  }
  if (operation.status === 'completed') return operation;

  const taskBranch = boundedString(task.branch);
  if (taskBranch && taskBranch !== operation.baseBranch) {
    throw createApiError(409, 'TASK_WORKSPACE_BRANCH_AUTHORITY_MISMATCH', `Task '${task.displayId || task.id}' targets '${taskBranch}', but finalization is frozen to '${operation.baseBranch}'.`, {
      affectedId: task.id,
      details: { taskBranch, workspaceBaseBranch: operation.baseBranch, workspaceId },
    });
  }
  const latest = getLatestTaskFinalizationOperation(task.id, workspaceId);
  if (latest && latest.id !== operation.id && latest.status !== 'completed') {
    throw createApiError(409, 'FINALIZATION_OPERATION_IDENTITY_CHANGED', 'Another incomplete finalization operation supersedes the requested frozen operation.', {
      affectedId: latest.id,
      details: { existingOperationId: latest.id, requestedOperationId: operation.id },
    });
  }

  const sessions = listExecutionSessionsForTask(task.id);
  const sourceExecution = operation.executionSessionId
    ? sessions.find((entry) => entry.id === operation.executionSessionId) || null
    : null;
  if (operation.executionSessionId && (!sourceExecution
    || sourceExecution.taskId !== task.id
    || sourceExecution.projectId !== task.projectId
    || sourceExecution.workspaceId !== workspaceId)) {
    throw createApiError(409, 'FINALIZATION_OPERATION_EXECUTION_MISMATCH', 'Frozen finalization execution identity no longer matches the selected task/workspace.', {
      affectedId: operation.id,
      details: { executionSessionId: operation.executionSessionId, workspaceId },
    });
  }
  if (operation.ownershipEpochId && sourceExecution) {
    const observedEpoch = getExecutionSessionOwnershipEpoch(sourceExecution.id).ownershipEpochId;
    if (observedEpoch !== operation.ownershipEpochId) {
      throw createApiError(409, 'FINALIZATION_OPERATION_OWNERSHIP_MISMATCH', 'Frozen finalization ownership epoch no longer matches the originating execution.', {
        affectedId: operation.id,
        details: { expectedOwnershipEpochId: operation.ownershipEpochId, observedOwnershipEpochId: observedEpoch },
      });
    }
  }
  const conflictingActive = sessions.filter((entry) => entry.status === 'active' && entry.id !== operation.executionSessionId);
  if (conflictingActive.length > 0) {
    throw createApiError(409, 'FINALIZATION_OPERATION_SUPERSEDED_BY_EXECUTION', 'A live execution supersedes the frozen finalization authority.', {
      affectedId: operation.id,
      details: { executionSessionIds: conflictingActive.map((entry) => entry.id), workspaceId },
    });
  }

  const metadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
  if (metadata) {
    if (metadata.projectId !== operation.projectId || metadata.baseBranch !== operation.baseBranch) {
      throw createApiError(409, 'FINALIZATION_OPERATION_WORKSPACE_MISMATCH', 'Finalization workspace/project/base binding changed after the operation was frozen.', {
        affectedId: operation.id,
        details: { workspaceId, baseBranch: operation.baseBranch },
      });
    }
    const inspection = inspectWorkspaceRecovery(workspaceId);
    if (inspection.dirtyFiles.length > 0) {
      throw createApiError(409, 'FINALIZATION_OPERATION_WORKSPACE_DIRTY', 'Frozen finalization cannot resume while the managed workspace has dirty files.', {
        affectedId: operation.id,
        details: { workspaceId, dirtyFiles: inspection.dirtyFiles },
      });
    }
    const observedSourceHead = String(inspection.sourceHead || '').trim();
    if (operation.phase === 'frozen' && observedSourceHead && observedSourceHead !== operation.sourceHead) {
      throw createApiError(409, 'FINALIZATION_OPERATION_SOURCE_CHANGED', 'Workspace source HEAD changed after finalization identity was frozen.', {
        affectedId: operation.id,
        details: { expectedSourceHead: operation.sourceHead, observedSourceHead },
      });
    }
  }
  return operation;
}

function buildPolicyInput(toolName: string, args: Record<string, any>, binding: ReturnType<typeof getTaskExecutionMutationBinding> | null): HarnessPolicyInput {
  const task = binding?.task || resolveTaskWithoutBinding(args);
  const projectId = task?.projectId || boundedString(args?.projectId) || undefined;
  const project = projectId ? getProject(projectId) : undefined;
  const explicit = resolveExplicitPolicy(args, task);
  const session = binding?.session;
  const action = actionForTool(toolName, args);
  return {
    task: {
      revision: task?.updatedAt || '<unknown>',
      risk: taskRisk(task),
      kind: taskKind(task),
      explicit: explicit.task,
      defaults: explicit.taskDefaults,
    },
    user: {
      revision: explicit.userRevision,
      explicit: explicit.user,
    },
    project: {
      revision: projectRevision(project),
    },
    rules: {
      revision: rulesRevision(project),
    },
    runtime: {
      revision: fingerprint({
        sessionId: session?.id || null,
        stage: session?.lifecycle.stage || null,
        transitionEvidenceId: session?.lifecycle.lastTransition?.evidenceId || null,
        repoRevision: session?.repoRevision || null,
        workspaceId: binding?.workspaceId || boundedString(args?.workspaceId),
        claimExpiresAt: task?.claim?.expiresAt || null,
      }),
      scopeRelationship: binding ? 'disjoint' : 'unknown',
      relatedWorkActive: action === 'restart' ? relatedWorkActivity(projectId, task?.id).active : false,
      restartRequested: action === 'restart',
      managedWorkspace: binding ? true : undefined,
      ownershipProven: binding ? binding.task?.claim?.workspaceId === binding.workspaceId : undefined,
      pathsSafe: pathsLookSafe(args),
      workingTreeClean: undefined,
      commitOwned: toolName === 'commit_task_owned_changes' ? true : undefined,
      integrationSafe: undefined,
    },
  };
}

function compactPolicy(policy: HarnessPolicy): HarnessExecutionGuardDecision['policy'] {
  return {
    version: policy.version,
    policyId: policy.policyId,
    inputFingerprint: policy.inputFingerprint,
    revisionFingerprint: policy.revisionFingerprint,
    planningEvidence: policy.planningEvidence,
    verification: policy.verification,
    restart: policy.restart,
    finalization: policy.finalization,
  };
}

function taskOwnedCommitRoute(binding: ReturnType<typeof getTaskExecutionMutationBinding> | null): TaskOwnedCommitRoute | null {
  if (!binding?.task?.id || !binding?.workspaceId || !binding?.session?.id) return null;
  return {
    tool: 'commit_task_owned_changes',
    taskId: binding.task.id,
    workspaceId: binding.workspaceId,
    executionSessionId: binding.session.id,
  };
}

function executionIdentity(binding: ReturnType<typeof getTaskExecutionMutationBinding> | null): HarnessExecutionGuardDecision['execution'] {
  if (!binding) return null;
  return {
    sessionId: binding.session.id,
    taskId: binding.session.taskId,
    workspaceId: binding.workspaceId,
    stage: binding.session.lifecycle.stage,
    transitionEvidenceId: binding.session.lifecycle.lastTransition?.evidenceId || null,
    commitRoute: taskOwnedCommitRoute(binding),
  };
}

function blockedDecision(toolName: string, action: HarnessExecutionAction, operationId: string, policy: HarnessPolicy, binding: ReturnType<typeof getTaskExecutionMutationBinding> | null, reasonCode: string, guidance: string[], restartBlockers: RestartExecutionBlocker[] = [], recovery?: HarnessExecutionRecovery): HarnessExecutionGuardDecision {
  return {
    guarded: true,
    allowed: false,
    action,
    effects: [action],
    toolName,
    reasonCode,
    guidance,
    policy: compactPolicy(policy),
    execution: executionIdentity(binding),
    operationId,
    ...(restartBlockers.length > 0 ? { restartBlockers } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

function outstandingVerificationDebt(sessionId: string) {
  const evidence = getExecutionSessionState(sessionId).evidence;
  const settledDebtIds = new Set(
    evidence
      .filter((entry: any) => entry.kind === 'verification-debt-settlement' && entry.metadata?.status === 'settled')
      .map((entry: any) => boundedString(entry.metadata?.debtEvidenceId))
      .filter(Boolean),
  );
  return [...evidence]
    .reverse()
    .find((entry: any) => entry.kind === 'verification-debt'
      && entry.metadata?.status === 'outstanding'
      && !settledDebtIds.has(entry.id)) || null;
}

export function preflightHarnessExecutionGuard(_state: AppState, toolNameValue: string, argsValue: Record<string, any> = {}): HarnessExecutionGuardDecision {
  const toolName = String(toolNameValue || '').trim();
  const args = argsValue || {};
  const effects = getHarnessExecutionEffects(toolName, args);
  const action = actionForTool(toolName, args);
  const operationId = operationIdentity(toolName, args);
  if (!action) {
    return { guarded: false, allowed: true, action: null, toolName, reasonCode: 'LIGHTWEIGHT_UNGUARDED', guidance: [], policy: null, execution: null, operationId };
  }

  const explicitExecutionIntent = Boolean(
    boundedString(args?.taskId)
    || boundedString(args?.harnessPolicyFingerprint)
    || boundedString(args?.harnessOperationId),
  );
  let durableFinalizationResume: TaskFinalizationOperationRecord | null = null;
  if (toolName === 'finalize_task_workspace' && boundedString(args?.operationId)) {
    try {
      durableFinalizationResume = assertDurableFinalizationResumeGuard(args);
    } catch (error: any) {
      const policy = evaluateHarnessPolicy(buildPolicyInput(toolName, args, null));
      return blockedDecision(toolName, action, operationId, policy, null, error?.payload?.code || error?.code || 'FINALIZATION_RESUME_AUTHORITY_REQUIRED', [String(error?.message || 'Frozen finalization resume authority could not be proven.')]);
    }
  }
  let binding: ReturnType<typeof getTaskExecutionMutationBinding> | null = null;
  try {
    binding = getTaskExecutionMutationBinding(args);
  } catch (error: any) {
    if (!durableFinalizationResume) {
      const policy = evaluateHarnessPolicy(buildPolicyInput(toolName, args, null));
      return blockedDecision(toolName, action, operationId, policy, null, error?.code || 'EXECUTION_BINDING_REQUIRED', [String(error?.message || 'Execution binding could not be proven.')]);
    }
  }

  if (action !== 'restart' && !binding && !explicitExecutionIntent) {
    return {
      guarded: false,
      allowed: true,
      action,
      toolName,
      reasonCode: 'GENERIC_NON_EXECUTION_UNGUARDED',
      guidance: [],
      policy: null,
      execution: null,
      operationId,
    };
  }

  const policyInput = buildPolicyInput(toolName, args, binding);
  const policy = evaluateHarnessPolicy(policyInput);
  const suppliedFingerprint = boundedString(args?.harnessPolicyFingerprint);
  if (suppliedFingerprint && suppliedFingerprint !== policy.inputFingerprint) {
    return blockedDecision(toolName, action, operationId, policy, binding, 'HARNESS_POLICY_STALE', ['Recompute execution policy from current task/project/rule/runtime facts before retrying.']);
  }

  if (toolName === 'commit_git_changes') {
    const route = taskOwnedCommitRoute(binding);
    const recovery = route ? {
      strategy: 'switch-tool' as const,
      nextTool: route.tool,
      retrySamePayload: false as const,
      autoApply: false as const,
      taskId: route.taskId,
      workspaceId: route.workspaceId,
      executionSessionId: route.executionSessionId,
    } : undefined;
    return blockedDecision(
      toolName,
      action,
      operationId,
      policy,
      binding,
      'TASK_OWNED_COMMIT_REQUIRED',
      ['Task-bound execution commits must use commit_task_owned_changes so task ownership, scope, and Git safety remain authoritative.'],
      [],
      recovery,
    );
  }
  if (action !== 'restart' && !binding && !durableFinalizationResume) {
    return blockedDecision(toolName, action, operationId, policy, null, 'MANAGED_WORKSPACE_REQUIRED', ['Lifecycle-affecting execution requires an actively claimed task-bound managed workspace.']);
  }
  if (binding && !pathsLookSafe(args)) {
    return blockedDecision(toolName, action, operationId, policy, binding, 'REPO_RELATIVE_PATH_SAFETY_REQUIRED', ['Lifecycle-affecting task paths must remain repository-relative.']);
  }
  if (binding) {
    const batchState = getExecutionVerificationBatchState(binding.session.id);
    if (batchState?.status === 'pending') {
      const liveOperations = getExecutionVerificationBatchLiveOperations(binding.session.id, batchState.batchId);
      const fencedEffect = effects.find((effect) => effect === 'mutation' || effect === 'commit' || effect === 'finalization');
      if (fencedEffect && liveOperations.length > 0) {
        return blockedDecision(toolName, fencedEffect, operationId, policy, binding, 'EXECUTION_VERIFICATION_BATCH_LIVE_MEMBERS', [
          `Verification batch '${batchState.batchId}' still has live durable member operations: ${liveOperations.map((entry) => entry.operationId).join(', ')}.`,
        ]);
      }
      if (effects.includes('verification')) {
        const requestedBatch = args?.verificationBatch && typeof args.verificationBatch === 'object' ? args.verificationBatch : null;
        const requestedId = String(requestedBatch?.id || '').trim();
        const requestedCheckId = String(requestedBatch?.checkId || args?.command || args?.preset || '').trim();
        const requestedChecks = Array.isArray(requestedBatch?.requiredChecks) ? requestedBatch.requiredChecks.map(String) : [];
        const continuation = requestedId === batchState.batchId
          && JSON.stringify(requestedChecks) === JSON.stringify(batchState.requiredChecks)
          && batchState.pending.includes(requestedCheckId);
        const replacement = requestedId !== batchState.batchId
          && String(requestedBatch?.supersedesBatchId || '').trim() === batchState.batchId
          && String(requestedBatch?.supersessionReason || '').trim().length >= 10;
        if (replacement && liveOperations.length > 0) {
          return blockedDecision(toolName, action, operationId, policy, binding, 'EXECUTION_VERIFICATION_BATCH_LIVE_MEMBERS', [
            `Verification batch '${batchState.batchId}' cannot be superseded until live member operations terminate or are fenced.`,
          ]);
        }
        if (!continuation && !replacement) {
          return blockedDecision(toolName, action, operationId, policy, binding, 'EXECUTION_VERIFICATION_BATCH_CONTINUATION_REQUIRED', [
            `Continue pending batch '${batchState.batchId}' with one of: ${batchState.pending.join(', ')}, or explicitly supersede it with supersedesBatchId and supersessionReason after live members terminate.`,
          ]);
        }
      }
    }
  }

  if (action === 'restart' && policy.restart.value.gate !== 'allowed') {
    const task = binding?.task || resolveTaskWithoutBinding(args);
    const projectId = task?.projectId || boundedString(args?.projectId) || undefined;
    const restartActivity = relatedWorkActivity(projectId, task?.id);
    const blockerSummary = restartActivity.blockers.map((entry) => `${entry.category}:${entry.stage}:${entry.taskId || 'unbound'}`);
    return blockedDecision(
      toolName,
      action,
      operationId,
      policy,
      binding,
      policy.restart.reasonCodes[0] || 'RESTART_BLOCKED',
      blockerSummary.length > 0
        ? [`Restart would interrupt live execution: ${blockerSummary.join(', ')}`]
        : ['Restart is blocked until related active work is known inactive.'],
      restartActivity.blockers,
    );
  }

  const guidance = [
    ...policy.planningEvidence.reasonCodes.map((code) => `planning:${code}`),
    ...policy.verification.reasonCodes.map((code) => `verification:${code}`),
  ].slice(0, 10);
  return {
    guarded: true,
    allowed: true,
    action,
    effects,
    toolName,
    reasonCode: durableFinalizationResume && !binding ? 'HARNESS_DURABLE_FINALIZATION_RESUME_ALLOWED' : 'HARNESS_EXECUTION_ALLOWED',
    guidance,
    policy: compactPolicy(policy),
    execution: executionIdentity(binding),
    operationId,
  };
}

export function assertHarnessExecutionAllowed(state: AppState, toolName: string, args: Record<string, any> = {}) {
  const decision = preflightHarnessExecutionGuard(state, toolName, args);
  if (!decision.allowed) {
    throw createApiError(409, decision.reasonCode, `Harness execution guard blocked '${toolName}'.`, { details: decision });
  }
  return decision;
}

const NON_TERMINAL_RESULT_STATUSES = new Set(['accepted', 'queued', 'pending', 'running', 'scheduled']);
const FAILED_RESULT_STATUSES = new Set(['failed', 'cancelled', 'timed_out', 'interrupted', 'blocked', 'needs-recovery', 'conflict']);

function resultIsTerminal(result: any) {
  if (!result || typeof result !== 'object') return false;
  const status = typeof result.status === 'string' ? result.status : '';
  return !NON_TERMINAL_RESULT_STATUSES.has(status) && result.ready !== false;
}

function resultFailed(result: any) {
  const status = typeof result?.status === 'string' ? result.status : '';
  return result?.ok === false
    || result?.timedOut === true
    || FAILED_RESULT_STATUSES.has(status)
    || (typeof result?.exitCode === 'number' && result.exitCode !== 0);
}

type VerificationFailureClass = 'code' | 'infrastructure';

const INFRASTRUCTURE_FAILURE_STATUSES = new Set(['cancelled', 'timed_out', 'interrupted', 'blocked', 'conflict']);
const INFRASTRUCTURE_FAILURE_CODE = /(CAPACITY|OUT_OF_MEMORY|\bOOM\b|TIMEOUT|TIMED_OUT|WORKER.*LEASE|TOOL.*CRASH|PROCESS.*KILL|INTERRUPT)/i;
const INFRASTRUCTURE_FAILURE_OUTPUT = /(OutOfMemoryError|Java heap space|heap out of memory|allocation failed[^\n]*heap|killed process|process[^\n]*killed|worker lease|verification capacity|tool runner[^\n]*crash)/i;

function classifyVerificationFailure(result: any): VerificationFailureClass {
  if (result?.timedOut === true) return 'infrastructure';
  if (boundedString(result?.signal)) return 'infrastructure';
  const status = boundedString(result?.status);
  if (status && INFRASTRUCTURE_FAILURE_STATUSES.has(status)) return 'infrastructure';
  const code = boundedString(result?.code || result?.error?.code);
  if (code && INFRASTRUCTURE_FAILURE_CODE.test(code)) return 'infrastructure';
  const diagnostics = [result?.stderr, result?.stdout, result?.message, result?.error?.message]
    .map((value) => boundedString(value) || '')
    .join('\n')
    .slice(0, 12_000);
  if (diagnostics && INFRASTRUCTURE_FAILURE_OUTPUT.test(diagnostics)) return 'infrastructure';
  return 'code';
}

function mutationHadAuthoritativeEffect(result: any) {
  if (!resultIsTerminal(result) || resultFailed(result) || result?.dryRun === true) return false;
  const effectFlags = ['changed', 'removed', 'moved', 'applied', 'created']
    .filter((key) => typeof result?.[key] === 'boolean')
    .map((key) => result[key] as boolean);
  return effectFlags.length === 0 || effectFlags.some(Boolean);
}

function commitWasCreated(result: any) {
  if (!resultIsTerminal(result) || resultFailed(result) || result?.dryRun === true) return false;
  return Boolean(boundedString(result?.commitHash || result?.hash));
}

function transition(sessionId: string, toStage: ExecutionLifecycleTransitionInput['toStage'], reasonCode: string, decision: HarnessExecutionGuardDecision, evidenceSuffix: string, kind: string) {
  return reconcileExecutionLifecycleStage(sessionId, {
    toStage,
    reasonCode,
    evidence: {
      id: `harness:${decision.operationId}:${evidenceSuffix}`,
      kind,
      status: 'completed',
      operationId: decision.operationId,
    },
  });
}

function recordVerificationFailureEvidence(sessionId: string, decision: HarnessExecutionGuardDecision, result: any, failureClass: VerificationFailureClass) {
  return recordExecutionSessionEvidence(sessionId, [{
    evidenceId: `harness:${decision.operationId}:verification-failure`,
    kind: 'verification-result',
    revisionIdentity: decision.operationId,
    metadata: {
      operationId: decision.operationId,
      outcome: 'failed',
      terminal: true,
      status: typeof result?.status === 'string' ? result.status : null,
      exitCode: typeof result?.exitCode === 'number' ? result.exitCode : null,
      timedOut: result?.timedOut === true,
      signal: boundedString(result?.signal),
      failureClass,
      sourceRepairRequired: failureClass === 'code',
      recoveryRequired: true,
    },
  }])[0] || null;
}

function compositeVerificationOutcome(result: any) {
  const verification = Array.isArray(result?.verification) ? result.verification : [];
  if (verification.length === 0) return null;
  const failed = verification.find((entry: any) => resultFailed(entry));
  return resultFailed(result) ? failed || result : result;
}

export function recordHarnessExecutionOutcome(decision: HarnessExecutionGuardDecision, result: any) {
  if (Array.isArray(decision.effects) && decision.effects.length > 1) {
    let recorded: any = null;
    for (const effect of decision.effects) {
      const effectResult = effect === 'mutation'
        ? result?.edit || result
        : effect === 'verification'
          ? compositeVerificationOutcome(result)
          : result;
      if (!effectResult) continue;
      const next = recordHarnessExecutionOutcome({ ...decision, action: effect, effects: [effect] }, effectResult);
      if (next) recorded = next;
    }
    return recorded;
  }
  if (!decision.guarded || !decision.allowed || !decision.execution?.sessionId || !decision.action) return null;
  const sessionId = decision.execution.sessionId;

  if (decision.action === 'mutation') {
    if (!mutationHadAuthoritativeEffect(result)) return null;
    const current = getTaskExecutionMutationBinding({ workspaceId: decision.execution.workspaceId });
    if (!current) return null;
    if (current.session.lifecycle.stage === 'implementing') return current.session.lifecycle;
    return transition(sessionId, 'implementing', 'authoritative-mutation-succeeded', decision, 'mutation', 'tool-result');
  }
  if (decision.action === 'verification') {
    if (!resultIsTerminal(result)) return null;
    let current = getTaskExecutionMutationBinding({ workspaceId: decision.execution.workspaceId });
    if (!current) return null;

    if (resultFailed(result)) {
      const failureClass = classifyVerificationFailure(result);
      recordVerificationFailureEvidence(sessionId, decision, result, failureClass);
      const batchState = getExecutionVerificationBatchState(sessionId);

      if (failureClass === 'infrastructure') {
        if (current.session.lifecycle.stage === 'verification-infra-blocked') return current.session.lifecycle;
        return transition(sessionId, 'verification-infra-blocked', 'verification-infrastructure-failure-recovery-required', decision, 'infra-blocked', 'verification-result');
      }

      if (current.session.lifecycle.stage === 'repairing') return current.session.lifecycle;
      const repairReason = current.session.lifecycle.stage === 'verification-infra-blocked'
        ? 'verification-recovery-found-code-failure'
        : (batchState?.status === 'failed' || batchState?.status === 'stale')
          ? 'verification-batch-failed-repair-required'
          : 'verification-failed-repair-required';
      return transition(sessionId, 'repairing', repairReason, decision, 'repair', 'verification-result');
    }

    if (current.session.lifecycle.stage === 'committed') {
      const debt = outstandingVerificationDebt(sessionId);
      if (!debt) return current.session.lifecycle;
      const ownership = getExecutionOwnershipState(sessionId, { repoRoot: current.workspace.root });
      if (ownership.verificationFresh !== true) return current.session.lifecycle;
      recordExecutionSessionEvidence(sessionId, [{
        evidenceId: `harness:${decision.operationId}:verification-debt-settlement`,
        kind: 'verification-debt-settlement',
        revisionIdentity: decision.operationId,
        metadata: {
          status: 'settled',
          debtEvidenceId: debt.id,
          commitHash: boundedString(debt.metadata?.commitHash),
          operationId: decision.operationId,
          settledAt: new Date().toISOString(),
        },
      }]);
      return current.session.lifecycle;
    }
    const ownership = getExecutionOwnershipState(sessionId, { repoRoot: current.workspace.root });
    if (ownership.verificationFresh !== true || current.session.lifecycle.stage === 'verifying') return current.session.lifecycle;
    return transition(sessionId, 'verifying', 'verification-result-observed', decision, 'verification', 'verification-result');
  }
  if (decision.action === 'commit') {
    if (!commitWasCreated(result)) return null;
    const current = getTaskExecutionMutationBinding({ workspaceId: decision.execution.workspaceId });
    if (!current) return null;
    const commitHash = boundedString(result?.commitHash || result?.hash)!;
    recordExecutionSessionEvidence(sessionId, [{
      evidenceId: `harness:${decision.operationId}:commit-result`,
      kind: 'git-commit-result',
      revisionIdentity: commitHash,
      metadata: {
        commitHash,
        taskId: current.task.id,
        workspaceId: current.workspaceId,
        executionSessionId: current.session.id,
        tool: 'commit_task_owned_changes',
        owned: true,
      },
    }]);
    return reconcileExecutionLifecycleStage(sessionId, {
      toStage: 'committed',
      reasonCode: result?.verificationDebtPreserved === true ? 'task-owned-commit-succeeded-with-verification-debt' : 'task-owned-commit-succeeded',
      evidence: {
        id: `harness:${decision.operationId}:commit`,
        kind: 'git-commit',
        status: 'completed',
        operationId: decision.operationId,
      },
    });
  }
  if (decision.action === 'finalization') {
    // The authoritative finalization service records the finalized lifecycle transition
    // after integration/cleanup succeed and before it makes the execution session terminal.
    return result?.status === 'completed' ? result : null;
  }
  return null;
}
