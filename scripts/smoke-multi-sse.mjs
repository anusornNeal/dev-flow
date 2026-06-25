#!/usr/bin/env node
// Smoke test: connect two MCP SSE clients, verify both get independent sessions.
// Run with DevFlow server on localhost:3000: npm run smoke-multi-sse

const BASE = process.env.DEVFLOW_URL || 'http://localhost:3000';

async function connect(label) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
  const client = new Client({ name: `smoke-${label}`, version: '1.0.0' });
  const transport = new SSEClientTransport(new URL('/sse', BASE));
  await client.connect(transport);
  return client;
}

async function main() {
  console.log('Smoke test: connecting two clients to DevFlow SSE');

  let a, b;
  try {
    a = await connect('A');
    b = await connect('B');

    const { tools: toolsA } = await a.listTools(undefined, { timeout: 5000 });
    const { tools: toolsB } = await b.listTools(undefined, { timeout: 5000 });
    if (!toolsA?.length) throw new Error('Client A got no tools');
    if (!toolsB?.length) throw new Error('Client B got no tools');
    console.log(`Client A: ${toolsA.length} tools, Client B: ${toolsB.length} tools`);

    let capsA = await a.callTool({ name: 'get_capabilities', arguments: {} }, undefined, { timeout: 5000 });
    let capsB = await b.callTool({ name: 'get_capabilities', arguments: {} }, undefined, { timeout: 5000 });
    if (!capsA?.content?.length) throw new Error('Client A capabilities failed');
    if (!capsB?.content?.length) throw new Error('Client B capabilities failed');
    console.log('Both clients completed calls independently');

    await a.close();
    a = null;
    capsB = await b.callTool({ name: 'get_capabilities', arguments: {} }, undefined, { timeout: 5000 });
    if (!capsB?.content?.length) throw new Error('Client B failed after A disconnected');
    console.log('Client B still works after A disconnected');

    await b.close();
    b = null;
    console.log('PASS: multi-client SSE routing is session-safe');
  } finally {
    if (a) await a.close().catch(() => {});
    if (b) await b.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
