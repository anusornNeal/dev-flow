import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const { devFlowToolDefinitions, getMcpToolList } = await import('../../src/server/contracts/devflowContract.js');
const { registerDevFlowRoutes } = await import('../../src/server/routes/devflow.js');
const { clearMcpTransportRecords, recordMcpTransportRequest } = await import('../../src/server/services/mcpTransportMonitor.js');

test('transport trace diagnostics is bounded and exposed on coding and diagnostics MCP profiles', () => {
  const tool = devFlowToolDefinitions.find((entry: any) => entry.name === 'get_transport_trace_diagnostics');
  assert.ok(tool);
  assert.equal(tool.lightweight, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.limit.minimum, 1);
  assert.equal(tool.inputSchema.properties.limit.maximum, 100);
  assert.equal(tool.inputSchema.properties.correlationId.maxLength, 160);
  assert.deepEqual(tool.inputSchema.properties.operation.enum, ['initialize', 'tools/list', 'tools/call', 'other']);
  assert.deepEqual(tool.inputSchema.properties.eventType.enum, ['request', 'session-lifecycle', 'legacy-sse']);
  assert.equal(getMcpToolList('coding').some((entry: any) => entry.name === tool.name), true);
  assert.equal(getMcpToolList('diagnostics').some((entry: any) => entry.name === tool.name), true);
  const request = tool.buildHttpRequest({ limit: 25, errorsOnly: true, toolName: 'get_task', runtimeInstanceId: 'runtime-1' });
  assert.equal(request.method, 'GET');
  assert.equal(request.path.includes('/api/transport-trace/diagnostics?'), true);
  assert.equal(request.path.includes('limit=25'), true);
  assert.equal(request.path.includes('errorsOnly=true'), true);
});

test('transport trace diagnostics HTTP route clamps results, filters errors, and stays metadata-only', async () => {
  clearMcpTransportRecords();
  for (let index = 0; index < 105; index += 1) {
    recordMcpTransportRequest({
      operation: 'tools/call',
      statusCode: index === 104 ? 500 : 200,
      totalMs: index,
      phaseMs: { parse: 0, connect: 0, handle: index, close: 0, responseFinalize: 0 },
      correlationId: `safe-${index}`,
      toolName: 'get_task',
      runtimeInstanceId: 'runtime-safe',
      outcome: index === 104 ? 'error' : 'success',
    });
  }

  const app = express();
  registerDevFlowRoutes(app, { state: { countersCache: {} }, writeAgentLog: () => {}, restartProcess: () => {} } as any);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind transport trace diagnostics test server.');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const cappedResponse = await fetch(`${baseUrl}/api/transport-trace/diagnostics?limit=999&runtimeInstanceId=runtime-safe`);
    const capped = await cappedResponse.json() as any;
    assert.equal(cappedResponse.status, 200);
    assert.equal(capped.limit, 100);
    assert.equal(capped.returned, 100);
    assert.equal(capped.truncated, true);
    assert.equal(capped.records.every((entry: any) => entry.runtimeInstanceId === 'runtime-safe'), true);
    assert.equal(capped.privacy.rawPayloadsStored, false);
    assert.equal(capped.privacy.rawHeadersStored, false);
    assert.equal(capped.privacy.toolArgumentsStored, false);
    assert.equal(capped.privacy.rawSessionIdentifiersStored, false);

    const errorsResponse = await fetch(`${baseUrl}/api/transport-trace/diagnostics?errorsOnly=true`);
    const errors = await errorsResponse.json() as any;
    assert.equal(errorsResponse.status, 200);
    assert.equal(errors.returned, 1);
    assert.equal(errors.records[0].statusCode, 500);

    const filteredResponse = await fetch(`${baseUrl}/api/transport-trace/diagnostics?slowMinMs=100&correlationId=safe-104&operation=tools%2Fcall&toolName=get_task&eventType=request`);
    const filtered = await filteredResponse.json() as any;
    assert.equal(filteredResponse.status, 200);
    assert.equal(filtered.returned, 1);
    assert.equal(filtered.records[0].correlationId, 'safe-104');
    assert.equal(filtered.records[0].totalMs, 104);

    const invalidResponse = await fetch(`${baseUrl}/api/transport-trace/diagnostics?errorsOnly=maybe`);
    const invalid = await invalidResponse.json() as any;
    assert.equal(invalidResponse.status, 400);
    assert.equal(invalid.error?.code, 'TRANSPORT_TRACE_FILTER_INVALID');

    const invalidTokenResponse = await fetch(`${baseUrl}/api/transport-trace/diagnostics?correlationId=unsafe%20value`);
    const invalidToken = await invalidTokenResponse.json() as any;
    assert.equal(invalidTokenResponse.status, 400);
    assert.equal(invalidToken.error?.code, 'TRANSPORT_TRACE_FILTER_INVALID');

    const serialized = JSON.stringify(capped);
    for (const forbidden of ['\"requestBody\":', '\"responseBody\":', '\"rawSessionId\":', 'secret-payload', 'raw-session-secret']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    clearMcpTransportRecords();
  }
});
