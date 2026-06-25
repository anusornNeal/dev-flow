import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTransport,
  TRANSPORT_NAMES,
  type TransportKind,
} from '../../src/server/transports/transportRegistry.js';

test('TRANSPORT_NAMES contains all four registered transports', () => {
  assert.deepEqual([...TRANSPORT_NAMES].sort(), ['mcp', 'proxy', 'rest', 'sse'].sort());
});

test('resolveTransport returns rest for /api and /api/* paths', () => {
  assert.equal(resolveTransport('/api/tasks'), 'rest');
  assert.equal(resolveTransport('/api/tasks/DVF-0001'), 'rest');
  assert.equal(resolveTransport('/api/capabilities'), 'rest');
});

test('resolveTransport returns sse for /sse path', () => {
  assert.equal(resolveTransport('/sse'), 'sse');
});

test('resolveTransport returns mcp for /mcp path', () => {
  assert.equal(resolveTransport('/mcp'), 'mcp');
});

test('resolveTransport returns proxy for /proxy/* paths', () => {
  assert.equal(resolveTransport('/proxy/github/sse'), 'proxy');
  assert.equal(resolveTransport('/proxy/jira/sse'), 'proxy');
});

test('resolveTransport returns null for unknown paths', () => {
  assert.equal(resolveTransport('/'), null);
  assert.equal(resolveTransport('/static/foo.png'), null);
});
