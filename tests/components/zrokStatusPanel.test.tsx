import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ZrokStatusPanel, {
  normalizeZrokStatus,
  requestZrokStatus,
  requestZrokTakeover,
  resolveMcpUrl,
  type ZrokRuntimeStatus,
} from '../../src/components/ZrokStatusPanel.js';

function renderStatus(status: ZrokRuntimeStatus, actionState: 'idle' | 'taking-over' | 'verifying' | 'success' | 'error' = 'idle') {
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
    baseUrl: 'https://devflow-mixed.shares.zrok.io',
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
  assert.equal(resolveMcpUrl(normalized), 'https://devflow-mixed.shares.zrok.io/mcp');
  assert.doesNotMatch(JSON.stringify(normalized), /must-not-leak|accountToken/);
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

test('renders Online only from live backend status with latency and MCP URL', () => {
  const html = renderStatus({
    status: 'online',
    baseUrl: 'https://devflow-mixed.shares.zrok.io',
    agentService: 'running',
    share: 'ready',
    publicReachability: 'healthy',
    latencyMs: 48,
  });
  assert.match(html, /Online · 48 ms/);
  assert.match(html, /https:\/\/devflow-mixed\.shares\.zrok\.io\/mcp/);
  assert.match(html, /aria-label="Copy MCP URL"/);
  assert.doesNotMatch(html, /\/sse/);
});

test('renders Degraded and Offline without healthy language', () => {
  const degraded = renderStatus({ status: 'degraded', publicReachability: 'degraded' });
  const offline = renderStatus({ status: 'offline', publicReachability: 'down' });
  assert.match(degraded, /Degraded/);
  assert.match(offline, /Offline/);
  assert.doesNotMatch(degraded, />Online</);
  assert.doesNotMatch(offline, />Online</);
});

test('renders Standby with remote ownership context and explicit Take over action', () => {
  const html = renderStatus({
    status: 'standby',
    baseUrl: 'https://devflow-mixed.shares.zrok.io',
    remoteOwner: 'Office PC',
    agentService: 'running',
    share: 'standby',
    publicReachability: 'remote owner',
  });
  assert.match(html, /Standby/);
  assert.match(html, /Active on Office PC/);
  assert.match(html, />Take over</);
  assert.match(html, /aria-label="Take over zrok connection from the active machine"/);
  assert.match(html, /Nothing is taken over automatically/);
});

test('renders Setup error with alert semantics', () => {
  const html = renderStatus({ status: 'setup-error', message: 'Agent enrollment failed.' });
  assert.match(html, /Setup error/);
  assert.match(html, /Agent enrollment failed/);
  assert.match(html, /role="status"|role="alert"/);
});

test('takeover busy state is disabled, explicit, and exposes progress accessibly', () => {
  const html = renderStatus({ status: 'standby', remoteOwner: 'Laptop' }, 'taking-over');
  assert.match(html, /Taking over…/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-label="Take over zrok connection from the active machine"/);
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

test('status request surfaces setup/API errors rather than converting them to Online', async () => {
  const failedFetch = (async () => jsonResponse({ message: 'zrok agent is unavailable' }, 503)) as typeof fetch;
  await assert.rejects(() => requestZrokStatus(failedFetch), /zrok agent is unavailable/);
});
