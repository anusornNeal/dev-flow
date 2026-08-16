import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getRuntimeIdentity } from './runtimeIdentityService.js';

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
    takeoverBlockedReason?: string;
  };
}

export interface ZrokTakeoverResult {
  ok: boolean;
  changed: boolean;
  code?:
    | 'ZROK_TAKEOVER_NOT_AVAILABLE'
    | 'ZROK_TAKEOVER_REMOTE_FENCE_UNAVAILABLE'
    | 'ZROK_TAKEOVER_REMOTE_FENCE_FAILED'
    | 'ZROK_TAKEOVER_STALE_OWNER'
    | 'ZROK_TAKEOVER_LOCAL_SHARE_FAILED'
    | 'ZROK_TAKEOVER_VERIFY_FAILED'
    | 'ZROK_TAKEOVER_FAILED';
  message: string;
  status: ZrokRuntimeStatus;
}

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
}

export interface ZrokAgentShareRecord {
  token: string;
  status: 'active' | 'retrying' | 'failed' | 'unknown';
}

export interface ZrokAgentStatusSnapshot {
  reachable: boolean;
  shares: ZrokAgentShareRecord[];
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
  listNames(): Promise<ZrokNameRecord[]>;
  listShares(): Promise<ZrokShareRecord[]>;
  listEnvironments(): Promise<ZrokEnvironmentRecord[]>;
  getAgentStatus(input: { apiEndpoint: string; accountToken: string; envZId: string }): Promise<ZrokAgentStatusSnapshot>;
  unshareRemote(input: { apiEndpoint: string; accountToken: string; envZId: string; shareToken: string }): Promise<void>;
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
}

interface DiscoverySnapshot {
  environment: ZrokEnvironmentSnapshot;
  serviceState: ZrokServiceState;
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
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
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

async function loadDiscovery(
  adapter: ZrokRuntimeAdapter,
  config: ZrokRuntimeConfig,
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

  let serviceState: ZrokServiceState;
  try {
    serviceState = await adapter.getServiceState(config.serviceName);
  } catch {
    serviceState = 'unknown';
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
        ? 'local'
        : 'remote';
  const baseUrl = normalizeBaseUrl(config.baseUrl || managedName.url || currentShare?.frontendEndpoints[0]);
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
    const remotelyVisible = Boolean(
      remoteEnrolled
      && ownerAgentStatus?.reachable
      && token
      && ownerAgentStatus.shares.some((share) => share.token === token),
    );
    let blockedReason: string | undefined;
    if (serviceState !== 'running') blockedReason = 'The local zrok agent service must be running before takeover.';
    else if (!remoteEnrolled) blockedReason = 'The active machine is not enrolled for authenticated zrok agent remoting.';
    else if (!remotelyVisible) blockedReason = 'The active machine cannot be fenced through authenticated zrok agent remoting right now.';

    return publicStatus('standby', checkedAt, {
      baseUrl,
      serviceState,
      shareState: 'remote-active',
      owner,
      probe: publicProbe,
      message: 'Standby · active on another machine',
      canTakeOver: !blockedReason,
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

function sameManagedName(left: ZrokNameRecord, right: ZrokNameRecord) {
  return left.namespaceToken === right.namespaceToken && normalizeName(left.name) === normalizeName(right.name);
}

export function createZrokRuntimeService(
  adapter: ZrokRuntimeAdapter,
  config: ZrokRuntimeConfig,
): ZrokRuntimeService {
  let takeoverInFlight: Promise<ZrokTakeoverResult> | null = null;

  const getStatus = async (): Promise<ZrokRuntimeStatus> => {
    try {
      const discovery = await loadDiscovery(adapter, config);
      return 'status' in discovery ? discovery : statusFromDiscovery(adapter, discovery);
    } catch {
      return safeSetupError(adapter, 'DevFlow could not inspect the zrok runtime safely. Run Recheck or zrok setup again.');
    }
  };

  const performTakeover = async (): Promise<ZrokTakeoverResult> => {
    let discovery: DiscoverySnapshot | ZrokRuntimeStatus;
    try {
      discovery = await loadDiscovery(adapter, config);
    } catch {
      const status = safeSetupError(adapter, 'DevFlow could not inspect the zrok runtime safely.');
      return safeTakeoverFailure('ZROK_TAKEOVER_FAILED', 'Takeover could not start because zrok runtime inspection failed.', status);
    }

    if ('status' in discovery) {
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
    if (
      discovery.serviceState !== 'running'
      || !isRemoteAgentEnrolled(discovery.environments, remoteShare.envZId)
      || !discovery.ownerAgentStatus?.reachable
      || !discovery.ownerAgentStatus.shares.some((share) => share.token === remoteShare.shareToken)
    ) {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_REMOTE_FENCE_UNAVAILABLE',
        'The active machine cannot be fenced through authenticated zrok agent remoting. No ownership change was attempted.',
        initialStatus,
      );
    }

    // Fence only the exact owner we inspected. If the account binding changed while we
    // were checking remote-agent status, stop rather than racing a new owner.
    try {
      const [freshNames, freshShares] = await Promise.all([adapter.listNames(), adapter.listShares()]);
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
    } catch {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_STALE_OWNER',
        'DevFlow could not confirm that the active zrok owner was unchanged. No ownership change was attempted.',
        initialStatus,
      );
    }

    try {
      await adapter.unshareRemote({
        apiEndpoint: environment.apiEndpoint!,
        accountToken: environment.accountToken!,
        envZId: remoteShare.envZId,
        shareToken: remoteShare.shareToken,
      });
    } catch {
      return safeTakeoverFailure(
        'ZROK_TAKEOVER_REMOTE_FENCE_FAILED',
        'The active machine did not confirm release of the managed zrok share. Local activation was not attempted.',
        await getStatus(),
      );
    }

    // Confirm the old agent no longer reports the exact share before claiming the name.
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

    // A different binding appearing after the old owner was fenced is a stale/race signal.
    try {
      const [postFenceNames, postFenceShares] = await Promise.all([adapter.listNames(), adapter.listShares()]);
      const postFenceName = postFenceNames.find((name) => sameManagedName(name, discovery.managedName));
      const rebound = postFenceName?.shareToken
        ? postFenceShares.find((share) => share.shareToken === postFenceName.shareToken)
        : undefined;
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

  return {
    getStatus,
    takeOver() {
      if (takeoverInFlight) return takeoverInFlight;
      takeoverInFlight = performTakeover().finally(() => {
        takeoverInFlight = null;
      });
      return takeoverInFlight;
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
}

export function createDefaultZrokRuntimeAdapter(options: DefaultZrokRuntimeAdapterOptions = {}): ZrokRuntimeAdapter {
  const binary = options.binary || process.env.DEVFLOW_ZROK_BIN?.trim() || 'zrok2';
  const zrokDir = path.resolve(options.zrokDir || process.env.DEVFLOW_ZROK_DIR?.trim() || path.join(os.homedir(), '.zrok2'));
  const commandTimeoutMs = options.commandTimeoutMs ?? 7_500;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl || fetch;

  const command = (args: string[]): CommandResult => {
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: commandTimeoutMs,
      maxBuffer: 1_000_000,
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
        return { reachable: true, shares };
      } catch {
        return { reachable: false, shares: [] };
      }
    },

    async unshareRemote(input) {
      await accountPost(input, 'agent/unshare', {
        envZId: input.envZId,
        token: input.shareToken,
      });
    },

    async startLocalShare(input) {
      const result = command([
        'share',
        'public',
        input.target,
        '--force-agent',
        '--open',
        '--name-selection',
        input.nameSelection,
      ]);
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

function defaultConfig(): ZrokRuntimeConfig {
  const runtime = getRuntimeIdentity();
  return {
    serviceName: process.env.DEVFLOW_ZROK_SERVICE_NAME?.trim() || 'zrokAgent',
    target: process.env.DEVFLOW_ZROK_TARGET?.trim() || 'http://127.0.0.1:3000',
    nameSelection: process.env.DEVFLOW_ZROK_NAME_SELECTION?.trim() || undefined,
    preferredName: process.env.DEVFLOW_ZROK_RESERVED_NAME?.trim() || undefined,
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
