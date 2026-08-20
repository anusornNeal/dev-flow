import type { AppState } from '../types';
import { getCapabilityCatalog, getMcpToolList } from '../contracts/devflowContract';
import { getGitStatus } from './gitService';
import { getDevFlowDiagnostics } from './mcpToolMonitor';
import { getLocalSearchRuntimeStatus } from './localFileService';
import { evaluatePerformanceSlo } from './performanceSloService';
import { performance as nodePerformance } from 'node:perf_hooks';
import { publishServerEvent } from './serverEventService.js';
import { getRecoveryStatus } from './backupIntegrityService';
import { getTasks } from '../repositories/taskRepository.js';
import { queryExecutionSessions, type ExecutionSessionRecord } from '../repositories/executionSessionRepository.js';
import { listLifecycleEmergencyOperations } from '../repositories/lifecycleEmergencyOperationRepository.js';
import { buildChatGptHarnessEnvelope, findProjectByIdentifier, findTaskByIdentifier } from './taskService.js';
import { getExecutionSessionOwnershipEpoch } from './executionSessionService.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import {
  findSessionWorkspaceRecoveryCandidatesForTask,
  getSessionWorkspaceMetadataForRecovery,
  listSessionWorkspaceMetadataForRecovery,
} from './sessionWorkspaceService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';
import { HARNESS_POLICY_VERSION } from './harnessPolicyService.js';
import { HARNESS_STRATEGY_VERSION } from './harnessStrategyService.js';

const lastHealthEventSignatures = new Map<string, string>();

type Probe<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string; status?: number } };

function probe<T>(fn: () => T): Probe<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error: any) {
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error || 'Unknown error'),
        code: error?.code,
        status: error?.status,
      },
    };
  }
}

function numberArg(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type WorkflowHealthResponseMode = 'compact' | 'full';

function resolveWorkflowHealthResponseMode(args: Record<string, any>): WorkflowHealthResponseMode {
  const raw = String(args.responseMode || args.mode || '').trim().toLowerCase();
  if (raw === 'compact' || raw === 'summary') return 'compact';
  return 'full';
}

function compactFailureGroups(groups: Array<{ toolName: string; count: number; statuses: string[]; examples: any[] }>) {
  return groups.map(({ toolName, count, statuses }) => ({ toolName, count, statuses }));
}

function summarizeFailedJobGroups(failures: any[]) {
  const groups = new Map<string, { toolName: string; count: number; statuses: string[]; examples: any[] }>();
  for (const failure of failures) {
    const toolName = String(failure?.toolName || 'unknown');
    const group = groups.get(toolName) || { toolName, count: 0, statuses: [], examples: [] };
    group.count += 1;
    const status = String(failure?.status || '').trim();
    if (status && !group.statuses.includes(status)) group.statuses.push(status);
    if (group.examples.length < 3) {
      group.examples.push({
        jobId: failure?.jobId,
        status: failure?.status,
        failureSummary: failure?.failureSummary || '',
      });
    }
    groups.set(toolName, group);
  }
  return Array.from(groups.values()).sort((left, right) => right.count - left.count);
}

export const CHATGPT_HARNESS_HEALTH_VERSION = 'chatgpt-harness-health.v2' as const;

type HarnessHealthDrift = {
  code: string;
  message: string;
  taskIds?: string[];
  workspaceIds?: string[];
  executionSessionIds?: string[];
  operationIds?: string[];
  nextAction: string;
};

function cleanHealthSelector(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function activeHealthClaim(task: any) {
  const workspaceId = cleanHealthSelector(task?.claim?.workspaceId);
  const expiresAtMs = Date.parse(String(task?.claim?.expiresAt || ''));
  if (!workspaceId || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
  return {
    workspaceId,
    ownershipEpochId: cleanHealthSelector(task?.claim?.ownershipEpochId) || null,
    expiresAt: String(task.claim.expiresAt),
  };
}

function pendingHealthOperations(session: ExecutionSessionRecord | null) {
  if (!session) return { checkpoint: null as any, operationIds: [] as string[] };
  const checkpoint = getLatestExecutionCheckpoint(session.id);
  const operationIds = Array.isArray(checkpoint?.pendingOperations)
    ? checkpoint.pendingOperations.map((entry: any) => cleanHealthSelector(entry?.operationId)).filter(Boolean).slice(0, 20)
    : [];
  return { checkpoint, operationIds };
}

function executionHealthView(session: ExecutionSessionRecord | null, stageOverride?: string) {
  if (!session) return { stage: stageOverride || 'unclaimed', sessionId: null, workspaceId: null, ownershipEpochId: null };
  const ownershipEpochId = getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId;
  return {
    stage: stageOverride || session.lifecycle.stage,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    taskId: session.taskId,
    status: session.status,
    ownershipEpochId,
    repoRevision: session.repoRevision,
  };
}

function actionableRecoveryWorkspace(workspaceId: string) {
  const inspection = inspectWorkspaceRecovery(workspaceId);
  return inspection.disposition === 'needs-recovery'
    || inspection.disposition === 'stale-registry'
    || inspection.disposition === 'committed-not-integrated'
    || inspection.state === 'integration-required';
}

function managedWorkspaceAuthorityDrift(
  workspaceId: string,
  context: Pick<HarnessHealthDrift, 'taskIds' | 'executionSessionIds'> = {},
): HarnessHealthDrift | null {
  const metadata = getSessionWorkspaceMetadataForRecovery(workspaceId);
  if (!metadata) {
    return {
      code: 'WORKSPACE_METADATA_MISSING',
      message: 'Lifecycle authority points at a managed workspace whose durable metadata cannot be read.',
      ...context,
      workspaceIds: [workspaceId],
      nextAction: 'Fail closed and recover the exact managed workspace authority before lifecycle mutation.',
    };
  }

  const inspection = inspectWorkspaceRecovery(workspaceId);
  if (inspection.disposition === 'stale-registry') {
    return {
      code: 'WORKSPACE_ROOT_OR_IDENTITY_INVALID',
      message: 'Managed workspace metadata exists, but its root, project root, or Git identity cannot be proven valid.',
      ...context,
      workspaceIds: [workspaceId],
      nextAction: 'Inspect the exact managed workspace and recover its root/identity before lifecycle mutation.',
    };
  }
  return null;
}

function baselineHarnessMetadata() {
  return {
    policy: { version: HARNESS_POLICY_VERSION, freshness: 'unavailable', policyId: null },
    context: { freshness: 'missing', handle: null },
    strategy: { version: HARNESS_STRATEGY_VERSION, mode: 'shadow', status: 'baseline', regressionState: 'unknown' },
    recovery: { pendingOperationCount: 0 },
  };
}

function blockedHarnessHealth(scope: string, drift: HarnessHealthDrift[], extra: Record<string, any> = {}) {
  return {
    version: CHATGPT_HARNESS_HEALTH_VERSION,
    scope,
    status: 'blocked',
    mode: 'chatgpt-only',
    ...baselineHarnessMetadata(),
    drift: drift.slice(0, 20),
    hardBlockers: drift.map((entry) => entry.code).slice(0, 20),
    ...extra,
  };
}

function taskHarnessHealth(state: AppState, taskId: string) {
  const task = findTaskByIdentifier(state, taskId);
  if (!task) {
    return blockedHarnessHealth('task', [{
      code: 'TASK_SELECTOR_NOT_FOUND',
      message: 'The requested task selector did not resolve to a durable task.',
      taskIds: [taskId],
      nextAction: 'Correct the task selector before making lifecycle decisions.',
    }], { task: null });
  }

  const claim = activeHealthClaim(task);
  const activeQuery = queryExecutionSessions({ taskId: task.id, status: 'active', limit: 20 });
  const active = activeQuery.sessions;
  const drift: HarnessHealthDrift[] = [];
  if (activeQuery.truncated || active.length > 1) {
    drift.push({
      code: 'MULTIPLE_ACTIVE_EXECUTIONS_FOR_TASK',
      message: 'More than one active execution is authoritative-looking for the same task.',
      taskIds: [task.id],
      workspaceIds: [...new Set(active.map((entry) => entry.workspaceId).filter(Boolean) as string[])].slice(0, 20),
      executionSessionIds: active.map((entry) => entry.id).slice(0, 20),
      nextAction: 'Use lifecycle reconciliation; do not select an execution heuristically.',
    });
  }
  const selected = active.length === 1 ? active[0] : null;
  if (!claim && selected) {
    drift.push({
      code: 'ACTIVE_EXECUTION_WITHOUT_ACTIVE_CLAIM',
      message: 'A durable active execution exists after active task-claim authority disappeared.',
      taskIds: [task.id],
      workspaceIds: selected.workspaceId ? [selected.workspaceId] : [],
      executionSessionIds: [selected.id],
      nextAction: 'Enter scoped lifecycle reconciliation or recovery; preserve workspace WIP.',
    });
  }
  if (claim && !active.some((entry) => entry.workspaceId === claim.workspaceId)) {
    drift.push({
      code: 'ACTIVE_CLAIM_WITHOUT_ACTIVE_EXECUTION',
      message: 'The task has an active claim but no active execution bound to its claimed workspace.',
      taskIds: [task.id],
      workspaceIds: [claim.workspaceId],
      nextAction: 'Reconcile the claim epoch before creating replacement execution authority.',
    });
  }
  if (claim && selected) {
    const executionEpoch = getExecutionSessionOwnershipEpoch(selected.id).ownershipEpochId;
    if (selected.workspaceId !== claim.workspaceId || (claim.ownershipEpochId && executionEpoch !== claim.ownershipEpochId)) {
      drift.push({
        code: 'CLAIM_EXECUTION_OWNERSHIP_MISMATCH',
        message: 'Claim workspace or ownership epoch does not match the active execution.',
        taskIds: [task.id],
        workspaceIds: [claim.workspaceId, selected.workspaceId].filter(Boolean) as string[],
        executionSessionIds: [selected.id],
        nextAction: 'Use scoped lifecycle reconciliation; do not infer authority from timestamps.',
      });
    }
  }

  const authoritativeWorkspaceIds = [...new Set([
    claim?.workspaceId,
    selected?.workspaceId,
  ].filter(Boolean) as string[])];
  for (const authoritativeWorkspaceId of authoritativeWorkspaceIds) {
    const workspaceDrift = managedWorkspaceAuthorityDrift(authoritativeWorkspaceId, {
      taskIds: [task.id],
      executionSessionIds: selected && selected.workspaceId === authoritativeWorkspaceId ? [selected.id] : [],
    });
    if (workspaceDrift) drift.push(workspaceDrift);
  }

  const pending = pendingHealthOperations(selected);
  if (pending.operationIds.length > 0) {
    drift.push({
      code: 'PENDING_DURABLE_OPERATIONS',
      message: 'The selected execution still has unresolved durable operations.',
      taskIds: [task.id],
      executionSessionIds: selected ? [selected.id] : [],
      operationIds: pending.operationIds,
      nextAction: 'Inspect durable job outcomes before rotating or replacing execution authority.',
    });
  }

  let actionableWorkspaceIds: string[] = [];
  let workspaceDiscoveryTruncated = false;
  if (!claim) {
    const discovery = findSessionWorkspaceRecoveryCandidatesForTask(task.projectId, task.displayId || task.id, 50);
    workspaceDiscoveryTruncated = discovery.truncated;
    actionableWorkspaceIds = discovery.exactMatches
      .map((entry) => entry.workspaceId)
      .filter(actionableRecoveryWorkspace)
      .slice(0, 20);
    if (workspaceDiscoveryTruncated) {
      drift.push({
        code: 'TASK_WORKSPACE_DISCOVERY_TRUNCATED',
        message: 'Bounded workspace discovery cannot prove a unique recovery state for the task.',
        taskIds: [task.id],
        workspaceIds: discovery.exactMatches.map((entry) => entry.workspaceId).slice(0, 20),
        nextAction: 'Use explicit workspace recovery selection; do not treat the task as idle.',
      });
    } else if (actionableWorkspaceIds.length > 0) {
      drift.push({
        code: actionableWorkspaceIds.length > 1 ? 'MULTIPLE_ACTIONABLE_TASK_WORKSPACES' : 'ACTIONABLE_WIP_WITHOUT_ACTIVE_CLAIM',
        message: actionableWorkspaceIds.length > 1
          ? 'Multiple exact task workspaces contain actionable recovery state.'
          : 'Exact task-compatible workspace state remains actionable after claim loss.',
        taskIds: [task.id],
        workspaceIds: actionableWorkspaceIds,
        nextAction: actionableWorkspaceIds.length > 1
          ? 'Resolve workspace ambiguity explicitly before recovery.'
          : 'Recover the exact workspace and preserve its WIP.',
      });
    }
  }

  const envelope = claim && selected && selected.workspaceId === claim.workspaceId && drift.length === 0
    ? buildChatGptHarnessEnvelope(state, task)
    : null;
  const result = {
    version: CHATGPT_HARNESS_HEALTH_VERSION,
    scope: 'task',
    status: drift.some((entry) => entry.code !== 'PENDING_DURABLE_OPERATIONS') ? 'blocked' : selected || claim ? 'active' : 'idle',
    mode: 'chatgpt-only',
    task: { id: task.id, displayId: task.displayId, status: task.status, projectId: task.projectId },
    claim: claim ? { present: true, ...claim } : { present: false, workspaceId: null, ownershipEpochId: null, expiresAt: null },
    execution: executionHealthView(selected),
    checkpoint: {
      freshness: envelope?.execution?.checkpointFreshness || (pending.checkpoint ? 'present' : 'missing'),
      ref: envelope?.execution?.checkpointRef || pending.checkpoint?.id || null,
    },
    policy: envelope?.policy || { version: HARNESS_POLICY_VERSION, freshness: 'unavailable', policyId: null },
    context: envelope?.context || { freshness: selected?.contextHandle ? 'present' : 'missing', handle: selected?.contextHandle || null },
    strategy: envelope ? { ...envelope.strategy, regressionState: 'unknown' } : { version: HARNESS_STRATEGY_VERSION, mode: 'shadow', status: 'baseline', regressionState: 'unknown' },
    recovery: { pendingOperationCount: pending.operationIds.length, actionableWorkspaceIds, workspaceDiscoveryTruncated },
    drift: drift.slice(0, 20),
    hardBlockers: drift.map((entry) => entry.code).slice(0, 20),
  };
  return result;
}

function workspaceHarnessHealth(state: AppState, workspaceId: string, expectedTaskId = '') {
  const activeQuery = queryExecutionSessions({ workspaceId, status: 'active', limit: 20 });
  const active = activeQuery.sessions;
  if (activeQuery.truncated || active.length > 1) {
    return blockedHarnessHealth('workspace', [{
      code: 'MULTIPLE_ACTIVE_EXECUTIONS_FOR_WORKSPACE',
      message: 'The workspace has multiple active task execution sessions.',
      workspaceIds: [workspaceId],
      executionSessionIds: active.map((entry) => entry.id).slice(0, 20),
      taskIds: [...new Set(active.map((entry) => entry.taskId).filter(Boolean) as string[])].slice(0, 20),
      nextAction: 'Use lifecycle reconciliation; never select one execution by age.',
    }], { execution: { stage: 'ambiguous', sessionId: null, workspaceId }, aggregate: { activeExecutionCount: activeQuery.total, truncated: activeQuery.truncated } });
  }

  const session = active[0] || null;
  const tasks = getTasks();
  const activeClaimTasks = tasks.filter((task) => activeHealthClaim(task)?.workspaceId === workspaceId);
  const drift: HarnessHealthDrift[] = [];
  if (activeClaimTasks.length > 1) {
    drift.push({
      code: 'MULTIPLE_ACTIVE_CLAIMS_FOR_WORKSPACE',
      message: 'Multiple active task claims point at the same workspace.',
      workspaceIds: [workspaceId],
      taskIds: activeClaimTasks.map((task) => task.id).slice(0, 20),
      nextAction: 'Reconcile claim authority before any workspace mutation.',
    });
  }
  const task = session?.taskId ? findTaskByIdentifier(state, session.taskId) : activeClaimTasks.length === 1 ? activeClaimTasks[0] : null;
  const claim = task ? activeHealthClaim(task) : null;
  if (session && !claim) {
    drift.push({
      code: 'ACTIVE_EXECUTION_WITHOUT_ACTIVE_CLAIM',
      message: 'A durable active execution exists for the workspace without matching active claim authority.',
      taskIds: session.taskId ? [session.taskId] : [],
      workspaceIds: [workspaceId],
      executionSessionIds: [session.id],
      nextAction: 'Enter scoped lifecycle reconciliation; preserve workspace WIP.',
    });
  }
  if (!session && activeClaimTasks.length === 1) {
    drift.push({
      code: 'ACTIVE_CLAIM_WITHOUT_ACTIVE_EXECUTION',
      message: 'An active claim points at the workspace but no active execution exists.',
      taskIds: [activeClaimTasks[0].id],
      workspaceIds: [workspaceId],
      nextAction: 'Reconcile the claim epoch before establishing one replacement execution.',
    });
  }
  if (expectedTaskId) {
    const expectedTask = findTaskByIdentifier(state, expectedTaskId);
    if (!expectedTask || (session?.taskId && session.taskId !== expectedTask.id) || (claim && task?.id !== expectedTask.id)) {
      drift.push({
        code: 'HEALTH_SELECTOR_CONFLICT',
        message: 'Task and workspace selectors resolve to different lifecycle identities.',
        taskIds: [expectedTask?.id || expectedTaskId, session?.taskId || task?.id].filter(Boolean) as string[],
        workspaceIds: [workspaceId],
        executionSessionIds: session ? [session.id] : [],
        nextAction: 'Correct the selectors; health will not compose authority across identities.',
      });
    }
  }
  if (claim && session) {
    const executionEpoch = getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId;
    if (session.taskId !== task?.id || (claim.ownershipEpochId && executionEpoch !== claim.ownershipEpochId)) {
      drift.push({
        code: 'CLAIM_EXECUTION_OWNERSHIP_MISMATCH',
        message: 'Claim task or ownership epoch does not match the active workspace execution.',
        taskIds: [task?.id, session.taskId].filter(Boolean) as string[],
        workspaceIds: [workspaceId],
        executionSessionIds: [session.id],
        nextAction: 'Use scoped lifecycle reconciliation before mutation.',
      });
    }
  }
  const workspaceAuthorityIssue = managedWorkspaceAuthorityDrift(workspaceId, {
    taskIds: task?.id ? [task.id] : session?.taskId ? [session.taskId] : activeClaimTasks.map((entry) => entry.id).slice(0, 20),
    executionSessionIds: session ? [session.id] : [],
  });
  if (workspaceAuthorityIssue) drift.push(workspaceAuthorityIssue);

  const pending = pendingHealthOperations(session);
  if (pending.operationIds.length > 0) {
    drift.push({
      code: 'PENDING_DURABLE_OPERATIONS',
      message: 'The workspace execution has unresolved durable operations.',
      workspaceIds: [workspaceId],
      executionSessionIds: session ? [session.id] : [],
      operationIds: pending.operationIds,
      nextAction: 'Inspect durable job outcomes before recovery or ownership rotation.',
    });
  }
  let actionableWorkspace = false;
  if (!claim && !session && !workspaceAuthorityIssue) {
    try {
      actionableWorkspace = actionableRecoveryWorkspace(workspaceId);
    } catch {
      actionableWorkspace = false;
    }
    if (actionableWorkspace) {
      drift.push({
        code: 'ACTIONABLE_WIP_WITHOUT_ACTIVE_CLAIM',
        message: 'The selected workspace still carries actionable recovery state without active claim authority.',
        workspaceIds: [workspaceId],
        nextAction: 'Recover or reconcile this exact workspace; preserve WIP and do not treat it as idle.',
      });
    }
  }
  return {
    version: CHATGPT_HARNESS_HEALTH_VERSION,
    scope: 'workspace',
    status: drift.some((entry) => entry.code !== 'PENDING_DURABLE_OPERATIONS') ? 'blocked' : session || claim ? 'active' : 'idle',
    mode: 'chatgpt-only',
    task: task ? { id: task.id, displayId: task.displayId, status: task.status, projectId: task.projectId } : null,
    claim: claim ? { present: true, ...claim } : { present: false, workspaceId: null, ownershipEpochId: null, expiresAt: null },
    execution: executionHealthView(session),
    checkpoint: { freshness: pending.checkpoint ? 'present' : 'missing', ref: pending.checkpoint?.id || null },
    ...baselineHarnessMetadata(),
    recovery: { pendingOperationCount: pending.operationIds.length },
    drift: drift.slice(0, 20),
    hardBlockers: drift.map((entry) => entry.code).slice(0, 20),
  };
}

function projectHarnessHealth(state: AppState, args: Record<string, any>) {
  let project: any = null;
  try {
    project = findProjectByIdentifier(state, args);
  } catch (error: any) {
    return blockedHarnessHealth('project-aggregate', [{
      code: 'PROJECT_SELECTOR_AMBIGUOUS',
      message: String(error?.message || 'Project selectors are ambiguous.'),
      nextAction: 'Provide one exact project identifier before using aggregate lifecycle health.',
    }], { aggregate: { activeExecutionCount: 0, activeClaimCount: 0, actionableWorkspaceCount: 0, pendingOperationCount: 0, driftCount: 1, truncated: false } });
  }
  if (!project) {
    return blockedHarnessHealth('project-aggregate', [{
      code: 'PROJECT_SELECTOR_NOT_FOUND',
      message: 'The supplied project selector did not resolve to a project.',
      nextAction: 'Correct the project selector before making lifecycle decisions.',
    }], { aggregate: { activeExecutionCount: 0, activeClaimCount: 0, actionableWorkspaceCount: 0, pendingOperationCount: 0, driftCount: 1, truncated: false } });
  }

  const allProjectTasks = getTasks().filter((task) => task.projectId === project.id);
  const boundedTaskPresentation = allProjectTasks.slice(0, 100);
  const projectTasksById = new Map(allProjectTasks.map((task) => [task.id, task]));
  const activeClaims = allProjectTasks.map((task) => ({ task, claim: activeHealthClaim(task) })).filter((entry) => Boolean(entry.claim));
  const executions = queryExecutionSessions({ projectId: project.id, status: 'active', limit: 50 });
  const drift: HarnessHealthDrift[] = [];
  const byTask = new Map<string, ExecutionSessionRecord[]>();
  const byWorkspace = new Map<string, ExecutionSessionRecord[]>();
  let pendingOperationCount = 0;

  for (const session of executions.sessions) {
    if (session.taskId) byTask.set(session.taskId, [...(byTask.get(session.taskId) || []), session]);
    if (session.workspaceId) byWorkspace.set(session.workspaceId, [...(byWorkspace.get(session.workspaceId) || []), session]);
    const pending = pendingHealthOperations(session);
    pendingOperationCount += pending.operationIds.length;
    const task = session.taskId ? projectTasksById.get(session.taskId) || null : null;
    const claim = task ? activeHealthClaim(task) : null;
    if (!claim || claim.workspaceId !== session.workspaceId) {
      drift.push({
        code: 'ACTIVE_EXECUTION_WITHOUT_ACTIVE_CLAIM',
        message: 'Project aggregate found an active execution without matching active claim authority.',
        taskIds: session.taskId ? [session.taskId] : [],
        workspaceIds: session.workspaceId ? [session.workspaceId] : [],
        executionSessionIds: [session.id],
        nextAction: 'Use scoped lifecycle reconciliation for the affected task/workspace.',
      });
    } else if (claim.ownershipEpochId && getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId !== claim.ownershipEpochId) {
      drift.push({
        code: 'CLAIM_EXECUTION_OWNERSHIP_MISMATCH',
        message: 'Project aggregate found an ownership epoch mismatch.',
        taskIds: [task!.id],
        workspaceIds: [claim.workspaceId],
        executionSessionIds: [session.id],
        nextAction: 'Use scoped lifecycle reconciliation; do not infer ownership.',
      });
    }
    if (pending.operationIds.length > 0) {
      drift.push({
        code: 'PENDING_DURABLE_OPERATIONS',
        message: 'Project aggregate found unresolved durable execution work.',
        taskIds: session.taskId ? [session.taskId] : [],
        workspaceIds: session.workspaceId ? [session.workspaceId] : [],
        executionSessionIds: [session.id],
        operationIds: pending.operationIds,
        nextAction: 'Inspect the durable operation outcome before ownership changes.',
      });
    }
  }

  for (const entry of activeClaims) {
    const matching = executions.sessions.filter((session) => session.taskId === entry.task.id && session.workspaceId === entry.claim!.workspaceId);
    if (matching.length === 0) {
      drift.push({
        code: 'ACTIVE_CLAIM_WITHOUT_ACTIVE_EXECUTION',
        message: 'Project aggregate found an active claim with no matching active execution.',
        taskIds: [entry.task.id],
        workspaceIds: [entry.claim!.workspaceId],
        nextAction: 'Reconcile the claim epoch before creating replacement execution authority.',
      });
    }
  }
  const authoritativeWorkspaceContexts = new Map<string, { taskIds: Set<string>; executionSessionIds: Set<string> }>();
  const rememberAuthoritativeWorkspace = (workspaceId: string, taskId?: string | null, executionSessionId?: string | null) => {
    if (!workspaceId) return;
    const existing = authoritativeWorkspaceContexts.get(workspaceId) || { taskIds: new Set<string>(), executionSessionIds: new Set<string>() };
    if (taskId) existing.taskIds.add(taskId);
    if (executionSessionId) existing.executionSessionIds.add(executionSessionId);
    authoritativeWorkspaceContexts.set(workspaceId, existing);
  };
  for (const entry of activeClaims) rememberAuthoritativeWorkspace(entry.claim!.workspaceId, entry.task.id, null);
  for (const session of executions.sessions) rememberAuthoritativeWorkspace(session.workspaceId || '', session.taskId, session.id);
  for (const [workspaceId, context] of authoritativeWorkspaceContexts) {
    const workspaceDrift = managedWorkspaceAuthorityDrift(workspaceId, {
      taskIds: [...context.taskIds].slice(0, 20),
      executionSessionIds: [...context.executionSessionIds].slice(0, 20),
    });
    if (workspaceDrift) drift.push(workspaceDrift);
  }

  for (const [taskId, sessions] of byTask) {
    if (sessions.length > 1) drift.push({
      code: 'MULTIPLE_ACTIVE_EXECUTIONS_FOR_TASK',
      message: 'Project aggregate found multiple active executions for one task.',
      taskIds: [taskId],
      workspaceIds: [...new Set(sessions.map((entry) => entry.workspaceId).filter(Boolean) as string[])],
      executionSessionIds: sessions.map((entry) => entry.id),
      nextAction: 'Use lifecycle reconciliation; do not choose one execution heuristically.',
    });
  }
  for (const [workspaceId, sessions] of byWorkspace) {
    if (sessions.length > 1) drift.push({
      code: 'MULTIPLE_ACTIVE_EXECUTIONS_FOR_WORKSPACE',
      message: 'Project aggregate found multiple active executions for one workspace.',
      taskIds: [...new Set(sessions.map((entry) => entry.taskId).filter(Boolean) as string[])],
      workspaceIds: [workspaceId],
      executionSessionIds: sessions.map((entry) => entry.id),
      nextAction: 'Use lifecycle reconciliation; do not choose one execution heuristically.',
    });
  }

  const registry = listSessionWorkspaceMetadataForRecovery(project.id, 50);
  const workspaceInspectionLimit = 10;
  const workspaceInspectionCandidates = registry.workspaces.slice(0, workspaceInspectionLimit);
  const actionableWorkspaceIds = workspaceInspectionCandidates
    .map((workspace) => workspace.workspaceId)
    .filter(actionableRecoveryWorkspace)
    .slice(0, 20);
  const truncated = executions.truncated
    || registry.truncated
    || registry.workspaces.length > workspaceInspectionCandidates.length
    || allProjectTasks.length > boundedTaskPresentation.length;
  if (truncated) drift.push({
    code: 'PROJECT_LIFECYCLE_SCAN_TRUNCATED',
    message: 'Project aggregate exceeded a bounded lifecycle scan and cannot prove a complete all-clear.',
    nextAction: 'Narrow health to an explicit task/workspace or inspect additional bounded pages.',
  });

  return {
    version: CHATGPT_HARNESS_HEALTH_VERSION,
    scope: 'project-aggregate',
    status: drift.length > 0 ? 'blocked' : executions.total > 0 || activeClaims.length > 0 || actionableWorkspaceIds.length > 0 ? 'active' : 'idle',
    mode: 'chatgpt-only',
    ...baselineHarnessMetadata(),
    project: { id: project.id, name: project.name },
    aggregate: {
      activeExecutionCount: executions.total,
      activeClaimCount: activeClaims.length,
      actionableWorkspaceCount: actionableWorkspaceIds.length,
      pendingOperationCount,
      driftCount: drift.length,
      truncated,
      executionSessionIds: executions.sessions.map((entry) => entry.id).slice(0, 20),
      taskIds: [...new Set([...activeClaims.map((entry) => entry.task.id), ...executions.sessions.map((entry) => entry.taskId).filter(Boolean) as string[]])].slice(0, 20),
      workspaceIds: [...new Set([...activeClaims.map((entry) => entry.claim!.workspaceId), ...executions.sessions.map((entry) => entry.workspaceId).filter(Boolean) as string[], ...actionableWorkspaceIds])].slice(0, 20),
    },
    recovery: { pendingOperationCount },
    drift: drift.slice(0, 20),
    hardBlockers: drift.map((entry) => entry.code).slice(0, 20),
  };
}

export function getChatGptHarnessHealthSnapshot(state: AppState, args: Record<string, any> = {}): Record<string, any> {
  const taskId = cleanHealthSelector(args.taskId);
  const workspaceId = cleanHealthSelector(args.workspaceId);
  if (workspaceId) return workspaceHarnessHealth(state, workspaceId, taskId);
  if (taskId) return taskHarnessHealth(state, taskId);
  const hasProjectSelector = ['projectId', 'projectName', 'repo', 'repoUrl', 'localPath'].some((key) => cleanHealthSelector(args[key]));
  if (hasProjectSelector) return projectHarnessHealth(state, args);
  return {
    version: CHATGPT_HARNESS_HEALTH_VERSION,
    scope: 'runtime',
    status: 'idle',
    mode: 'chatgpt-only',
    ...baselineHarnessMetadata(),
    execution: { stage: 'unclaimed', sessionId: null, workspaceId: null, ownershipEpochId: null },
    checkpoint: { freshness: 'missing', ref: null },
    aggregate: { activeExecutionCount: 0, activeClaimCount: 0, actionableWorkspaceCount: 0, pendingOperationCount: 0, driftCount: 0, truncated: false },
    drift: [],
    hardBlockers: [],
  };
}

export function getWorkflowHealth(state: AppState, args: Record<string, any> = {}): Record<string, any> {
  const recommendations: string[] = [];
  const responseMode = resolveWorkflowHealthResponseMode(args);
  const startedAt = nodePerformance.now();
  let phaseStartedAt = startedAt;
  const phaseMs = () => {
    const elapsed = nodePerformance.now() - phaseStartedAt;
    phaseStartedAt = nodePerformance.now();
    return Math.round(elapsed * 100) / 100;
  };
  const windowMs = numberArg(args.windowMs, 10 * 60 * 1000);
  const catalog = getCapabilityCatalog();
  const advertisedTools = getMcpToolList(catalog.mcpProfile.active);
  const advertisedNames = new Set(advertisedTools.map((tool) => tool.name));
  const advertisedDefinitions = catalog.tools.filter((tool: any) => advertisedNames.has(tool.name));
  const catalogMs = phaseMs();
  const diagnostics = getDevFlowDiagnostics({ windowMs });
  const diagnosticsMs = phaseMs();
  const gitProbe = probe(() => getGitStatus(state, args));
  const gitMs = phaseMs();
  const search = getLocalSearchRuntimeStatus();
  const searchMs = phaseMs();
  const sloPerformance = evaluatePerformanceSlo(Array.isArray(diagnostics?.tools?.topTools) ? diagnostics.tools.topTools : []);
  const recovery = getRecoveryStatus();
  const harness = getChatGptHarnessHealthSnapshot(state, args);
  const historicalPerformance = diagnostics?.performanceHistory || {
    windowMs,
    minSamples: 5,
    regressionThreshold: 0.15,
    comparisons: [],
    regressions: [],
    improvements: [],
    stable: [],
    insufficientSamples: [],
  };
  const sloMs = phaseMs();
  const harnessMs = phaseMs();

  const git = gitProbe.ok === true ? {
    ok: true,
    clean: Array.isArray(gitProbe.value.files) && gitProbe.value.files.length === 0 && !gitProbe.value.operation?.blocked,
    changedFileCount: Array.isArray(gitProbe.value.files) ? gitProbe.value.files.length : 0,
    changedFiles: Array.isArray(gitProbe.value.files) ? gitProbe.value.files : [],
    operation: gitProbe.value.operation || { blocked: false, code: null, kind: null, marker: null, unmergedPathCount: 0, unmergedPaths: [] },
  } : {
    ok: false,
    clean: false,
    error: gitProbe.error,
  };

  if (!git.ok) recommendations.push('Git status is unavailable; check projectId/localPath and whether the project is a git repository.');
  if (git.ok && git.operation?.blocked) recommendations.push(`Git ${git.operation.kind || 'operation'} state is unresolved (${git.operation.unmergedPathCount || 0} unmerged paths); do not start unrelated write/integration work until the operation is resolved or aborted.`);
  if (git.ok && !git.clean && !git.operation?.blocked) recommendations.push('Working tree has local changes; review or commit them before starting unrelated work.');

  const queueDepth = Number(diagnostics?.mcp?.queueDepth || 0);
  const runtimeSupervisor = diagnostics?.runtimeSupervisor;
  const isolation = diagnostics?.isolation || {
    waits: { workspaceLockWait: { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 }, capacityWait: { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 }, blockerReasons: {} },
    phases: {
      admissionWait: { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 },
      queueWait: { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 },
      workspaceLockWait: { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 },
      capacityWait: { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 },
      execution: { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 },
      responseHandoff: { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 },
    },
    capacity: { active: 0, limit: 0, saturated: false },
    workspaces: { known: 0, active: 0, integrationRequired: 0 },
    integrations: { conflicts: 0, pendingConflicts: 0 },
    activeResources: { workspaces: 0, sharedRepos: 0, other: 0 },
  };
  const failedJobs = Number(diagnostics?.mcp?.metrics?.failedJobs || 0);
  const failedJobSummaries = Array.isArray(diagnostics?.mcp?.metrics?.failures) ? diagnostics.mcp.metrics.failures.slice(0, 10) : [];
  const failedJobGroups = summarizeFailedJobGroups(failedJobSummaries);
  const durableJobs = diagnostics?.mcp?.metrics?.durable || { queued: 0, running: 0, healthyRunning: 0, detached: 0, failed: 0, cancelled: 0, recovered: 0, staleRunning: 0, fencedLateWrites: 0, oldestLeaseAgeMs: 0 };
  const staleAgentRuns = Number(diagnostics?.agents?.staleCount || 0);
  const duplicateBursts = Array.isArray(diagnostics?.tools?.duplicateBursts) ? diagnostics.tools.duplicateBursts.length : 0;
  const repoCaches = Array.isArray(diagnostics?.repoCaches?.domains) ? diagnostics.repoCaches.domains : [];
  const compactRepoCaches = {
    domains: repoCaches
      .filter((domain: any) => ['local-file-search', 'repo-inspection-index', 'repo-context-bundle'].includes(domain?.name))
      .slice(0, 3)
      .map((domain: any) => ({
        name: domain.name,
        hits: Number(domain.hits || 0),
        misses: Number(domain.misses || 0),
        hitRate: Number(domain.hitRate || 0),
        invalidations: Number(domain.invalidations || 0),
        lastInvalidationReason: domain.lastInvalidationReason,
        lastInvalidatedAt: domain.lastInvalidatedAt,
        lineageToken: domain.lineageToken,
      })),
  };
  if (runtimeSupervisor?.api?.status === 'healthy' && (runtimeSupervisor?.tunnel?.status === 'degraded' || runtimeSupervisor?.tunnel?.status === 'down')) {
    recommendations.push(`Public zrok route is ${runtimeSupervisor.tunnel.status} while the local API is healthy; inspect zrok service/share state and runtime supervisor public-probe evidence.`);
  }
  if (queueDepth > 0) recommendations.push('MCP tool jobs are queued; inspect job status/log before starting conflicting repo work.');
  if (Number(durableJobs.staleRunning || 0) > 0) recommendations.push('A stale MCP tool job lease was detected in durable state; inspect recovery classification before retrying the job.');
  if (isolation.capacity?.saturated) recommendations.push('Verification capacity is saturated; queued verify work is capacity-limited rather than blocked by a workspace correctness lock.');
  if (failedJobs > 0) {
    const groupedTools = failedJobGroups.map((group) => `${group.toolName}=${group.count}`).join(', ');
    recommendations.push(groupedTools
      ? `Recent tool jobs include failures grouped by tool (${groupedTools}); inspect diagnostics.failedJobGroups before retrying broad work.`
      : 'Recent tool jobs include failures; inspect logs/results before retrying broad work.');
  }
  if (staleAgentRuns > 0) recommendations.push('There are stale agent runs; cancel or retry them before starting more agent-owned work.');
  if (duplicateBursts > 0) recommendations.push('Duplicate tool bursts detected; prefer get_repo_context_bundle before repeated reads/searches.');
  if (!recovery.lastVerifiedGoodBackup) recommendations.push('No verified recovery snapshot exists yet; create one from Settings or export a backup.');
  if (recovery.failureReason) recommendations.push(`Recovery verification needs attention: ${recovery.failureReason.code} — ${recovery.failureReason.reason}`);
  if (sloPerformance.regressions.length > 0) {
    const slow = sloPerformance.regressions.slice(0, 3).map((entry) => `${entry.toolName} p95=${entry.p95DurationMs}ms>${entry.budgetMs}ms`).join(', ');
    recommendations.push(`Performance SLO regression detected: ${slow}.`);
  }
  if (historicalPerformance.regressions.length > 0) {
    const slow = historicalPerformance.regressions
      .slice(0, 3)
      .map((entry: any) => `${entry.toolName} p95 ${entry.baseline?.p95DurationMs}ms→${entry.current?.p95DurationMs}ms (${entry.deltaPercent}%)`)
      .join(', ');
    recommendations.push(`Historical performance regression detected: ${slow}.`);
  }

  const keyToolsPresent = {
    get_repo_context_bundle: catalog.tools.some((tool: any) => tool.name === 'get_repo_context_bundle'),
    move_task_to_status: catalog.tools.some((tool: any) => tool.name === 'move_task_to_status'),
    commit_git_changes: catalog.tools.some((tool: any) => tool.name === 'commit_git_changes'),
    devflow_health_check: catalog.tools.some((tool: any) => tool.name === 'devflow_health_check'),
  };
  const hasErrors = !git.ok || Boolean(git.ok && git.operation?.blocked) || catalog.tools.length === 0;
  const hasWarnings = recommendations.some((recommendation) => !recommendation.startsWith('No verified recovery snapshot exists yet;'));
  const status = hasErrors ? 'error' : hasWarnings ? 'warning' : 'ok';
  const healthEventProjectId = typeof args.projectId === 'string' ? args.projectId : undefined;
  const healthEventKey = healthEventProjectId || 'global';
  const healthEventSignature = status === 'ok'
    ? ''
    : [
        status,
        failedJobs,
        staleAgentRuns,
        Number(durableJobs.staleRunning || 0),
        sloPerformance.regressions.length,
        git.ok ? git.operation?.code || '' : 'git-unavailable',
        git.ok ? git.operation?.kind || '' : '',
        git.ok ? git.operation?.unmergedPathCount || 0 : 0,
      ].join(':');
  const priorHealthEventSignature = lastHealthEventSignatures.get(healthEventKey) || '';
  if (healthEventSignature && healthEventSignature !== priorHealthEventSignature) {
    publishServerEvent('health.regression', {
      projectId: healthEventProjectId,
      status,
      reason: `failedJobs=${failedJobs};staleAgents=${staleAgentRuns};staleJobs=${Number(durableJobs.staleRunning || 0)};slo=${sloPerformance.regressions.length};gitBlocker=${git.ok ? git.operation?.code || 'none' : 'unavailable'};gitKind=${git.ok ? git.operation?.kind || 'none' : 'unknown'};unmerged=${git.ok ? git.operation?.unmergedPathCount || 0 : 0}`,
    });
  }
  if (healthEventSignature) lastHealthEventSignatures.set(healthEventKey, healthEventSignature);
  else lastHealthEventSignatures.delete(healthEventKey);

  const emergencyOperations = healthEventProjectId
    ? listLifecycleEmergencyOperations({ projectId: healthEventProjectId, limit: 20 })
    : [];
  const unresolvedEmergencyOperations = emergencyOperations.filter((entry) => entry.status === 'active' || entry.status === 'partial');
  const breakGlassHealth = {
    unresolvedCount: unresolvedEmergencyOperations.length,
    recent: emergencyOperations.slice(0, 10).map((entry) => ({
      id: entry.id,
      action: entry.action,
      taskId: entry.taskId,
      workspaceId: entry.workspaceId,
      status: entry.status,
      actorLabel: entry.actorLabel,
      wipDisposition: entry.wipDisposition,
      failure: entry.failure,
      updatedAt: entry.updatedAt,
    })),
  };

  const fullResult = {
    ok: status !== 'error',
    status,
    generatedAt: new Date().toISOString(),
    checks: { git: git.ok, capabilityCatalog: advertisedTools.length > 0, diagnostics: true, recovery: Boolean(recovery.lastVerifiedGoodBackup) && !recovery.failureReason },
    capabilities: {
      contractVersion: catalog.contractVersion,
      toolCount: advertisedTools.length,
      backendToolCount: catalog.tools.length,
      lightweightToolCount: advertisedDefinitions.filter((tool: any) => tool.lightweight).length,
      asyncToolCount: advertisedDefinitions.filter((tool: any) => tool.executionPolicy?.mode === 'job').length,
      search,
      keyToolsPresent,
    },
    git,
    diagnostics: {
      queueDepth,
      failedJobs,
      failedJobGroups,
      failedJobSummaries,
      durableJobs,
      staleAgentRuns,
      duplicateBursts,
      repoCaches: { domains: repoCaches },
      performance: { ...sloPerformance, history: historicalPerformance },
      telemetryPersistence: diagnostics?.telemetryPersistence,
      isolation,
      recovery,
      breakGlass: breakGlassHealth,
      runtimeSupervisor,
      harness,
    },
    performance: {
      totalMs: Math.round((nodePerformance.now() - startedAt) * 100) / 100,
      phases: { catalogMs, diagnosticsMs, gitMs, searchMs, sloMs, harnessMs },
    },
    recommendations,
  };

  if (responseMode === 'full') return fullResult;

  const compactGit = git.ok
    ? {
        ok: true,
        clean: git.clean,
        changedFileCount: git.changedFileCount,
        operation: {
          blocked: Boolean(git.operation?.blocked),
          code: git.operation?.code || null,
          kind: git.operation?.kind || null,
          unmergedPathCount: Number(git.operation?.unmergedPathCount || 0),
        },
      }
    : { ok: false, clean: false, error: git.error };
  const compactRegressions = sloPerformance.regressions.slice(0, 5).map((entry: any) => ({
    toolName: entry.toolName,
    p50DurationMs: entry.p50DurationMs,
    p95DurationMs: entry.p95DurationMs,
    budgetMs: entry.budgetMs,
    status: entry.status,
  }));

  return {
    ok: fullResult.ok,
    status: fullResult.status,
    generatedAt: fullResult.generatedAt,
    checks: fullResult.checks,
    git: compactGit,
    queue: {
      depth: queueDepth,
      capacity: isolation.capacity,
      durableJobs: {
        queued: Number(durableJobs.queued || 0),
        running: Number(durableJobs.running || 0),
        healthyRunning: Number(durableJobs.healthyRunning || 0),
        staleRunning: Number(durableJobs.staleRunning || 0),
        detached: Number(durableJobs.detached || 0),
      },
    },
    failures: {
      total: failedJobs,
      groups: compactFailureGroups(failedJobGroups),
    },
    regressions: compactRegressions,
    harness,
    runtime: {
      repoCaches: compactRepoCaches,
      search: {
        backend: search.backend,
        ripgrepSource: search.ripgrepSource,
        fallbackAvailable: search.fallbackAvailable,
        fallbackReason: search.fallbackReason,
        circuitOpen: search.circuitOpen,
        infrastructureFailureCount: search.infrastructureFailureCount,
      },
      capabilities: {
        contractVersion: catalog.contractVersion,
        toolCount: advertisedTools.length,
        backendToolCount: catalog.tools.length,
        keyToolsPresent,
      },
      supervisor: runtimeSupervisor ? {
        summary: runtimeSupervisor.summary,
        apiStatus: runtimeSupervisor.api?.status,
        tunnelStatus: runtimeSupervisor.tunnel?.status,
        tunnelProcessStatus: runtimeSupervisor.tunnel?.processStatus,
        lastProbeAt: runtimeSupervisor.tunnel?.lastProbeAt,
        consecutiveProbeFailures: runtimeSupervisor.tunnel?.consecutiveProbeFailures,
        lastErrorCode: runtimeSupervisor.tunnel?.lastErrorCode,
        lastErrorClass: runtimeSupervisor.tunnel?.lastErrorClass,
        lastFailureAt: runtimeSupervisor.tunnel?.lastFailureAt,
        lastRecoveryAt: runtimeSupervisor.tunnel?.lastRecoveryAt,
        recoveryAttempt: runtimeSupervisor.tunnel?.recoveryAttempt,
        nextRecoveryAt: runtimeSupervisor.tunnel?.nextRecoveryAt,
      } : null,
    },
    recovery: {
      hasVerifiedGoodBackup: Boolean(recovery.lastVerifiedGoodBackup),
      breakGlass: { unresolvedCount: breakGlassHealth.unresolvedCount, recent: breakGlassHealth.recent.slice(0, 5) },
      failureReason: recovery.failureReason
        ? { code: recovery.failureReason.code, reason: recovery.failureReason.reason, recordedAt: recovery.failureReason.recordedAt }
        : null,
    },
    performance: { totalMs: fullResult.performance.totalMs },
    recommendations: recommendations.slice(0, 8),
  };
}
