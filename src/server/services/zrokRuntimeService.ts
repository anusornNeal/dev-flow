import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getRuntimeIdentity } from './runtimeIdentityService.js';
import { getDevFlowRuntimeDir } from '../../lib/devFlowPaths.js';
import {
  createZrokAgentConsoleClient,
  selectTargetShare,
  type ZrokAgentConsoleClient,
  type ZrokLocalAgentShare,
  type ZrokLocalAgentStatus,
} from './zrokAgentConsoleClient.js';

export type ZrokRuntimeStatusCode =
  | 'setup-required'
  | 'starting'
  | 'online'
  | 'degraded'
  | 'offline'
  | 'standby'
  | 'setup-error';

export type ZrokServiceState = 'missing' | 'stopped' | 'starting' | 'running' | 'unknown';
export type ZrokShareState = 'missing' | 'starting' | 'active' | 'retrying' | 'failed' | 'remote-active' | 'unknown';
export type ZrokPublicState = 'unknown' | 'healthy' | 'unhealthy';

export interface ZrokRuntimeStatus {
  status: ZrokRuntimeStatusCode;
  statusLabel: 'Setup required' | 'Starting' | 'Online' | 'Degraded' | 'Offline' | 'Standby' | 'Setup error';
  baseUrl: string | null;
  mcpUrl: string | null;
  agentService: {
    state: ZrokServiceState;
  };
  share: {
    state: ZrokShareState;
    owner: 'none' | 'local' | 'remote' | 'unknown';
  };
  publicReachability: {
    state: ZrokPublicState;
    routedToThisMachine: boolean | null;
  };
  latencyMs: number | null;
  lastCheckedAt: string;
  message?: string;
  actionability: {
    canRecheck: true;
    canTakeOver: boolean;
    canSwitchHere: boolean;
    canRecoverStaleSameMachineOwner?: boolean;
    takeoverBlockedReason?: string;
  };
}

interface ZrokRuntimeTransitionResult<TCode extends string> {
  ok: boolean;
  changed: boolean;
  code?: TCode;
  message: string;
  status: ZrokRuntimeStatus;
}

export interface ZrokTakeoverResult extends ZrokRuntimeTransitionResult<
  | 'ZROK_TAKEOVER_NOT_AVAILABLE'
  | 'ZROK_TAKEOVER_IN_PROGRESS'
  | 'ZROK_TAKEOVER_REMOTE_FENCE_UNAVAILABLE'
  | 'ZROK_TAKEOVER_REMOTE_FENCE_FAILED'
  | 'ZROK_TAKEOVER_STALE_OWNER'
  | 'ZROK_TAKEOVER_LOCAL_SHARE_FAILED'
  | 'ZROK_TAKEOVER_VERIFY_FAILED'
  | 'ZROK_TAKEOVER_FAILED'
> {}

export interface ZrokSwitchHereResult extends ZrokRuntimeTransitionResult<
    | 'ZROK_SWITCH_NOT_AVAILABLE'
    | 'ZROK_SWITCH_IN_PROGRESS'
    | 'ZROK_SWITCH_STALE_OWNER'
    | 'ZROK_SWITCH_DELETE_FAILED'
    | 'ZROK_SWITCH_LOCAL_SHARE_FAILED'
    | 'ZROK_SWITCH_VERIFY_FAILED'
    | 'ZROK_SWITCH_FAILED'
> {}

export interface ZrokEnvironmentSnapshot {
  enabled: boolean;
  envZId?: string;
  apiEndpoint?: string;
  accountToken?: string;
  defaultNamespace?: string;
}

export interface ZrokNameRecord {
  url?: string;
  name: string;
  namespaceToken: string;
  namespaceName?: string;
  shareToken?: string;
  reserved: boolean;
}

export interface ZrokShareRecord {
  shareToken: string;
  envZId: string;
  shareMode?: string;
  backendMode?: string;
  target?: string;
  frontendEndpoints: string[];
}

export interface ZrokEnvironmentRecord {
  envZId: string;
  remoteAgent: boolean;
  description?: string;
  host?: string;
  address?: string;
}

export interface ZrokAgentShareRecord {
  token: string;
  status: 'active' | 'retrying' | 'failed' | 'unknown';
}

export interface ZrokAgentStatusSnapshot {
  reachable: boolean;
  shares: ZrokAgentShareRecord[];
  remoteControl?: 'available' | 'unsupported' | 'unavailable';
}

export interface ZrokPublicProbe {
  state: ZrokPublicState;
  latencyMs: number | null;
  routedToThisMachine: boolean | null;
}

export interface ZrokRuntimeAdapter {
  isInstalled(): Promise<boolean>;
  readEnvironment(): Promise<ZrokEnvironmentSnapshot>;
  getServiceState(serviceName: string): Promise<ZrokServiceState>;
  getLocalAgentStatus(): Promise<ZrokLocalAgentStatus>;
  listNames(): Promise<ZrokNameRecord[]>;
  listShares(): Promise<ZrokShareRecord[]>;
  listEnvironments(): Promise<ZrokEnvironmentRecord[]>;
  getAgentStatus(input: { apiEndpoint: string; accountToken: string; envZId: string }): Promise<ZrokAgentStatusSnapshot>;
  unshareRemote(input: { apiEndpoint: string; accountToken: string; envZId: string; shareToken: string }): Promise<void>;
  deleteShare(input: { envZId: string; shareToken: string }): Promise<void>;
  startLocalShare(input: { target: string; nameSelection: string }): Promise<void>;
  probePublic(input: { baseUrl: string; expectedRuntimeInstanceId: string }): Promise<ZrokPublicProbe>;
  now(): Date;
}

export interface ZrokRuntimeConfig {
  serviceName: string;
  target: string;
  nameSelection?: string;
  preferredName?: string;
  baseUrl?: string;
  expectedRuntimeInstanceId: string;
}

export interface ZrokRuntimeService {
  getStatus(): Promise<ZrokRuntimeStatus>;
  takeOver(): Promise<ZrokTakeoverResult>;
  switchHere(): Promise<ZrokSwitchHereResult>;
}

interface DiscoverySnapshot {
  environment: ZrokEnvironmentSnapshot;
  serviceState: ZrokServiceState;
  localAgentReachable: boolean;
  names: ZrokNameRecord[];
  shares: ZrokShareRecord[];
  environments: ZrokEnvironmentRecord[];
  managedName: ZrokNameRecord;
  currentShare?: ZrokShareRecord;
  owner: 'none' | 'local' | 'remote' | 'unknown';
  baseUrl: string | null;
  publicProbe: ZrokPublicProbe;
  ownerAgentStatus?: ZrokAgentStatusSnapshot;
}

const STATUS_LABELS: Record<ZrokRuntimeStatusCode, ZrokRuntimeStatus['statusLabel']> = {
  'setup-required': 'Setup required',
  starting: 'Starting',
  online: 'Online',
  degraded: 'Degraded',
  offline: 'Offline',
  standby: 'Standby',
  'setup-error': 'Setup error',
};

class ZrokRuntimeInternalError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function normalizeBaseUrl(value?: string | null) {
  const raw = String(value || '');
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    const url = new URL(candidate);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeTarget(value?: string | null) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeName(value?: string | null) {
  return String(value || '').trim().toLowerCase();
}

function parseNameSelection(value?: string | null) {
  const text = String(value || '').trim();
  if (!text) return null;
  const index = text.indexOf(':');
  if (index < 0) return { namespaceToken: '', name: text };
  return {
    namespaceToken: text.slice(0, index).trim(),
    name: text.slice(index + 1).trim(),
  };
}

function buildNameSelection(name: ZrokNameRecord) {
  return `${name.namespaceToken}:${name.name}`;
}

function publicStatus(
  code: ZrokRuntimeStatusCode,
  checkedAt: string,
  input: {
    baseUrl?: string | null;
    serviceState?: ZrokServiceState;
    shareState?: ZrokShareState;
    owner?: 'none' | 'local' | 'remote' | 'unknown';
    probe?: ZrokPublicProbe;
    message?: string;
    canTakeOver?: boolean;
    canSwitchHere?: boolean;
    canRecoverStaleSameMachineOwner?: boolean;
    takeoverBlockedReason?: string;
  } = {},
): ZrokRuntimeStatus {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const probe = input.probe || { state: 'unknown' as const, latencyMs: null, routedToThisMachine: null };
  return {
    status: code,
    statusLabel: STATUS_LABELS[code],
    baseUrl,
    mcpUrl: baseUrl ? `${baseUrl}/mcp` : null,
    agentService: { state: input.serviceState || 'unknown' },
    share: {
      state: input.shareState || 'unknown',
      owner: input.owner || 'unknown',
    },
    publicReachability: {
      state: probe.state,
      routedToThisMachine: probe.routedToThisMachine,
    },
    latencyMs: probe.latencyMs,
    lastCheckedAt: checkedAt,
    ...(input.message ? { message: input.message } : {}),
    actionability: {
      canRecheck: true,
      canTakeOver: Boolean(input.canTakeOver),
      canSwitchHere: Boolean(input.canSwitchHere),
      canRecoverStaleSameMachineOwner: Boolean(input.canRecoverStaleSameMachineOwner),
      ...(input.takeoverBlockedReason ? { takeoverBlockedReason: input.takeoverBlockedReason } : {}),
    },
  };
}

function shareStateFromAgent(status: ZrokAgentStatusSnapshot | undefined, token: string | undefined): ZrokShareState {
  if (!token) return 'missing';
  const share = status?.shares.find((item) => item.token === token);
  if (!share) return status?.reachable ? 'unknown' : 'unknown';
  if (share.status === 'active') return 'active';
  if (share.status === 'retrying') return 'retrying';
  if (share.status === 'failed') return 'failed';
  return 'unknown';
}

function chooseManagedName(
  names: ZrokNameRecord[],
  shares: ZrokShareRecord[],
  config: ZrokRuntimeConfig,
): ZrokNameRecord | null {
  const explicit = parseNameSelection(config.nameSelection);
  if (explicit) {
    const matches = names.filter((name) => {
      if (normalizeName(name.name) !== normalizeName(explicit.name)) return false;
      return !explicit.namespaceToken || name.namespaceToken === explicit.namespaceToken;
    });
    if (matches.length === 1) return matches[0];
    return null;
  }

  const preferredName = normalizeName(config.preferredName);
  if (preferredName) {
    const matches = names.filter((name) => normalizeName(name.name) === preferredName);
    if (matches.length === 1) return matches[0];
  }

  const reserved = names.filter((name) => name.reserved);
  const target = normalizeTarget(config.target);
  const targetTokens = new Set(
    shares
      .filter((share) => normalizeTarget(share.target) === target)
      .map((share) => share.shareToken)
      .filter(Boolean),
  );
  const targetMatches = reserved.filter((name) => name.shareToken && targetTokens.has(name.shareToken));
  if (targetMatches.length === 1) return targetMatches[0];

  const devflowNames = reserved.filter((name) => /^dev-?flow|^devflow/i.test(name.name));
  if (devflowNames.length === 1) return devflowNames[0];
  if (reserved.length === 1) return reserved[0];
  return null;
}

function safeSetupError(adapter: ZrokRuntimeAdapter, message: string): ZrokRuntimeStatus {
  return publicStatus('setup-error', adapter.now().toISOString(), {
    message,
    shareState: 'unknown',
    owner: 'unknown',
  });
}

function isRemoteAgentEnrolled(environments: ZrokEnvironmentRecord[], envZId: string) {
  return environments.some((environment) => environment.envZId === envZId && environment.remoteAgent);
}

function environmentMachineIdentity(environment: ZrokEnvironmentRecord | undefined) {
  const parts = String(environment?.host || '').split(';').map((part) => normalizeName(part));
  if (!parts[0] || !parts[1]) return null;
  return { username: parts[0], hostname: parts[1] };
}

function isSameMachinePredecessor(
  environments: ZrokEnvironmentRecord[],
  currentEnvZId: string | undefined,
  ownerEnvZId: string,
) {
  if (!currentEnvZId || currentEnvZId === ownerEnvZId) return false;
  const current = environmentMachineIdentity(environments.find((environment) => environment.envZId === currentEnvZId));
  const owner = environmentMachineIdentity(environments.find((environment) => environment.envZId === ownerEnvZId));
  return Boolean(
    current
    && owner
    && current.username === owner.username
    && current.hostname === owner.hostname,
  );
}

function isStaleSameMachineOwner(discovery: DiscoverySnapshot) {
  const ownerEnvZId = discovery.currentShare?.envZId;
  return Boolean(
    discovery.owner === 'remote'
    && ownerEnvZId
    && discovery.serviceState === 'running'
    && discovery.publicProbe.state === 'unhealthy'
    && !isRemoteAgentEnrolled(discovery.environments, ownerEnvZId)
    && isSameMachinePredecessor(discovery.environments, discovery.environment.envZId, ownerEnvZId),
  );
}

function remoteFenceAvailable(discovery: DiscoverySnapshot) {
  const remoteShare = discovery.currentShare;
  return Boolean(
    discovery.owner === 'remote'
    && remoteShare
    && discovery.serviceState === 'running'
    && isRemoteAgentEnrolled(discovery.environments, remoteShare.envZId)
    && discovery.ownerAgentStatus?.reachable
    && discovery.ownerAgentStatus.remoteControl === 'available'
    && discovery.ownerAgentStatus.shares.some((share) => share.token === remoteShare.shareToken),
  );
}

function canSwitchHere(discovery: DiscoverySnapshot) {
  const remoteShare = discovery.currentShare;
  const remoteEnrolled = Boolean(remoteShare && isRemoteAgentEnrolled(discovery.environments, remoteShare.envZId));
  return Boolean(
    discovery.owner === 'remote'
    && remoteShare
    && discovery.serviceState === 'running'
    && discovery.localAgentReachable
    && !isStaleSameMachineOwner(discovery)
    && (
      !remoteEnrolled
      || discovery.ownerAgentStatus?.remoteControl === 'unsupported'
    ),
  );
}

function localShareState(share: ZrokLocalAgentShare): ZrokShareState {
  const status = normalizeName(share.status);
  if (status === 'active' || status === 'retrying' || status === 'failed') return status;
  return 'unknown';
}

async function statusFromLocalAgent(
  adapter: ZrokRuntimeAdapter,
  config: ZrokRuntimeConfig,
  serviceState: ZrokServiceState,
  share: ZrokLocalAgentShare,
): Promise<ZrokRuntimeStatus> {
  const checkedAt = adapter.now().toISOString();
  const baseUrl = normalizeBaseUrl(share.frontendEndpoint);
  const shareState = localShareState(share);
  let probe: ZrokPublicProbe = { state: 'unknown', latencyMs: null, routedToThisMachine: null };
  if (baseUrl) {
    try {
      probe = await adapter.probePublic({ baseUrl, expectedRuntimeInstanceId: config.expectedRuntimeInstanceId });
    } catch {
      probe = { state: 'unhealthy', latencyMs: null, routedToThisMachine: null };
    }
  }

  if (serviceState === 'starting' || shareState === 'retrying') {
    return publicStatus('starting', checkedAt, {
      baseUrl,
      serviceState,
      shareState,
      owner: 'local',
      probe,
      message: shareState === 'retrying'
        ? 'The local zrok share is retrying its connection.'
        : 'The local zrok agent service is starting.',
    });
  }
  if (serviceState === 'missing' || serviceState === 'stopped' || shareState === 'failed') {
    return publicStatus('offline', checkedAt, {
      baseUrl,
      serviceState,
      shareState,
      owner: 'local',
      probe,
      message: shareState === 'failed'
        ? 'The local zrok share failed to start.'
        : 'The local zrok agent service is not running.',
    });
  }
  if (baseUrl && shareState === 'active' && probe.state === 'healthy' && probe.routedToThisMachine === true) {
    return publicStatus('online', checkedAt, {
      baseUrl,
      serviceState,
      shareState,
      owner: 'local',
      probe,
      message: 'The public zrok endpoint is routing to this DevFlow runtime.',
    });
  }
  return publicStatus('degraded', checkedAt, {
    baseUrl,
    serviceState,
    shareState,
    owner: 'local',
    probe,
    message: baseUrl
      ? 'The local zrok share exists, but the public DevFlow endpoint is not healthy.'
      : 'The local zrok Agent reported an invalid public endpoint.',
  });
}

async function loadDiscovery(
  adapter: ZrokRuntimeAdapter,
  config: ZrokRuntimeConfig,
  trustedPublicBaseUrl: string | null = null,
): Promise<DiscoverySnapshot | ZrokRuntimeStatus> {
  const checkedAt = adapter.now().toISOString();
  const installed = await adapter.isInstalled();
  if (!installed) {
    return publicStatus('setup-required', checkedAt, {
      serviceState: 'missing',
      shareState: 'missing',
      owner: 'none',
      message: 'zrok is not installed yet. Start DevFlow setup to finish zrok configuration.',
    });
  }

  let serviceState: ZrokServiceState;
  try {
    serviceState = await adapter.getServiceState(config.serviceName);
  } catch {
    serviceState = 'unknown';
  }

  let localAgentStatus: ZrokLocalAgentStatus = { reachable: false, shares: [] };
  try {
    localAgentStatus = await adapter.getLocalAgentStatus();
  } catch {}
  if (!localAgentStatus.reachable) {
    const blockedReason = 'The local zrok Agent authority is unreachable, so ownership cannot be determined safely.';
    const baseUrl = normalizeBaseUrl(trustedPublicBaseUrl || config.baseUrl);
    let probe: ZrokPublicProbe = { state: 'unknown', latencyMs: null, routedToThisMachine: null };
    if (baseUrl) {
      try {
        probe = await adapter.probePublic({
          baseUrl,
          expectedRuntimeInstanceId: config.expectedRuntimeInstanceId,
        });
      } catch {
        probe = { state: 'unhealthy', latencyMs: null, routedToThisMachine: null };
      }
    }
    return publicStatus('degraded', checkedAt, {
      baseUrl,
      serviceState,
      shareState: 'unknown',
      owner: 'unknown',
      probe,
      message: blockedReason,
      takeoverBlockedReason: blockedReason,
    });
  }
  const localSelection = selectTargetShare(localAgentStatus, config.target);
  if (localSelection.kind === 'one' && localSelection.share) {
    return statusFromLocalAgent(adapter, config, serviceState, localSelection.share);
  }
  if (localSelection.kind === 'ambiguous') {
    const blockedReason = 'Multiple local zrok shares match the configured DevFlow target.';
    return publicStatus('degraded', checkedAt, {
      serviceState,
      shareState: 'unknown',
      owner: 'unknown',
      message: blockedReason,
      takeoverBlockedReason: blockedReason,
    });
  }

  let environment: ZrokEnvironmentSnapshot;
  try {
    environment = await adapter.readEnvironment();
  } catch {
    return publicStatus('setup-error', checkedAt, {
      message: 'The local zrok environment could not be read safely. Run DevFlow zrok setup again.',
    });
  }
  if (!environment.enabled || !environment.envZId || !environment.accountToken || !environment.apiEndpoint) {
    return publicStatus('setup-required', checkedAt, {
      serviceState: 'unknown',
      shareState: 'missing',
      owner: 'none',
      message: 'The local zrok environment is not enabled yet. Start DevFlow setup to finish zrok configuration.',
    });
  }

  let names: ZrokNameRecord[];
  let shares: ZrokShareRecord[];
  let environments: ZrokEnvironmentRecord[];
  try {
    [names, shares, environments] = await Promise.all([
      adapter.listNames(),
      adapter.listShares(),
      adapter.listEnvironments(),
    ]);
  } catch {
    return publicStatus('setup-error', checkedAt, {
      serviceState,
      shareState: 'unknown',
      owner: 'unknown',
      message: 'DevFlow could not read the zrok account state. Check zrok connectivity and run Recheck.',
    });
  }

  const managedName = chooseManagedName(names, shares, config);
  if (!managedName) {
    return publicStatus('setup-error', checkedAt, {
      serviceState,
      shareState: 'missing',
      owner: 'unknown',
      baseUrl: config.baseUrl,
      message: 'DevFlow could not identify one managed reserved zrok name. Run DevFlow zrok setup again.',
    });
  }

  const currentShare = managedName.shareToken
    ? shares.find((share) => share.shareToken === managedName.shareToken)
    : undefined;
  const owner: DiscoverySnapshot['owner'] = !managedName.shareToken
    ? 'none'
    : !currentShare
      ? 'unknown'
      : currentShare.envZId === environment.envZId
        ? 'unknown'
        : 'remote';
  const baseUrl = normalizeBaseUrl(currentShare?.frontendEndpoints[0] || managedName.url || config.baseUrl);
  let publicProbe: ZrokPublicProbe = { state: 'unknown', latencyMs: null, routedToThisMachine: null };
  if (baseUrl) {
    try {
      publicProbe = await adapter.probePublic({
        baseUrl,
        expectedRuntimeInstanceId: config.expectedRuntimeInstanceId,
      });
    } catch {
      publicProbe = { state: 'unhealthy', latencyMs: null, routedToThisMachine: null };
    }
  }

  let ownerAgentStatus: ZrokAgentStatusSnapshot | undefined;
  if (currentShare && isRemoteAgentEnrolled(environments, currentShare.envZId)) {
    try {
      ownerAgentStatus = await adapter.getAgentStatus({
        apiEndpoint: environment.apiEndpoint,
        accountToken: environment.accountToken,
        envZId: currentShare.envZId,
      });
    } catch {
      ownerAgentStatus = { reachable: false, shares: [] };
    }
  }

  return {
    environment,
    serviceState,
    localAgentReachable: localAgentStatus.reachable,
    names,
    shares,
    environments,
    managedName,
    currentShare,
    owner,
    baseUrl,
    publicProbe,
    ownerAgentStatus,
  };
}

function statusFromDiscovery(adapter: ZrokRuntimeAdapter, discovery: DiscoverySnapshot): ZrokRuntimeStatus {
  const checkedAt = adapter.now().toISOString();
  const { serviceState, currentShare, owner, publicProbe, ownerAgentStatus, baseUrl, environment, environments } = discovery;
  const token = currentShare?.shareToken;

  if (owner === 'remote') {
    const remoteEnrolled = Boolean(currentShare && isRemoteAgentEnrolled(environments, currentShare.envZId));
    const staleSameMachineRecoverable = isStaleSameMachineOwner(discovery);
    const remotelyVisible = Boolean(
      remoteEnrolled
      && ownerAgentStatus?.reachable
      && token
      && ownerAgentStatus.shares.some((share) => share.token === token),
    );
    let blockedReason: string | undefined;
    if (serviceState !== 'running') blockedReason = 'The local zrok agent service must be running before takeover.';
    else if (staleSameMachineRecoverable) blockedReason = undefined;
    else if (!remoteEnrolled) blockedReason = 'The active machine is not enrolled for authenticated zrok agent remoting.';
    else if (ownerAgentStatus?.remoteControl === 'unsupported') blockedReason = 'Remote zrok agent control is unsupported by the controller.';
    else if (!remotelyVisible || ownerAgentStatus?.remoteControl !== 'available') blockedReason = 'The active machine cannot be fenced through authenticated zrok agent remoting right now.';

    return publicStatus('standby', checkedAt, {
      baseUrl,
      serviceState,
      shareState: 'remote-active',
      owner,
      probe: publicProbe,
      message: staleSameMachineRecoverable
        ? 'Standby · stale zrok owner from this machine can be recovered safely'
        : 'Standby · active on another machine',
      canTakeOver: !blockedReason,
      canSwitchHere: canSwitchHere(discovery),
      canRecoverStaleSameMachineOwner: staleSameMachineRecoverable,
      takeoverBlockedReason: blockedReason,
    });
  }

  if (serviceState === 'starting') {
    return publicStatus('starting', checkedAt, {
      baseUrl,
      serviceState,
      shareState: shareStateFromAgent(ownerAgentStatus, token),
      owner,
      probe: publicProbe,
      message: 'The local zrok agent service is starting.',
    });
  }

  if (owner === 'unknown') {
    return publicStatus('degraded', checkedAt, {
      baseUrl,
      serviceState,
      shareState: 'unknown',
      owner,
      probe: publicProbe,
      message: 'The managed zrok name is bound, but its active environment could not be identified safely.',
    });
  }

  if (serviceState === 'missing' || serviceState === 'stopped') {
    return publicStatus('offline', checkedAt, {
      baseUrl,
      serviceState,
      shareState: currentShare ? 'unknown' : 'missing',
      owner,
      probe: publicProbe,
      message: serviceState === 'missing'
        ? 'The zrok agent service is not installed.'
        : 'The zrok agent service is stopped.',
    });
  }

  if (owner === 'none' || !currentShare) {
    return publicStatus('offline', checkedAt, {
      baseUrl,
      serviceState,
      shareState: 'missing',
      owner: 'none',
      probe: publicProbe,
      message: 'The managed zrok name is ready, but this machine is not sharing it right now.',
    });
  }

  const agentShareState = shareStateFromAgent(ownerAgentStatus, token);
  if (agentShareState === 'retrying') {
    return publicStatus('starting', checkedAt, {
      baseUrl,
      serviceState,
      shareState: 'retrying',
      owner: 'local',
      probe: publicProbe,
      message: 'The local zrok share is retrying its connection.',
    });
  }
  if (agentShareState === 'failed') {
    return publicStatus('offline', checkedAt, {
      baseUrl,
      serviceState,
      shareState: 'failed',
      owner: 'local',
      probe: publicProbe,
      message: 'The local zrok share failed to start.',
    });
  }

  if (publicProbe.state === 'healthy' && publicProbe.routedToThisMachine === true) {
    return publicStatus('online', checkedAt, {
      baseUrl,
      serviceState,
      shareState: 'active',
      owner: 'local',
      probe: publicProbe,
      message: 'The public zrok endpoint is routing to this DevFlow runtime.',
    });
  }

  return publicStatus('degraded', checkedAt, {
    baseUrl,
    serviceState,
    shareState: agentShareState === 'active' ? 'active' : 'unknown',
    owner: 'local',
    probe: publicProbe,
    message: publicProbe.routedToThisMachine === false
      ? 'The managed zrok URL is reachable but is not routing to this DevFlow runtime.'
      : 'The local zrok share exists, but the public DevFlow endpoint is not healthy.',
  });
}

function safeTakeoverFailure(
  code: Exclude<ZrokTakeoverResult['code'], undefined>,
  message: string,
  status: ZrokRuntimeStatus,
): ZrokTakeoverResult {
  return { ok: false, changed: false, code, message, status };
}

function safeSwitchFailure(
  code: Exclude<ZrokSwitchHereResult['code'], undefined>,
  message: string,
  status: ZrokRuntimeStatus,
): ZrokSwitchHereResult {
  return { ok: false, changed: false, code, message, status };
}

function sameManagedName(left: ZrokNameRecord, right: ZrokNameRecord) {
  return left.namespaceToken === right.namespaceToken && normalizeName(left.name) === normalizeName(right.name);
}

export function createZrokRuntimeService(
  adapter: ZrokRuntimeAdapter,
  config: ZrokRuntimeConfig,
): ZrokRuntimeService {
  let transitionInFlight:
    | { kind: 'takeover'; promise: Promise<ZrokTakeoverResult> }
    | { kind: 'switchHere'; promise: Promise<ZrokSwitchHereResult> }
    | null = null;
  let trustedPublicBaseUrl = normalizeBaseUrl(config.baseUrl);

  const rememberTrustedBaseUrl = (status: ZrokRuntimeStatus) => {
    if (status.baseUrl && status.share.owner !== 'unknown') trustedPublicBaseUrl = status.baseUrl;
    return status;
  };

  const getStatus = async (): Promise<ZrokRuntimeStatus> => {
    try {
      const discovery = await loadDiscovery(adapter, config, trustedPublicBaseUrl);
      const status = 'status' in discovery ? discovery : statusFromDiscovery(adapter, discovery);
      return rememberTrustedBaseUrl(status);
    } catch {
      return safeSetupError(adapter, 'DevFlow could not inspect the zrok runtime safely. Run Recheck or zrok setup again.');
    }
  };

  const withTakeoverTransition = async (transition: () => Promise<ZrokTakeoverResult>): Promise<ZrokTakeoverResult> => {
    if (transitionInFlight?.kind === 'takeover') return transitionInFlight.promise;
    if (transitionInFlight?.kind === 'switchHere') {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_IN_PROGRESS',
        'Another zrok ownership transition is already in progress.',
        await getStatus(),
      );
    }
    const promise = transition().finally(() => {
      if (transitionInFlight?.promise === promise) transitionInFlight = null;
    });
    transitionInFlight = { kind: 'takeover', promise };
    return promise;
  };

  const withSwitchTransition = async (transition: () => Promise<ZrokSwitchHereResult>): Promise<ZrokSwitchHereResult> => {
    if (transitionInFlight?.kind === 'switchHere') return transitionInFlight.promise;
    if (transitionInFlight?.kind === 'takeover') {
      return safeSwitchFailure(
        'ZROK_SWITCH_IN_PROGRESS',
        'Another zrok ownership transition is already in progress.',
        await getStatus(),
      );
    }
    const promise = transition().finally(() => {
      if (transitionInFlight?.promise === promise) transitionInFlight = null;
    });
    transitionInFlight = { kind: 'switchHere', promise };
    return promise;
  };

  const performTakeover = async (): Promise<ZrokTakeoverResult> => {
    let discovery: DiscoverySnapshot | ZrokRuntimeStatus;
    try {
      discovery = await loadDiscovery(adapter, config, trustedPublicBaseUrl);
    } catch {
      const status = safeSetupError(adapter, 'DevFlow could not inspect the zrok runtime safely.');
      return safeTakeoverFailure('ZROK_TAKEOVER_FAILED', 'Takeover could not start because zrok runtime inspection failed.', status);
    }

    if ('status' in discovery) {
      if (discovery.status === 'online' && discovery.share.owner === 'local') {
        return {
          ok: true,
          changed: false,
          message: 'This machine already owns the managed zrok endpoint.',
          status: discovery,
        };
      }
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_NOT_AVAILABLE',
        'Takeover is unavailable until zrok setup is healthy.',
        discovery,
      );
    }

    const initialStatus = statusFromDiscovery(adapter, discovery);
    if (initialStatus.status === 'online' && discovery.owner === 'local') {
      return {
        ok: true,
        changed: false,
        message: 'This machine already owns the managed zrok endpoint.',
        status: initialStatus,
      };
    }

    if (discovery.owner !== 'remote' || !discovery.currentShare) {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_NOT_AVAILABLE',
        'Takeover is only available while the managed zrok endpoint is active on another machine.',
        initialStatus,
      );
    }

    const remoteShare = discovery.currentShare;
    const environment = discovery.environment;
    const staleSameMachineRecovery = isStaleSameMachineOwner(discovery);
    if (!staleSameMachineRecovery && !remoteFenceAvailable(discovery)) {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_REMOTE_FENCE_UNAVAILABLE',
        'The active machine cannot be fenced through authenticated zrok agent remoting. No ownership change was attempted.',
        initialStatus,
      );
    }

    // Fence only the exact owner we inspected. If the account binding changed while we
    // were checking remote-agent status, stop rather than racing a new owner.
    try {
      const [freshNames, freshShares, freshEnvironments] = await Promise.all([
        adapter.listNames(),
        adapter.listShares(),
        adapter.listEnvironments(),
      ]);
      const freshName = freshNames.find((name) => sameManagedName(name, discovery.managedName));
      const freshShare = freshName?.shareToken
        ? freshShares.find((share) => share.shareToken === freshName.shareToken)
        : undefined;
      if (!freshName || freshName.shareToken !== remoteShare.shareToken || freshShare?.envZId !== remoteShare.envZId) {
        return safeTakeoverFailure(
          'ZROK_TAKEOVER_STALE_OWNER',
          'The active zrok owner changed during takeover preflight. No ownership change was attempted.',
          await getStatus(),
        );
      }
      if (staleSameMachineRecovery) {
        const sameMachineStillProven = isSameMachinePredecessor(
          freshEnvironments,
          environment.envZId,
          remoteShare.envZId,
        );
        const stillUnenrolled = !isRemoteAgentEnrolled(freshEnvironments, remoteShare.envZId);
        const freshProbe = discovery.baseUrl
          ? await adapter.probePublic({
              baseUrl: discovery.baseUrl,
              expectedRuntimeInstanceId: config.expectedRuntimeInstanceId,
            })
          : { state: 'unknown' as const, latencyMs: null, routedToThisMachine: null };
        if (!sameMachineStillProven || !stillUnenrolled || freshProbe.state !== 'unhealthy') {
          return safeTakeoverFailure(
            'ZROK_TAKEOVER_STALE_OWNER',
            'The stale same-machine zrok owner could not be revalidated immediately before release. No ownership change was attempted.',
            await getStatus(),
          );
        }
      }
    } catch {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_STALE_OWNER',
        'DevFlow could not confirm that the active zrok owner was unchanged. No ownership change was attempted.',
        initialStatus,
      );
    }

    try {
      if (staleSameMachineRecovery) {
        await adapter.deleteShare({
          envZId: remoteShare.envZId,
          shareToken: remoteShare.shareToken,
        });
      } else {
        await adapter.unshareRemote({
          apiEndpoint: environment.apiEndpoint!,
          accountToken: environment.accountToken!,
          envZId: remoteShare.envZId,
          shareToken: remoteShare.shareToken,
        });
      }
    } catch {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_REMOTE_FENCE_FAILED',
        staleSameMachineRecovery
          ? 'The exact stale same-machine zrok share could not be released. Local activation was not attempted.'
          : 'The active machine did not confirm release of the managed zrok share. Local activation was not attempted.',
        await getStatus(),
      );
    }

    // Authenticated remote owners must be proven fenced through the remote agent.
    if (!staleSameMachineRecovery) {
      try {
        const fenced = await adapter.getAgentStatus({
          apiEndpoint: environment.apiEndpoint!,
          accountToken: environment.accountToken!,
          envZId: remoteShare.envZId,
        });
        if (!fenced.reachable || fenced.shares.some((share) => share.token === remoteShare.shareToken)) {
          return safeTakeoverFailure(
            'ZROK_TAKEOVER_REMOTE_FENCE_FAILED',
            'The old machine could not be proven fenced. Local activation was not attempted.',
            await getStatus(),
          );
        }
      } catch {
        return safeTakeoverFailure(
          'ZROK_TAKEOVER_REMOTE_FENCE_FAILED',
          'The old machine could not be proven fenced. Local activation was not attempted.',
          await getStatus(),
        );
      }
    }

    // A different binding appearing after the old owner was fenced is a stale/race signal.
    try {
      const [postFenceNames, postFenceShares] = await Promise.all([adapter.listNames(), adapter.listShares()]);
      const postFenceName = postFenceNames.find((name) => sameManagedName(name, discovery.managedName));
      const rebound = postFenceName?.shareToken
        ? postFenceShares.find((share) => share.shareToken === postFenceName.shareToken)
        : undefined;
      const staleShareStillPresent = postFenceShares.some(
        (share) => share.shareToken === remoteShare.shareToken && share.envZId === remoteShare.envZId,
      );
      if (staleSameMachineRecovery && (postFenceName?.shareToken === remoteShare.shareToken || staleShareStillPresent)) {
        return safeTakeoverFailure(
          'ZROK_TAKEOVER_REMOTE_FENCE_FAILED',
          'The old zrok share binding still exists after release. Local activation was not attempted.',
          await getStatus(),
        );
      }
      if (postFenceName?.shareToken && postFenceName.shareToken !== remoteShare.shareToken && rebound?.envZId !== environment.envZId) {
        return safeTakeoverFailure(
          'ZROK_TAKEOVER_STALE_OWNER',
          'Another machine claimed the managed zrok name after fencing. Local activation was not attempted.',
          await getStatus(),
        );
      }
    } catch {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_STALE_OWNER',
        'DevFlow could not confirm the managed name was free after fencing. Local activation was not attempted.',
        await getStatus(),
      );
    }

    try {
      await adapter.startLocalShare({
        target: config.target,
        nameSelection: buildNameSelection(discovery.managedName),
      });
    } catch {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_LOCAL_SHARE_FAILED',
        'The old machine was fenced, but the local zrok share could not be activated.',
        await getStatus(),
      );
    }

    const finalStatus = await getStatus();
    if (finalStatus.status !== 'online' || finalStatus.share.owner !== 'local' || finalStatus.publicReachability.routedToThisMachine !== true) {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_VERIFY_FAILED',
        'The local share started, but the stable public URL did not verify as this DevFlow runtime.',
        finalStatus,
      );
    }

    return {
      ok: true,
      changed: true,
      message: 'Takeover complete. The stable zrok endpoint now routes to this DevFlow runtime.',
      status: finalStatus,
    };
  };

  const performSwitchHere = async (): Promise<ZrokSwitchHereResult> => {
    let discovery: DiscoverySnapshot | ZrokRuntimeStatus;
    try {
      discovery = await loadDiscovery(adapter, config, trustedPublicBaseUrl);
    } catch {
      const status = safeSetupError(adapter, 'DevFlow could not inspect the zrok runtime safely.');
      return safeSwitchFailure('ZROK_SWITCH_FAILED', 'Switch here could not start because zrok runtime inspection failed.', status);
    }

    if ('status' in discovery) {
      if (discovery.status === 'online' && discovery.share.owner === 'local') {
        return {
          ok: true,
          changed: false,
          message: 'This machine already owns the managed zrok endpoint.',
          status: discovery,
        };
      }
      return safeSwitchFailure(
        'ZROK_SWITCH_NOT_AVAILABLE',
        'Switch here is unavailable until zrok setup is healthy.',
        discovery,
      );
    }

    const initialStatus = statusFromDiscovery(adapter, discovery);
    if (initialStatus.status === 'online' && discovery.owner === 'local') {
      return {
        ok: true,
        changed: false,
        message: 'This machine already owns the managed zrok endpoint.',
        status: initialStatus,
      };
    }

    if (!canSwitchHere(discovery) || !discovery.currentShare) {
      return safeSwitchFailure(
        'ZROK_SWITCH_NOT_AVAILABLE',
        'Switch here is only available while the managed zrok endpoint is active on another machine and authenticated remote fencing is unavailable.',
        initialStatus,
      );
    }

    const remoteShare = discovery.currentShare;

    try {
      const [freshNames, freshShares] = await Promise.all([
        adapter.listNames(),
        adapter.listShares(),
      ]);
      const freshName = freshNames.find((name) => sameManagedName(name, discovery.managedName));
      const freshShare = freshName?.shareToken
        ? freshShares.find((share) => share.shareToken === freshName.shareToken)
        : undefined;
      if (!freshName || freshName.shareToken !== remoteShare.shareToken || freshShare?.envZId !== remoteShare.envZId) {
        return safeSwitchFailure(
          'ZROK_SWITCH_STALE_OWNER',
          'The active zrok owner changed during switch preflight. No ownership change was attempted.',
          await getStatus(),
        );
      }
    } catch {
      return safeSwitchFailure(
        'ZROK_SWITCH_STALE_OWNER',
        'DevFlow could not confirm that the active zrok owner was unchanged. No ownership change was attempted.',
        initialStatus,
      );
    }

    try {
      await adapter.deleteShare({
        envZId: remoteShare.envZId,
        shareToken: remoteShare.shareToken,
      });
    } catch {
      return safeSwitchFailure(
        'ZROK_SWITCH_DELETE_FAILED',
        'The exact remote zrok share could not be released. Local activation was not attempted.',
        await getStatus(),
      );
    }

    try {
      const [postDeleteNames, postDeleteShares] = await Promise.all([
        adapter.listNames(),
        adapter.listShares(),
      ]);
      const postDeleteName = postDeleteNames.find((name) => sameManagedName(name, discovery.managedName));
      const rebound = postDeleteName?.shareToken
        ? postDeleteShares.find((share) => share.shareToken === postDeleteName.shareToken)
        : undefined;
      const deletedShareStillPresent = postDeleteShares.some(
        (share) => share.shareToken === remoteShare.shareToken && share.envZId === remoteShare.envZId,
      );
      if (postDeleteName?.shareToken === remoteShare.shareToken || deletedShareStillPresent) {
        return safeSwitchFailure(
          'ZROK_SWITCH_DELETE_FAILED',
          'The old zrok share binding still exists after release. Local activation was not attempted.',
          await getStatus(),
        );
      }
      if (postDeleteName?.shareToken && rebound?.envZId !== discovery.environment.envZId) {
        return safeSwitchFailure(
          'ZROK_SWITCH_STALE_OWNER',
          'Another machine claimed the managed zrok name after release. Local activation was not attempted.',
          await getStatus(),
        );
      }
    } catch {
      return safeSwitchFailure(
        'ZROK_SWITCH_STALE_OWNER',
        'DevFlow could not confirm the managed name was free after release. Local activation was not attempted.',
        await getStatus(),
      );
    }

    try {
      await adapter.startLocalShare({
        target: config.target,
        nameSelection: buildNameSelection(discovery.managedName),
      });
    } catch {
      return safeSwitchFailure(
        'ZROK_SWITCH_LOCAL_SHARE_FAILED',
        'The remote zrok share was released, but the local zrok share could not be activated.',
        await getStatus(),
      );
    }

    const finalStatus = await getStatus();
    if (finalStatus.status !== 'online' || finalStatus.share.owner !== 'local' || finalStatus.publicReachability.routedToThisMachine !== true) {
      return safeSwitchFailure(
        'ZROK_SWITCH_VERIFY_FAILED',
        'The local share started, but the stable public URL did not verify as this DevFlow runtime.',
        finalStatus,
      );
    }

    return {
      ok: true,
      changed: true,
      message: 'Switch complete. The stable zrok endpoint now routes to this DevFlow runtime.',
      status: finalStatus,
    };
  };

  return {
    getStatus,
    takeOver() {
      return withTakeoverTransition(performTakeover);
    },
    switchHere() {
      return withSwitchTransition(performSwitchHere);
    },
  };
}

function valueString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function valueBoolean(value: unknown) {
  return value === true;
}

function pickString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function pickArray(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  }
  return [] as string[];
}

function parseJson(raw: string) {
  const text = String(raw || '').trim();
  if (!text) throw new ZrokRuntimeInternalError('ZROK_EMPTY_JSON');
  try {
    return JSON.parse(text);
  } catch {
    const objectIndex = text.search(/[\[{]/);
    if (objectIndex >= 0) {
      try {
        return JSON.parse(text.slice(objectIndex));
      } catch {}
    }
    throw new ZrokRuntimeInternalError('ZROK_INVALID_JSON');
  }
}

function arrayPayload(value: unknown, key?: string) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && key) {
    const nested = (value as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  missing: boolean;
}

export interface DefaultZrokRuntimeAdapterOptions {
  binary?: string;
  zrokDir?: string;
  commandTimeoutMs?: number;
  fetchTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  agentConsoleClient?: ZrokAgentConsoleClient;
  spawnSyncImpl?: typeof spawnSync;
}

export function resolveZrokServiceProfile(input: {
  platform?: NodeJS.Platform;
  windowsDir?: string;
} = {}) {
  if ((input.platform || process.platform) !== 'win32') return null;
  const windowsDir = input.windowsDir?.trim() || process.env.WINDIR?.trim() || 'C:\\Windows';
  return path.win32.join(windowsDir, 'System32', 'config', 'systemprofile');
}

export function resolveZrokBinary(input: {
  binary?: string;
  platform?: NodeJS.Platform;
  programFilesDir?: string;
  fileExists?: (candidate: string) => boolean;
} = {}) {
  const explicit = input.binary?.trim() || process.env.DEVFLOW_ZROK_BIN?.trim();
  if (explicit) return explicit;
  const platform = input.platform || process.platform;
  if (platform === 'win32') {
    const programFilesDir = input.programFilesDir !== undefined
      ? input.programFilesDir.trim()
      : process.env.ProgramFiles?.trim();
    if (!programFilesDir) return 'zrok2';
    const installedBinary = path.win32.join(programFilesDir, 'zrok2', 'zrok2.exe');
    return (input.fileExists || fs.existsSync)(installedBinary) ? installedBinary : 'zrok2';
  }
  if (platform === 'darwin') {
    const localBinary = path.join(getDevFlowRuntimeDir(), 'bin', 'zrok2');
    if (fs.existsSync(localBinary)) return localBinary;
  }
  return 'zrok2';
}

export function createDefaultZrokRuntimeAdapter(options: DefaultZrokRuntimeAdapterOptions = {}): ZrokRuntimeAdapter {
  const binary = resolveZrokBinary(options);
  const zrokDir = path.resolve(options.zrokDir || process.env.DEVFLOW_ZROK_DIR?.trim() || path.join(os.homedir(), '.zrok2'));
  const commandTimeoutMs = options.commandTimeoutMs ?? 7_500;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl || fetch;
  const agentConsoleClient = options.agentConsoleClient || createZrokAgentConsoleClient({ fetchImpl });
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;

  const command = (args: string[], envOverrides?: NodeJS.ProcessEnv): CommandResult => {
    const result = spawnSyncImpl(binary, args, {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: commandTimeoutMs,
      maxBuffer: 1_000_000,
      env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
    });
    const missing = Boolean((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT');
    return {
      ok: result.status === 0 && !result.error,
      stdout: String(result.stdout || ''),
      missing,
    };
  };

  const accountPost = async (
    input: { apiEndpoint: string; accountToken: string },
    endpoint: string,
    body: Record<string, unknown>,
  ) => {
    const base = input.apiEndpoint.endsWith('/') ? input.apiEndpoint : `${input.apiEndpoint}/`;
    const url = new URL(`api/v2/${endpoint.replace(/^\/+/, '')}`, base);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/zrok.v1+json',
        'x-token': input.accountToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
    if (!response.ok) throw new ZrokRuntimeInternalError(`ZROK_AGENT_HTTP_${response.status}`);
    const text = await response.text();
    if (!text.trim()) return null;
    return parseJson(text);
  };

  return {
    async isInstalled() {
      const result = command(['version']);
      return !result.missing && result.ok;
    },

    async readEnvironment() {
      const environmentPath = path.join(zrokDir, 'environment.json');
      if (!fs.existsSync(environmentPath)) return { enabled: false };
      const environment = parseJson(fs.readFileSync(environmentPath, 'utf8')) as Record<string, unknown>;
      let defaultNamespace = '';
      const configPath = path.join(zrokDir, 'config.json');
      if (fs.existsSync(configPath)) {
        try {
          const config = parseJson(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
          defaultNamespace = pickString(config, 'default_namespace', 'defaultNamespace');
        } catch {}
      }
      return {
        enabled: true,
        envZId: pickString(environment, 'ziti_identity', 'zitiIdentity', 'envZId', 'envZID'),
        apiEndpoint: pickString(environment, 'api_endpoint', 'apiEndpoint'),
        accountToken: pickString(environment, 'zrok_token', 'accountToken'),
        defaultNamespace,
      };
    },

    async getServiceState(serviceName: string) {
      if (process.platform === 'darwin') {
        try {
          return (await agentConsoleClient.getStatus()).reachable ? 'running' : 'stopped';
        } catch {
          return 'unknown';
        }
      }
      if (process.platform !== 'win32') return 'unknown';
      const script = [
        '$svc=Get-Service -Name $env:DEVFLOW_ZROK_SERVICE_QUERY -ErrorAction Stop',
        '$svc.Status.ToString()',
      ].join(';');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 5_000,
        env: { ...process.env, DEVFLOW_ZROK_SERVICE_QUERY: serviceName },
      });
      if (result.status !== 0) return 'missing';
      const status = String(result.stdout || '').trim().toLowerCase();
      if (status === 'running') return 'running';
      if (status === 'startpending' || status === 'continuepending') return 'starting';
      if (status === 'stopped' || status === 'paused' || status === 'stoppending' || status === 'pausepending') return 'stopped';
      return 'unknown';
    },

    async getLocalAgentStatus() {
      return agentConsoleClient.getStatus();
    },

    async listNames() {
      const result = command(['list', 'names', '--json']);
      if (!result.ok) throw new ZrokRuntimeInternalError('ZROK_LIST_NAMES_FAILED');
      return arrayPayload(parseJson(result.stdout)).flatMap((entry): ZrokNameRecord[] => {
        if (!entry || typeof entry !== 'object') return [];
        const record = entry as Record<string, unknown>;
        const name = pickString(record, 'name', 'Name');
        const namespaceToken = pickString(record, 'namespaceToken', 'namespace_token', 'NamespaceToken');
        if (!name || !namespaceToken) return [];
        return [{
          url: pickString(record, 'url', 'URL', 'Url'),
          name,
          namespaceToken,
          namespaceName: pickString(record, 'namespaceName', 'namespace_name', 'NamespaceName'),
          shareToken: pickString(record, 'shareToken', 'share_token', 'ShareToken'),
          reserved: valueBoolean(record.reserved ?? record.Reserved),
        }];
      });
    },

    async listShares() {
      const result = command(['list', 'shares', '--json']);
      if (!result.ok) throw new ZrokRuntimeInternalError('ZROK_LIST_SHARES_FAILED');
      return arrayPayload(parseJson(result.stdout), 'shares').flatMap((entry): ZrokShareRecord[] => {
        if (!entry || typeof entry !== 'object') return [];
        const record = entry as Record<string, unknown>;
        const shareToken = pickString(record, 'shareToken', 'share_token', 'ShareToken', 'token');
        const envZId = pickString(record, 'envZID', 'envZId', 'env_zid', 'EnvZID');
        if (!shareToken || !envZId) return [];
        return [{
          shareToken,
          envZId,
          shareMode: pickString(record, 'shareMode', 'share_mode', 'ShareMode'),
          backendMode: pickString(record, 'backendMode', 'backend_mode', 'BackendMode'),
          target: pickString(record, 'target', 'Target'),
          frontendEndpoints: pickArray(record, 'frontendEndpoints', 'frontend_endpoints', 'FrontendEndpoints'),
        }];
      });
    },

    async listEnvironments() {
      const result = command(['list', 'environments', '--json']);
      if (!result.ok) throw new ZrokRuntimeInternalError('ZROK_LIST_ENVIRONMENTS_FAILED');
      return arrayPayload(parseJson(result.stdout), 'environments').flatMap((entry): ZrokEnvironmentRecord[] => {
        if (!entry || typeof entry !== 'object') return [];
        const record = entry as Record<string, unknown>;
        const envZId = pickString(record, 'envZID', 'envZId', 'env_zid', 'EnvZID');
        if (!envZId) return [];
        return [{
          envZId,
          remoteAgent: valueBoolean(record.remoteAgent ?? record.remote_agent ?? record.RemoteAgent),
          description: pickString(record, 'description', 'Description'),
          host: pickString(record, 'host', 'Host'),
          address: pickString(record, 'address', 'Address'),
        }];
      });
    },

    async getAgentStatus(input) {
      try {
        const payload = await accountPost(input, 'agent/status', { envZId: input.envZId });
        const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        const shares = arrayPayload(record.shares).flatMap((entry): ZrokAgentShareRecord[] => {
          if (!entry || typeof entry !== 'object') return [];
          const share = entry as Record<string, unknown>;
          const token = pickString(share, 'token', 'shareToken', 'share_token');
          if (!token) return [];
          const rawStatus = normalizeName(pickString(share, 'status'));
          const status: ZrokAgentShareRecord['status'] = rawStatus === 'active' || rawStatus === 'retrying' || rawStatus === 'failed'
            ? rawStatus
            : 'unknown';
          return [{ token, status }];
        });
        return { reachable: true, remoteControl: 'available', shares };
      } catch (error) {
        return {
          reachable: false,
          remoteControl: error instanceof ZrokRuntimeInternalError && error.code === 'ZROK_AGENT_HTTP_501'
            ? 'unsupported'
            : 'unavailable',
          shares: [],
        };
      }
    },

    async unshareRemote(input) {
      await accountPost(input, 'agent/unshare', {
        envZId: input.envZId,
        token: input.shareToken,
      });
    },

    async deleteShare(input) {
      const result = command(['delete', 'share', '--envzid', input.envZId, input.shareToken]);
      if (!result.ok) throw new ZrokRuntimeInternalError('ZROK_DELETE_SHARE_FAILED');
    },

    async startLocalShare(input) {
      const serviceProfile = resolveZrokServiceProfile();
      const result = command([
        'share',
        'public',
        input.target,
        '--force-agent',
        '--open',
        '--name-selection',
        input.nameSelection,
      ], serviceProfile ? { USERPROFILE: serviceProfile, HOME: serviceProfile } : undefined);
      if (!result.ok) throw new ZrokRuntimeInternalError('ZROK_LOCAL_SHARE_FAILED');
    },

    async probePublic(input) {
      const base = input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`;
      const url = new URL('api/capabilities', base);
      const startedAt = Date.now();
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(fetchTimeoutMs),
        });
        const latencyMs = Date.now() - startedAt;
        if (!response.ok) return { state: 'unhealthy', latencyMs, routedToThisMachine: null };
        const body = await response.json() as Record<string, unknown>;
        return {
          state: 'healthy',
          latencyMs,
          routedToThisMachine: valueString(body.runtimeInstanceId) === input.expectedRuntimeInstanceId,
        };
      } catch {
        return { state: 'unhealthy', latencyMs: Date.now() - startedAt, routedToThisMachine: null };
      }
    },

    now() {
      return new Date();
    },
  };
}

const MAX_ZROK_SELECTION_BYTES = 4_096;
const MAX_ZROK_RESERVED_NAME_LENGTH = 256;

export function readZrokSelectedReservedName(
  selectionPath = path.join(getDevFlowRuntimeDir(), 'zrok-selection.json'),
): string | undefined {
  try {
    if (!fs.existsSync(selectionPath)) return undefined;
    const stat = fs.statSync(selectionPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ZROK_SELECTION_BYTES) return undefined;
    const payload = JSON.parse(fs.readFileSync(selectionPath, 'utf8')) as Record<string, unknown>;
    const name = typeof payload.reservedName === 'string' ? payload.reservedName.trim() : '';
    if (!name || name.length > MAX_ZROK_RESERVED_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return undefined;
    return name;
  } catch {
    return undefined;
  }
}

export function resolveZrokPreferredName(explicit?: string, selectionPath?: string): string | undefined {
  const configured = explicit?.trim();
  if (configured) return configured;
  return readZrokSelectedReservedName(selectionPath);
}

function defaultConfig(): ZrokRuntimeConfig {
  const runtime = getRuntimeIdentity();
  return {
    serviceName: process.env.DEVFLOW_ZROK_SERVICE_NAME?.trim() || 'zrokAgent',
    target: process.env.DEVFLOW_ZROK_TARGET?.trim() || 'http://127.0.0.1:3000',
    nameSelection: process.env.DEVFLOW_ZROK_NAME_SELECTION?.trim() || undefined,
    preferredName: resolveZrokPreferredName(process.env.DEVFLOW_ZROK_RESERVED_NAME),
    baseUrl: process.env.DEVFLOW_ZROK_BASE_URL?.trim() || undefined,
    expectedRuntimeInstanceId: runtime.runtimeInstanceId,
  };
}

let singleton: ZrokRuntimeService | null = null;

export function getZrokRuntimeService() {
  if (!singleton) {
    singleton = createZrokRuntimeService(createDefaultZrokRuntimeAdapter(), defaultConfig());
  }
  return singleton;
}

export function __resetZrokRuntimeServiceForTests() {
  singleton = null;
}
