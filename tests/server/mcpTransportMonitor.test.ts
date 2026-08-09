import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import express from 'express';import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  classifyMcpTransportOperation,
  clearMcpTransportRecords,
  createMcpTransportRequestTracker,
  getMcpTransportSummary,
  recordMcpTransportRequest,
} from '../../src/server/services/mcpTransportMonitor.js';
import { createReusableMcpHttpHandler } from '../../src/server/mcpStreamableHttp.js';

test('transport monitor aggregates bounded p50/p95 timings without retaining payloads', () => {
  clearMcpTransportRecords();
  const now = 10_000;
  recordMcpTransportRequest({
    operation: 'initialize',
    statusCode: 200,
    totalMs: 10,
    phaseMs: { parse: 1, connect: 2, handle: 5, close: 1, responseFinalize: 1 },
    timestamp: now,
  });
  recordMcpTransportRequest({
    operation: 'initialize',
    statusCode: 200,
    totalMs: 30,
    phaseMs: { parse: 2, connect: 4, handle: 20, close: 2, responseFinalize: 2 },
    timestamp: now + 1,
  });
  recordMcpTransportRequest({
    operation: 'tools/list',
    statusCode: 500,
    totalMs: 15,
    phaseMs: { parse: 1, connect: 3, handle: 8, close: 2, responseFinalize: 1 },
    timestamp: now + 2,
  });

  const summary = getMcpTransportSummary({ now: now + 10, windowMs: 1_000 });
  assert.equal(summary.totalRequests, 3);
  assert.equal(summary.privacy.rawPayloadsStored, false);
  assert.equal(summary.downstreamToolTelemetry.doubleCounted, false);
  assert.equal(summary.downstreamToolTelemetry.source, 'tools');

  const initialize = summary.byOperation.find((entry) => entry.operation === 'initialize');
  assert.equal(initialize?.count, 2);
  assert.equal(initialize?.p50TotalMs, 10);
  assert.equal(initialize?.p95TotalMs, 30);
  assert.equal(initialize?.phases.handle.p50Ms, 5);
  assert.equal(initialize?.phases.handle.p95Ms, 20);
  assert.equal(initialize?.errorCount, 0);

  const list = summary.byOperation.find((entry) => entry.operation === 'tools/list');
  assert.equal(list?.errorCount, 1);
  assert.doesNotMatch(JSON.stringify(summary), /password|secret|arguments|params/);
});

test('transport monitor retention is bounded', () => {
  clearMcpTransportRecords();
  for (let index = 0; index < 550; index += 1) {
    recordMcpTransportRequest({
      operation: 'tools/call',
      statusCode: 200,
      totalMs: index,
      phaseMs: { parse: 0, connect: 0, handle: index, close: 0, responseFinalize: 0 },
      timestamp: index,
    });
  }
  const summary = getMcpTransportSummary({ now: 600, windowMs: 10_000 });
  assert.equal(summary.retainedRecords <= 500, true);
  assert.equal(summary.totalRequests <= 500, true);
});

test('operation classifier stores only bounded method labels', () => {
  assert.equal(classifyMcpTransportOperation({ method: 'initialize', params: { secret: 'x' } }), 'initialize');
  assert.equal(classifyMcpTransportOperation({ method: 'tools/list', params: { secret: 'x' } }), 'tools/list');
  assert.equal(classifyMcpTransportOperation({ method: 'tools/call', params: { name: 'commit_git_changes', arguments: { password: 'secret' } } }), 'tools/call');
  assert.equal(classifyMcpTransportOperation({ method: 'notifications/initialized' }), 'other');
});

test('production MCP route records transport timings and diagnostics expose the summary', () => {
  const serverSource = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const diagnosticsSource = fs.readFileSync(new URL('../../src/server/services/mcpToolMonitor.ts', import.meta.url), 'utf8');
  assert.match(serverSource, /createMcpTransportRequestTracker/);
  assert.match(serverSource, /classifyMcpTransportOperation/);
  assert.match(serverSource, /tracker\.complete/);
  assert.match(diagnosticsSource, /getMcpTransportSummary/);
  assert.match(diagnosticsSource, /mcpTransport/);
});

test('tracker records initialize, tools/list, and tools/call lifecycle phases from real Streamable HTTP requests', async () => {
  clearMcpTransportRecords();
  const app = express();
  let apiBaseUrl = '';
  let handler: ReturnType<typeof createReusableMcpHttpHandler> | null = null;
  app.get('/api/workflow-health', (_req, res) => res.json({ ok: true, marker: 'transport-monitor-ok' }));
  app.use('/mcp', (req, res, next) => {
    res.locals.mcpTransportStartedAt = Date.now();
    next();
  });
  app.use('/mcp', express.json({ limit: '1mb' }));
  app.post('/mcp', async (req, res, next) => {
    if (!handler) throw new Error('MCP transport test handler is not initialized.');
    const startedAt = Number(res.locals.mcpTransportStartedAt || Date.now());
    const tracker = createMcpTransportRequestTracker({
      operation: classifyMcpTransportOperation(req.body),
      startedAt,
      parseMs: Math.max(0, Date.now() - startedAt),
    });
    res.locals.mcpTransportTracker = tracker;
    let responseFinishedAt: number | undefined;
    res.once('finish', () => { responseFinishedAt = Date.now(); });
    try {
      await handler(req, res, next);
    } finally {
      tracker.complete({ statusCode: res.statusCode, responseFinishedAt });
    }
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind transport monitor test server.');
  apiBaseUrl = `http://127.0.0.1:${address.port}`;
  handler = createReusableMcpHttpHandler(apiBaseUrl, 'full', undefined, {
    requestHooks: (_req, res) => res.locals.mcpTransportTracker?.hooks,
  });

  const client = new Client({ name: 'transport-monitor-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${apiBaseUrl}/mcp`));
  try {
    await client.connect(transport);
    await client.listTools();
    const call = await client.callTool({ name: 'devflow_health_check', arguments: {} }) as any;
    assert.equal(call.isError, undefined);

    const summary = getMcpTransportSummary({ windowMs: 60_000 });
    for (const operation of ['initialize', 'tools/list', 'tools/call'] as const) {
      const row = summary.byOperation.find((entry) => entry.operation === operation);
      assert.equal(row?.count, 1, `${operation} should be recorded once`);
      assert.equal((row?.p95TotalMs || 0) >= 0, true);
      for (const phase of Object.values(row?.phases || {})) {
        assert.equal(phase.p50Ms >= 0, true);
        assert.equal(phase.p95Ms >= 0, true);
      }
    }
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
