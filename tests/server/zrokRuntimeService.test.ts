import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createZrokRuntimeService,
  type ZrokAgentStatusSnapshot,
  type ZrokEnvironmentRecord,
  type ZrokEnvironmentSnapshot,
  type ZrokNameRecord,
  type ZrokPublicProbe,
  type ZrokRuntimeAdapter,
  type ZrokRuntimeConfig,
  type ZrokServiceState,
  type ZrokShareRecord,
} from '../../src/server/services/zrokRuntimeService.js';

const LOCAL_ENV = 'local-env-zid';
const REMOTE_ENV = 'remote-env-zid';
const SECRET_ACCOUNT_TOKEN = 'account-super-secret-do-not-leak';
const MANAGED_NAME = 'devflow-mixed';
const NAME_SELECTION = `public:${MANAGED_NAME}`;
const STABLE_URL = 'https://devflow-mixed.shares.zrok.io';
const REMOTE_TOKEN = 'remote-share-token';
const LOCAL_TOKEN = 'local-share-token';

interface FixtureState {
  installed: boolean;
  environment: ZrokEnvironmentSnapshot;
  serviceState: ZrokServiceState;
  names: ZrokNameRecord[];
  shares: ZrokShareRecord[];
  environments: ZrokEnvironmentRecord[];
  agentShares: Map<string, ZrokAgentStatusSnapshot>;
  probe: ZrokPublicProbe;
  unshareCalls: number;
  startCalls: number;
  failUnshare: boolean;
  failStart: boolean;
}

function baseConfig(): ZrokRuntimeConfig {
  return {
    serviceName: 'zrokAgent',
    target: 'http://127.0.0.1:3000',
    nameSelection: NAME_SELECTION,
    expectedRuntimeInstanceId: 'runtime-local',
  };
}

function makeName(shareToken = ''): ZrokNameRecord {
  return {
    url: STABLE_URL,
    name: MANAGED_NAME,
    namespaceToken: 'public',
    shareToken,
    reserved: true,
  };
}

function makeShare(envZId: string, shareToken: string): ZrokShareRecord {
  return {
    shareToken,
    envZId,
    shareMode: 'public',
    backendMode: 'proxy',
    target: 'http://127.0.0.1:3000',
    frontendEndpoints: [STABLE_URL],
  };
}

function makeFixture(overrides: Partial<FixtureState> = {}) {
  const state: FixtureState = {
    installed: true,
    environment: {
      enabled: true,
      envZId: LOCAL_ENV,
      apiEndpoint: 'https://api-v2.zrok.io',
      accountToken: SECRET_ACCOUNT_TOKEN,
      defaultNamespace: 'public',
    },
    serviceState: 'running',
    names: [makeName(LOCAL_TOKEN)],
    shares: [makeShare(LOCAL_ENV, LOCAL_TOKEN)],
    environments: [
      { envZId: LOCAL_ENV, remoteAgent: true },
      { envZId: REMOTE_ENV, remoteAgent: true },
    ],
    agentShares: new Map([
      [LOCAL_ENV, { reachable: true, shares: [{ token: LOCAL_TOKEN, status: 'active' }] }],
      [REMOTE_ENV, { reachable: true, shares: [{ token: REMOTE_TOKEN, status: 'active' }] }],
    ]),
    probe: { state: 'healthy', latencyMs: 87, routedToThisMachine: true },
    unshareCalls: 0,
    startCalls: 0,
    failUnshare: false,
    failStart: false,
    ...overrides,
  };

  const adapter: ZrokRuntimeAdapter = {
    async isInstalled() {
      return state.installed;
    },
    async readEnvironment() {
      return { ...state.environment };
    },
    async getServiceState() {
      return state.serviceState;
    },
    async listNames() {
      return state.names.map((name) => ({ ...name }));
    },
    async listShares() {
      return state.shares.map((share) => ({ ...share, frontendEndpoints: [...share.frontendEndpoints] }));
    },
    async listEnvironments() {
      return state.environments.map((environment) => ({ ...environment }));
    },
    async getAgentStatus(input) {
      const snapshot = state.agentShares.get(input.envZId) || { reachable: false, shares: [] };
      return { reachable: snapshot.reachable, shares: snapshot.shares.map((share) => ({ ...share })) };
    },
    async unshareRemote(input) {
      state.unshareCalls += 1;
      if (state.failUnshare) throw new Error('simulated remote failure with secret that must not escape');
      const remote = state.agentShares.get(input.envZId);
      if (remote) remote.shares = remote.shares.filter((share) => share.token !== input.shareToken);
      state.shares = state.shares.filter((share) => share.shareToken !== input.shareToken);
    },
    async startLocalShare() {
      state.startCalls += 1;
      if (state.failStart) throw new Error('simulated local share failure');
      state.names = [makeName(LOCAL_TOKEN)];
      state.shares = [makeShare(LOCAL_ENV, LOCAL_TOKEN)];
      state.agentShares.set(LOCAL_ENV, { reachable: true, shares: [{ token: LOCAL_TOKEN, status: 'active' }] });
      state.probe = { state: 'healthy', latencyMs: 65, routedToThisMachine: true };
    },
    async probePublic() {
      return { ...state.probe };
    },
    now() {
      return new Date('2026-08-16T14:00:00.000Z');
    },
  };

  return { state, adapter, service: createZrokRuntimeService(adapter, baseConfig()) };
}

function remoteOwnerFixture(overrides: Partial<FixtureState> = {}) {
  return makeFixture({
    names: [makeName(REMOTE_TOKEN)],
    shares: [makeShare(REMOTE_ENV, REMOTE_TOKEN)],
    probe: { state: 'healthy', latencyMs: 120, routedToThisMachine: false },
    ...overrides,
  });
}

test('status reports Setup required when zrok is not installed', async () => {
  const { service } = makeFixture({ installed: false });
  const status = await service.getStatus();
  assert.equal(status.status, 'setup-required');
  assert.equal(status.statusLabel, 'Setup required');
  assert.equal(status.baseUrl, null);
  assert.equal(status.mcpUrl, null);
  assert.equal(status.actionability.canTakeOver, false);
});

test('status reports Starting while the local agent service is starting', async () => {
  const { service } = makeFixture({ serviceState: 'starting' });
  const status = await service.getStatus();
  assert.equal(status.status, 'starting');
  assert.equal(status.statusLabel, 'Starting');
  assert.equal(status.agentService.state, 'starting');
});

test('status reports Online only when public routing reaches this runtime', async () => {
  const { service } = makeFixture();
  const status = await service.getStatus();
  assert.equal(status.status, 'online');
  assert.equal(status.statusLabel, 'Online');
  assert.equal(status.baseUrl, STABLE_URL);
  assert.equal(status.mcpUrl, `${STABLE_URL}/mcp`);
  assert.equal(status.share.owner, 'local');
  assert.equal(status.share.state, 'active');
  assert.equal(status.publicReachability.state, 'healthy');
  assert.equal(status.publicReachability.routedToThisMachine, true);
  assert.equal(status.latencyMs, 87);
});

test('status reports Degraded when the local share exists but public routing is unhealthy', async () => {
  const { service } = makeFixture({
    probe: { state: 'unhealthy', latencyMs: 150, routedToThisMachine: null },
  });
  const status = await service.getStatus();
  assert.equal(status.status, 'degraded');
  assert.equal(status.statusLabel, 'Degraded');
  assert.equal(status.share.owner, 'local');
  assert.equal(status.publicReachability.state, 'unhealthy');
});

test('status reports Offline when no machine currently owns the managed name', async () => {
  const { service } = makeFixture({
    names: [makeName('')],
    shares: [],
    probe: { state: 'unhealthy', latencyMs: 90, routedToThisMachine: null },
  });
  const status = await service.getStatus();
  assert.equal(status.status, 'offline');
  assert.equal(status.statusLabel, 'Offline');
  assert.equal(status.share.owner, 'none');
  assert.equal(status.share.state, 'missing');
});

test('status reports Standby without mutating a healthy remote owner', async () => {
  const { service, state } = remoteOwnerFixture();
  const status = await service.getStatus();
  assert.equal(status.status, 'standby');
  assert.equal(status.statusLabel, 'Standby');
  assert.equal(status.message, 'Standby · active on another machine');
  assert.equal(status.share.owner, 'remote');
  assert.equal(status.share.state, 'remote-active');
  assert.equal(status.actionability.canTakeOver, true);
  assert.equal(state.unshareCalls, 0);
  assert.equal(state.startCalls, 0);
});

test('remote ownership stays Standby even while the local agent service is starting', async () => {
  const { service } = remoteOwnerFixture({ serviceState: 'starting' });
  const status = await service.getStatus();
  assert.equal(status.status, 'standby');
  assert.equal(status.share.owner, 'remote');
  assert.equal(status.actionability.canTakeOver, false);
  assert.match(status.actionability.takeoverBlockedReason || '', /must be running/i);
});

test('status keeps Standby but blocks takeover when authenticated remote fencing is unavailable', async () => {
  const { service } = remoteOwnerFixture({
    agentShares: new Map([
      [LOCAL_ENV, { reachable: true, shares: [] }],
      [REMOTE_ENV, { reachable: false, shares: [] }],
    ]),
  });
  const status = await service.getStatus();
  assert.equal(status.status, 'standby');
  assert.equal(status.actionability.canTakeOver, false);
  assert.match(status.actionability.takeoverBlockedReason || '', /cannot be fenced/i);
});

test('status reports Setup error when the managed reserved name cannot be identified', async () => {
  const { adapter } = makeFixture({
    names: [
      { ...makeName(''), name: 'alpha' },
      { ...makeName(''), name: 'beta' },
    ],
    shares: [],
  });
  const config = { ...baseConfig(), nameSelection: undefined };
  const actual = await createZrokRuntimeService(adapter, config).getStatus();
  assert.equal(actual.status, 'setup-error');
  assert.equal(actual.statusLabel, 'Setup error');
});

test('status payload never exposes the zrok account token', async () => {
  const { service } = remoteOwnerFixture();
  const status = await service.getStatus();
  assert.equal(JSON.stringify(status).includes(SECRET_ACCOUNT_TOKEN), false);
  assert.equal('accountToken' in status, false);
});

test('takeover fences the old remote share before activating and verifying the local owner', async () => {
  const { service, state } = remoteOwnerFixture();
  const result = await service.takeOver();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.equal(result.status.status, 'online');
  assert.equal(result.status.share.owner, 'local');
  assert.equal(state.unshareCalls, 1);
  assert.equal(state.startCalls, 1);
  assert.equal(JSON.stringify(result).includes(SECRET_ACCOUNT_TOKEN), false);
});

test('takeover fails closed when the remote agent is unreachable', async () => {
  const { service, state } = remoteOwnerFixture({
    agentShares: new Map([
      [LOCAL_ENV, { reachable: true, shares: [] }],
      [REMOTE_ENV, { reachable: false, shares: [] }],
    ]),
  });
  const result = await service.takeOver();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZROK_TAKEOVER_REMOTE_FENCE_UNAVAILABLE');
  assert.equal(state.unshareCalls, 0);
  assert.equal(state.startCalls, 0);
});

test('takeover never starts locally when authenticated remote unshare fails', async () => {
  const { service, state } = remoteOwnerFixture({ failUnshare: true });
  const result = await service.takeOver();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZROK_TAKEOVER_REMOTE_FENCE_FAILED');
  assert.equal(state.unshareCalls, 1);
  assert.equal(state.startCalls, 0);
  assert.equal(JSON.stringify(result).includes(SECRET_ACCOUNT_TOKEN), false);
});

test('takeover reports local activation failure after the old owner was fenced', async () => {
  const { service, state } = remoteOwnerFixture({ failStart: true });
  const result = await service.takeOver();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZROK_TAKEOVER_LOCAL_SHARE_FAILED');
  assert.equal(state.unshareCalls, 1);
  assert.equal(state.startCalls, 1);
});

test('takeover rejects success when the stable URL does not route to this runtime', async () => {
  const { service, state } = remoteOwnerFixture();
  const originalProbe = state.probe;
  let probes = 0;
  const adapterFixture = remoteOwnerFixture();
  const adapter = adapterFixture.adapter;
  const originalProbePublic = adapter.probePublic.bind(adapter);
  adapter.probePublic = async (input) => {
    probes += 1;
    if (probes >= 2) return { state: 'healthy', latencyMs: 55, routedToThisMachine: false };
    return originalProbePublic(input);
  };
  const runtime = createZrokRuntimeService(adapter, baseConfig());
  const result = await runtime.takeOver();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZROK_TAKEOVER_VERIFY_FAILED');
  assert.equal(adapterFixture.state.unshareCalls, 1);
  assert.equal(adapterFixture.state.startCalls, 1);
  assert.deepEqual(originalProbe, { state: 'healthy', latencyMs: 120, routedToThisMachine: false });
});

test('repeated takeover is idempotent after the first successful transfer', async () => {
  const { service, state } = remoteOwnerFixture();
  const first = await service.takeOver();
  const second = await service.takeOver();
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(state.unshareCalls, 1);
  assert.equal(state.startCalls, 1);
});

test('concurrent takeover requests share one fenced transfer', async () => {
  const { state, adapter } = remoteOwnerFixture();
  let releaseFence: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseFence = resolve; });
  const originalUnshare = adapter.unshareRemote.bind(adapter);
  adapter.unshareRemote = async (input) => {
    await gate;
    return originalUnshare(input);
  };
  const service = createZrokRuntimeService(adapter, baseConfig());
  const first = service.takeOver();
  const second = service.takeOver();
  releaseFence?.();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(state.unshareCalls, 1);
  assert.equal(state.startCalls, 1);
});

test('takeover aborts on a stale ownership race before remote unshare', async () => {
  const { state, adapter } = remoteOwnerFixture();
  let nameReads = 0;
  let shareReads = 0;
  adapter.listNames = async () => {
    nameReads += 1;
    if (nameReads >= 2) return [makeName('racing-share-token')];
    return [makeName(REMOTE_TOKEN)];
  };
  adapter.listShares = async () => {
    shareReads += 1;
    if (shareReads >= 2) return [makeShare('racing-env-zid', 'racing-share-token')];
    return [makeShare(REMOTE_ENV, REMOTE_TOKEN)];
  };
  const service = createZrokRuntimeService(adapter, baseConfig());
  const result = await service.takeOver();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZROK_TAKEOVER_STALE_OWNER');
  assert.equal(state.unshareCalls, 0);
  assert.equal(state.startCalls, 0);
});

test('takeover is unavailable when there is no remote owner', async () => {
  const { service, state } = makeFixture({ names: [makeName('')], shares: [] });
  const result = await service.takeOver();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZROK_TAKEOVER_NOT_AVAILABLE');
  assert.equal(state.unshareCalls, 0);
  assert.equal(state.startCalls, 0);
});
