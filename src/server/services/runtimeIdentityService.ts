import { randomUUID } from 'node:crypto';

export type DevFlowMcpTransport = 'streamable-http' | 'legacy-sse';

export interface RuntimeIdentity {
  runtimeInstanceId: string;
  runtimeStartedAt: string;
  transport: DevFlowMcpTransport[];
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
}

export type RuntimeDiagnosisCode =
  | 'runtime-restarted'
  | 'tool-surface-changed'
  | 'deployment-changed'
  | 'client-registry-desync'
  | 'contract-changed'
  | 'runtime-current';

export interface RuntimeDiagnosis {
  code: RuntimeDiagnosisCode;
  detail: string;
  nextAction: string;
  recoverySurface?: 'get_recovery_handoff';
}

const runtimeIdentity: Omit<RuntimeIdentity, 'transport'> = {
  runtimeInstanceId: randomUUID(),
  runtimeStartedAt: new Date().toISOString(),
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

export function classifyRuntimeIdentity(
  current: RuntimeIdentityWithContract,
  clientState?: RuntimeClientState,
): RuntimeDiagnosis | undefined {
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
