import test from 'node:test';
import assert from 'node:assert/strict';
import { apiClient, apiGet, apiPost, apiPut, apiDelete, ApiError } from '../../src/client/apiClient.js';

function mockFetchOnce(response: { status: number; body: unknown; contentType?: string; headers?: Record<string, string> }) {
  const fetchMock = async (_input: any, _init: any) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(response.headers || {})) headers.set(k, v);
    headers.set('content-type', response.contentType || 'application/json');
    return new Response(typeof response.body === 'string' ? response.body : JSON.stringify(response.body), {
      status: response.status,
      headers,
    });
  };
  (globalThis as any).fetch = fetchMock;
}

test('apiClient.fetchJson returns parsed JSON with correlationId on 2xx', async () => {
  mockFetchOnce({
    status: 200,
    body: { ok: true },
    headers: { 'x-correlation-id': 'cid-abc' },
  });
  const result = await apiClient.fetchJson<{ ok: boolean }>('GET', '/api/test');
  assert.equal(result.data.ok, true);
  assert.equal(result.correlationId, 'cid-abc');
  assert.ok(result.durationMs >= 0);
});

test('apiClient.fetchJson throws ApiError with normalized shape on non-2xx', async () => {
  mockFetchOnce({
    status: 400,
    body: { error: { code: 'BAD_REQUEST', message: 'invalid', retryable: false, correlationId: 'cid-x' } },
    headers: { 'x-correlation-id': 'cid-x' },
  });
  await assert.rejects(
    apiClient.fetchJson('GET', '/api/test'),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      const e = err as ApiError;
      assert.equal(e.code, 'BAD_REQUEST');
      assert.equal(e.message, 'invalid');
      assert.equal(e.retryable, false);
      assert.equal(e.correlationId, 'cid-x');
      return true;
    },
  );
});

test('apiClient.fetchJson wraps plain error bodies as HTTP_ERROR', async () => {
  mockFetchOnce({ status: 500, body: 'oops' });
  await assert.rejects(
    apiClient.fetchJson('GET', '/api/test'),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      const e = err as ApiError;
      assert.equal(e.code, 'HTTP_ERROR');
      assert.equal(e.retryable, true);
      assert.match(e.correlationId, /^cid-/);
      return true;
    },
  );
});

test('apiClient.fetchJson sends Content-Type and body for POST', async () => {
  let capturedInit: any;
  (globalThis as any).fetch = async (_input: any, init: any) => {
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await apiPost('/api/test', { hello: 'world' });
  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.headers['Content-Type'], 'application/json');
  assert.equal(capturedInit.headers['Accept'], 'application/json');
  assert.match(capturedInit.headers['x-correlation-id'], /^cid-/);
  assert.equal(capturedInit.body, JSON.stringify({ hello: 'world' }));
});

test('helpers route to correct methods without body for GET/DELETE', async () => {
  let capturedInit: any;
  (globalThis as any).fetch = async (_input: any, init: any) => {
    capturedInit = init;
    return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await apiGet('/api/x');
  assert.equal(capturedInit.method, 'GET');
  assert.equal(capturedInit.body, undefined);
  await apiDelete('/api/x');
  assert.equal(capturedInit.method, 'DELETE');
  await apiPut('/api/x', { a: 1 });
  assert.equal(capturedInit.method, 'PUT');
});
