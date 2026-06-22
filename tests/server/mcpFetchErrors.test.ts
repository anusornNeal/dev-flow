import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevFlowMcpServer } from '../../src/server/mcp.js';

test('mcp server handles ECONNREFUSED fetch errors without crashing', async (t) => {
  const originalFetch = global.fetch;

  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:3000');
    (error as any).code = 'ECONNREFUSED';
    throw error;
  };

  const server = createDevFlowMcpServer('http://127.0.0.1:3000');
  const handler = (server as any)._requestHandlers.get('tools/call');
  assert.ok(handler, 'CallToolRequestSchema handler should be registered');

  const request = {
    method: 'tools/call',
    params: {
      name: 'get_skill_router',
      arguments: {}
    }
  };

  // The handler should resolve with an error payload rather than rejecting (crashing)
  const response = await handler(request);

  assert.equal(response.isError, true, 'Response should be marked as an error');
  assert.ok(response.content, 'Response should have content');
  assert.equal(response.content[0].type, 'text');

  const errorPayload = JSON.parse(response.content[0].text);
  assert.equal(errorPayload.code, 'FETCH_FAILED', 'Should map to FETCH_FAILED code');
  assert.ok(errorPayload.message.includes('ECONNREFUSED'), 'Message should include ECONNREFUSED');
  assert.equal(errorPayload.details.toolName, 'get_skill_router', 'Should include toolName in details');
  assert.equal(errorPayload.details.attemptedUrl, 'http://127.0.0.1:3000/api/skills/authoring/00-skill-router');
  assert.equal(errorPayload.details.apiBaseUrl, 'http://127.0.0.1:3000');
  assert.equal(errorPayload.retryable, true, 'Should be retryable');
});

test('mcp server handles HTTP 503 with invalid JSON without crashing', async (t) => {
  const originalFetch = global.fetch;

  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => {
    return {
      ok: false,
      status: 503,
      headers: {
        get: () => 'text/html'
      },
      text: async () => '<html><body>Service Unavailable</body></html>'
    } as unknown as Response;
  };

  const server = createDevFlowMcpServer('http://127.0.0.1:3000');
  const handler = (server as any)._requestHandlers.get('tools/call');

  const request = {
    method: 'tools/call',
    params: {
      name: 'get_skill_router',
      arguments: {}
    }
  };

  const response = await handler(request);
  assert.equal(response.isError, true, 'Response should be marked as an error');

  const errorPayload = JSON.parse(response.content[0].text);
  assert.equal(errorPayload.code, 'HTTP_ERROR');
  assert.equal(errorPayload.retryable, true);
  assert.equal(errorPayload.message, '<html><body>Service Unavailable</body></html>', 'Should capture text fallback message');
  assert.equal(errorPayload.details.toolName, 'get_skill_router');
  assert.equal(errorPayload.details.attemptedUrl, 'http://127.0.0.1:3000/api/skills/authoring/00-skill-router');
  assert.equal(errorPayload.details.apiBaseUrl, 'http://127.0.0.1:3000');
});

test('mcp server handles successful invalid JSON as a structured error', async (t) => {
  const originalFetch = global.fetch;

  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => {
    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json'
      },
      text: async () => '{ invalid json'
    } as unknown as Response;
  };

  const server = createDevFlowMcpServer('http://127.0.0.1:3000');
  const handler = (server as any)._requestHandlers.get('tools/call');

  const response = await handler({
    method: 'tools/call',
    params: {
      name: 'get_skill_router',
      arguments: {}
    }
  });

  assert.equal(response.isError, true, 'Invalid JSON should be returned as a tool error');

  const errorPayload = JSON.parse(response.content[0].text);
  assert.equal(errorPayload.code, 'INVALID_JSON_RESPONSE');
  assert.equal(errorPayload.details.toolName, 'get_skill_router');
  assert.equal(errorPayload.details.attemptedUrl, 'http://127.0.0.1:3000/api/skills/authoring/00-skill-router');
  assert.equal(errorPayload.details.apiBaseUrl, 'http://127.0.0.1:3000');
  assert.equal(errorPayload.retryable, true);
});

test('mcp server handles successful non-JSON responses as structured errors', async (t) => {
  const originalFetch = global.fetch;

  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => {
    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'text/plain'
      },
      text: async () => 'not json'
    } as unknown as Response;
  };

  const server = createDevFlowMcpServer('http://127.0.0.1:3000');
  const handler = (server as any)._requestHandlers.get('tools/call');

  const response = await handler({
    method: 'tools/call',
    params: {
      name: 'get_skill_router',
      arguments: {}
    }
  });

  assert.equal(response.isError, true, 'Non-JSON success responses should be returned as tool errors');

  const errorPayload = JSON.parse(response.content[0].text);
  assert.equal(errorPayload.code, 'NON_JSON_RESPONSE');
  assert.equal(errorPayload.details.toolName, 'get_skill_router');
  assert.equal(errorPayload.details.apiBaseUrl, 'http://127.0.0.1:3000');
  assert.equal(errorPayload.retryable, true);
});

test('mcp server preserves successful JSON response shape', async (t) => {
  const originalFetch = global.fetch;

  t.after(() => {
    global.fetch = originalFetch;
  });

  const body = {
    id: '00-skill-router',
    content: 'router content'
  };

  global.fetch = async () => {
    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json'
      },
      text: async () => JSON.stringify(body)
    } as unknown as Response;
  };

  const server = createDevFlowMcpServer('http://127.0.0.1:3000');
  const handler = (server as any)._requestHandlers.get('tools/call');

  const response = await handler({
    method: 'tools/call',
    params: {
      name: 'get_skill_router',
      arguments: {}
    }
  });

  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, body);
  assert.equal(JSON.parse(response.content[0].text).id, '00-skill-router');
});
