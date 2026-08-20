import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMove, normalizeRecoveryDisposition, requiresRecoveryDispositionForDone } from '../../src/server/useCases/taskUseCases.js';
import { buildTaskStatusMoveRequest } from '../../src/lib/taskStatusMove.js';
import { getToolDefinitionByName } from '../../src/server/contracts/devflowContract.js';

const soft = [{ code: 'HEAD_NOT_PUSHED', message: 'HEAD is local only.', bypassable: true }];
const hard = [{ code: 'ACTIVE_AGENT_LOCK', message: 'Agent is still running.', bypassable: false }];

test('manual move returns confirmation-required for soft workflow blockers', () => {
  const decision = evaluateMove({ intent: 'manual', softBlockers: soft, hardBlockers: [] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.outcome, 'confirmation-required');
  assert.deepEqual(decision.blockers.map((item: any) => item.code), ['HEAD_NOT_PUSHED']);
});

test('explicit manual override bypasses only soft workflow blockers', () => {
  const decision = evaluateMove({ intent: 'manual', manualOverride: true, softBlockers: soft, hardBlockers: [] });
  assert.equal(decision.allowed, true);
  assert.equal(decision.outcome, 'allowed');
  assert.deepEqual(decision.bypassedBlockers.map((item: any) => item.code), ['HEAD_NOT_PUSHED']);
});

test('hard safety blockers remain non-bypassable', () => {
  const decision = evaluateMove({ intent: 'manual', manualOverride: true, softBlockers: soft, hardBlockers: hard });
  assert.equal(decision.allowed, false);
  assert.equal(decision.outcome, 'hard-blocked');
  assert.deepEqual(decision.blockers.map((item: any) => item.code), ['ACTIVE_AGENT_LOCK']);
});

test('strict/default callers do not inherit manual override semantics', () => {
  const decision = evaluateMove({ softBlockers: soft, hardBlockers: [] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.outcome, 'blocked');
});

test('unfinished DONE override requires a bounded recovery disposition', () => {
  assert.equal(requiresRecoveryDispositionForDone('done', [{ code: 'CHECKLIST_INCOMPLETE', message: 'unfinished', bypassable: true }]), true);
  assert.equal(requiresRecoveryDispositionForDone('ready-for-review', [{ code: 'CHECKLIST_INCOMPLETE', message: 'unfinished', bypassable: true }]), false);
  assert.equal(requiresRecoveryDispositionForDone('done', [{ code: 'HEAD_NOT_PUSHED', message: 'local only', bypassable: true }]), false);
  assert.deepEqual(normalizeRecoveryDisposition({ classification: 'follow-up', summary: '  finish remaining scope  ', followUpTaskId: ' DVF-0999 ', workspaceId: ' ws_abc123 ' }), {
    classification: 'follow-up', summary: 'finish remaining scope', followUpTaskId: 'DVF-0999', workspaceId: 'ws_abc123',
  });
  assert.throws(() => normalizeRecoveryDisposition({ classification: 'unknown', summary: 'x' }), /classification/i);
  assert.throws(() => normalizeRecoveryDisposition({ classification: 'follow-up', summary: '   ' }), /summary/i);
});

test('Board move request declares manual intent and override without emergency', () => {
  const normal = JSON.parse(String(buildTaskStatusMoveRequest('task-1', 'ready-for-review', { intent: 'manual' }).init.body));
  assert.deepEqual(normal, { status: 'ready-for-review', intent: 'manual' });
  const override = JSON.parse(String(buildTaskStatusMoveRequest('task-1', 'ready-for-review', { intent: 'manual', manualOverride: true }).init.body));
  assert.deepEqual(override, { status: 'ready-for-review', intent: 'manual', manualOverride: true });
});

test('MCP move tools stay strict by default and expose explicit manualOverride', () => {
  for (const name of ['move_task_status', 'move_task_to_status']) {
    const tool = getToolDefinitionByName(name)!;
    assert.ok(tool.inputSchema.properties.manualOverride);
    assert.match(tool.inputSchema.properties.manualOverride.description, /explicit/i);
    assert.match(tool.inputSchema.properties.manualOverride.description, /break_glass_lifecycle/);
    const strictRequest = tool.buildHttpRequest({ taskId: 'DVF-0001', status: 'done' });
    assert.equal((strictRequest.body as any).manualOverride, undefined);
    assert.equal((strictRequest.body as any).intent, undefined);
    const overrideRequest = tool.buildHttpRequest({ taskId: 'DVF-0001', status: 'done', manualOverride: true });
    assert.equal((overrideRequest.body as any).manualOverride, true);
    assert.equal((overrideRequest.body as any).intent, 'manual');
  }
});
