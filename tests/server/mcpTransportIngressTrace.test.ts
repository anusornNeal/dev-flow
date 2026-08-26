import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Keep ingress tracing metadata-only and fail-open at the source contract boundary.
const adapterSource = fs.readFileSync('src/server/mcpStreamableHttp.ts', 'utf8');
const serverSource = fs.readFileSync('server.ts', 'utf8');

test('Streamable HTTP lifecycle contract carries request correlation metadata without session ids', () => {
  assert.match(adapterSource, /requestTraceContext\?:/);
  assert.match(adapterSource, /correlationId\?: string \| null/);
  assert.match(adapterSource, /runtimeInstanceId\?: string \| null/);
  assert.match(adapterSource, /statusCode\?: number \| null/);
  assert.match(adapterSource, /totalMs\?: number \| null/);
  assert.match(adapterSource, /outcome\?: ['"]success['"] \| ['"]error['"] \| ['"]aborted['"]/);
  assert.doesNotMatch(adapterSource, /sessionId:\s*entry\.sessionId/);
});

test('Streamable HTTP telemetry callbacks are guarded so instrumentation stays fail-open', () => {
  assert.match(adapterSource, /try\s*\{[\s\S]{0,300}options\.requestHooks\?\./);
  assert.match(adapterSource, /try\s*\{[\s\S]{0,300}options\.requestTraceContext\?\./);
  assert.match(adapterSource, /Telemetry must never alter transport behavior|telemetry must never alter transport behavior/i);
});

test('production MCP ingress attaches runtime, correlation, tool metadata and terminal outcome', () => {
  assert.match(serverSource, /getRuntimeIdentity/);
  assert.match(serverSource, /getMcpTransportToolName/);
  assert.match(serverSource, /x-correlation-id/i);
  assert.match(serverSource, /runtimeInstanceId/);
  assert.match(serverSource, /correlationId/);
  assert.match(serverSource, /toolName/);
  assert.match(serverSource, /outcome/);
  assert.match(serverSource, /Access-Control-Expose-Headers['"], ['"]x-correlation-id/i);
});

test('legacy SSE ingress emits metadata lifecycle traces without raw session ids', () => {
  assert.match(serverSource, /recordMcpTransportTraceEvent/);
  assert.match(serverSource, /sse-connect/);
  assert.match(serverSource, /sse-disconnect/);
  assert.match(serverSource, /sse-error/);
  assert.match(serverSource, /sse-post-miss/);
  assert.doesNotMatch(serverSource, /recordMcpTransportTraceEvent\([\s\S]{0,500}sessionId\s*:/);
  assert.doesNotMatch(serverSource, /(?:transport|res)\.onmessage\s*=\s*[\s\S]{0,500}recordMcpTransportTraceEvent/);
});
