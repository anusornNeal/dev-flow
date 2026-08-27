import test from 'node:test';
import assert from 'node:assert/strict';
import type { ZrokLocalAgentShare } from '../../src/server/services/zrokAgentConsoleClient.js';
import {
  createZrokAgentConsoleClient,
  selectTargetShare,
} from '../../src/server/services/zrokAgentConsoleClient.js';
import { parseZrokRetryAfterMs } from '../../src/server/services/zrokRateLimitPolicy.js';

function fakeAgentFetch(payloadByPort: Record<number, unknown>, calls: string[] = []) {
  return async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const payload = payloadByPort[Number(url.port)];
    if (payload === undefined) throw new Error('connection refused');
    const text = JSON.stringify(payload);
    return new Response(text, {
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(text)) },
    });
  };
}

test('discovers a target share without returning its token', async () => {
  const client = createZrokAgentConsoleClient({
    ports: [8888],
    fetchImpl: fakeAgentFetch({
      8888: { shares: [{ token: 'secret', shareMode: 'public', backendMode: 'proxy', backendEndpoint: 'http://127.0.0.1:3000/', frontendEndpoint: 'account.example.net', status: 'active' }] },
    }),
  });
  const status = await client.getStatus();
  assert.equal(status.reachable, true);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(selectTargetShare(status, 'http://127.0.0.1:3000').kind, 'one');
});

test('uses only the configured loopback host and probes ports sequentially', async () => {
  const calls: string[] = [];
  const client = createZrokAgentConsoleClient({
    host: 'localhost',
    ports: [8888, 8889],
    fetchImpl: fakeAgentFetch({ 8889: { shares: [] } }, calls),
  });
  await client.getStatus();
  assert.deepEqual(calls, [
    'http://localhost:8888/v1/agent/status',
    'http://localhost:8889/v1/agent/status',
  ]);
  assert.throws(() => createZrokAgentConsoleClient({ host: 'agent.example.net' }), /loopback/i);
  assert.throws(() => createZrokAgentConsoleClient({ host: '127.0.0.2' }), /loopback/i);
});

test('reuses the verified Agent port and rediscovers when it becomes stale', async () => {
  const calls: number[] = [];
  let activePort = 8889;
  const client = createZrokAgentConsoleClient({
    ports: [8888, 8889, 8890],
    fetchImpl: async (input) => {
      const port = Number(new URL(String(input)).port);
      calls.push(port);
      if (port !== activePort) throw new Error('connection refused');
      return new Response(JSON.stringify({ shares: [] }), { status: 200 });
    },
  });

  assert.equal((await client.getStatus()).reachable, true);
  assert.deepEqual(calls, [8888, 8889]);

  calls.length = 0;
  assert.equal((await client.getStatus()).reachable, true);
  assert.deepEqual(calls, [8889]);

  activePort = 8890;
  calls.length = 0;
  assert.equal((await client.getStatus()).reachable, true);
  assert.deepEqual(calls, [8889, 8888, 8890]);

  calls.length = 0;
  assert.equal((await client.getStatus()).reachable, true);
  assert.deepEqual(calls, [8890]);
});

test('invalidates a transiently failed verified port and can recover on the next bounded discovery', async () => {
  const calls: number[] = [];
  let failVerifiedOnce = false;
  const client = createZrokAgentConsoleClient({
    ports: [8888, 8889],
    fetchImpl: async (input) => {
      const port = Number(new URL(String(input)).port);
      calls.push(port);
      if (port !== 8889 || failVerifiedOnce) {
        failVerifiedOnce = false;
        throw new Error('transient timeout');
      }
      return new Response(JSON.stringify({ shares: [] }), { status: 200 });
    },
  });

  assert.equal((await client.getStatus()).reachable, true);
  calls.length = 0;
  failVerifiedOnce = true;
  assert.equal((await client.getStatus()).reachable, false);
  assert.deepEqual(calls, [8889, 8888]);

  calls.length = 0;
  assert.equal((await client.getStatus()).reachable, true);
  assert.deepEqual(calls, [8888, 8889]);
});

test('refuses redirects from the loopback Agent console', async () => {
  let redirect: RequestRedirect | undefined;
  const client = createZrokAgentConsoleClient({
    ports: [8888],
    fetchImpl: async (_input, init) => {
      redirect = init?.redirect;
      return new Response(JSON.stringify({ shares: [] }), { status: 200 });
    },
  });
  await client.getStatus();
  assert.equal(redirect, 'error');
});

test('rejects an oversized streamed body before reading it completely', async () => {
  let textReads = 0;
  let cancelled = false;
  const oversizedChunk = new Uint8Array(256 * 1024 + 1);
  const response = {
    status: 200,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedChunk);
      },
      cancel() {
        cancelled = true;
      },
    }),
    async text() {
      textReads += 1;
      return '{}';
    },
  } as unknown as Response;
  const client = createZrokAgentConsoleClient({ ports: [8888], fetchImpl: async () => response });
  assert.deepEqual(await client.getStatus(), { reachable: false, shares: [] });
  assert.equal(textReads, 0);
  assert.equal(cancelled, true);
});

test('sanitizes malformed payload entries and omits unknown fields', async () => {
  const client = createZrokAgentConsoleClient({
    ports: [8888],
    fetchImpl: fakeAgentFetch({
      8888: { shares: [
        null,
        { backendEndpoint: 42 },
        { token: 'secret', shareMode: 'public', backendMode: 'proxy', backendEndpoint: 'http://127.0.0.1:3000', frontendEndpoint: 'https://agent.example.net', status: 'active', extra: 'omit-me' },
      ] },
    }),
  });
  const status = await client.getStatus();
  assert.deepEqual(status.shares, [{
    shareMode: 'public',
    backendMode: 'proxy',
    backendEndpoint: 'http://127.0.0.1:3000',
    frontendEndpoint: 'https://agent.example.net',
    status: 'active',
  }]);
});

test('normalizes the live Agent console frontendEndpoint array schema', async () => {
  const client = createZrokAgentConsoleClient({
    ports: [8888],
    fetchImpl: fakeAgentFetch({
      8888: { shares: [{
        token: 'secret',
        shareMode: 'public',
        backendMode: 'proxy',
        backendEndpoint: 'http://127.0.0.1:3000',
        frontendEndpoint: ['zrok-test.example.test'],
        status: 'active',
      }] },
    }),
  });

  const status = await client.getStatus();
  assert.deepEqual(status.shares, [{
    shareMode: 'public',
    backendMode: 'proxy',
    backendEndpoint: 'http://127.0.0.1:3000',
    frontendEndpoint: 'zrok-test.example.test',
    status: 'active',
  }]);
  assert.equal(JSON.stringify(status).includes('secret'), false);
});

test('drops ambiguous or unsafe frontend endpoint arrays', async () => {
  const client = createZrokAgentConsoleClient({
    ports: [8888],
    fetchImpl: fakeAgentFetch({
      8888: { shares: [
        {
          shareMode: 'public',
          backendMode: 'proxy',
          backendEndpoint: 'http://127.0.0.1:3000',
          frontendEndpoint: ['one.example.net', 'two.example.net'],
          status: 'active',
        },
        {
          shareMode: 'public',
          backendMode: 'proxy',
          backendEndpoint: 'http://127.0.0.1:3001',
          frontendEndpoint: ['\u0000invalid', 'valid.example.net'],
          status: 'active',
        },
        {
          shareMode: 'public',
          backendMode: 'proxy',
          backendEndpoint: 'http://127.0.0.1:3002',
          frontendEndpoint: ['x'.repeat(2_049)],
          status: 'active',
        },
      ] },
    }),
  });

  const status = await client.getStatus();
  assert.deepEqual(status.shares, [{
    shareMode: 'public',
    backendMode: 'proxy',
    backendEndpoint: 'http://127.0.0.1:3001',
    frontendEndpoint: 'valid.example.net',
    status: 'active',
  }]);
});

test('matches canonical backend targets exactly and preserves path semantics', () => {
  const status = {
    reachable: true,
    shares: [
      { shareMode: 'public', backendMode: 'proxy', backendEndpoint: 'HTTP://LOCALHOST:3000/api/', frontendEndpoint: 'agent.example.net', status: 'active' },
      { shareMode: 'public', backendMode: 'proxy', backendEndpoint: 'http://localhost:3000/api/v2', frontendEndpoint: 'custom.example.net', status: 'active' },
    ],
  };
  assert.equal(selectTargetShare(status, 'http://localhost:3000/api').kind, 'one');
  assert.equal(selectTargetShare(status, 'http://localhost:3000/api/').kind, 'one');
  assert.equal(selectTargetShare(status, 'http://localhost:3000').kind, 'none');
  assert.equal(selectTargetShare(status, 'http://localhost:3000/api/v2').kind, 'one');
});

test('selects only public proxy shares with a recognized lifecycle', () => {
  const target = 'http://127.0.0.1:3000';
  const makeShare = (overrides: Partial<ZrokLocalAgentShare>): ZrokLocalAgentShare => ({
    shareMode: 'public',
    backendMode: 'proxy',
    backendEndpoint: target,
    frontendEndpoint: 'agent.example.net',
    status: 'active',
    ...overrides,
  });

  for (const lifecycle of ['active', 'retrying', 'failed']) {
    const result = selectTargetShare({
      reachable: true,
      shares: [
        makeShare({ shareMode: 'private' }),
        makeShare({ backendMode: 'tunnel' }),
        makeShare({ status: 'unknown' }),
        makeShare({ status: lifecycle }),
      ],
    }, target);
    assert.equal(result.kind, 'one');
    assert.equal(result.share?.status, lifecycle);
  }
});

test('returns none or ambiguous when target selection is not unique', () => {
  const share = { shareMode: 'public', backendMode: 'proxy', backendEndpoint: 'http://127.0.0.1:3000', frontendEndpoint: 'custom.example.net', status: 'active' };
  assert.equal(selectTargetShare({ reachable: false, shares: [] }, 'http://127.0.0.1:3000').kind, 'none');
  assert.deepEqual(selectTargetShare({ reachable: true, shares: [share, { ...share, frontendEndpoint: 'bare.example.net' }] }, 'http://127.0.0.1:3000'), { kind: 'ambiguous' });
});

test('parses Retry-After seconds and HTTP dates with bounded delays', () => {
  const nowMs = Date.parse('2026-08-27T03:00:00.000Z');
  assert.equal(parseZrokRetryAfterMs('5', nowMs), 5_000);
  assert.equal(parseZrokRetryAfterMs(new Date(nowMs + 3_000).toUTCString(), nowMs), 3_000);
  assert.equal(parseZrokRetryAfterMs('not-a-delay', nowMs), null);
  assert.equal(parseZrokRetryAfterMs('999999', nowMs), 60_000);
});

test('honors local Agent 429 cooldown without probing other ports or amplifying requests', async () => {
  let nowMs = Date.parse('2026-08-27T03:00:00.000Z');
  let calls = 0;
  let rateLimited = true;
  const client = createZrokAgentConsoleClient({
    ports: [8888, 8889],
    now: () => nowMs,
    random: () => 0,
    fetchImpl: async () => {
      calls += 1;
      if (rateLimited) return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      return new Response(JSON.stringify({ shares: [] }), { status: 200 });
    },
  });

  const first = await client.getStatus();
  assert.equal(first.reachable, false);
  assert.equal(first.rateLimit?.source, 'local-agent');
  assert.equal(first.rateLimit?.retryAfterMs, 2_000);
  assert.equal(calls, 1);

  await client.getStatus();
  nowMs += 1_999;
  await client.getStatus();
  assert.equal(calls, 1);

  rateLimited = false;
  nowMs += 1;
  const recovered = await client.getStatus();
  assert.equal(recovered.reachable, true);
  assert.equal(recovered.rateLimit, undefined);
  assert.equal(calls, 2);
});

test('uses capped exponential fallback when Retry-After is missing or malformed', async () => {
  let nowMs = Date.parse('2026-08-27T03:00:00.000Z');
  let calls = 0;
  const client = createZrokAgentConsoleClient({
    ports: [8888],
    now: () => nowMs,
    random: () => 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response('', {
        status: 429,
        headers: calls === 1 ? { 'retry-after': 'malformed' } : {},
      });
    },
  });

  const first = await client.getStatus();
  assert.equal(first.rateLimit?.retryAfterMs, 1_000);
  assert.equal(first.rateLimit?.observedCount, 1);
  nowMs += 1_000;
  const second = await client.getStatus();
  assert.equal(second.rateLimit?.retryAfterMs, 2_000);
  assert.equal(second.rateLimit?.observedCount, 2);
  assert.equal(calls, 2);
});

test('coalesces concurrent local Agent status discovery into one request', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client = createZrokAgentConsoleClient({
    ports: [8888],
    freshResultMs: 0,
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return new Response(JSON.stringify({ shares: [] }), { status: 200 });
    },
  });

  const first = client.getStatus();
  const second = client.getStatus();
  const third = client.getStatus();
  release?.();
  const results = await Promise.all([first, second, third]);
  assert.equal(results.every((status) => status.reachable), true);
  assert.equal(calls, 1);
});
