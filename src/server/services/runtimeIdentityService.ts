import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths.js';
import { getRepoChangedPathsBetweenRevisions, getRepoRevisionForRoot } from './repoRevisionService.js';
import { queryExecutionSessions } from '../repositories/executionSessionRepository.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import { classifyLifecycleLiveWorkAuthority, type LiveWorkAuthorityClassification } from './lifecycleAuthorityService.js';

export type DevFlowMcpTransport = 'streamable-http' | 'legacy-sse';

export type RuntimeSourceFreshnessCode = 'current' | 'content-equivalent' | 'stale' | 'dirty-ambiguous' | 'unavailable';

export interface RuntimeSourceSnapshot {
  available: boolean;
  revision: string | null;
  treeId: string | null;
  repoToken: string | null;
  dirty: boolean | null;
  changedFileCount: number | null;
  observedAt: string;
  errorCode?: string;
}

export interface RuntimeSourceFreshness {
  code: RuntimeSourceFreshnessCode;
  loadedRevision: string | null;
  currentRevision: string | null;
  loadedTreeId: string | null;
  currentTreeId: string | null;
  contentEquivalent: boolean;
  loadedRepoToken: string | null;
  currentRepoToken: string | null;
  loadedSourceDirty: boolean | null;
  currentSourceDirty: boolean | null;
  currentChangedFileCount: number | null;
  headMismatch: boolean;
  detail: string;
  nextAction: string;
}
export type RuntimeContractImpactCode = 'not-applicable' | 'none' | 'contract-sensitive' | 'unknown';

export interface RuntimeContractImpact {
  code: RuntimeContractImpactCode;
  loadedRevision: string | null;
  currentRevision: string | null;
  changedPaths: string[];
  matchedPaths: string[];
  truncated: boolean;
  reasonCodes: string[];
}


export interface RuntimeRestartSafetyEntry {
  taskId: string | null;
  executionSessionId: string;
  workspaceId: string | null;
  stage: string;
  classification: LiveWorkAuthorityClassification | 'durable-operation-without-task' | 'non-authoritative-execution';
  reasonCodes: string[];
  pendingOperationIds: string[];
  changedFiles: string[];
  nextAction?: string;
}

export interface RuntimeRestartSafety {
  blocked: boolean;
  truncated: boolean;
  active: RuntimeRestartSafetyEntry[];
  cleanupDebt: RuntimeRestartSafetyEntry[];
}
const MAX_RUNTIME_RESTART_BLOCKERS = 10;
const MAX_RUNTIME_RESTART_DEBT = 10;

export interface RuntimeIdentity {
  runtimeInstanceId: string;
  runtimeStartedAt: string;
  transport: DevFlowMcpTransport[];
  loadedRevision: string | null;
  loadedTreeId: string | null;
  loadedRepoToken: string | null;
  loadedSourceDirty: boolean | null;
  loadedSourceChangedFileCount: number | null;
  sourceRevisionAvailable: boolean;
}

export interface RuntimeClientState {
  contractVersion?: string;
  runtimeInstanceId?: string;
  toolSurfaceIdentity?: string;
  criticalToolSchemaIdentity?: string;
  toolsVisible?: boolean;
  unavailableToolNames?: readonly string[];
}

export interface RuntimeIdentityWithContract extends RuntimeIdentity {
  contractVersion: string;
  toolSurfaceIdentity: string;
  criticalToolSchemaIdentity?: string;
  sourceFreshness?: RuntimeSourceFreshness;
}

export type RuntimeDiagnosisCode =
  | 'runtime-restarted'
  | 'tool-surface-changed'
  | 'deployment-changed'
  | 'client-registry-desync'
  | 'contract-changed'
  | 'runtime-source-stale'
  | 'runtime-source-stale-contract-sensitive'
  | 'runtime-source-dirty-ambiguous'
  | 'runtime-source-unavailable'
  | 'runtime-current';

export interface RuntimeDiagnosis {
  code: RuntimeDiagnosisCode;
  detail: string;
  nextAction: string;
  recoverySurface?: 'get_recovery_handoff';
  sourceFreshness?: RuntimeSourceFreshness;
  concurrentDiagnostics?: RuntimeDiagnosis[];
  restartSafety?: RuntimeRestartSafety;
  contractImpact?: RuntimeContractImpact;
  runningToolSurfaceIdentity?: string;
}

export type RuntimeRecoveryClientObservationState = 'unknown' | 'ready' | 'stale' | 'missing-tools' | 'schema-mismatch';
export type RuntimeRecoveryEndToEndState = 'unknown' | 'ready' | 'not-ready';

export interface RuntimeServerRecoveryState {
  scope?: string;
  profile?: string;
  ready: boolean;
  serverReady?: boolean;
  toolSurfaceIdentity?: string;
  missingCapabilityIds?: readonly string[];
  capabilities?: readonly {
    id?: string;
    toolName?: string;
    callable?: boolean;
  }[];
}

export interface RuntimeRecoveryParity {
  server: {
    scope: 'server-advertised';
    profile: string | null;
    ready: boolean;
    toolSurfaceIdentity: string;
    missingCapabilityIds: string[];
  };
  clientObserved: {
    observed: boolean;
    state: RuntimeRecoveryClientObservationState;
    toolsVisible: boolean | null;
    contractMatch: boolean | null;
    runtimeMatch: boolean | null;
    toolSurfaceMatch: boolean | null;
    criticalToolSchemaMatch: boolean | null;
    missingRequiredRecoveryToolNames: string[];
  };
  endToEnd: {
    state: RuntimeRecoveryEndToEndState;
    ready: boolean | null;
    reasonCodes: string[];
    nextAction: string;
    recoverySurface?: 'get_recovery_handoff';
  };
}

export function classifyRecoveryCapabilityParity(
  current: RuntimeIdentityWithContract,
  serverRecovery: RuntimeServerRecoveryState,
  clientState?: RuntimeClientState,
): RuntimeRecoveryParity {
  const previousContract = String(clientState?.contractVersion || '').trim();
  const previousRuntime = String(clientState?.runtimeInstanceId || '').trim();
  const previousToolSurface = String(clientState?.toolSurfaceIdentity || '').trim();
  const previousCriticalToolSchema = String(clientState?.criticalToolSchemaIdentity || '').trim();
  const currentCriticalToolSchema = String(current.criticalToolSchemaIdentity || '').trim();
  const observed = Boolean(previousContract || previousRuntime || previousToolSurface || previousCriticalToolSchema || clientState?.toolsVisible !== undefined);
  const contractMatch = previousContract ? previousContract === current.contractVersion : null;
  const runtimeMatch = previousRuntime ? previousRuntime === current.runtimeInstanceId : null;
  const toolSurfaceMatch = previousToolSurface ? previousToolSurface === current.toolSurfaceIdentity : null;
  const criticalToolSchemaMatch = currentCriticalToolSchema ? (previousCriticalToolSchema ? previousCriticalToolSchema === currentCriticalToolSchema : null) : null;
  const toolsVisible = clientState?.toolsVisible === undefined ? null : clientState.toolsVisible;
  const unavailableToolNames = new Set((clientState?.unavailableToolNames || []).map((name) => String(name || '').trim()).filter(Boolean));
  const missingRequiredRecoveryToolNames = (serverRecovery.capabilities || [])
    .map((capability) => String(capability?.toolName || '').trim())
    .filter((toolName) => toolName && unavailableToolNames.has(toolName));
  const identityMismatch = contractMatch === false || runtimeMatch === false || toolSurfaceMatch === false;
  const schemaMismatch = criticalToolSchemaMatch === false;
  const schemaParityProven = !currentCriticalToolSchema || criticalToolSchemaMatch === true;
  const clientObservationState: RuntimeRecoveryClientObservationState = !observed
    ? 'unknown'
    : toolsVisible === false || missingRequiredRecoveryToolNames.length > 0
      ? 'missing-tools'
      : schemaMismatch
        ? 'schema-mismatch'
        : identityMismatch
          ? 'stale'
          : toolsVisible === true && contractMatch === true && runtimeMatch === true && toolSurfaceMatch === true && schemaParityProven
            ? 'ready'
            : 'unknown';
  const serverReady = Boolean(serverRecovery.ready);
  const reasonCodes: string[] = [];
  if (!serverReady) reasonCodes.push('SERVER_RECOVERY_SURFACE_NOT_READY');
  if (toolsVisible === false) reasonCodes.push('CLIENT_TOOLS_NOT_VISIBLE');
  if (missingRequiredRecoveryToolNames.length > 0) reasonCodes.push('CLIENT_REQUIRED_RECOVERY_TOOLS_MISSING');
  if (contractMatch === false) reasonCodes.push('CLIENT_CONTRACT_MISMATCH');
  if (runtimeMatch === false) reasonCodes.push('CLIENT_RUNTIME_MISMATCH');
  if (toolSurfaceMatch === false) reasonCodes.push('CLIENT_TOOL_SURFACE_MISMATCH');
  if (criticalToolSchemaMatch === false) reasonCodes.push('CLIENT_TOOL_SCHEMA_MISMATCH');
  if (currentCriticalToolSchema && criticalToolSchemaMatch === null) reasonCodes.push('CLIENT_TOOL_SCHEMA_PARITY_NOT_PROVEN');
  if (serverReady && clientObservationState === 'unknown') reasonCodes.push('CLIENT_RECOVERY_PARITY_NOT_PROVEN');

  const endToEndState: RuntimeRecoveryEndToEndState = !serverReady
    ? 'not-ready'
    : clientObservationState === 'ready'
      ? 'ready'
      : clientObservationState === 'stale' || clientObservationState === 'missing-tools' || clientObservationState === 'schema-mismatch'
        ? 'not-ready'
        : 'unknown';
  const endToEndReady = endToEndState === 'ready' ? true : endToEndState === 'not-ready' ? false : null;
  const clientNeedsRefresh = clientObservationState === 'stale' || clientObservationState === 'missing-tools' || clientObservationState === 'schema-mismatch';
  const nextAction = endToEndState === 'ready'
    ? 'No recovery-surface refresh is required; server capability and client-observed registry evidence match.'
    : !serverReady
      ? 'Repair the server-advertised closure recovery capability surface before relying on recovery operations.'
      : clientNeedsRefresh
        ? 'Reconnect or refresh the ChatGPT MCP/plugin tool registry. After tools are visible and current again, call get_recovery_handoff to continue from DevFlow-owned durable state without replaying mutations.'
        : 'Client recovery parity is not proven. Supply the client-observed contract version, runtime instance, tool-surface fingerprint, critical-tool schema fingerprint, and tool visibility before claiming end-to-end recovery readiness.';

  return {
    server: {
      scope: 'server-advertised',
      profile: serverRecovery.profile ? String(serverRecovery.profile) : null,
      ready: Boolean(serverReady),
      toolSurfaceIdentity: String(serverRecovery.toolSurfaceIdentity || current.toolSurfaceIdentity || ''),
      missingCapabilityIds: Array.isArray(serverRecovery.missingCapabilityIds) ? [...serverRecovery.missingCapabilityIds] : [],
    },
    clientObserved: { observed, state: clientObservationState, toolsVisible, contractMatch, runtimeMatch, toolSurfaceMatch, criticalToolSchemaMatch, missingRequiredRecoveryToolNames },
    endToEnd: {
      state: endToEndState,
      ready: endToEndReady,
      reasonCodes,
      nextAction,
      ...(clientNeedsRefresh ? { recoverySurface: 'get_recovery_handoff' as const } : {}),
    },
  };
}


function runtimeSourceRoot() {
  return path.resolve(process.env.DEVFLOW_RUNTIME_SOURCE_ROOT || getDevFlowAppRoot());
}

function readRuntimeSourceSnapshot(root = runtimeSourceRoot()): RuntimeSourceSnapshot {
  const observedAt = new Date().toISOString();
  try {
    const revision = getRepoRevisionForRoot(root);
    return {
      available: true,
      revision: revision.head || null,
      treeId: revision.treeId || null,
      repoToken: revision.token || null,
      dirty: revision.changedFiles.length > 0,
      changedFileCount: revision.changedFiles.length,
      observedAt,
    };
  } catch (error: any) {
    return {
      available: false,
      revision: null,
      treeId: null,
      repoToken: null,
      dirty: null,
      changedFileCount: null,
      observedAt,
      errorCode: String(error?.code || error?.payload?.code || 'RUNTIME_SOURCE_REVISION_UNAVAILABLE'),
    };
  }
}

const loadedSource = readRuntimeSourceSnapshot();
const runtimeIdentity: Omit<RuntimeIdentity, 'transport'> = {
  runtimeInstanceId: randomUUID(),
  runtimeStartedAt: new Date().toISOString(),
  loadedRevision: loadedSource.revision,
  loadedTreeId: loadedSource.treeId,
  loadedRepoToken: loadedSource.repoToken,
  loadedSourceDirty: loadedSource.dirty,
  loadedSourceChangedFileCount: loadedSource.changedFileCount,
  sourceRevisionAvailable: loadedSource.available,
};

function resolveTransports(): DevFlowMcpTransport[] {
  return ['streamable-http', 'legacy-sse'];
}

export function getRuntimeIdentity(): RuntimeIdentity {
  return {
    ...runtimeIdentity,
    transport: resolveTransports(),
  };
}

export function getRuntimeSourceFreshness(): RuntimeSourceFreshness {
  const current = readRuntimeSourceSnapshot();
  const loadedRevision = loadedSource.revision;
  const currentRevision = current.revision;
  const headMismatch = Boolean(loadedRevision && currentRevision && loadedRevision !== currentRevision);
  const contentEquivalent = Boolean(headMismatch && loadedSource.treeId && current.treeId && loadedSource.treeId === current.treeId);
  const common = {
    loadedRevision,
    currentRevision,
    loadedTreeId: loadedSource.treeId,
    currentTreeId: current.treeId,
    contentEquivalent,
    loadedRepoToken: loadedSource.repoToken,
    currentRepoToken: current.repoToken,
    loadedSourceDirty: loadedSource.dirty,
    currentSourceDirty: current.dirty,
    currentChangedFileCount: current.changedFileCount,
    headMismatch,
  };

  if (!loadedSource.available || !current.available || !loadedRevision || !currentRevision) {
    return {
      code: 'unavailable',
      ...common,
      detail: 'DevFlow could not prove the process-loaded source revision against the configured local source repository.',
      nextAction: 'Restore a readable local DevFlow Git source root before treating runtime source freshness as current; do not fetch or mutate Git as part of this diagnostic.',
    };
  }

  if (loadedSource.dirty || current.dirty) {
    return {
      code: 'dirty-ambiguous',
      ...common,
      detail: headMismatch
        ? 'The configured DevFlow source HEAD moved after runtime start and the source tree is dirty, so the exact deployed source cannot be inferred from Git HEAD alone.'
        : 'The configured DevFlow source tree is or was dirty, so Git HEAD alone cannot prove the exact source bytes loaded by this runtime.',
      nextAction: 'Resolve or intentionally preserve local source changes, then restart only when no durable operation or active WIP could be interrupted; do not label this runtime current from HEAD alone.',
    };
  }

  if (contentEquivalent) {
    return {
      code: 'content-equivalent',
      ...common,
      detail: `The DevFlow source commit moved from ${loadedRevision} to ${currentRevision}, but both commits resolve to the same Git tree ${current.treeId}.`,
      nextAction: 'No source-content restart is required; the loaded and current clean source trees are content-equivalent.',
    };
  }

  if (headMismatch) {
    return {
      code: 'stale',
      ...common,
      detail: `The DevFlow process loaded ${loadedRevision} but the configured local source repository is now at ${currentRevision}.`,
      nextAction: 'Restart the DevFlow API when no durable operation or active WIP could be interrupted so the process loads the current local source revision; do not auto-restart or cancel active work.',
    };
  }

  return {
    code: 'current',
    ...common,
    detail: `The DevFlow process-loaded source revision matches the configured local source revision ${currentRevision}.`,
    nextAction: 'No source-revision restart is required.',
  };
}

const MAX_RUNTIME_CONTRACT_GAP_PATHS = 50;
const MAX_RUNTIME_CONTRACT_MATCHED_PATHS = 20;
const RUNTIME_CONTRACT_SENSITIVE_PREFIXES = ['src/server/contracts/'] as const;
const RUNTIME_CONTRACT_SENSITIVE_PATHS = new Set([
  'src/server/mcp.ts',
  'src/server/routes/devflow.ts',
  'src/server/services/mcpToolMonitor.ts',
  'src/server/services/mcpTransportMonitor.ts',
  'src/server/services/runtimeIdentityService.ts',
  'src/server/services/workflowHealthService.ts',
  'src/server/services/workflowRecoveryHandoffService.ts',
]);

function isRuntimeContractSensitivePath(value: string) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return RUNTIME_CONTRACT_SENSITIVE_PATHS.has(normalized)
    || RUNTIME_CONTRACT_SENSITIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function getRuntimeContractImpact(source: RuntimeSourceFreshness = getRuntimeSourceFreshness()): RuntimeContractImpact {
  const common = {
    loadedRevision: source.loadedRevision,
    currentRevision: source.currentRevision,
    changedPaths: [] as string[],
    matchedPaths: [] as string[],
    truncated: false,
  };
  if (source.code !== 'stale') {
    return { code: 'not-applicable', ...common, reasonCodes: ['RUNTIME_SOURCE_NOT_STALE'] };
  }
  if (!source.loadedRevision || !source.currentRevision) {
    return { code: 'unknown', ...common, reasonCodes: ['RUNTIME_REVISION_GAP_UNAVAILABLE'] };
  }
  const delta = getRepoChangedPathsBetweenRevisions(
    runtimeSourceRoot(),
    source.loadedRevision,
    source.currentRevision,
    MAX_RUNTIME_CONTRACT_GAP_PATHS,
  );
  if (!delta.available) {
    return {
      code: 'unknown',
      ...common,
      reasonCodes: ['RUNTIME_REVISION_GAP_UNAVAILABLE', delta.errorCode || 'REVISION_DIFF_FAILED'],
    };
  }
  const matchedPaths = delta.paths.filter(isRuntimeContractSensitivePath).slice(0, MAX_RUNTIME_CONTRACT_MATCHED_PATHS);
  if (matchedPaths.length > 0) {
    return {
      code: 'contract-sensitive',
      loadedRevision: source.loadedRevision,
      currentRevision: source.currentRevision,
      changedPaths: delta.paths,
      matchedPaths,
      truncated: delta.truncated,
      reasonCodes: ['RUNTIME_CONTRACT_SURFACE_CHANGED', ...(delta.truncated ? ['RUNTIME_REVISION_GAP_TRUNCATED'] : [])],
    };
  }
  if (delta.truncated) {
    return {
      code: 'unknown',
      loadedRevision: source.loadedRevision,
      currentRevision: source.currentRevision,
      changedPaths: delta.paths,
      matchedPaths: [],
      truncated: true,
      reasonCodes: ['RUNTIME_REVISION_GAP_TRUNCATED', 'RUNTIME_CONTRACT_IMPACT_UNPROVEN'],
    };
  }
  return {
    code: 'none',
    loadedRevision: source.loadedRevision,
    currentRevision: source.currentRevision,
    changedPaths: delta.paths,
    matchedPaths: [],
    truncated: false,
    reasonCodes: ['RUNTIME_REVISION_GAP_NON_CONTRACT'],
  };
}

export function getRuntimeRestartSafety(): RuntimeRestartSafety {
  const query = queryExecutionSessions({ status: 'active', limit: 100 });
  const authorityByTask = new Map<string, ReturnType<typeof classifyLifecycleLiveWorkAuthority> | null>();
  const active: RuntimeRestartSafetyEntry[] = [];
  const cleanupDebt: RuntimeRestartSafetyEntry[] = [];
  let resultTruncated = query.truncated;

  const appendBounded = (target: RuntimeRestartSafetyEntry[], entry: RuntimeRestartSafetyEntry, limit: number) => {
    if (target.length < limit) target.push(entry);
    else resultTruncated = true;
  };

  for (const session of query.sessions) {
    const checkpoint = getLatestExecutionCheckpoint(session.id);
    const pendingOperationIds = (checkpoint?.pendingOperations || [])
      .filter((entry) => entry.status === 'accepted' || entry.status === 'running')
      .map((entry) => entry.operationId)
      .filter(Boolean);
    const changedFiles = Array.from(new Set(session.changedFiles || [])).slice(0, 50);
    const taskId = String(session.taskId || '').trim();
    const baseEntry = {
      taskId: session.taskId,
      executionSessionId: session.id,
      workspaceId: session.workspaceId,
      stage: session.lifecycle.stage,
      pendingOperationIds,
      changedFiles,
    };

    if (!taskId) {
      if (pendingOperationIds.length > 0) {
        appendBounded(active, {
          ...baseEntry,
          classification: 'durable-operation-without-task',
          reasonCodes: ['PENDING_DURABLE_OPERATION', 'TASK_ID_MISSING'],
        }, MAX_RUNTIME_RESTART_BLOCKERS);
      } else {
        appendBounded(cleanupDebt, {
          ...baseEntry,
          classification: 'non-authoritative-execution',
          reasonCodes: ['TASK_ID_MISSING', 'NON_AUTHORITATIVE_EXECUTION'],
          nextAction: 'Inspect with cleanup_orphan_executions dry-run; this stale execution row is non-blocking unless durable work or recoverable WIP is discovered.',
        }, MAX_RUNTIME_RESTART_DEBT);
      }
      continue;
    }

    let authority = authorityByTask.get(taskId);
    if (authority === undefined) {
      try {
        authority = classifyLifecycleLiveWorkAuthority(taskId, {
          workspaceId: session.workspaceId || undefined,
        });
      } catch {
        authority = null;
      }
      authorityByTask.set(taskId, authority);
    }

    if (!authority) {
      if (pendingOperationIds.length > 0) {
        appendBounded(active, {
          ...baseEntry,
          classification: 'durable-operation-without-task',
          reasonCodes: ['PENDING_DURABLE_OPERATION', 'TASK_AUTHORITY_UNAVAILABLE'],
        }, MAX_RUNTIME_RESTART_BLOCKERS);
      } else {
        appendBounded(cleanupDebt, {
          ...baseEntry,
          classification: 'non-authoritative-execution',
          reasonCodes: ['TASK_AUTHORITY_UNAVAILABLE', 'NON_AUTHORITATIVE_EXECUTION'],
          nextAction: 'Inspect with cleanup_orphan_executions dry-run; unresolved historical authority is surfaced as cleanup debt instead of permanently blocking restart.',
        }, MAX_RUNTIME_RESTART_DEBT);
      }
      continue;
    }

    const restartProjection = authority.operations.restart;
    const terminalInvalidWorkspaceHistory = authority.classification === 'invalid-workspace-authority'
      && authority.task.status === 'done'
      && !authority.claim.active
      && authority.durableOperations.count === 0;
    const entry: RuntimeRestartSafetyEntry = {
      ...baseEntry,
      classification: authority.classification,
      reasonCodes: restartProjection.reasonCodes,
    };
    if (restartProjection.hardBlocked && !terminalInvalidWorkspaceHistory) {
      appendBounded(active, entry, MAX_RUNTIME_RESTART_BLOCKERS);
    } else if (restartProjection.debt || terminalInvalidWorkspaceHistory) {
      appendBounded(cleanupDebt, {
        ...entry,
        nextAction: terminalInvalidWorkspaceHistory
          ? 'Preserve this terminal task history for audited recovery; invalid workspace authority without a live claim or durable operation is cleanup debt and does not block API restart.'
          : 'Inspect with cleanup_orphan_executions dry-run and apply only when the canonical orphan-cleanup classifier confirms the execution is safe.',
      }, MAX_RUNTIME_RESTART_DEBT);
    }
  }

  return {
    blocked: active.length > 0 || query.truncated,
    truncated: resultTruncated,
    active,
    cleanupDebt,
  };
}

function classifyClientRuntimeIdentity(current: RuntimeIdentityWithContract, clientState?: RuntimeClientState): RuntimeDiagnosis | undefined {
  if (!clientState) return undefined;

  const previousContract = String(clientState.contractVersion || '').trim();
  const previousRuntime = String(clientState.runtimeInstanceId || '').trim();
  const previousToolSurface = String(clientState.toolSurfaceIdentity || '').trim();
  const contractChanged = Boolean(previousContract && previousContract !== current.contractVersion);
  const runtimeChanged = Boolean(previousRuntime && previousRuntime !== current.runtimeInstanceId);
  const toolSurfaceChanged = Boolean(previousToolSurface && previousToolSurface !== current.toolSurfaceIdentity);

  if (toolSurfaceChanged) {
    return {
      code: 'tool-surface-changed',
      detail: runtimeChanged
        ? 'The DevFlow runtime restarted and its advertised MCP tool/schema surface changed since the client registry was loaded.'
        : 'The client MCP tool/schema surface fingerprint does not match the current DevFlow runtime.',
      nextAction: 'Reconnect DevFlow and refresh the ChatGPT plugin/tool registry before issuing more MCP calls; open a fresh chat if the stale registry remains cached.',
    };
  }

  if (runtimeChanged && contractChanged) {
    return {
      code: 'deployment-changed',
      detail: 'The DevFlow runtime instance and contract version both changed, which indicates a new deployment or schema surface.',
      nextAction: 'Reconnect the MCP client and refresh the ChatGPT plugin/tool registry before relying on cached tool schemas.',
    };
  }

  if (runtimeChanged) {
    return {
      code: 'runtime-restarted',
      detail: 'The contract version is unchanged but the runtime instance changed, which indicates a DevFlow process restart.',
      nextAction: 'Reconnect the MCP client; refresh the plugin connection if the client still shows stale tools.',
    };
  }

  if (!runtimeChanged && !contractChanged && clientState.toolsVisible === false && previousRuntime) {
    return {
      code: 'client-registry-desync',
      detail: 'The DevFlow runtime and contract are unchanged and the server diagnostic surface is healthy, but the client reports missing tools. DevFlow cannot repair the ChatGPT tool registry automatically.',
      nextAction: 'Refresh or reconnect the ChatGPT plugin; if tools remain stale, open a fresh chat so the client reloads the tool registry. After tools are available again, call get_recovery_handoff to resume from DevFlow-owned durable state.',
      recoverySurface: 'get_recovery_handoff',
    };
  }

  if (contractChanged) {
    return {
      code: 'contract-changed',
      detail: 'The contract version changed while the runtime instance appears unchanged.',
      nextAction: 'Refresh the client tool schema before issuing further MCP calls.',
    };
  }

  return {
    code: 'runtime-current',
    detail: 'The observed runtime and contract match the current DevFlow process.',
    nextAction: 'No runtime identity recovery action is required.',
  };
}

function classifySourceFreshness(source: RuntimeSourceFreshness): RuntimeDiagnosis | undefined {
  if (source.code === 'current' || source.code === 'content-equivalent') return undefined;
  if (source.code === 'stale') {
    return {
      code: 'runtime-source-stale',
      detail: source.detail,
      nextAction: source.nextAction,
      sourceFreshness: source,
    };
  }
  if (source.code === 'dirty-ambiguous') {
    return {
      code: 'runtime-source-dirty-ambiguous',
      detail: source.detail,
      nextAction: source.nextAction,
      sourceFreshness: source,
    };
  }
  return {
    code: 'runtime-source-unavailable',
    detail: source.detail,
    nextAction: source.nextAction,
    sourceFreshness: source,
  };
}

export function classifyRuntimeIdentity(
  current: RuntimeIdentityWithContract,
  clientState?: RuntimeClientState,
): RuntimeDiagnosis | undefined {
  const source = current.sourceFreshness || getRuntimeSourceFreshness();
  let sourceDiagnosis = classifySourceFreshness(source);
  const clientDiagnosis = classifyClientRuntimeIdentity(current, clientState);
  if (sourceDiagnosis && source.code === 'stale') {
    const contractImpact = getRuntimeContractImpact(source);
    sourceDiagnosis = contractImpact.code === 'contract-sensitive'
      ? {
          code: 'runtime-source-stale-contract-sensitive',
          detail: `${source.detail} The loaded-to-current revision gap touches authoritative MCP/runtime contract surfaces (${contractImpact.matchedPaths.join(', ')}).`,
          nextAction: 'Use the existing guarded API restart when restart safety permits, then reconnect/refresh the client tool registry. Until then, rely only on the currently advertised running tool surface and do not infer newly integrated runtime/tool behavior.',
          recoverySurface: 'get_recovery_handoff',
          sourceFreshness: source,
          contractImpact,
          runningToolSurfaceIdentity: current.toolSurfaceIdentity,
        }
      : { ...sourceDiagnosis, contractImpact, runningToolSurfaceIdentity: current.toolSurfaceIdentity };
  }

  if (sourceDiagnosis) {
    const restartSafety = getRuntimeRestartSafety();
    const blockerIdentities = restartSafety.active
      .map((entry) => `${entry.taskId || 'task-unknown'}/${entry.executionSessionId}/${entry.stage}`)
      .join(', ');
    const contractSensitive = sourceDiagnosis.code === 'runtime-source-stale-contract-sensitive';
    const diagnosed = restartSafety.blocked
      ? {
          ...sourceDiagnosis,
          restartSafety,
          nextAction: contractSensitive
            ? `The running MCP/runtime contract is stale and restart is blocked by authoritative live work (${blockerIdentities || 'bounded active-session scan is truncated'}). Continue only compatible already-owned work or mechanical finalization using the currently advertised tool surface; do not reason from newly integrated runtime/tool behavior. Resolve or preserve blockers, then use the guarded API restart and reconnect/refresh the client registry.`
            : `Restart is blocked by durable operation or active WIP risk (${blockerIdentities || 'bounded active-session scan is truncated'}). Resolve or preserve the reported pending operation/WIP safely, then restart; lifecycle stage labels alone do not authorize or block restart.`,
        }
      : restartSafety.cleanupDebt.length > 0
        ? {
            ...sourceDiagnosis,
            restartSafety,
            nextAction: `${sourceDiagnosis.nextAction} ${restartSafety.cleanupDebt.length} bounded stale/non-authoritative execution record(s) remain as non-blocking cleanup debt; inspect cleanup_orphan_executions with dry-run after restart rather than cancelling or deleting them implicitly.`,
          }
        : { ...sourceDiagnosis, restartSafety };
    return clientDiagnosis
      ? { ...diagnosed, concurrentDiagnostics: [clientDiagnosis] }
      : diagnosed;
  }
  return clientDiagnosis;
}
