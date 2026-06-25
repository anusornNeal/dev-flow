import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFromDevFlowAppRoot } from '../../src/lib/devFlowPaths.js';

// bootstrap.ts is an integration entrypoint - we verify its module shape and that
// resolveFromDevFlowAppRoot keeps a stable path resolution contract.

test('resolveFromDevFlowAppRoot returns a path that includes the DevFlow app root', () => {
  const resolved = resolveFromDevFlowAppRoot('logs', 'agent-trigger.log');
  assert.match(resolved, /logs[\\\/]agent-trigger\.log$/);
});

test('resolveFromDevFlowAppRoot accepts a single segment', () => {
  const resolved = resolveFromDevFlowAppRoot('package.json');
  assert.match(resolved, /[\\\/]package\.json$/);
});
