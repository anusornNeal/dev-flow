import test from 'node:test';
import assert from 'node:assert/strict';
import { emergencyToolDefinitions } from '../../src/server/contracts/devflowEmergencyTools.js';

test('break-glass contract exposes only genuine emergency recovery actions', () => {
  const tool = emergencyToolDefinitions.find((entry) => entry.name === 'break_glass_lifecycle');
  assert.ok(tool);
  assert.deepEqual((tool.inputSchema as any).properties.action.enum, [
    'finalize-as-integrated',
    'reconcile-integrated-detached',
    'supersede-execution',
    'supersede-task-work',
    'discard-wip',
  ]);
  const description = String(tool.description || '');
  assert.match(description, /audited/i);
  assert.match(description, /normal.*commit/i);
  assert.match(description, /release\/rotation/i);
  assert.match(description, /verification debt/i);
  assert.match(description, /destructive|emergency/i);
});
