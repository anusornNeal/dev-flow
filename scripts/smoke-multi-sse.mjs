#!/usr/bin/env node
// Smoke test: connect two MCP SSE clients, verify both get independent sessions
// Run: npm run smoke-multi-sse
// Assumes DevFlow server is running on http://localhost:3000

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
  console.log(`Smoke test: connecting two clients to ${BASE}/sse`);

  const a = await connect('A');
  const b = await connect('B');

  // Both clients should be able to list tools independently
  const listA = await a.request({ method: 'tools/list' }, { timeout: 5000 });
  const listB = await b.request({ method: 'tools/list' }, { timeout: 5000 });
  if (!listA?.tools?.length) throw new Error('Client A got no tools');
  if (!listB?.tools?.length) throw new Error('Client B got no tools');

  console.log(`Client A: ${listA.tools.length} tools`);
  console.log(`Client B: ${listB.tools.length} tools`);

  // Both clients should get capabilities independently
  const capsA = await a.request({ method: 'tools/call', params: { name: 'get_capabilities', arguments: {} } }, { timeout: 5000 });
  const capsB = await b.request({ method: 'tools/call', params: { name: 'get_capabilities', arguments: {} } }, { timeout: 5000 });
  if (!capsA?.content?.length) throw new Error('Client A capabilities failed');
  if (!capsB?.content?.length) throw new Error('Client B capabilities failed');

  console.log('Both clients completed calls independently');

  // Disconnect A, verify B still works
  await a.close();
  const capsB2 = await b.request({ method: 'tools/call', params: { name: 'get_capabilities', arguments: {} } }, { timeout: 5000 });
  if (!capsB2?.content?.length) throw new Error('Client B failed after A disconnected');
  console.log('Client B still works after A disconnected');

  await b.close();
  console.log('PASS: multi-client SSE routing is session-safe');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
