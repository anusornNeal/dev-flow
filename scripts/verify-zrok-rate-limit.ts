import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createZrokRateLimitTracker,
  parseZrokRetryAfterMs,
  type ZrokRateLimitInfo,
} from '../src/server/services/zrokRateLimitPolicy';
import {
  createZrokRuntimeService,
  type ZrokPublicProbe,
  type ZrokRuntimeAdapter,
} from '../src/server/services/zrokRuntimeService';
import {
  createZrokStatusRefreshCoordinator,
  getZrokPollDelayMs,
  type ZrokRuntimeStatus as UiZrokRuntimeStatus,
} from '../src/components/ZrokStatusPanel';
import {
  getZrokProbeAdmission,
  probeZrokPublicRoute,
} from './start-all';

const START_MS = Date.parse('2026-08-27T04:00:00.000Z');
const LOCAL_BASE_URL = 'http://127.0.0.1:3456';
const PUBLIC_BASE_URL = 'https://devflow-rate-limit.example.test';
const TARGET = 'http://127.0.0.1:3000';
const COOLDOWN_MS = 8_000;

function rateLimitInfo(nowMs: number, retryAfterMs = COOLDOWN_MS, observedCount = 1): ZrokRateLimitInfo {
  return {
    source: 'public',
    firstObservedAt: new Date(nowMs).toISOString(),
    lastObservedAt: new Date(nowMs).toISOString(),
    nextAttemptAt: new Date(nowMs + retryAfterMs).toISOString(),
    retryAfterMs,
    observedCount,
  };
}

function uiStatus(nowMs: number, limited: boolean): UiZrokRuntimeStatus {
  return limited
    ? {
        status: 'degraded',
        baseUrl: PUBLIC_BASE_URL,
        mcpUrl: `${PUBLIC_BASE_URL}/mcp`,
        agentService: 'running',
        share: 'active',
        publicReachability: 'unknown',
        message: 'Shared zrok public cooldown is active.',
        actionability: { canRecheck: true, canTakeOver: false, canSwitchHere: false },
        rateLimit: rateLimitInfo(nowMs),
      }
    : {
        status: 'online',
        baseUrl: PUBLIC_BASE_URL,
        mcpUrl: `${PUBLIC_BASE_URL}/mcp`,
        agentService: 'running',
        share: 'active',
        publicReachability: 'healthy',
        latencyMs: 12,
        actionability: { canRecheck: true, canTakeOver: false, canSwitchHere: false },
      };
}

function createRuntimeHarness() {
  let nowMs = START_MS;
  let publicCalls = 0;
  let limited = true;

  const adapter: ZrokRuntimeAdapter = {
    async isInstalled() {
      return true;
    },
    async readEnvironment() {
      return {
        enabled: true,
        envZId: 'local-env',
        apiEndpoint: 'https://api-v2.zrok.io',
        accountToken: 'not-returned-to-callers',
        defaultNamespace: 'public',
      };
    },
    async getServiceState() {
      return 'running';
    },
    async getLocalAgentStatus() {
      return {
        reachable: true,
        shares: [{
          shareMode: 'public',
          backendMode: 'proxy',
          backendEndpoint: TARGET,
          frontendEndpoint: PUBLIC_BASE_URL,
          status: 'active',
        }],
      };
    },
    async listNames() {
      return [];
    },
    async listShares() {
      return [];
    },
    async listEnvironments() {
      return [];
    },
    async getAgentStatus() {
      return { reachable: false, shares: [] };
    },
    async unshareRemote() {},
    async deleteShare() {},
    async startLocalShare() {},
    async probePublic(): Promise<ZrokPublicProbe> {
      publicCalls += 1;
      return limited
        ? {
            state: 'unknown',
            latencyMs: 9,
            routedToThisMachine: null,
            rateLimit: rateLimitInfo(nowMs),
          }
        : {
            state: 'healthy',
            latencyMs: 11,
            routedToThisMachine: true,
          };
    },
    now() {
      return new Date(nowMs);
    },
  };

  const service = createZrokRuntimeService(adapter, {
    serviceName: 'zrokAgent',
    target: TARGET,
    expectedRuntimeInstanceId: 'runtime-local',
    statusFreshMs: 250,
  });

  return {
    service,
    get publicCalls() {
      return publicCalls;
    },
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
    recover() {
      limited = false;
    },
  };
}

test('Retry-After parsing and fallback backoff stay deterministic and capped', () => {
  let nowMs = START_MS;
  assert.equal(parseZrokRetryAfterMs('8', nowMs, 10_000), 8_000);
  assert.equal(parseZrokRetryAfterMs(new Date(nowMs + 4_000).toUTCString(), nowMs, 10_000), 4_000);
  assert.equal(parseZrokRetryAfterMs('not-a-date', nowMs, 10_000), null);
  assert.equal(parseZrokRetryAfterMs(undefined, nowMs, 10_000), null);

  const tracker = createZrokRateLimitTracker('public', {
    now: () => nowMs,
    random: () => 0,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
    maxBackoffAttempts: 4,
  });

  const explicit = tracker.observe('3');
  assert.equal(explicit.retryAfterMs, 3_000);
  nowMs += 100;
  const malformed = tracker.observe('bogus');
  assert.equal(malformed.retryAfterMs, 2_000);
  nowMs += 100;
  const missing = tracker.observe();
  assert.equal(missing.retryAfterMs, 4_000);
  nowMs += 100;
  const capped = tracker.observe();
  assert.equal(capped.retryAfterMs, 8_000);
  nowMs += 100;
  const stillCapped = tracker.observe();
  assert.equal(stillCapped.retryAfterMs, 8_000);
  assert.equal(stillCapped.observedCount, 5);
  assert.equal(Date.parse(stillCapped.nextAttemptAt) - nowMs, 8_000);
});

test('runtime status burst coalesces to one public call and cooldown cache blocks amplification', async () => {
  const harness = createRuntimeHarness();

  const burst = await Promise.all(Array.from({ length: 32 }, () => harness.service.getStatus()));
  assert.equal(harness.publicCalls, 1, '32 concurrent callers share one underlying public probe');
  assert.equal(burst.every((status) => status.status === 'degraded'), true);
  assert.equal(burst.every((status) => status.rateLimit?.source === 'public'), true);
  assert.equal(burst.every((status) => status.share.owner === 'local'), true, '429 never loses known local ownership');

  await Promise.all(Array.from({ length: 32 }, () => harness.service.getStatus()));
  assert.equal(harness.publicCalls, 1, 'fresh cooldown result suppresses repeated public probes');

  harness.advance(COOLDOWN_MS - 1);
  await harness.service.getStatus();
  assert.equal(harness.publicCalls, 1, 'provider is not retried one millisecond before cooldown expiry');

  harness.advance(1);
  harness.recover();
  const recovered = await Promise.all(Array.from({ length: 16 }, () => harness.service.getStatus()));
  assert.equal(harness.publicCalls, 2, 'cooldown expiry admits exactly one recovery probe');
  assert.equal(recovered.every((status) => status.status === 'online'), true);
});

test('supervisor ticks and UI Recheck bursts honor shared cooldown without provider fan-out', async () => {
  let nowMs = START_MS;
  let supervisorLocalStatusCalls = 0;
  let supervisorPublicCalls = 0;
  let uiStatusCalls = 0;
  let providerHealthy = false;
  const limited = rateLimitInfo(nowMs);

  const fakeSupervisorFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === `${LOCAL_BASE_URL}/api/zrok/status`) {
      supervisorLocalStatusCalls += 1;
      return new Response(JSON.stringify(providerHealthy
        ? {
            status: 'online',
            baseUrl: PUBLIC_BASE_URL,
            share: { state: 'active' },
          }
        : {
            status: 'degraded',
            baseUrl: PUBLIC_BASE_URL,
            share: { state: 'active' },
            rateLimit: limited,
          }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === `${PUBLIC_BASE_URL}/api/capabilities`) {
      supervisorPublicCalls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected supervisor URL ${url}`);
  };

  const supervisorBurst = await Promise.all(Array.from({ length: 24 }, () => probeZrokPublicRoute(
    LOCAL_BASE_URL,
    PUBLIC_BASE_URL,
    500,
    fakeSupervisorFetch,
    { now: () => nowMs },
  )));
  assert.equal(supervisorBurst.every((result) => result.publicProbe.failureClass === 'rate-limit'), true);
  assert.equal(supervisorPublicCalls, 0, 'supervisor shared cooldown never calls the hosted public route');
  assert.equal(supervisorLocalStatusCalls, 24, 'supervisor may read cheap local status without amplifying provider traffic');

  let admitted = 0;
  for (let offset = 0; offset < COOLDOWN_MS; offset += 250) {
    if (getZrokProbeAdmission({ cooldownUntilMs: START_MS + COOLDOWN_MS, nowMs: START_MS + offset }).admit) admitted += 1;
  }
  assert.equal(admitted, 0);
  assert.equal(getZrokProbeAdmission({ cooldownUntilMs: START_MS + COOLDOWN_MS, nowMs: START_MS + COOLDOWN_MS }).admit, true);

  const coordinator = createZrokStatusRefreshCoordinator({
    now: () => nowMs,
    request: async () => {
      uiStatusCalls += 1;
      return uiStatus(nowMs, !providerHealthy);
    },
  });

  const uiBurst = await Promise.all(Array.from({ length: 24 }, () => coordinator.refresh()));
  assert.equal(uiStatusCalls, 1, 'burst Recheck demand shares one local status request');
  assert.equal(uiBurst.filter(Boolean).length, 24, 'concurrent Recheck callers share the same result');
  assert.equal(getZrokPollDelayMs(coordinator.getStatus()!, 5_000, nowMs), COOLDOWN_MS);

  await Promise.all(Array.from({ length: 24 }, () => coordinator.refresh()));
  assert.equal(uiStatusCalls, 1, 'UI cooldown blocks repeated Recheck calls');

  nowMs += COOLDOWN_MS;
  providerHealthy = true;
  const recoveredUi = await Promise.all(Array.from({ length: 24 }, () => coordinator.refresh()));
  assert.equal(uiStatusCalls, 2, 'UI cooldown expiry admits exactly one refresh');
  assert.equal(recoveredUi.every((status) => status?.status === 'online'), true);

  const recoveredSupervisor = await probeZrokPublicRoute(
    LOCAL_BASE_URL,
    PUBLIC_BASE_URL,
    500,
    fakeSupervisorFetch,
    { now: () => nowMs },
  );
  assert.equal(recoveredSupervisor.publicProbe.ok, true);
  assert.equal(supervisorPublicCalls, 1, 'healthy supervisor recovery performs one bounded public probe');
});

test('rate-limited zrok status does not block unrelated local/API work', async () => {
  const harness = createRuntimeHarness();
  let unrelatedApiCalls = 0;
  let unrelatedMcpCalls = 0;

  const zrokBurst = Array.from({ length: 20 }, () => harness.service.getStatus());
  const localApiBurst = Array.from({ length: 20 }, async () => {
    unrelatedApiCalls += 1;
    return { ok: true, capability: 'tasks' };
  });
  const mcpBurst = Array.from({ length: 20 }, async () => {
    unrelatedMcpCalls += 1;
    return { ok: true, tool: 'search_tasks' };
  });

  const [zrok, localApi, mcp] = await Promise.all([
    Promise.all(zrokBurst),
    Promise.all(localApiBurst),
    Promise.all(mcpBurst),
  ]);

  assert.equal(harness.publicCalls, 1);
  assert.equal(zrok.every((status) => status.rateLimit?.source === 'public'), true);
  assert.equal(localApi.every((result) => result.ok), true);
  assert.equal(mcp.every((result) => result.ok), true);
  assert.equal(unrelatedApiCalls, 20);
  assert.equal(unrelatedMcpCalls, 20);

  console.log(JSON.stringify({
    runtimeBurstCallers: 20,
    zrokPublicCalls: harness.publicCalls,
    unrelatedApiCalls,
    unrelatedMcpCalls,
  }));
});
