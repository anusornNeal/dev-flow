import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWithPendingMoves } from '../../src/viewModels/boardOptimisticMerge.js';
import type { DomainTask } from '../../src/domain/mappers/taskMapper.js';

function t(id: string, status: string, extra: Partial<DomainTask> = {}): DomainTask {
  return { id, displayId: id, title: id, status, images: [], ...extra } as any;
}

test('mergeWithPendingMoves keeps optimistic version of in-flight task', () => {
  const serverTasks = [t('a', 'todo'), t('b', 'in-progress')];
  const prev = [t('a', 'todo'), t('b', 'in-progress', { activeAgent: 'codex' })];
  const next = mergeWithPendingMoves(serverTasks, prev, new Set(['b']));
  assert.equal(next[1].activeAgent, 'codex');
  assert.equal(next[1].status, 'in-progress');
});

test('mergeWithPendingMoves uses server version when task is not in-flight', () => {
  const serverTasks = [t('a', 'done')];
  const prev = [t('a', 'todo')];
  const next = mergeWithPendingMoves(serverTasks, prev, new Set());
  assert.equal(next[0].status, 'done');
});

test('mergeWithPendingMoves returns previous reference when shallow-equal (no in-flight)', () => {
  const sameRef = [t('a', 'todo')];
  const next = mergeWithPendingMoves(sameRef, sameRef, new Set());
  assert.equal(next, sameRef);
});
