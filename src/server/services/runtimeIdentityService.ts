import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths.js';
import { getRepoRevisionForRoot } from './repoRevisionService.js';
import { queryExecutionSessions } from '../repositories/executionSessionRepository.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';

export type DevFlowMcpTransport = 'streamable-http' | 'legacy-sse';

export type RuntimeSourceFreshnessCode = 'current' | 'stale' | 'dirty-ambiguous' | 'unavailable';

export interface RuntimeSourceSnapshot {
  available: boolean;
  revision: string | null;
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
  loadedRepoToken: string | null;
  currentRepoToken: string | null;
  loadedSourceDirty: boolean | null;
  currentSourceDirty: boolean | null;
  currentChangedFileCount: number | null;
  headMismatch: boolean;
  detail: string;
  nextAction: string;
}

export interface RuntimeRestartSafety {
  blocked: boolean;
  truncated: boolean;
  active: Array<{
    taskId: string | null;
    executionSessionId: string;
    workspaceId: string | null;
    stage: string;
    reasonCodes: string[];
    pendingOperationIds: string[];
    changedFiles: string[];
  }>;
}
const MAX_RUNTIME_RESTART_BLOCKERS = 10;

export interface RuntimeIdentity {
  runtimeInstanceId: string;
  runtimeStartedAt: string;
  transport: DevFlowMcpTransport[];
  loadedRevision: string | null;
  loadedRepoToken: string | null;
  loadedSourceDirty: boolean | null;
  loadedSourceChangedFileCount: number | null;
  sourceRevisionAvailable: boolean;
}

export interface RuntimeClientState {
  contractVersion?: string;
  runtimeInstanceId?: string;
  toolSurfaceIdentity?: string;
  toolsVisible?: boolean;
}

export interface RuntimeIdentityWithContract extends RuntimeIdentity {
  contractVersion: string;
  toolSurfaceIdentity: string;
  sourceFreshness?: RuntimeSourceFreshness;
}

export type RuntimeDiagnosisCode =
  | 'runtime-restarted'
  | 'tool-surface-changed'
  | 'deployment-changed'
  | 'client-registry-desync'
  | 'contract-changed'
  | 'runtime-source-stale'
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
      repoToken: revision.token || null,
      dirty: revision.changedFiles.length > 0,
      changedFileCount: revision.changedFiles.length,
      observedAt,
    };
  } catch (error: any) {
    return {
      available: false,
      revision: null,
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
  const common = {
    loadedRevision,
    currentRevision,
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

export function getRuntimeRestartSafety(): RuntimeRestartSafety {
  const query = queryExecutionSessions({ status: 'active', limit: 100 });
  const active = query.sessions
    .flatMap((session) => {
      const checkpoint = getLatestExecutionCheckpoint(session.id);
      const pendingOperationIds = (checkpoint?.pendingOperations || [])
        .filter((entry) => entry.status === 'accepted' || entry.status === 'running')
        .map((entry) => entry.operationId)
        .filter(Boolean);
      const changedFiles = Array.from(new Set(session.changedFiles || [])).slice(0, 50);
      const reasonCodes = [
        ...(pendingOperationIds.length > 0 ? ['PENDING_DURABLE_OPERATION'] : []),
        ...(changedFiles.length > 0 ? ['ACTIVE_WIP_RISK'] : []),
      ];
      if (reasonCodes.length === 0) return [];
      return [{
        taskId: session.taskId,
        executionSessionId: session.id,
        workspaceId: session.workspaceId,
        stage: session.lifecycle.stage,
        reasonCodes,
        pendingOperationIds,
        changedFiles,
      }];
    })
    .slice(0, MAX_RUNTIME_RESTART_BLOCKERS);
  return {
    blocked: active.length > 0 || query.truncated,
    truncated: query.truncated,
    active,
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
  if (source.code === 'current') return undefined;
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
  const sourceDiagnosis = classifySourceFreshness(source);
  const clientDiagnosis = classifyClientRuntimeIdentity(current, clientState);

  if (sourceDiagnosis) {
    const restartSafety = getRuntimeRestartSafety();
    const blockerIdentities = restartSafety.active
      .map((entry) => `${entry.taskId || 'task-unknown'}/${entry.executionSessionId}/${entry.stage}`)
      .join(', ');
    const diagnosed = restartSafety.blocked
      ? {
          ...sourceDiagnosis,
          restartSafety,
          nextAction: `Restart is blocked by durable operation or active WIP risk (${blockerIdentities || 'bounded active-session scan is truncated'}). Resolve or preserve the reported pending operation/WIP safely, then restart; lifecycle stage labels alone do not authorize or block restart.`, 
        }
      : { ...sourceDiagnosis, restartSafety };
    return clientDiagnosis
      ? { ...diagnosed, concurrentDiagnostics: [clientDiagnosis] }
      : diagnosed;
  }
  return clientDiagnosis;
}
