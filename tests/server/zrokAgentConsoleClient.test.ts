import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createZrokAgentConsoleClient,
  selectTargetShare,
} from '../../src/server/services/zrokAgentConsoleClient.js';

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

test('returns none or ambiguous when target selection is not unique', () => {
  const share = { shareMode: 'public', backendMode: 'proxy', backendEndpoint: 'http://127.0.0.1:3000', frontendEndpoint: 'custom.example.net', status: 'active' };
  assert.equal(selectTargetShare({ reachable: false, shares: [] }, 'http://127.0.0.1:3000').kind, 'none');
  assert.deepEqual(selectTargetShare({ reachable: true, shares: [share, { ...share, frontendEndpoint: 'bare.example.net' }] }, 'http://127.0.0.1:3000'), { kind: 'ambiguous' });
});
