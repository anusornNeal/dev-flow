import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ZrokLocalAgentShare, ZrokLocalAgentStatus } from '../../src/server/services/zrokAgentConsoleClient.js';
import {
  createDefaultZrokRuntimeAdapter,
  createZrokRuntimeService,
  resolveZrokBinary,
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
const MANAGED_NAME = 'test-reserved-name';
const NAME_SELECTION = `public:${MANAGED_NAME}`;
const STABLE_URL = 'https://zrok-test.example.test';
const REMOTE_TOKEN = 'remote-share-token';
const LOCAL_TOKEN = 'local-share-token';
const LOCAL_HOST = 'LAPTOP-UNVM1ETB\\mixed; LAPTOP-UNVM1ETB; windows; Microsoft Windows 11 Pro; standalone; 10.0.26100; 10.0.26100; amd64';
const REMOTE_HOST = 'OTHER-PC\\mixed; OTHER-PC; windows; Microsoft Windows 11 Pro; standalone; 10.0.26100; 10.0.26100; amd64';

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
  deleteCalls: Array<{ envZId: string; shareToken: string }>;
  startCalls: number;
  failUnshare: boolean;
  failDelete: boolean;
  failStart: boolean;
  localAgentStatus: ZrokLocalAgentStatus;
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
      { envZId: LOCAL_ENV, remoteAgent: true, description: 'mixed@LAPTOP-UNVM1ETB', host: LOCAL_HOST },
      { envZId: REMOTE_ENV, remoteAgent: true, description: 'mixed@OTHER-PC', host: REMOTE_HOST },
    ],
    agentShares: new Map([
      [LOCAL_ENV, { reachable: true, shares: [{ token: LOCAL_TOKEN, status: 'active' }] }],
      [REMOTE_ENV, { reachable: true, shares: [{ token: REMOTE_TOKEN, status: 'active' }] }],
    ]),
    probe: { state: 'healthy', latencyMs: 87, routedToThisMachine: true },
    unshareCalls: 0,
    deleteCalls: [],
    startCalls: 0,
    failUnshare: false,
    failDelete: false,
    failStart: false,
    localAgentStatus: {
      reachable: true,
      shares: [{
        shareMode: 'public',
        backendMode: 'proxy',
        backendEndpoint: 'http://127.0.0.1:3000',
        frontendEndpoint: STABLE_URL,
        status: 'active',
      }],
    },
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
    async getLocalAgentStatus() {
      return {
        reachable: state.localAgentStatus.reachable,
        shares: state.localAgentStatus.shares.map((share) => ({ ...share })),
      };
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
      return {
        reachable: snapshot.reachable,
        remoteControl: snapshot.remoteControl ?? 'available',
        shares: snapshot.shares.map((share) => ({ ...share })),
      };
    },
    async unshareRemote(input) {
      state.unshareCalls += 1;
      if (state.failUnshare) throw new Error('simulated remote failure with secret that must not escape');
      const remote = state.agentShares.get(input.envZId);
      if (remote) remote.shares = remote.shares.filter((share) => share.token !== input.shareToken);
      state.shares = state.shares.filter((share) => share.shareToken !== input.shareToken);
      state.names = state.names.map((name) => name.shareToken === input.shareToken ? { ...name, shareToken: '' } : name);
    },
    async deleteShare(input) {
      state.deleteCalls.push({ ...input });
      if (state.failDelete) throw new Error('simulated exact stale share delete failure');
      state.shares = state.shares.filter(
        (share) => !(share.shareToken === input.shareToken && share.envZId === input.envZId),
      );
      state.names = state.names.map((name) => name.shareToken === input.shareToken ? { ...name, shareToken: '' } : name);
    },
    async startLocalShare() {
      state.startCalls += 1;
      if (state.failStart) throw new Error('simulated local share failure');
      state.names = [makeName(LOCAL_TOKEN)];
      state.shares = [makeShare(LOCAL_ENV, LOCAL_TOKEN)];
      state.agentShares.set(LOCAL_ENV, { reachable: true, shares: [{ token: LOCAL_TOKEN, status: 'active' }] });
      state.localAgentStatus = {
        reachable: true,
        shares: [makeLocalAgentShare(STABLE_URL)],
      };
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
    localAgentStatus: { reachable: true, shares: [] },
    ...overrides,
  });
}

function sameMachineStaleOwnerFixture(overrides: Partial<FixtureState> = {}) {
  return makeFixture({
    names: [makeName(REMOTE_TOKEN)],
    shares: [makeShare(REMOTE_ENV, REMOTE_TOKEN)],
    environments: [
      { envZId: LOCAL_ENV, remoteAgent: true, description: 'mixed@LAPTOP-UNVM1ETB', host: LOCAL_HOST },
      { envZId: REMOTE_ENV, remoteAgent: false, description: 'mixed@LAPTOP-UNVM1ETB', host: LOCAL_HOST },
    ],
    agentShares: new Map([
      [LOCAL_ENV, { reachable: true, shares: [] }],
      [REMOTE_ENV, { reachable: false, shares: [] }],
    ]),
    probe: { state: 'unhealthy', latencyMs: null, routedToThisMachine: null },
    localAgentStatus: { reachable: true, shares: [] },
    ...overrides,
  });
}

function makeLocalAgentShare(frontendEndpoint: string): ZrokLocalAgentShare {
  return {
    shareMode: 'public',
    backendMode: 'proxy',
    backendEndpoint: 'http://127.0.0.1:3000',
    frontendEndpoint,
    status: 'active',
  };
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

test('uses the local Agent share across profile identities', async () => {
  const shareToken = 'service-profile-share-token';
  const { service } = makeFixture({
    environment: {
      enabled: true,
      envZId: 'interactive-env',
      apiEndpoint: 'https://controller.example',
      accountToken: 'secret',
    },
    names: [makeName(shareToken)],
    shares: [makeShare('service-env', shareToken)],
    localAgentStatus: {
      reachable: true,
      shares: [makeLocalAgentShare('dynamic.example.net')],
    },
    probe: { state: 'healthy', latencyMs: 20, routedToThisMachine: true },
  });

  const actual = await service.getStatus();

  assert.equal(actual.status, 'online');
  assert.equal(actual.baseUrl, 'https://dynamic.example.net');
  assert.equal(actual.mcpUrl, 'https://dynamic.example.net/mcp');
  assert.equal(actual.share.owner, 'local');
});

test('prefers the live custom Agent domain over configured and account URLs', async () => {
  const fixture = makeFixture({
    localAgentStatus: {
      reachable: true,
      shares: [makeLocalAgentShare('https://custom.devflow.example/app/')],
    },
  });
  const service = createZrokRuntimeService(fixture.adapter, {
    ...baseConfig(),
    baseUrl: 'https://configured.example',
  });

  const actual = await service.getStatus();

  assert.equal(actual.baseUrl, 'https://custom.devflow.example/app');
  assert.equal(actual.mcpUrl, 'https://custom.devflow.example/app/mcp');
});

test('rejects credentials and control characters from every public URL source', async () => {
  const local = makeFixture({
    localAgentStatus: {
      reachable: true,
      shares: [makeLocalAgentShare('https://user:secret@local.example.net\n')],
    },
  });
  const localStatus = await local.service.getStatus();
  assert.equal(localStatus.baseUrl, null);
  assert.equal(localStatus.mcpUrl, null);

  const controlOnly = makeFixture({
    localAgentStatus: {
      reachable: true,
      shares: [makeLocalAgentShare('https://local.example.net\u000b')],
    },
  });
  const controlOnlyStatus = await controlOnly.service.getStatus();
  assert.equal(controlOnlyStatus.baseUrl, null);
  assert.equal(controlOnlyStatus.mcpUrl, null);

  const configFixture = makeFixture({
    names: [{ ...makeName(''), url: undefined }],
    shares: [],
    localAgentStatus: { reachable: true, shares: [] },
  });
  const configStatus = await createZrokRuntimeService(configFixture.adapter, {
    ...baseConfig(),
    baseUrl: 'https://user:secret@configured.example.net\u000b',
  }).getStatus();
  assert.equal(configStatus.baseUrl, null);
  assert.equal(configStatus.mcpUrl, null);
});

test('degrades when multiple local Agent shares match the runtime target', async () => {
  const { service } = makeFixture({
    localAgentStatus: {
      reachable: true,
      shares: [
        makeLocalAgentShare('first.example.net'),
        makeLocalAgentShare('second.example.net'),
      ],
    },
  });

  const actual = await service.getStatus();

  assert.equal(actual.status, 'degraded');
  assert.equal(actual.share.owner, 'unknown');
  assert.equal(actual.actionability.canTakeOver, false);
  assert.match(actual.actionability.takeoverBlockedReason || '', /multiple local zrok shares/i);
});

test('does not infer local service ownership from the interactive profile alone', async () => {
  const { service } = makeFixture({
    localAgentStatus: { reachable: true, shares: [] },
  });

  const actual = await service.getStatus();

  assert.equal(actual.status, 'degraded');
  assert.equal(actual.share.owner, 'unknown');
  assert.equal(actual.actionability.canTakeOver, false);
});

test('does not expose local share or account tokens in the runtime payload', async () => {
  const shareToken = 'local-share-secret';
  const { service } = makeFixture({
    environment: {
      enabled: true,
      envZId: 'interactive-env',
      apiEndpoint: 'https://controller.example',
      accountToken: SECRET_ACCOUNT_TOKEN,
    },
    names: [makeName(shareToken)],
    shares: [makeShare('service-env', shareToken)],
    localAgentStatus: {
      reachable: true,
      shares: [makeLocalAgentShare('private.example.net')],
    },
  });

  const serialized = JSON.stringify(await service.getStatus());

  assert.equal(serialized.includes(shareToken), false);
  assert.equal(serialized.includes(SECRET_ACCOUNT_TOKEN), false);
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

test('keeps public reachability healthy from previously trusted endpoint evidence when local Agent authority is unavailable', async () => {
  const fixture = makeFixture();
  const first = await fixture.service.getStatus();
  assert.equal(first.status, 'online');

  fixture.state.localAgentStatus = { reachable: false, shares: [] };
  const status = await fixture.service.getStatus();

  assert.equal(status.status, 'degraded');
  assert.equal(status.baseUrl, STABLE_URL);
  assert.equal(status.publicReachability.state, 'healthy');
  assert.equal(status.publicReachability.routedToThisMachine, true);
  assert.equal(status.share.owner, 'unknown');
  assert.equal(status.share.state, 'unknown');
  assert.equal(status.actionability.canTakeOver, false);
  assert.match(status.actionability.takeoverBlockedReason || '', /authority is unreachable/i);
});

test('keeps public unhealthy evidence separate from local ownership authority', async () => {
  const fixture = makeFixture({
    localAgentStatus: { reachable: false, shares: [] },
    probe: { state: 'unhealthy', latencyMs: 140, routedToThisMachine: null },
  });
  const service = createZrokRuntimeService(fixture.adapter, {
    ...baseConfig(),
    baseUrl: STABLE_URL,
  });

  const status = await service.getStatus();

  assert.equal(status.status, 'degraded');
  assert.equal(status.publicReachability.state, 'unhealthy');
  assert.equal(status.share.owner, 'unknown');
  assert.equal(status.actionability.canTakeOver, false);
});

test('leaves public reachability unknown when local authority is unavailable without a trusted public URL', async () => {
  const { service } = makeFixture({
    localAgentStatus: { reachable: false, shares: [] },
  });

  const status = await service.getStatus();

  assert.equal(status.status, 'degraded');
  assert.equal(status.baseUrl, null);
  assert.equal(status.publicReachability.state, 'unknown');
  assert.equal(status.publicReachability.routedToThisMachine, null);
  assert.equal(status.share.owner, 'unknown');
  assert.equal(status.actionability.canTakeOver, false);
});

test('status reports Offline when no machine currently owns the managed name', async () => {
  const { service } = makeFixture({
    names: [makeName('')],
    shares: [],
    localAgentStatus: { reachable: true, shares: [] },
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

test('blocks takeover when local Agent authority is unreachable', async () => {
  const { service, state } = remoteOwnerFixture({
    localAgentStatus: { reachable: false, shares: [] },
  });

  const status = await service.getStatus();
  const takeover = await service.takeOver();

  assert.equal(status.status, 'degraded');
  assert.equal(status.share.owner, 'unknown');
  assert.equal(status.actionability.canTakeOver, false);
  assert.match(status.actionability.takeoverBlockedReason || '', /local zrok Agent.*unreachable/i);
  assert.equal(takeover.ok, false);
  assert.equal(takeover.code, 'ZROK_TAKEOVER_NOT_AVAILABLE');
  assert.equal(takeover.status.share.owner, 'unknown');
  assert.equal(state.unshareCalls, 0);
  assert.equal(state.startCalls, 0);
});

test('status marks only an unhealthy unenrolled predecessor on the same host/user as auto-recoverable', async () => {
  const { service } = sameMachineStaleOwnerFixture();
  const status = await service.getStatus();
  assert.equal(status.status, 'standby');
  assert.equal(status.share.owner, 'remote');
  assert.equal(status.publicReachability.state, 'unhealthy');
  assert.equal(status.actionability.canTakeOver, true);
  assert.equal(status.actionability.canRecoverStaleSameMachineOwner, true);
});

test('same-machine recovery stays disabled for a different host, missing identity, or healthy route', async () => {
  const differentHost = sameMachineStaleOwnerFixture({
    environments: [
      { envZId: LOCAL_ENV, remoteAgent: true, host: LOCAL_HOST },
      { envZId: REMOTE_ENV, remoteAgent: false, host: REMOTE_HOST },
    ],
  });
  const ambiguous = sameMachineStaleOwnerFixture({
    environments: [
      { envZId: LOCAL_ENV, remoteAgent: true, host: LOCAL_HOST },
      { envZId: REMOTE_ENV, remoteAgent: false },
    ],
  });
  const healthy = sameMachineStaleOwnerFixture({
    probe: { state: 'healthy', latencyMs: 42, routedToThisMachine: false },
  });
  for (const fixture of [differentHost, ambiguous, healthy]) {
    const status = await fixture.service.getStatus();
    assert.equal(status.status, 'standby');
    assert.equal(status.actionability.canRecoverStaleSameMachineOwner, false);
    assert.equal(status.actionability.canTakeOver, false);
  }
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

test('status keeps Standby but blocks takeover when remote fencing is explicitly unsupported', async () => {
  const { service } = remoteOwnerFixture({
    agentShares: new Map([
      [LOCAL_ENV, { reachable: true, shares: [] }],
      [REMOTE_ENV, {
        reachable: true,
        remoteControl: 'unsupported',
        shares: [{ token: REMOTE_TOKEN, status: 'active' }],
      }],
    ]),
  });
  const status = await service.getStatus();
  assert.equal(status.status, 'standby');
  assert.equal(status.actionability.canTakeOver, false);
  assert.match(status.actionability.takeoverBlockedReason || '', /unsupported/i);
});

test('preserves unsupported remote-control capability from an HTTP 501 controller response', async () => {
  const adapter = createDefaultZrokRuntimeAdapter({
    binary: 'zrok2',
    fetchImpl: async () => new Response('', { status: 501 }),
  });
  const status = await adapter.getAgentStatus({
    apiEndpoint: 'https://controller.example',
    accountToken: 'secret',
    envZId: REMOTE_ENV,
  });
  assert.deepEqual(status, { reachable: false, remoteControl: 'unsupported', shares: [] });
});

test('resolves the bootstrap-installed zrok binary from ProgramFiles and falls back to PATH', () => {
  assert.equal(
    resolveZrokBinary({ platform: 'win32', programFilesDir: 'C:\\Program Files' }),
    'C:\\Program Files\\zrok2\\zrok2.exe',
  );
  assert.equal(resolveZrokBinary({ platform: 'win32', programFilesDir: '' }), 'zrok2');
  assert.equal(resolveZrokBinary({ platform: 'linux' }), 'zrok2');
  assert.equal(resolveZrokBinary({ binary: 'D:\\tools\\zrok2.exe', platform: 'win32' }), 'D:\\tools\\zrok2.exe');
});

test('saved local reserved name is read safely and explicit configuration wins', async () => {
  const runtimeModule = await import('../../src/server/services/zrokRuntimeService.js');
  const resolver = (runtimeModule as unknown as { resolveZrokPreferredName?: unknown }).resolveZrokPreferredName;
  assert.equal(typeof resolver, 'function', 'runtime should expose bounded preferred-name resolution');
  if (typeof resolver !== 'function') return;
  const resolvePreferredName = resolver as (explicit?: string, selectionPath?: string) => string | undefined;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-zrok-selection-'));
  const selectionPath = path.join(tempDir, 'zrok-selection.json');
  try {
    fs.writeFileSync(selectionPath, JSON.stringify({ reservedName: 'saved-beta', ignored: 'not-used' }));
    assert.equal(resolvePreferredName(undefined, selectionPath), 'saved-beta');
    assert.equal(resolvePreferredName(' env-override ', selectionPath), 'env-override');
    fs.writeFileSync(selectionPath, '{not-json');
    assert.equal(resolvePreferredName(undefined, selectionPath), undefined);
    fs.writeFileSync(selectionPath, JSON.stringify({ reservedName: 'x'.repeat(300) }));
    assert.equal(resolvePreferredName(undefined, selectionPath), undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('preferred reserved name disambiguates multiple owned names', async () => {
  const { adapter } = makeFixture({
    names: [
      { ...makeName(''), name: 'alpha' },
      { ...makeName(''), name: 'beta' },
    ],
    shares: [],
    localAgentStatus: { reachable: true, shares: [] },
  });
  const actual = await createZrokRuntimeService(adapter, {
    ...baseConfig(),
    nameSelection: undefined,
    preferredName: 'beta',
  }).getStatus();
  assert.equal(actual.status, 'offline');
  assert.equal(actual.share.owner, 'none');
});

test('status reports Setup error when the managed reserved name cannot be identified', async () => {
  const { adapter } = makeFixture({
    names: [
      { ...makeName(''), name: 'alpha' },
      { ...makeName(''), name: 'beta' },
    ],
    shares: [],
    localAgentStatus: { reachable: true, shares: [] },
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

test('takeover releases only the exact stale same-machine share and preserves the reserved name', async () => {
  const { service, state } = sameMachineStaleOwnerFixture();
  const result = await service.takeOver();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.equal(result.status.status, 'online');
  assert.equal(result.status.share.owner, 'local');
  assert.deepEqual(state.deleteCalls, [{ envZId: REMOTE_ENV, shareToken: REMOTE_TOKEN }]);
  assert.equal(state.unshareCalls, 0);
  assert.equal(state.startCalls, 1);
  assert.equal(state.names.length, 1);
  assert.equal(state.names[0].name, MANAGED_NAME);
  assert.equal(state.names[0].reserved, true);
  assert.equal(state.names[0].url, STABLE_URL);
});

test('stale same-machine takeover aborts if binding or machine identity drifts during preflight', async () => {
  const bindingFixture = sameMachineStaleOwnerFixture();
  let nameReads = 0;
  bindingFixture.adapter.listNames = async () => {
    nameReads += 1;
    return nameReads >= 2 ? [makeName('racing-share-token')] : [makeName(REMOTE_TOKEN)];
  };
  const bindingResult = await createZrokRuntimeService(bindingFixture.adapter, baseConfig()).takeOver();
  assert.equal(bindingResult.ok, false);
  assert.equal(bindingResult.code, 'ZROK_TAKEOVER_STALE_OWNER');
  assert.equal(bindingFixture.state.deleteCalls.length, 0);
  assert.equal(bindingFixture.state.startCalls, 0);

  const identityFixture = sameMachineStaleOwnerFixture();
  let environmentReads = 0;
  identityFixture.adapter.listEnvironments = async () => {
    environmentReads += 1;
    if (environmentReads >= 2) {
      return [
        { envZId: LOCAL_ENV, remoteAgent: true, host: LOCAL_HOST },
        { envZId: REMOTE_ENV, remoteAgent: false, host: REMOTE_HOST },
      ];
    }
    return identityFixture.state.environments.map((environment) => ({ ...environment }));
  };
  const identityResult = await createZrokRuntimeService(identityFixture.adapter, baseConfig()).takeOver();
  assert.equal(identityResult.ok, false);
  assert.equal(identityResult.code, 'ZROK_TAKEOVER_STALE_OWNER');
  assert.equal(identityFixture.state.deleteCalls.length, 0);
  assert.equal(identityFixture.state.startCalls, 0);
});

test('stale same-machine takeover fails closed when exact share deletion fails', async () => {
  const { service, state } = sameMachineStaleOwnerFixture({ failDelete: true });
  const result = await service.takeOver();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZROK_TAKEOVER_REMOTE_FENCE_FAILED');
  assert.deepEqual(state.deleteCalls, [{ envZId: REMOTE_ENV, shareToken: REMOTE_TOKEN }]);
  assert.equal(state.unshareCalls, 0);
  assert.equal(state.startCalls, 0);
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
  const { service, state } = makeFixture({
    names: [makeName('')],
    shares: [],
    localAgentStatus: { reachable: true, shares: [] },
  });
  const result = await service.takeOver();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZROK_TAKEOVER_NOT_AVAILABLE');
  assert.equal(state.unshareCalls, 0);
  assert.equal(state.startCalls, 0);
});
