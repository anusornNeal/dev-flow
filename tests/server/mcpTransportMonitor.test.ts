import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  classifyMcpTransportOperation,
  clearMcpTransportRecords,
  createMcpTransportRequestTracker,
  getMcpTransportToolName,
  queryMcpTransportTrace,
  recordMcpTransportTraceEvent,
  getMcpTransportSummary,
  recordMcpStreamableHttpSessionLifecycle,
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

test('session lifecycle diagnostics expose bounded aggregate counts and timestamps only', () => {
  clearMcpTransportRecords();
  const now = 20_000;
  recordMcpStreamableHttpSessionLifecycle({ kind: 'request-start', timestamp: now, activeSessions: 1, idleSessions: 2 });
  recordMcpStreamableHttpSessionLifecycle({ kind: 'created', timestamp: now + 1, activeSessions: 1, idleSessions: 2 });
  recordMcpStreamableHttpSessionLifecycle({ kind: 'capacity-evicted', timestamp: now + 2, activeSessions: 1, idleSessions: 1 });
  recordMcpStreamableHttpSessionLifecycle({ kind: 'stale-session-404', timestamp: now + 3, activeSessions: 1, idleSessions: 1 });

  const summary = getMcpTransportSummary({ now: now + 10, windowMs: 1_000 });
  assert.equal(summary.sessions.activeSessions, 1);
  assert.equal(summary.sessions.idleSessions, 1);
  assert.equal(summary.sessions.created, 1);
  assert.equal(summary.sessions.capacityEvicted, 1);
  assert.equal(summary.sessions.staleSession404, 1);
  assert.equal(summary.sessions.lastMcpRequestAt, new Date(now).toISOString());
  assert.equal(summary.privacy.rawSessionIdentifiersStored, false);
  assert.equal(summary.privacy.rawClientIdentifiersStored, false);
  assert.doesNotMatch(JSON.stringify(summary.sessions), /sessionId|clientId|secret/i);
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

test('trace records keep only bounded safe metadata and represent missing fields explicitly', () => {
  clearMcpTransportRecords();
  recordMcpTransportRequest({
    operation: 'tools/call',
    statusCode: 200,
    totalMs: 42,
    phaseMs: { parse: 1, connect: 2, handle: 35, close: 1, responseFinalize: 3 },
    timestamp: 30_000,
    correlationId: 'corr-123',
    toolName: 'commit_git_changes',
    runtimeInstanceId: 'runtime-abc',
    outcome: 'success',
  });
  recordMcpTransportTraceEvent({
    eventType: 'legacy-sse',
    lifecycleEvent: 'sse-connect',
    correlationId: 'sse-1',
    runtimeInstanceId: 'runtime-abc',
    timestamp: 30_001,
  });

  const request = queryMcpTransportTrace({ correlationId: 'corr-123' });
  assert.equal(request.returned, 1);
  assert.equal(request.records[0].eventType, 'request');
  assert.equal(request.records[0].operation, 'tools/call');
  assert.equal(request.records[0].toolName, 'commit_git_changes');
  assert.equal(request.records[0].runtimeInstanceId, 'runtime-abc');
  assert.equal(request.records[0].outcome, 'success');
  assert.deepEqual(request.records[0].phaseMs, { parse: 1, connect: 2, handle: 35, close: 1, responseFinalize: 3 });
  assert.equal(request.records[0].lifecycleEvent, null);

  const lifecycle = queryMcpTransportTrace({ eventType: 'legacy-sse' });
  assert.equal(lifecycle.records[0].lifecycleEvent, 'sse-connect');
  assert.equal(lifecycle.records[0].operation, null);
  assert.equal(lifecycle.records[0].toolName, null);
  assert.equal(lifecycle.records[0].statusCode, null);
  assert.equal(lifecycle.records[0].outcome, 'unknown');
  assert.equal(lifecycle.records[0].phaseMs, null);
  assert.equal(lifecycle.privacy.rawPayloadsStored, false);
  assert.equal(lifecycle.privacy.rawHeadersStored, false);
  assert.equal(lifecycle.privacy.toolArgumentsStored, false);
  assert.equal(lifecycle.privacy.rawSessionIdentifiersStored, false);
});

test('unsafe trace metadata is discarded instead of retaining raw values', () => {
  clearMcpTransportRecords();
  const unsafeCorrelation = 'corr secret with spaces';
  const unsafeTool = `tool-${'x'.repeat(200)}`;
  const unsafeRuntime = 'runtime\\nsecret';
  recordMcpTransportRequest({
    operation: 'tools/call',
    statusCode: 500,
    totalMs: 10,
    phaseMs: { parse: 0, connect: 0, handle: 10, close: 0, responseFinalize: 0 },
    correlationId: unsafeCorrelation,
    toolName: unsafeTool,
    runtimeInstanceId: unsafeRuntime,
    outcome: 'error',
  });
  const result = queryMcpTransportTrace();
  assert.equal(result.records[0].correlationId, null);
  assert.equal(result.records[0].toolName, null);
  assert.equal(result.records[0].runtimeInstanceId, null);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /corr secret with spaces/);
  assert.doesNotMatch(serialized, /runtime\\nsecret/);
  assert.equal(serialized.includes(unsafeTool), false);
});

test('trace retention, drop accounting, and query limits are hard bounded', () => {
  clearMcpTransportRecords();
  for (let index = 0; index < 550; index += 1) {
    recordMcpTransportRequest({
      operation: index % 2 === 0 ? 'tools/call' : 'tools/list',
      statusCode: index % 10 === 0 ? 500 : 200,
      totalMs: index,
      phaseMs: { parse: 0, connect: 0, handle: index, close: 0, responseFinalize: 0 },
      timestamp: index,
      correlationId: `corr-${index}`,
      runtimeInstanceId: 'runtime-retention',
      outcome: index % 10 === 0 ? 'error' : 'success',
    });
  }
  const summary = getMcpTransportSummary({ now: 600, windowMs: 10_000 });
  assert.equal(summary.trace.retainedRecords, 500);
  assert.equal(summary.trace.droppedRecords, 50);

  const capped = queryMcpTransportTrace({ limit: 999 });
  assert.equal(capped.limit, 100);
  assert.equal(capped.returned, 100);
  assert.equal(capped.totalMatched, 500);
  assert.equal(capped.droppedRecords, 50);
  assert.equal(capped.truncated, true);

  const errors = queryMcpTransportTrace({ errorsOnly: true, runtimeInstanceId: 'runtime-retention' });
  assert.equal(errors.records.every((entry) => entry.outcome === 'error' || (entry.statusCode || 0) >= 400), true);
  const slow = queryMcpTransportTrace({ slowMinMs: 540 });
  assert.equal(slow.records.every((entry) => (entry.totalMs || 0) >= 540), true);
});

test('invalid or oversized trace filters fail closed instead of broadening the query', () => {
  clearMcpTransportRecords();
  recordMcpTransportRequest({
    operation: 'initialize',
    statusCode: 200,
    totalMs: 1,
    phaseMs: { parse: 0, connect: 0, handle: 1, close: 0, responseFinalize: 0 },
    correlationId: 'known-good',
  });
  const invalid = queryMcpTransportTrace({ correlationId: 'bad filter with spaces' });
  assert.equal(invalid.returned, 0);
  assert.deepEqual(invalid.invalidFilters, ['correlationId']);
  const oversized = queryMcpTransportTrace({ toolName: 'x'.repeat(500) });
  assert.equal(oversized.returned, 0);
  assert.deepEqual(oversized.invalidFilters, ['toolName']);
  const invalidSince = queryMcpTransportTrace({ since: Number.NaN });
  assert.deepEqual(invalidSince.invalidFilters, ['since']);
  const invalidSlow = queryMcpTransportTrace({ slowMinMs: -1 });
  assert.deepEqual(invalidSlow.invalidFilters, ['slowMinMs']);
});

test('duplicate and malformed metadata stay bounded and explicit without throwing', () => {
  clearMcpTransportRecords();
  for (let index = 0; index < 2; index += 1) {
    recordMcpTransportRequest({
      operation: 'tools/list',
      statusCode: 200,
      totalMs: 1,
      phaseMs: { parse: 0, connect: 0, handle: 1, close: 0, responseFinalize: 0 },
      correlationId: 'duplicate-correlation',
    });
  }
  const duplicates = queryMcpTransportTrace({ correlationId: 'duplicate-correlation' });
  assert.equal(duplicates.totalMatched, 2);
  assert.equal(duplicates.records.every((entry) => entry.outcome === 'unknown'), true);

  assert.doesNotThrow(() => recordMcpTransportTraceEvent({
    eventType: 'not-a-real-event',
    lifecycleEvent: 'not-a-real-lifecycle',
    correlationId: 'unsafe correlation value',
  } as any));
  const latest = queryMcpTransportTrace({ limit: 1 });
  assert.equal(latest.records[0].eventType, 'session-lifecycle');
  assert.equal(latest.records[0].lifecycleEvent, null);
  assert.equal(latest.records[0].correlationId, null);
  assert.equal(JSON.stringify(latest).includes('unsafe correlation value'), false);
});

test('tool-name extraction reads only already-parsed tools/call metadata', () => {
  assert.equal(getMcpTransportToolName({ method: 'tools/call', params: { name: 'commit_git_changes', arguments: { password: 'secret' } } }), 'commit_git_changes');
  assert.equal(getMcpTransportToolName({ method: 'tools/list', params: { name: 'should-not-be-read' } }), null);
  assert.equal(getMcpTransportToolName({ method: 'tools/call', params: { name: 'unsafe tool name' } }), null);
});

test('representative trace bookkeeping keeps p50/p95 overhead bounded versus the pre-trace aggregate path', () => {
  const samples = 25;
  const recordsPerSample = 400;
  const baselineDurations: number[] = [];
  const tracedDurations: number[] = [];
  const baselineRecords: any[] = [];
  const percentile = (values: number[], ratio: number) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
  };
  const baselineRecord = (index: number) => {
    baselineRecords.push({
      operation: 'tools/call',
      statusCode: 200,
      totalMs: index,
      phaseMs: { parse: 0, connect: 0, handle: index, close: 0, responseFinalize: 0 },
      timestamp: index,
    });
    if (baselineRecords.length > 500) baselineRecords.splice(0, baselineRecords.length - 500);
  };

  for (let sample = 0; sample < samples; sample += 1) {
    baselineRecords.length = 0;
    let startedAt = performance.now();
    for (let index = 0; index < recordsPerSample; index += 1) baselineRecord(index);
    baselineDurations.push((performance.now() - startedAt) / recordsPerSample);

    clearMcpTransportRecords();
    startedAt = performance.now();
    for (let index = 0; index < recordsPerSample; index += 1) {
      recordMcpTransportRequest({
        operation: 'tools/call',
        statusCode: 200,
        totalMs: index,
        phaseMs: { parse: 0, connect: 0, handle: index, close: 0, responseFinalize: 0 },
        timestamp: index,
        correlationId: `bench-${index}`,
        toolName: 'get_task',
        runtimeInstanceId: 'runtime-bench',
        outcome: 'success',
      });
    }
    tracedDurations.push((performance.now() - startedAt) / recordsPerSample);
  }

  const baselineP50 = percentile(baselineDurations, 0.5);
  const baselineP95 = percentile(baselineDurations, 0.95);
  const tracedP50 = percentile(tracedDurations, 0.5);
  const tracedP95 = percentile(tracedDurations, 0.95);
  console.log(`[transport-trace-overhead] baseline_p50_ms=${baselineP50.toFixed(6)} baseline_p95_ms=${baselineP95.toFixed(6)} traced_p50_ms=${tracedP50.toFixed(6)} traced_p95_ms=${tracedP95.toFixed(6)}`);
  assert.equal(Number.isFinite(tracedP50) && Number.isFinite(tracedP95), true);
  assert.equal(tracedP95 < Math.max(5, baselineP95 * 20), true);
});

test('production MCP route records transport timings and diagnostics expose the summary', () => {
  const serverSource = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const diagnosticsSource = fs.readFileSync(new URL('../../src/server/services/mcpToolMonitor.ts', import.meta.url), 'utf8');
  assert.match(serverSource, /createMcpTransportRequestTracker/);
  assert.match(serverSource, /classifyMcpTransportOperation/);
  assert.match(serverSource, /tracker\.complete/);
  assert.match(serverSource, /DEVFLOW_MCP_SESSION_IDLE_TTL_MS/);
  assert.match(serverSource, /onSessionLifecycle:\s*recordMcpStreamableHttpSessionLifecycle/);
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
  app.all('/mcp', async (req, res, next) => {
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
    onSessionLifecycle: recordMcpStreamableHttpSessionLifecycle,
  });

  const client = new Client({ name: 'transport-monitor-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${apiBaseUrl}/mcp`));
  try {
    await client.connect(transport);
    await client.listTools();
    const call = await client.callTool({ name: 'devflow_health_check', arguments: {} }) as any;
    assert.equal(call.isError, undefined);
    await client.close();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const pendingSummary = getMcpTransportSummary({ windowMs: 60_000 });
      if ((pendingSummary.byOperation.find((entry) => entry.operation === 'other')?.count || 0) >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

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

    const other = summary.byOperation.find((entry) => entry.operation === 'other');
    assert.ok((other?.count || 0) >= 2, 'initialized notification and GET SSE lifecycle should both be tracked as bounded other operations');
    assert.equal(other?.errorCount, 0, 'normal GET SSE lifecycle must not be recorded as a transport error');
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
