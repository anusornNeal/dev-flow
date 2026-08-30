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
  queryProjectActiveTaskClaims,
} from './sessionWorkspaceService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';
import { HARNESS_POLICY_VERSION } from './harnessPolicyService.js';
import { HARNESS_STRATEGY_VERSION } from './harnessStrategyService.js';
import { classifyLifecycleLiveWorkAuthority } from './lifecycleAuthorityService.js';
import { classifyRecoveryCapabilityParity, type RuntimeClientState } from './runtimeIdentityService.js';
import { resolveTaskClaimLiveness } from './taskClaimLivenessService.js';
import { getResidualVerificationResourceSnapshot } from './residualVerificationProcessService';

const lastHealthEventSignatures = new Map<string, string>();
let capabilityCatalogProvider: () => ReturnType<typeof getCapabilityCatalog> = getCapabilityCatalog;
let workspaceRecoveryInspector: typeof inspectWorkspaceRecovery = inspectWorkspaceRecovery;

export function __setWorkflowHealthWorkspaceRecoveryInspectorForTests(provider?: (typeof inspectWorkspaceRecovery) | null) {
  workspaceRecoveryInspector = provider || inspectWorkspaceRecovery;
}

export function __setWorkflowHealthCapabilityCatalogForTests(provider?: (() => ReturnType<typeof getCapabilityCatalog>) | null) {
  capabilityCatalogProvider = provider || getCapabilityCatalog;
  lastHealthEventSignatures.clear();
}

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

function workflowHealthClientState(args: Record<string, any>): RuntimeClientState | undefined {
  const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const toolsVisible = args.clientToolsVisible === true || args.clientToolsVisible === 'true'
    ? true
    : args.clientToolsVisible === false || args.clientToolsVisible === 'false'
      ? false
      : undefined;
  const unavailableToolNames = Array.isArray(args.clientUnavailableToolNames)
    ? args.clientUnavailableToolNames.map(clean).filter(Boolean)
    : clean(args.clientUnavailableToolNames).split(',').map((name) => name.trim()).filter(Boolean);
  const state: RuntimeClientState = {
    contractVersion: clean(args.previousContractVersion) || undefined,
    runtimeInstanceId: clean(args.previousRuntimeInstanceId) || undefined,
    toolSurfaceIdentity: clean(args.previousToolSurfaceIdentity) || undefined,
    criticalToolSchemaIdentity: clean(args.previousCriticalToolSchemaIdentity) || undefined,
    toolsVisible,
    unavailableToolNames,
  };
  return state.contractVersion || state.runtimeInstanceId || state.toolSurfaceIdentity || state.criticalToolSchemaIdentity || state.toolsVisible !== undefined || state.unavailableToolNames.length > 0
    ? state
    : undefined;
}

type WorkflowHealthResponseMode = 'compact' | 'full';

function resolveWorkflowHealthResponseMode(args: Record<string, any>): WorkflowHealthResponseMode {
  const raw = String(args.responseMode || args.mode || '').trim().toLowerCase();
  if (raw === 'compact' || raw === 'summary') return 'compact';
  return 'full';
}

type FailedJobRecoveryGroup = {
  toolName: string;
  recoveryCategory: string;
  recoveryStrategy: string;
  count: number;
  statuses: string[];
  examples: any[];
};

function compactFailureGroups(groups: FailedJobRecoveryGroup[]) {
  return groups.map(({ toolName, recoveryCategory, recoveryStrategy, count, statuses }) => ({
    toolName,
    recoveryCategory,
    recoveryStrategy,
    count,
    statuses,
  }));
}

function summarizeFailedJobGroups(failures: any[]) {
  const groups = new Map<string, FailedJobRecoveryGroup>();
  for (const failure of failures) {
    const toolName = String(failure?.toolName || 'unknown');
    const recoveryCategory = String(failure?.recovery?.category || 'terminal');
    const recoveryStrategy = String(failure?.recovery?.strategy || 'stop');
    const key = `${toolName}\u0000${recoveryCategory}\u0000${recoveryStrategy}`;
    const group = groups.get(key) || {
      toolName,
      recoveryCategory,
      recoveryStrategy,
      count: 0,
      statuses: [],
      examples: [],
    };
    group.count += 1;
    const status = String(failure?.status || '').trim();
    if (status && !group.statuses.includes(status)) group.statuses.push(status);
    if (group.examples.length < 3) {
      const recovery = failure?.recovery && typeof failure.recovery === 'object' ? {
        code: failure.recovery.code,
        category: failure.recovery.category,
        strategy: failure.recovery.strategy,
        retrySamePayload: failure.recovery.retrySamePayload === true,
        autoApply: failure.recovery.autoApply === true,
        requiresFreshSource: failure.recovery.requiresFreshSource === true,
        requiresFreshPreview: failure.recovery.requiresFreshPreview === true,
        guidance: String(failure.recovery.guidance || '').slice(0, 500),
      } : undefined;
      group.examples.push({
        jobId: failure?.jobId,
        status: failure?.status,
        failureSummary: String(failure?.failureSummary || '').slice(0, 500),
        ...(failure?.errorCode ? { errorCode: failure.errorCode } : {}),
        ...(recovery ? { recovery } : {}),
        recoveryClassification: failure?.recoveryClassification,
      });
    }
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((left, right) =>
    right.count - left.count
    || left.toolName.localeCompare(right.toolName)
    || left.recoveryCategory.localeCompare(right.recoveryCategory)
    || left.recoveryStrategy.localeCompare(right.recoveryStrategy));
}

export const CHATGPT_HARNESS_HEALTH_VERSION = 'chatgpt-harness-health.v2' as const;

type HarnessHealthDrift = {
  code: string;
  message: string;
  severity?: 'hard' | 'debt' | 'info';
  taskIds?: string[];
  workspaceIds?: string[];
  executionSessionIds?: string[];
  operationIds?: string[];
  nextAction: string;
};

function hardHealthDriftCodes(drift: HarnessHealthDrift[]) {
  return [...new Set(drift.filter((entry) => entry.severity !== 'debt' && entry.severity !== 'info').map((entry) => entry.code))].slice(0, 20);
}

function cleanHealthSelector(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function activeHealthClaim(task: any) {
  const liveness = resolveTaskClaimLiveness(task?.claim);
  if (!liveness.live || !liveness.workspaceId) return null;
  return {
    workspaceId: liveness.workspaceId,
    ownershipEpochId: liveness.ownershipEpochId,
    expiresAt: liveness.retentionExpiresAt,
    liveness: {
      state: liveness.state,
      lastMeaningfulActivityAt: liveness.lastMeaningfulActivityAt,
      expiresAt: liveness.livenessExpiresAt,
      windowMs: liveness.livenessWindowMs,
      source: liveness.source,
      migrationDerived: liveness.migrationDerived,
      protectedByDurableWork: liveness.protectedByDurableWork,
      pendingOperationIds: liveness.pendingOperationIds,
      activeJobIds: liveness.activeJobIds,
    },
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
  inspectionOverride?: ReturnType<typeof inspectWorkspaceRecovery> | null,
  deferInspection = false,
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

  if (deferInspection) return null;
  const inspection = inspectionOverride === undefined ? inspectWorkspaceRecovery(workspaceId) : inspectionOverride;
  if (!inspection || inspection.disposition === 'stale-registry') {
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
    hardBlockers: hardHealthDriftCodes(drift),
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
  const authority = classifyLifecycleLiveWorkAuthority(task.id, {
    workspaceId: claim?.workspaceId || selected?.workspaceId || undefined,
  });
  if (!claim && selected) {
    const safeOrphan = authority.classification === 'safe-orphan';
    const recoverableWip = authority.classification === 'recoverable-wip';
    drift.push({
      code: safeOrphan ? 'SAFE_ORPHAN_EXECUTION' : recoverableWip ? 'ACTIONABLE_WIP_WITHOUT_ACTIVE_CLAIM' : 'ACTIVE_EXECUTION_WITHOUT_ACTIVE_CLAIM',
      severity: safeOrphan || recoverableWip ? 'debt' : 'hard',
      message: safeOrphan
        ? 'An active execution row remains, but no live claim or durable operation grants concurrency authority.'
        : recoverableWip
          ? 'Recoverable workspace WIP remains after claim authority disappeared.'
          : 'A durable active execution exists without provably safe orphan or recoverable-WIP classification.',
      taskIds: [task.id],
      workspaceIds: selected.workspaceId ? [selected.workspaceId] : [],
      executionSessionIds: [selected.id],
      nextAction: safeOrphan
        ? 'Converge the orphan metadata when convenient; do not treat it as live work or a restart blocker.'
        : 'Enter scoped lifecycle recovery and preserve workspace WIP.',
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
        severity: actionableWorkspaceIds.length > 1 ? 'hard' : 'debt',
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
  const taskHardBlockers = [...new Set([
    ...hardHealthDriftCodes(drift),
    ...(authority.operations.status.hardBlocked ? authority.operations.status.reasonCodes : []),
  ])].slice(0, 20);
  const result = {
    version: CHATGPT_HARNESS_HEALTH_VERSION,
    scope: 'task',
    status: taskHardBlockers.length > 0 ? 'blocked' : authority.classification === 'live-authoritative' || authority.classification === 'live-durable-operation' ? 'active' : 'idle',
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
    authority,
    drift: drift.slice(0, 20),
    hardBlockers: taskHardBlockers,
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
  const authority = task ? classifyLifecycleLiveWorkAuthority(task.id, { workspaceId }) : null;
  if (session && !claim) {
    const safeOrphan = authority?.classification === 'safe-orphan';
    const recoverableWip = authority?.classification === 'recoverable-wip';
    drift.push({
      code: safeOrphan ? 'SAFE_ORPHAN_EXECUTION' : recoverableWip ? 'ACTIONABLE_WIP_WITHOUT_ACTIVE_CLAIM' : 'ACTIVE_EXECUTION_WITHOUT_ACTIVE_CLAIM',
      severity: safeOrphan || recoverableWip ? 'debt' : 'hard',
      message: safeOrphan
        ? 'The workspace has a stale active execution row without live claim or durable operation authority.'
        : recoverableWip
          ? 'The workspace carries recoverable WIP without live claim authority.'
          : 'A durable active execution exists for the workspace without provably safe lifecycle classification.',
      taskIds: session.taskId ? [session.taskId] : [],
      workspaceIds: [workspaceId],
      executionSessionIds: [session.id],
      nextAction: safeOrphan
        ? 'Converge the orphan metadata without treating it as live work.'
        : 'Enter scoped lifecycle recovery and preserve workspace WIP.',
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
        severity: 'debt',
        workspaceIds: [workspaceId],
        nextAction: 'Recover or reconcile this exact workspace; preserve WIP and do not treat it as idle.',
      });
    }
  }
  const workspaceHardBlockers = [...new Set([
    ...hardHealthDriftCodes(drift),
    ...(authority?.operations.status.hardBlocked ? authority.operations.status.reasonCodes : []),
  ])].slice(0, 20);
  return {
    version: CHATGPT_HARNESS_HEALTH_VERSION,
    scope: 'workspace',
    status: workspaceHardBlockers.length > 0
      ? 'blocked'
      : authority?.classification === 'live-authoritative' || authority?.classification === 'live-durable-operation'
        ? 'active'
        : 'idle',
    mode: 'chatgpt-only',
    task: task ? { id: task.id, displayId: task.displayId, status: task.status, projectId: task.projectId } : null,
    claim: claim ? { present: true, ...claim } : { present: false, workspaceId: null, ownershipEpochId: null, expiresAt: null },
    execution: executionHealthView(session),
    checkpoint: { freshness: pending.checkpoint ? 'present' : 'missing', ref: pending.checkpoint?.id || null },
    ...baselineHarnessMetadata(),
    recovery: { pendingOperationCount: pending.operationIds.length },
    authority,
    drift: drift.slice(0, 20),
    hardBlockers: workspaceHardBlockers,
  };
}

function projectHarnessHealth(state: AppState, args: Record<string, any>, options: { deepRecoveryScan?: boolean } = {}) {
  const deepRecoveryScan = options.deepRecoveryScan !== false;
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

  const activeClaimQuery = queryProjectActiveTaskClaims(project.id, 100);
  const activeClaims = activeClaimQuery.claims
    .map((task) => ({ task, claim: activeHealthClaim(task) }))
    .filter((entry) => Boolean(entry.claim));
  const activeClaimsByTaskId = new Map(activeClaims.map((entry) => [entry.task.id, entry] as const));
  const firstExecutionPage = queryExecutionSessions({ projectId: project.id, status: 'active', limit: 50 });
  const executions = firstExecutionPage.truncated
    ? queryExecutionSessions({ projectId: project.id, status: 'active', limit: 100 })
    : firstExecutionPage;
  const drift: HarnessHealthDrift[] = [];
  const byTask = new Map<string, ExecutionSessionRecord[]>();
  const byWorkspace = new Map<string, ExecutionSessionRecord[]>();
  let pendingOperationCount = 0;
  const authorityByTask = new Map<string, ReturnType<typeof classifyLifecycleLiveWorkAuthority>>();
  const workspaceInspectionCache = new Map<string, ReturnType<typeof inspectWorkspaceRecovery>>();
  const inspectProjectWorkspaceOnce = (workspaceId: string) => {
    const cached = workspaceInspectionCache.get(workspaceId);
    if (cached) return cached;
    try {
      const inspection = workspaceRecoveryInspector(workspaceId);
      workspaceInspectionCache.set(workspaceId, inspection);
      return inspection;
    } catch {
      return null;
    }
  };

  for (const session of executions.sessions) {
    if (session.taskId) byTask.set(session.taskId, [...(byTask.get(session.taskId) || []), session]);
    if (session.workspaceId) byWorkspace.set(session.workspaceId, [...(byWorkspace.get(session.workspaceId) || []), session]);
    const pending = pendingHealthOperations(session);
    pendingOperationCount += pending.operationIds.length;
    const claimedEntry = session.taskId ? activeClaimsByTaskId.get(session.taskId) || null : null;
    const task = claimedEntry?.task || (session.taskId ? findTaskByIdentifier(state, session.taskId) || null : null);
    const claim = claimedEntry?.claim || (task ? activeHealthClaim(task) : null);
    if (!claim) {
      if (deepRecoveryScan && session.workspaceId) inspectProjectWorkspaceOnce(session.workspaceId);
      const authority = task
        ? authorityByTask.get(task.id) || classifyLifecycleLiveWorkAuthority(task.id, {
            workspaceId: session.workspaceId || undefined,
            workspaceInspections: workspaceInspectionCache,
            deferWorkspaceInspection: !deepRecoveryScan,
          })
        : null;
      if (task && authority) authorityByTask.set(task.id, authority);
      const safeOrphan = authority?.classification === 'safe-orphan';
      const recoverableWip = authority?.classification === 'recoverable-wip';
      drift.push({
        code: safeOrphan ? 'SAFE_ORPHAN_EXECUTION' : recoverableWip ? 'ACTIONABLE_WIP_WITHOUT_ACTIVE_CLAIM' : 'ACTIVE_EXECUTION_WITHOUT_ACTIVE_CLAIM',
        severity: safeOrphan || recoverableWip ? 'debt' : 'hard',
        message: safeOrphan
          ? 'Project aggregate found stale execution metadata without live concurrency authority.'
          : recoverableWip
            ? 'Project aggregate found recoverable workspace WIP without live claim authority.'
            : 'Project aggregate found an active execution without matching claim and without provably safe classification.',
        taskIds: session.taskId ? [session.taskId] : [],
        workspaceIds: session.workspaceId ? [session.workspaceId] : [],
        executionSessionIds: [session.id],
        nextAction: safeOrphan
          ? 'Converge safe orphan metadata without treating it as live work.'
          : 'Use scoped lifecycle recovery for the affected task/workspace and preserve WIP.',
      });
    } else if (claim.workspaceId !== session.workspaceId || (claim.ownershipEpochId && getExecutionSessionOwnershipEpoch(session.id).ownershipEpochId !== claim.ownershipEpochId)) {
      drift.push({
        code: 'CLAIM_EXECUTION_OWNERSHIP_MISMATCH',
        message: 'Project aggregate found a claim/execution workspace or ownership epoch mismatch.',
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
    const requiresGitInspection = deepRecoveryScan;
    const workspaceDrift = managedWorkspaceAuthorityDrift(workspaceId, {
      taskIds: [...context.taskIds].slice(0, 20),
      executionSessionIds: [...context.executionSessionIds].slice(0, 20),
    }, requiresGitInspection ? inspectProjectWorkspaceOnce(workspaceId) : undefined, !requiresGitInspection);
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

  const authoritativeWorkspaceIds = new Set(authoritativeWorkspaceContexts.keys());
  const registryPageSize = 100;
  let registryOffset = 0;
  let registryScanComplete = true;
  let registryScanError = '';
  let registryOutsideActiveAuthorityCount = 0;
  let actionableRecoveryWorkspaceCount = 0;
  let recoveryInspectionUnknownCount = 0;
  const deferredWorkspaceIds: string[] = [];
  const actionableRecoveryWorkspaceIds: string[] = [];
  while (true) {
    const page = listSessionWorkspaceMetadataForRecovery(project.id, registryPageSize, registryOffset);
    if (page.error || page.offset !== registryOffset) {
      registryScanComplete = false;
      registryScanError = String(page.error || `Workspace registry page offset mismatch: expected ${registryOffset}, received ${page.offset}.`);
      break;
    }
    for (const workspace of page.workspaces) {
      if (authoritativeWorkspaceIds.has(workspace.workspaceId)) continue;
      registryOutsideActiveAuthorityCount += 1;
      if (!deepRecoveryScan) {
        if (deferredWorkspaceIds.length < 20) deferredWorkspaceIds.push(workspace.workspaceId);
        continue;
      }
      const inspection = inspectProjectWorkspaceOnce(workspace.workspaceId);
      if (!inspection) {
        recoveryInspectionUnknownCount += 1;
        continue;
      }
      const actionable = inspection.disposition === 'needs-recovery'
        || inspection.disposition === 'stale-registry'
        || inspection.disposition === 'committed-not-integrated'
        || inspection.state === 'integration-required';
      if (!actionable) continue;
      actionableRecoveryWorkspaceCount += 1;
      if (actionableRecoveryWorkspaceIds.length < 20) actionableRecoveryWorkspaceIds.push(workspace.workspaceId);
    }
    const nextOffset = registryOffset + page.workspaces.length;
    if (!page.truncated) {
      registryScanComplete = page.complete !== false && nextOffset >= page.total;
      if (!registryScanComplete && !registryScanError) registryScanError = 'Workspace registry pagination ended before the reported total was consumed.';
      break;
    }
    if (page.workspaces.length === 0 || nextOffset <= registryOffset) {
      registryScanComplete = false;
      registryScanError = 'Workspace registry pagination made no forward progress.';
      break;
    }
    registryOffset = nextOffset;
  }
  const recoveryScanDeferred = !deepRecoveryScan && (registryOutsideActiveAuthorityCount > 0 || authoritativeWorkspaceContexts.size > 0);
  if (recoveryScanDeferred) drift.push({
    code: 'PROJECT_RECOVERY_SCAN_DEFERRED',
    severity: 'info',
    message: 'Compact project health deferred Git-backed recovery inspection; use exact scoped or full/debug health before treating workspace recovery as clear.',
    workspaceIds: [...new Set([...authoritativeWorkspaceContexts.keys(), ...deferredWorkspaceIds])].slice(0, 20),
    nextAction: 'Use full/debug project health before treating the project as lifecycle-clear or performing recovery cleanup.',
  });
  if (!registryScanComplete) drift.push({
    code: 'PROJECT_WORKSPACE_SCAN_UNKNOWN',
    message: registryScanError
      ? `Project workspace registry completeness could not be proven: ${registryScanError}`
      : 'Project workspace registry completeness could not be proven.',
    severity: 'debt',
    nextAction: 'Repair workspace registry discovery before treating the project as lifecycle-clear.',
  });
  if (deepRecoveryScan && recoveryInspectionUnknownCount > 0) drift.push({
    code: 'PROJECT_RECOVERY_INSPECTION_UNKNOWN',
    message: `Recovery inspection failed for ${recoveryInspectionUnknownCount} managed workspace(s), so a complete all-clear cannot be proven.`,
    severity: 'debt',
    nextAction: 'Inspect the affected workspace registry/Git state before treating the project as lifecycle-clear.',
  });
  if (!activeClaimQuery.complete) drift.push({
    code: 'PROJECT_LIFECYCLE_AUTHORITY_UNKNOWN',
    message: activeClaimQuery.error
      ? `Project active-claim authority query could not prove completeness: ${activeClaimQuery.error}`
      : 'Project active-claim authority query could not prove completeness within the bounded live-authority view.',
    severity: 'debt',
    nextAction: 'Repair malformed claim metadata or the authoritative claim query before treating the project as lifecycle-clear.',
  });
  const truncated = executions.truncated
    || activeClaimQuery.truncated
    || !activeClaimQuery.complete
    || !registryScanComplete
    || (deepRecoveryScan && recoveryInspectionUnknownCount > 0);
  if (truncated) drift.push({
    code: 'PROJECT_LIFECYCLE_SCAN_TRUNCATED',
    message: 'Project aggregate exceeded a bounded lifecycle scan and cannot prove a complete all-clear.',
    severity: 'debt',
    nextAction: 'Narrow health to an explicit task/workspace or inspect additional bounded pages.',
  });

  const projectHardBlockers = hardHealthDriftCodes(drift);
  const canonicalLiveAuthorityCount = [...authorityByTask.values()].filter((authority) =>
    authority.classification === 'live-authoritative' || authority.classification === 'live-durable-operation').length;
  const recoveryIdentityBlocked = projectHardBlockers.some((code) =>
    code === 'WORKSPACE_METADATA_MISSING' || code === 'WORKSPACE_ROOT_OR_IDENTITY_INVALID');
  const recoveryInspectionState = recoveryScanDeferred
    ? 'deferred'
    : !registryScanComplete || recoveryInspectionUnknownCount > 0
      ? 'unknown'
      : recoveryIdentityBlocked
        ? 'blocked'
        : actionableRecoveryWorkspaceCount > 0
          ? 'actionable'
          : 'clear';
  const recoveryInspectionAuthoritative = recoveryInspectionState === 'clear'
    || recoveryInspectionState === 'blocked'
    || recoveryInspectionState === 'actionable';
  const lifecycleClear = recoveryInspectionState === 'clear'
    && projectHardBlockers.length === 0
    && canonicalLiveAuthorityCount === 0
    && activeClaims.length === 0
    && executions.total === 0
    && pendingOperationCount === 0;
  const recoveryInspection = {
    state: recoveryInspectionState,
    authoritative: recoveryInspectionAuthoritative,
    lifecycleClear,
  };
  return {
    version: CHATGPT_HARNESS_HEALTH_VERSION,
    scope: 'project-aggregate',
    status: projectHardBlockers.length > 0
      ? 'blocked'
      : canonicalLiveAuthorityCount > 0 || activeClaims.length > 0 || actionableRecoveryWorkspaceCount > 0
        ? 'active'
        : 'idle',
    mode: 'chatgpt-only',
    ...baselineHarnessMetadata(),
    project: { id: project.id, name: project.name },
    aggregate: {
      activeExecutionCount: executions.total,
      activeClaimCount: activeClaimQuery.total,
      actionableWorkspaceCount: actionableRecoveryWorkspaceCount,
      pendingOperationCount,
      canonicalLiveAuthorityCount,
      driftCount: drift.length,
      truncated,
      executionSessionIds: executions.sessions.map((entry) => entry.id).slice(0, 20),
      taskIds: [...new Set([...activeClaims.map((entry) => entry.task.id), ...executions.sessions.map((entry) => entry.taskId).filter(Boolean) as string[]])].slice(0, 20),
      workspaceIds: [...new Set([...activeClaims.map((entry) => entry.claim!.workspaceId), ...executions.sessions.map((entry) => entry.workspaceId).filter(Boolean) as string[], ...actionableRecoveryWorkspaceIds])].slice(0, 20),
    },
    recovery: {
      pendingOperationCount,
      ...(deepRecoveryScan || recoveryInspectionState !== 'clear' ? { inspection: recoveryInspection } : {}),
    },
    drift: drift.slice(0, 20),
    hardBlockers: projectHardBlockers,
  };
}

export function getChatGptHarnessHealthSnapshot(state: AppState, args: Record<string, any> = {}): Record<string, any> {
  const taskId = cleanHealthSelector(args.taskId);
  const workspaceId = cleanHealthSelector(args.workspaceId);
  if (workspaceId) return workspaceHarnessHealth(state, workspaceId, taskId);
  if (taskId) return taskHarnessHealth(state, taskId);
  const hasProjectSelector = ['projectId', 'projectName', 'repo', 'repoUrl', 'localPath'].some((key) => cleanHealthSelector(args[key]));
  if (hasProjectSelector) return projectHarnessHealth(state, args, {
    deepRecoveryScan: resolveWorkflowHealthResponseMode(args) === 'full',
  });
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
  const clientState = workflowHealthClientState(args);
  const catalog = capabilityCatalogProvider();
  const advertisedTools = getMcpToolList(catalog.mcpProfile.active);
  const advertisedNames = new Set(advertisedTools.map((tool) => tool.name));
  const advertisedDefinitions = catalog.tools.filter((tool: any) => advertisedNames.has(tool.name));
  const catalogMs = phaseMs();
  const diagnostics = getDevFlowDiagnostics({ windowMs, includePerformanceHistory: responseMode === 'full', clientState });
  const diagnosticsMs = phaseMs();
  const gitProbe = probe(() => getGitStatus(state, args));
  const gitMs = phaseMs();
  const search = getLocalSearchRuntimeStatus();
  const searchMs = phaseMs();
  const sloPerformance = evaluatePerformanceSlo(Array.isArray(diagnostics?.tools?.topTools) ? diagnostics.tools.topTools : []);
  const sloMs = phaseMs();
  const recovery = getRecoveryStatus();
  const recoveryMs = phaseMs();
  const harness = getChatGptHarnessHealthSnapshot(state, args);
  const harnessMs = phaseMs();
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
  const residualProcessDebt = getResidualVerificationResourceSnapshot();
  const runtimeSupervisor = diagnostics?.runtimeSupervisor;
  const runtimeSourceFreshness = diagnostics?.runtime?.sourceFreshness || null;
  const runtimeDiagnosis = diagnostics?.runtimeDiagnosis || null;
  const restartSafetySummary = runtimeDiagnosis?.restartSafety ? {
    blocked: runtimeDiagnosis.restartSafety.blocked === true,
    hardBlockerCount: Array.isArray(runtimeDiagnosis.restartSafety.active) ? runtimeDiagnosis.restartSafety.active.length : 0,
    cleanupDebtCount: Array.isArray(runtimeDiagnosis.restartSafety.cleanupDebt) ? runtimeDiagnosis.restartSafety.cleanupDebt.length : 0,
    truncated: runtimeDiagnosis.restartSafety.truncated === true,
    hardReasonCodes: [...new Set((runtimeDiagnosis.restartSafety.active || []).flatMap((entry: any) => entry.reasonCodes || []))].slice(0, 8),
    debtReasonCodes: [...new Set((runtimeDiagnosis.restartSafety.cleanupDebt || []).flatMap((entry: any) => entry.reasonCodes || []))].slice(0, 8),
  } : null;
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
  const failedJobEvidence = {
    freshness: runtimeSourceFreshness?.code === 'current' ? 'current' : runtimeSourceFreshness?.code === 'stale' ? 'stale-runtime' : 'unknown',
    reasonCode: runtimeSourceFreshness?.code === 'stale' ? 'FAILED_JOB_EVIDENCE_STALE_RUNTIME' : runtimeSourceFreshness?.code === 'current' ? 'FAILED_JOB_EVIDENCE_CURRENT_RUNTIME' : 'FAILED_JOB_EVIDENCE_FRESHNESS_UNKNOWN',
    ...(runtimeSourceFreshness?.loadedRevision ? { loadedRevision: String(runtimeSourceFreshness.loadedRevision).slice(0, 40) } : {}),
    ...(runtimeSourceFreshness?.currentRevision ? { currentRevision: String(runtimeSourceFreshness.currentRevision).slice(0, 40) } : {}),
  };
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
  const closureRecovery = catalog.recovery || {
    scope: 'server-advertised',
    profile: catalog.mcpProfile.active,
    serverReady: false,
    ready: false,
    toolSurfaceIdentity: catalog.mcpProfile.toolSurfaceIdentity,
    missingCapabilityIds: ['capability-status-missing'],
    capabilities: [],
  };

  const recoveryParity = classifyRecoveryCapabilityParity({ ...diagnostics.runtime, criticalToolSchemaIdentity: catalog.mcpProfile.criticalToolSchemaIdentity } as any, closureRecovery as any, clientState);
  if (!closureRecovery.ready) {
    const missing = Array.isArray(closureRecovery.missingCapabilityIds)
      ? closureRecovery.missingCapabilityIds.slice(0, 8).join(', ')
      : 'unknown';
    recommendations.push(`Closure recovery capability drift detected for profile '${closureRecovery.profile}' (${missing || 'unknown'}); refresh/reconnect the MCP capability surface when active work is safe, and do not attempt unavailable recovery actions until the advertised surface matches the contract.`);
  }
  if (closureRecovery.ready && recoveryParity.endToEnd.ready === false) {
    recommendations.push(`Client-observed recovery parity is not ready (${recoveryParity.endToEnd.reasonCodes.join(', ') || 'client-registry-stale'}); ${recoveryParity.endToEnd.nextAction}`);
  }
  if (runtimeSupervisor?.api?.status === 'healthy' && (runtimeSupervisor?.tunnel?.status === 'degraded' || runtimeSupervisor?.tunnel?.status === 'down')) {
    recommendations.push(`OpenAI tunnel is ${runtimeSupervisor.tunnel.status} while the local API is healthy; run npm run tunnel:status and inspect tunnel-client diagnostics.`);
  }
  if (runtimeSourceFreshness && runtimeSourceFreshness.code !== 'current') {
    recommendations.push(`DevFlow runtime source is ${runtimeSourceFreshness.code}; ${runtimeDiagnosis?.nextAction || runtimeSourceFreshness.nextAction || 'inspect runtime source freshness before treating this process as current.'}`);
  }
  if (failedJobs > 0 && failedJobEvidence.freshness === 'stale-runtime') {
    recommendations.push('Recent failed-job diagnostics were observed while the DevFlow runtime source is stale relative to the current repository; revalidate the failure against current source before creating or implementing a defect card.');
  }
  if (restartSafetySummary && restartSafetySummary.cleanupDebtCount > 0) {
    recommendations.push(`Restart safety found ${restartSafetySummary.cleanupDebtCount} bounded non-blocking execution cleanup debt record(s); inspect cleanup_orphan_executions with dry-run before applying cleanup.`);
  }
  if (queueDepth > 0) recommendations.push('MCP tool jobs are queued; inspect job status/log before starting conflicting repo work.');
  if (Number(durableJobs.staleRunning || 0) > 0) recommendations.push('A stale MCP tool job lease was detected in durable state; inspect recovery classification before retrying the job.');
  if (isolation.capacity?.saturated) recommendations.push('Verification capacity is saturated; queued verify work is capacity-limited rather than blocked by a workspace correctness lock.');
  if (residualProcessDebt.count > 0) recommendations.push(`Residual verification process debt remains (${residualProcessDebt.count} record(s), ${residualProcessDebt.resourceEstimate.processCount} estimated process(es)); heavy verification stays degraded until identity-safe cleanup is confirmed.`);
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
    get_repo_context_bundle: advertisedNames.has('get_repo_context_bundle'),
    move_task_to_status: advertisedNames.has('move_task_to_status'),
    commit_git_changes: advertisedNames.has('commit_git_changes'),
    devflow_health_check: advertisedNames.has('devflow_health_check'),
  };
  const hasErrors = !git.ok || Boolean(git.ok && git.operation?.blocked) || advertisedTools.length === 0 || !closureRecovery.ready;
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
        Array.isArray(closureRecovery.missingCapabilityIds) ? closureRecovery.missingCapabilityIds.length : 1,
      ].join(':');
  const priorHealthEventSignature = lastHealthEventSignatures.get(healthEventKey) || '';
  if (healthEventSignature && healthEventSignature !== priorHealthEventSignature) {
    publishServerEvent('health.regression', {
      projectId: healthEventProjectId,
      status,
      reason: `failedJobs=${failedJobs};staleAgents=${staleAgentRuns};staleJobs=${Number(durableJobs.staleRunning || 0)};slo=${sloPerformance.regressions.length};gitBlocker=${git.ok ? git.operation?.code || 'none' : 'unavailable'};gitKind=${git.ok ? git.operation?.kind || 'none' : 'unknown'};unmerged=${git.ok ? git.operation?.unmergedPathCount || 0 : 0};missingRecoveryCapabilities=${Array.isArray(closureRecovery.missingCapabilityIds) ? closureRecovery.missingCapabilityIds.length : 1}`,
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
    checks: { git: git.ok, capabilityCatalog: advertisedTools.length > 0 && closureRecovery.ready, diagnostics: true, recovery: Boolean(recovery.lastVerifiedGoodBackup) && !recovery.failureReason },
    capabilities: {
      contractVersion: catalog.contractVersion,
      toolCount: advertisedTools.length,
      backendToolCount: catalog.tools.length,
      lightweightToolCount: advertisedDefinitions.filter((tool: any) => tool.lightweight).length,
      asyncToolCount: advertisedDefinitions.filter((tool: any) => tool.executionPolicy?.mode === 'job').length,
      search,
      keyToolsPresent,
      recovery: {
        scope: 'end-to-end',
        ready: recoveryParity.endToEnd.ready,
        serverReady: closureRecovery.serverReady ?? closureRecovery.ready,
        serverScope: closureRecovery.scope || 'server-advertised',
        profile: closureRecovery.profile,
        toolSurfaceIdentity: closureRecovery.toolSurfaceIdentity,
        missingCapabilityIds: Array.isArray(closureRecovery.missingCapabilityIds) ? closureRecovery.missingCapabilityIds.slice(0, 8) : ['capability-status-missing'],
        clientObserved: recoveryParity.clientObserved,
        endToEnd: recoveryParity.endToEnd,
      },
    },
    git,
    diagnostics: {
      queueDepth,
      failedJobs,
      failedJobGroups,
      failedJobEvidence,
      failedJobSummaries,
      durableJobs,
      residualProcessDebt,
      staleAgentRuns,
      duplicateBursts,
      repoCaches: { domains: repoCaches },
      performance: { ...sloPerformance, history: historicalPerformance },
      telemetryPersistence: diagnostics?.telemetryPersistence,
      isolation,
      recovery,
      breakGlass: breakGlassHealth,
      runtimeSupervisor,
      runtimeSource: {
        identity: diagnostics?.runtime || null,
        diagnosis: runtimeDiagnosis,
        restartSafety: restartSafetySummary,
      },
      harness,
    },
    performance: {
      totalMs: Math.round((nodePerformance.now() - startedAt) * 100) / 100,
      phases: { catalogMs, diagnosticsMs, gitMs, searchMs, sloMs, recoveryMs, harnessMs },
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
    checks: fullResult.checks,
    git: compactGit,
    queue: {
      depth: queueDepth,
      capacity: isolation.capacity,
      ...(residualProcessDebt.count > 0 ? { residualProcessDebt } : {}),
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
      ...(failedJobs > 0 ? {
        evidence: {
          freshness: failedJobEvidence.freshness,
          reasonCode: failedJobEvidence.reasonCode,
        },
      } : {}),
    },
    regressions: compactRegressions,
    harness,
    runtime: {
      sourceFreshness: runtimeSourceFreshness ? {
        code: runtimeSourceFreshness.code,
        loadedRevision: runtimeSourceFreshness.loadedRevision,
        currentRevision: runtimeSourceFreshness.currentRevision,
        currentSourceDirty: runtimeSourceFreshness.currentSourceDirty,
        headMismatch: runtimeSourceFreshness.headMismatch,
        contentEquivalent: runtimeSourceFreshness.contentEquivalent,
      } : null,
      diagnosis: runtimeDiagnosis ? {
        code: runtimeDiagnosis.code,
        restartBlocked: runtimeDiagnosis.restartSafety?.blocked === true,
        restartSafety: restartSafetySummary,
        ...(runtimeDiagnosis.contractImpact ? {
          contractImpact: {
            code: runtimeDiagnosis.contractImpact.code,
            loadedRevision: runtimeDiagnosis.contractImpact.loadedRevision,
            currentRevision: runtimeDiagnosis.contractImpact.currentRevision,
            changedPaths: runtimeDiagnosis.contractImpact.changedPaths.slice(0, 20),
            matchedPaths: runtimeDiagnosis.contractImpact.matchedPaths.slice(0, 20),
            truncated: runtimeDiagnosis.contractImpact.truncated,
            reasonCodes: runtimeDiagnosis.contractImpact.reasonCodes.slice(0, 8),
          },
        } : {}),
        ...(runtimeDiagnosis.runningToolSurfaceIdentity ? { runningToolSurfaceIdentity: runtimeDiagnosis.runningToolSurfaceIdentity } : {}),
      } : null,
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
        serverRecoveryReady: closureRecovery.serverReady ?? closureRecovery.ready,
        recoveryReady: recoveryParity.endToEnd.ready,
      },
      supervisor: runtimeSupervisor ? {
        summary: runtimeSupervisor.summary,
        apiStatus: runtimeSupervisor.api?.status,
        tunnelStatus: runtimeSupervisor.tunnel?.status,
        tunnelProcessStatus: runtimeSupervisor.tunnel?.processStatus,
        lastCheckedAt: runtimeSupervisor.tunnel?.lastCheckedAt,
        lastSuccessAt: runtimeSupervisor.tunnel?.lastSuccessAt,
        lastErrorCode: runtimeSupervisor.tunnel?.lastErrorCode,
        lastErrorClass: runtimeSupervisor.tunnel?.lastErrorClass,
        lastFailureAt: runtimeSupervisor.tunnel?.lastFailureAt,
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
