import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ZrokStatusPanel, {
  createZrokStatusRefreshCoordinator,
  getZrokPollDelayMs,
  normalizeZrokStatus,
  requestLocalApiLatency,
  requestZrokDiagnostics,
  requestZrokSwitchHere,
  requestZrokStatus,
  requestZrokTakeover,
  resolveMcpUrl,
  type ZrokRuntimeStatus,
} from '../../src/components/ZrokStatusPanel.js';

function renderStatus(
  status: ZrokRuntimeStatus,
  actionState: 'idle' | 'taking-over' | 'switching-here' | 'verifying' | 'success' | 'error' = 'idle',
) {
  return renderToStaticMarkup(React.createElement(ZrokStatusPanel, {
    initialStatus: status,
    initialExpanded: true,
    initialActionState: actionState,
  }));
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('normalizes the bounded backend contract without projecting secrets', () => {
  const normalized = normalizeZrokStatus({
    status: 'ONLINE',
    baseUrl: 'https://zrok-test.example.test',
    agentService: { status: 'running' },
    share: { state: 'ready' },
    publicReachability: { status: 'healthy', latencyMs: 37 },
    lastCheckedAt: '2026-08-16T14:00:00.000Z',
    accountToken: 'must-not-leak',
  });

  assert.equal(normalized.status, 'online');
  assert.equal(normalized.agentService, 'running');
  assert.equal(normalized.share, 'ready');
  assert.equal(normalized.publicReachability, 'healthy');
  assert.equal(normalized.latencyMs, 37);
  assert.equal(resolveMcpUrl(normalized), 'https://zrok-test.example.test/mcp');
  assert.doesNotMatch(JSON.stringify(normalized), /must-not-leak|accountToken/);
});

test('normalizes only the structured zrok actionability fields', () => {
  const normalized = normalizeZrokStatus({
    status: 'standby',
    actionability: {
      canRecheck: true,
      canTakeOver: false,
      canSwitchHere: true,
      takeoverBlockedReason: 'Remote control unsupported.',
      accountToken: 'must-not-leak',
      internalReason: 'must-not-project',
    },
  });

  assert.deepEqual(normalized.actionability, {
    canRecheck: true,
    canTakeOver: false,
    canSwitchHere: true,
    takeoverBlockedReason: 'Remote control unsupported.',
  });
  assert.doesNotMatch(JSON.stringify(normalized), /must-not-leak|internalReason/);
});test('normalizes bounded rate-limit metadata without projecting raw provider data', () => {
  const normalized = normalizeZrokStatus({
    status: 'degraded',
    baseUrl: 'https://zrok-test.example.test',
    agentService: { state: 'running' },
    share: { state: 'active' },
    rateLimit: {
      source: 'public',
      firstObservedAt: '2026-08-27T00:00:00.000Z',
      lastObservedAt: '2026-08-27T00:00:01.000Z',
      nextAttemptAt: '2026-08-27T00:00:05.000Z',
      retryAfterMs: 4000,
      observedCount: 2,
      retryAfterHeader: 'secret-raw-header',
      accountToken: 'must-not-leak',
    },
  });

  assert.deepEqual(normalized.rateLimit, {
    source: 'public',
    firstObservedAt: '2026-08-27T00:00:00.000Z',
    lastObservedAt: '2026-08-27T00:00:01.000Z',
    nextAttemptAt: '2026-08-27T00:00:05.000Z',
    retryAfterMs: 4000,
    observedCount: 2,
  });
  assert.equal(normalized.agentService, 'running');
  assert.equal(normalized.share, 'active');
  assert.doesNotMatch(JSON.stringify(normalized), /secret-raw-header|must-not-leak|retryAfterHeader|accountToken/);
});

test('renders Setup required without pretending the tunnel is online', () => {
  const html = renderStatus({
    status: 'setup-required',
    message: 'Run Start DevFlow again to finish setup.',
    agentService: 'not installed',
  });
  assert.match(html, /Setup required/);
  assert.match(html, /Run Start DevFlow again to finish setup/);
  assert.doesNotMatch(html, />Online</);
  assert.match(html, /aria-label="zrok connection details"/);
});

test('renders Starting as a distinct non-healthy state', () => {
  const html = renderStatus({ status: 'starting', agentService: 'starting', share: 'pending' });
  assert.match(html, /Starting/);
  assert.match(html, /Agent service/);
  assert.doesNotMatch(html, />Online</);
});

test('renders local and public latency as separate diagnostics without an ambiguous compact ping', () => {
  const html = renderStatus({
    status: 'online',
    baseUrl: 'https://zrok-test.example.test',
    agentService: 'running',
    share: 'ready',
    publicReachability: 'healthy',
    latencyMs: 48,
    localApiLatencyMs: 7,
  });
  assert.doesNotMatch(html, /Online · 48 ms/);
  assert.match(html, /Local API/);
  assert.match(html, />7 ms</);
  assert.match(html, /Public route \(end-to-end\)/);
  assert.match(html, />48 ms</);
  assert.match(html, /https:\/\/zrok-test\.example\.test\/mcp/);
  assert.match(html, /aria-label="Copy MCP URL"/);
  assert.doesNotMatch(html, /\/sse/);
});

test('renders local and public latency availability independently', () => {
  const localOnly = renderStatus({ status: 'online', localApiLatencyMs: 9 });
  assert.match(localOnly, /Local API/);
  assert.match(localOnly, />9 ms</);
  assert.match(localOnly, /Public route \(end-to-end\)/);

  const publicOnly = renderStatus({ status: 'online', latencyMs: 51 });
  assert.match(publicOnly, /Local API/);
  assert.match(publicOnly, /Public route \(end-to-end\)/);
  assert.match(publicOnly, />51 ms</);
});

test('renders Degraded and Offline without healthy language', () => {
  const degraded = renderStatus({ status: 'degraded', publicReachability: 'degraded' });
  const offline = renderStatus({ status: 'offline', publicReachability: 'down' });
  assert.match(degraded, /Degraded/);
  assert.match(offline, /Offline/);
  assert.doesNotMatch(degraded, />Online</);
  assert.doesNotMatch(offline, />Online</);
});test('renders active rate limiting separately while preserving last-known ownership and diagnostics', () => {
  const html = renderStatus({
    status: 'degraded',
    baseUrl: 'https://zrok-test.example.test',
    agentService: 'running',
    share: 'active',
    publicReachability: 'unknown',
    latencyMs: 48,
    localApiLatencyMs: 7,
    actionability: { canRecheck: true, canTakeOver: false, canSwitchHere: false },
    rateLimit: {
      source: 'public',
      firstObservedAt: '2099-08-27T00:00:00.000Z',
      lastObservedAt: '2099-08-27T00:00:01.000Z',
      nextAttemptAt: '2099-08-27T00:00:05.000Z',
      retryAfterMs: 4000,
      observedCount: 2,
    },
  });

  assert.match(html, /Rate limited/);
  assert.match(html, /Public route/);
  assert.match(html, /Agent service/);
  assert.match(html, />running</);
  assert.match(html, /Named share/);
  assert.match(html, />active</);
  assert.match(html, /https:\/\/zrok-test\.example\.test\/mcp/);
  assert.match(html, /Cooling down/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /Offline/);
});

test('renders Standby with remote ownership context and explicit Take over action', () => {
  const html = renderStatus({
    status: 'standby',
    baseUrl: 'https://zrok-test.example.test',
    remoteOwner: 'Office PC',
    agentService: 'running',
    share: 'standby',
    publicReachability: 'remote owner',
    actionability: { canRecheck: true, canTakeOver: true },
  });
  assert.match(html, /Standby/);
  assert.match(html, /Active on Office PC/);
  assert.match(html, />Take over</);
  assert.match(html, /aria-label="Take over zrok connection from the active machine"/);
  assert.match(html, /Nothing is taken over automatically/);
});

test('does not offer takeover when backend blocks it and shows the blocked reason', () => {
  const html = renderStatus({
    status: 'standby',
    actionability: {
      canRecheck: true,
      canTakeOver: false,
      canSwitchHere: false,
      takeoverBlockedReason: 'Remote control unsupported.',
    },
  });

  assert.doesNotMatch(html, />Take over</);
  assert.match(html, /Remote control unsupported\./);
  assert.match(html, /aria-label="Recheck zrok status"/);
});

test('renders Standby with explicit Switch here action when remote fencing is unavailable', () => {
  const html = renderStatus({
    status: 'standby',
    remoteOwner: 'Office PC',
    agentService: 'running',
    share: 'remote-active',
    publicReachability: 'healthy',
    actionability: {
      canRecheck: true,
      canTakeOver: false,
      canSwitchHere: true,
      takeoverBlockedReason: 'The active machine is not enrolled for authenticated zrok agent remoting.',
    },
  });

  assert.match(html, /Switch here/);
  assert.match(html, /aria-label="Switch the managed zrok connection to this machine"/);
  assert.match(html, /old Agent can reclaim the share unless it is stopped/i);
});

test('renders Setup error with alert semantics', () => {
  const html = renderStatus({ status: 'setup-error', message: 'Agent enrollment failed.' });
  assert.match(html, /Setup error/);
  assert.match(html, /Agent enrollment failed/);
  assert.match(html, /role="status"|role="alert"/);
});

test('takeover busy state is disabled, explicit, and exposes progress accessibly', () => {
  const html = renderStatus({
    status: 'standby',
    remoteOwner: 'Laptop',
    actionability: { canRecheck: true, canTakeOver: true, canSwitchHere: false },
  }, 'taking-over');
  assert.match(html, /Taking over…/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-label="Take over zrok connection from the active machine"/);
});

test('switchHere busy state is disabled, explicit, and exposes progress accessibly', () => {
  const html = renderStatus({
    status: 'standby',
    remoteOwner: 'Laptop',
    actionability: { canRecheck: true, canTakeOver: false, canSwitchHere: true },
  }, 'switching-here');
  assert.match(html, /Switching…/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-label="Switch the managed zrok connection to this machine"/);
});

test('status request reads the live zrok endpoint and normalizes response', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ status: 'healthy', mcpUrl: 'https://example.test/mcp', latencyMs: 12 });
  }) as typeof fetch;

  const result = await requestZrokStatus(fakeFetch);
  assert.equal(result.status, 'online');
  assert.equal(result.mcpUrl, 'https://example.test/mcp');
  assert.equal(calls[0].url, '/api/zrok/status');
  assert.equal(calls[0].init?.cache, 'no-store');
});test('refresh coordinator coalesces burst Recheck and automatic refresh into one request', async () => {
  let calls = 0;
  let release: ((status: ZrokRuntimeStatus) => void) | undefined;
  const coordinator = createZrokStatusRefreshCoordinator({
    now: () => 1000,
    request: () => {
      calls += 1;
      return new Promise<ZrokRuntimeStatus>((resolve) => { release = resolve; });
    },
  });

  const first = coordinator.refresh();
  const second = coordinator.refresh();
  const third = coordinator.refresh();
  assert.equal(calls, 1);
  release?.({ status: 'online', actionability: { canRecheck: true, canTakeOver: false } });
  const results = await Promise.all([first, second, third]);
  assert.equal(results.every((result) => result?.status === 'online'), true);
  assert.equal(calls, 1);
});

test('refresh coordinator suppresses cooldown calls and admits one request after expiry', async () => {
  let nowMs = 1000;
  let calls = 0;
  const coordinator = createZrokStatusRefreshCoordinator({
    now: () => nowMs,
    initialStatus: {
      status: 'degraded',
      rateLimit: {
        source: 'public',
        firstObservedAt: '1970-01-01T00:00:01.000Z',
        lastObservedAt: '1970-01-01T00:00:01.000Z',
        nextAttemptAt: '1970-01-01T00:00:05.000Z',
        retryAfterMs: 4000,
        observedCount: 1,
      },
    },
    request: async () => {
      calls += 1;
      return {
        status: 'degraded',
        rateLimit: {
          source: 'public',
          firstObservedAt: '1970-01-01T00:00:01.000Z',
          lastObservedAt: '1970-01-01T00:00:05.000Z',
          nextAttemptAt: '1970-01-01T00:00:09.000Z',
          retryAfterMs: 4000,
          observedCount: 2,
        },
      };
    },
  });

  assert.equal(await coordinator.refresh(), null);
  nowMs = 4999;
  assert.equal(await coordinator.refresh(), null);
  assert.equal(calls, 0);
  nowMs = 5000;
  assert.equal((await coordinator.refresh())?.rateLimit?.observedCount, 2);
  assert.equal(calls, 1);
  nowMs = 6000;
  assert.equal(await coordinator.refresh(), null, 'a repeated 429 extends cooldown without another request');
  assert.equal(calls, 1);
  nowMs = 9000;
  await coordinator.refresh();
  assert.equal(calls, 2, 'exactly one new request is admitted when the extended cooldown expires');
});

test('poll delay respects backend cooldown without becoming a rapid timer', () => {
  const status: ZrokRuntimeStatus = {
    status: 'degraded',
    rateLimit: {
      source: 'control',
      firstObservedAt: '1970-01-01T00:00:01.000Z',
      lastObservedAt: '1970-01-01T00:00:01.000Z',
      nextAttemptAt: '1970-01-01T00:00:20.000Z',
      retryAfterMs: 19000,
      observedCount: 1,
    },
  };
  assert.equal(getZrokPollDelayMs(status, 5000, 1000), 19000);
  assert.equal(getZrokPollDelayMs(status, 15000, 20000), 15000);
});

test('local API latency probe is bounded, direct, and uses deterministic timing', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const nowValues = [100, 112.6];
  let nowIndex = 0;
  let scheduledTimeoutMs: number | undefined;
  let cancelledHandle: unknown;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  const latencyMs = await requestLocalApiLatency(fakeFetch, {
    timeoutMs: 750,
    now: () => nowValues[nowIndex++]!,
    scheduleAbort: (_abort, timeoutMs) => {
      scheduledTimeoutMs = timeoutMs;
      return 'local-probe-timeout';
    },
    cancelAbort: (handle) => {
      cancelledHandle = handle;
    },
  });

  assert.equal(latencyMs, 13);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/capabilities');
  assert.equal(calls[0].init?.cache, 'no-store');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.equal(scheduledTimeoutMs, 750);
  assert.equal(cancelledHandle, 'local-probe-timeout');
});

test('local probe timeout is unavailable evidence and does not change backend zrok health', async () => {
  const calls: string[] = [];
  let triggerAbort: (() => void) | undefined;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === '/api/zrok/status') {
      return jsonResponse({
        status: 'online',
        latencyMs: 51,
        actionability: { canRecheck: true, canTakeOver: false, canSwitchHere: false },
      });
    }
    if (url === '/api/capabilities') {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        triggerAbort?.();
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  const result = await requestZrokDiagnostics(fakeFetch, {
    timeoutMs: 1_000,
    scheduleAbort: (abort) => {
      triggerAbort = abort;
      return 'timeout-handle';
    },
    cancelAbort: () => {},
  });

  assert.deepEqual(calls.sort(), ['/api/capabilities', '/api/zrok/status']);
  assert.equal(result.status, 'online');
  assert.equal(result.latencyMs, 51);
  assert.equal(result.localApiLatencyMs, undefined);
  assert.deepEqual(result.actionability, { canRecheck: true, canTakeOver: false, canSwitchHere: false });
});

test('takeover request is explicit and reports backend failures without racing another action', async () => {
  let capturedInit: RequestInit | undefined;
  const successFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return jsonResponse({ ok: true });
  }) as typeof fetch;
  await requestZrokTakeover(successFetch);
  assert.equal(capturedInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), { explicit: true });

  const blockedFetch = (async () => jsonResponse({ error: 'Remote owner could not be fenced safely.' }, 409)) as typeof fetch;
  await assert.rejects(() => requestZrokTakeover(blockedFetch), /could not be fenced safely/);
});

test('switchHere request is explicit and reports backend failures safely', async () => {
  let capturedInit: RequestInit | undefined;
  const successFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return jsonResponse({ ok: true });
  }) as typeof fetch;
  await requestZrokSwitchHere(successFetch);
  assert.equal(capturedInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), { explicit: true });

  const blockedFetch = (async () => jsonResponse({ message: 'The exact remote zrok share could not be released.' }, 502)) as typeof fetch;
  await assert.rejects(() => requestZrokSwitchHere(blockedFetch), /could not be released/);
});

test('status request surfaces setup/API errors rather than converting them to Online', async () => {
  const failedFetch = (async () => jsonResponse({ message: 'zrok agent is unavailable' }, 503)) as typeof fetch;
  await assert.rejects(() => requestZrokStatus(failedFetch), /zrok agent is unavailable/);
});
