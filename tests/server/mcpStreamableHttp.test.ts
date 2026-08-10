import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as streamableHttpModule from '../../src/server/mcpStreamableHttp.js';


async function withMcpServer(
  run: (baseUrl: string) => Promise<void>,
  hooks?: { onTiming?: (event: { phase: string; durationMs: number; outcome: string }) => void },
  sessionOptions?: streamableHttpModule.McpStreamableHttpSessionOptions,
) {
  const app = express();
  const runtimeInstanceId = randomUUID();
  let apiBaseUrl = '';
  let handler: ReturnType<typeof streamableHttpModule.createReusableMcpHttpHandler> | null = null;

  app.get('/api/workflow-health', (_req, res) => {
    res.json({ contractVersion: 'test-contract', runtimeInstanceId, marker: 'streamable-http-call-ok' });
  });
  app.use('/mcp', express.json({ limit: '1mb' }));
  app.all('/mcp', (req, res, next) => {
    if (!handler) throw new Error('MCP test handler is not initialized.');
    return handler(req, res, next);
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind MCP test server.');
  apiBaseUrl = `http://127.0.0.1:${address.port}`;
  handler = streamableHttpModule.createReusableMcpHttpHandler(apiBaseUrl, 'full', hooks, sessionOptions);

  try {
    await run(apiBaseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function createClient(baseUrl: string, name: string) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  return { client, transport };
}

async function readMcpResponse(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (/application\/json/i.test(contentType)) return response.json() as Promise<any>;
  const text = await response.text();
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
  assert.ok(dataLine, `Expected MCP SSE data frame, got: ${text.slice(0, 200)}`);
  return JSON.parse(dataLine.slice('data:'.length).trim()) as any;
}

async function callHealth(client: Client) {
  const result = await client.callTool({ name: 'devflow_health_check', arguments: {} }) as any;
  assert.equal(result.isError, undefined);
  const text = String(result.content?.[0]?.text || '');
  assert.match(text, /streamable-http-call-ok/);
  return JSON.parse(text) as { runtimeInstanceId: string; marker: string };
}

test('Streamable HTTP lifecycle plumbing lives in a focused transport module', () => {
  const mcpSource = fs.readFileSync(new URL('../../src/server/mcp.ts', import.meta.url), 'utf8');
  const adapterUrl = new URL('../../src/server/mcpStreamableHttp.ts', import.meta.url);
  assert.equal(fs.existsSync(adapterUrl), true, 'focused Streamable HTTP adapter module should exist');
  const adapterSource = fs.readFileSync(adapterUrl, 'utf8');
  const serverSource = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(mcpSource, /StreamableHTTPServerTransport/);
  assert.match(adapterSource, /StreamableHTTPServerTransport/);
  assert.match(serverSource, /from ['"]\.\/src\/server\/mcpStreamableHttp['"]/);
});

test('production server mounts the Streamable HTTP handler at /mcp while retaining /sse', () => {
  const source = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  assert.match(source, /app\.all\(['"]\/mcp['"]/);
  assert.match(source, /app\.get\(['"]\/sse['"]/);
  assert.match(source, /app\.post\(['"]\/sse['"]/);
});

test('Streamable HTTP handler initializes a reusable server session', async () => {
  await withMcpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'devflow-test-client', version: '1.0.0' },
        },
      }),
    });

    const body = await readMcpResponse(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.jsonrpc, '2.0');
    assert.match(response.headers.get('content-type') || '', /^text\/event-stream/i, 'Streamable HTTP POST responses should use request-scoped SSE');
    assert.equal(body.id, 1);
    assert.equal(body.result?.serverInfo?.name, 'dev-flow-mcp');
    assert.match(response.headers.get('mcp-session-id') || '', /^[0-9a-f-]{20,}$/i, 'stateful mode must issue a reusable session id');
  });
});

test('GET /mcp opens the SDK standalone SSE stream for an initialized session', async () => {
  await withMcpServer(async (baseUrl) => {
    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-stream-init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'devflow-get-stream-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get('mcp-session-id') || '';
    assert.match(sessionId, /^[0-9a-f-]{20,}$/i);
    await initialized.body?.cancel();

    const stream = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-06-18',
      },
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') || '', /^text\/event-stream/i);
    await stream.body?.cancel();
  });
});

test('GET /mcp preserves 404 only for a genuine stale session id', async () => {
  await withMcpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'mcp-session-id': randomUUID(),
        'mcp-protocol-version': '2025-06-18',
      },
    });
    assert.equal(response.status, 404);
    await response.body?.cancel();
  });
});

test('unsupported /mcp methods return 405 and advertise GET plus POST', async () => {
  await withMcpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'PUT' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, POST');
    await response.body?.cancel();
  });
});

test('optional lifecycle timing hook keeps the active session open after initialize', async () => {
  const events: Array<{ phase: string; durationMs: number; outcome: string }> = [];

  await withMcpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'devflow-lifecycle-hook-test', version: '1.0.0' },
        },
      }),
    });

    const body = await readMcpResponse(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.result?.serverInfo?.name, 'dev-flow-mcp');
  }, {
    onTiming: (event) => events.push(event),
  });

  assert.deepEqual(events.map((event) => event.phase), ['connect', 'handle']);
  assert.ok(events.every((event) => event.durationMs >= 0));
  assert.ok(events.every((event) => event.outcome === 'success'));
});

test('official Streamable HTTP client reuses one server session across list and tool calls', async () => {
  await withMcpServer(async (baseUrl) => {
    const { client, transport } = createClient(baseUrl, 'devflow-streamable-http-test');

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === 'devflow_health_check'));
      await callHealth(client);
      assert.match(String((transport as any).sessionId || ''), /^[0-9a-f-]{20,}$/i, 'client must retain the reusable server session id');
    } finally {
      await client.close();
    }
  });
});

test('repeated calls reuse one MCP server and transport lifecycle for the active session', async () => {
  const events: Array<{ phase: string; durationMs: number; outcome: string }> = [];
  await withMcpServer(async (baseUrl) => {
    const { client, transport } = createClient(baseUrl, 'devflow-session-reuse');
    try {
      await client.connect(transport);
      await client.listTools();
      await callHealth(client);
    } finally {
      await client.close();
    }
  }, { onTiming: (event) => events.push(event) });

  assert.equal(events.filter((event) => event.phase === 'connect').length, 1);
  assert.ok(events.filter((event) => event.phase === 'handle').length >= 3);
  assert.equal(events.filter((event) => event.phase === 'close').length, 0);
});

test('idle sessions are pruned and stale session ids require a fresh initialize', async () => {
  let fakeNow = 1_000;
  const events: Array<{ phase: string; durationMs: number; outcome: string }> = [];
  const initialize = (baseUrl: string, name: string) => fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: name,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name, version: '1.0.0' },
      },
    }),
  });

  await withMcpServer(async (baseUrl) => {
    const first = await initialize(baseUrl, 'idle-first');
    assert.equal(first.status, 200);
    const firstSessionId = first.headers.get('mcp-session-id') || '';
    assert.match(firstSessionId, /^[0-9a-f-]{20,}$/i);
    await first.body?.cancel();

    fakeNow += 1_000;
    const second = await initialize(baseUrl, 'idle-second');
    assert.equal(second.status, 200);
    const secondSessionId = second.headers.get('mcp-session-id') || '';
    assert.match(secondSessionId, /^[0-9a-f-]{20,}$/i);
    assert.notEqual(secondSessionId, firstSessionId);
    await second.body?.cancel();

    const stale = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': firstSessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    });
    assert.equal(stale.status, 404);
    await stale.body?.cancel();
  }, { onTiming: (event) => events.push(event) }, {
    idleTtlMs: 100,
    maxSessions: 2,
    now: () => fakeNow,
  });

  assert.ok(events.some((event) => event.phase === 'close' && event.outcome === 'success'));
});

test('two Streamable HTTP clients operate concurrently without shared server session state', async () => {
  await withMcpServer(async (baseUrl) => {
    const a = createClient(baseUrl, 'devflow-client-a');
    const b = createClient(baseUrl, 'devflow-client-b');

    try {
      await Promise.all([a.client.connect(a.transport), b.client.connect(b.transport)]);
      await Promise.all([callHealth(a.client), callHealth(b.client)]);
      assert.match(String((a.transport as any).sessionId || ''), /^[0-9a-f-]{20,}$/i);
      assert.match(String((b.transport as any).sessionId || ''), /^[0-9a-f-]{20,}$/i);
      assert.notEqual((a.transport as any).sessionId, (b.transport as any).sessionId);
    } finally {
      await Promise.all([a.client.close(), b.client.close()]);
    }
  });
});

test('a fresh Streamable HTTP client reconnects to a replacement runtime without old protocol session state', async () => {
  let firstRuntimeInstanceId = '';
  let secondRuntimeInstanceId = '';

  await withMcpServer(async (baseUrl) => {
    const first = createClient(baseUrl, 'devflow-before-restart');
    try {
      await first.client.connect(first.transport);
      firstRuntimeInstanceId = (await callHealth(first.client)).runtimeInstanceId;
      assert.match(String((first.transport as any).sessionId || ''), /^[0-9a-f-]{20,}$/i);
    } finally {
      await first.client.close();
    }
  });

  await withMcpServer(async (baseUrl) => {
    const second = createClient(baseUrl, 'devflow-after-restart');
    try {
      await second.client.connect(second.transport);
      secondRuntimeInstanceId = (await callHealth(second.client)).runtimeInstanceId;
      assert.match(String((second.transport as any).sessionId || ''), /^[0-9a-f-]{20,}$/i);
    } finally {
      await second.client.close();
    }
  });

  assert.notEqual(firstRuntimeInstanceId, secondRuntimeInstanceId, 'replacement runtime should expose a fresh runtime identity');
});
