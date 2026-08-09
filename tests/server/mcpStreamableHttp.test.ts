import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as mcpModule from '../../src/server/mcp.js';

const previousToolProfile = process.env.DEVFLOW_MCP_TOOL_PROFILE;
test.before(() => {
  process.env.DEVFLOW_MCP_TOOL_PROFILE = 'full';
});
test.after(() => {
  if (previousToolProfile === undefined) delete process.env.DEVFLOW_MCP_TOOL_PROFILE;
  else process.env.DEVFLOW_MCP_TOOL_PROFILE = previousToolProfile;
});

async function withMcpServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  const runtimeInstanceId = randomUUID();
  let apiBaseUrl = '';

  app.get('/api/capabilities', (_req, res) => {
    res.json({ contractVersion: 'test-contract', runtimeInstanceId, marker: 'streamable-http-call-ok' });
  });
  app.use('/mcp', express.json({ limit: '1mb' }));
  app.post('/mcp', (req, res, next) => {
    return (mcpModule as any).createStatelessMcpHttpHandler(apiBaseUrl)(req, res, next);
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind MCP test server.');
  apiBaseUrl = `http://127.0.0.1:${address.port}`;

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

async function callCapabilities(client: Client) {
  const result = await client.callTool({ name: 'get_capabilities', arguments: {} }) as any;
  assert.equal(result.isError, undefined);
  const text = String(result.content?.[0]?.text || '');
  assert.match(text, /streamable-http-call-ok/);
  return JSON.parse(text) as { runtimeInstanceId: string; marker: string };
}

test('mcp module exposes a stateless Streamable HTTP request handler factory', () => {
  assert.equal(
    typeof (mcpModule as any).createStatelessMcpHttpHandler,
    'function',
    'createStatelessMcpHttpHandler should be exported for /mcp routing',
  );
});

test('production server mounts the Streamable HTTP handler at /mcp while retaining /sse', () => {
  const source = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  assert.match(source, /app\.post\(['"]\/mcp['"]/);
  assert.match(source, /app\.get\(['"]\/sse['"]/);
  assert.match(source, /app\.post\(['"]\/sse['"]/);
});

test('stateless Streamable HTTP handler accepts MCP initialize', async () => {
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

    const body = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.result?.serverInfo?.name, 'dev-flow-mcp');
    assert.equal(response.headers.get('mcp-session-id'), null, 'stateless mode must not issue a session id');
  });
});

test('official Streamable HTTP client can connect, list tools, and call get_capabilities without a server session', async () => {
  await withMcpServer(async (baseUrl) => {
    const { client, transport } = createClient(baseUrl, 'devflow-streamable-http-test');

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === 'get_capabilities'));
      await callCapabilities(client);
      assert.equal((transport as any).sessionId, undefined, 'stateless client must not receive a server session id');
    } finally {
      await client.close();
    }
  });
});

test('two Streamable HTTP clients operate concurrently without shared server session state', async () => {
  await withMcpServer(async (baseUrl) => {
    const a = createClient(baseUrl, 'devflow-client-a');
    const b = createClient(baseUrl, 'devflow-client-b');

    try {
      await Promise.all([a.client.connect(a.transport), b.client.connect(b.transport)]);
      await Promise.all([callCapabilities(a.client), callCapabilities(b.client)]);
      assert.equal((a.transport as any).sessionId, undefined);
      assert.equal((b.transport as any).sessionId, undefined);
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
      firstRuntimeInstanceId = (await callCapabilities(first.client)).runtimeInstanceId;
      assert.equal((first.transport as any).sessionId, undefined);
    } finally {
      await first.client.close();
    }
  });

  await withMcpServer(async (baseUrl) => {
    const second = createClient(baseUrl, 'devflow-after-restart');
    try {
      await second.client.connect(second.transport);
      secondRuntimeInstanceId = (await callCapabilities(second.client)).runtimeInstanceId;
      assert.equal((second.transport as any).sessionId, undefined);
    } finally {
      await second.client.close();
    }
  });

  assert.notEqual(firstRuntimeInstanceId, secondRuntimeInstanceId, 'replacement runtime should expose a fresh runtime identity');
});
