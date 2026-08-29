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

test('DONE quality debt does not require recovery disposition while dependency debt still does', () => {
  assert.equal(requiresRecoveryDispositionForDone('done', [{ code: 'CHECKLIST_INCOMPLETE', message: 'unfinished', bypassable: true }]), false);
  assert.equal(requiresRecoveryDispositionForDone('done', [{ code: 'VERIFICATION_EVIDENCE_MISSING', message: 'missing', bypassable: true }]), false);
  assert.equal(requiresRecoveryDispositionForDone('done', [{ code: 'HEAD_NOT_PUSHED', message: 'local only', bypassable: true }]), false);
  assert.equal(requiresRecoveryDispositionForDone('done', [{ code: 'CHILD_TASK_BLOCKING', message: 'child active', bypassable: true }]), true);
  assert.equal(requiresRecoveryDispositionForDone('ready-for-review', [{ code: 'CHILD_TASK_BLOCKING', message: 'child active', bypassable: true }]), false);
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

test('MCP move tools describe readiness debt separately from lifecycle status authority', () => {
  for (const name of ['move_task_status', 'move_task_to_status']) {
    const tool = getToolDefinitionByName(name)!;
    assert.ok(tool.inputSchema.properties.manualOverride);
    assert.match(tool.description, /quality|readiness/i);
    assert.doesNotMatch(tool.description, /Strict by default/i);
    const normalRequest = tool.buildHttpRequest({ taskId: 'DVF-0001', status: 'done' });
    assert.equal((normalRequest.body as any).manualOverride, undefined);
    assert.equal((normalRequest.body as any).intent, undefined);
    const overrideRequest = tool.buildHttpRequest({ taskId: 'DVF-0001', status: 'done', manualOverride: true });
    assert.equal((overrideRequest.body as any).manualOverride, true);
    assert.equal((overrideRequest.body as any).intent, 'manual');
  }
});

test('board status tools keep ready-for-review as workflow policy rather than managed lifecycle authority', () => {
  const submit = getToolDefinitionByName('submit_task_for_review')!;
  assert.match(submit.description, /optional human\/reviewer workflow/i);
  assert.match(submit.description, /not a prerequisite.*finalization.*DONE/i);

  for (const name of ['move_task_status', 'move_task_to_status']) {
    const tool = getToolDefinitionByName(name)!;
    assert.match(tool.description, /board\/manual|workflow policy/i);
    assert.match(tool.description, /not .*managed.*lifecycle|not a prerequisite chain.*managed finalization/i);
  }
});
