import test from 'node:test';
import assert from 'node:assert/strict';

import { runUiPreviewObjectGc } from '../../src/server/services/uiPreviewObjectGcService.js';

const H = {
  referenced: 'a'.repeat(64),
  secondReferenced: 'b'.repeat(64),
  old: 'c'.repeat(64),
  young: 'd'.repeat(64),
  boundary: 'e'.repeat(64),
  failing: 'f'.repeat(64),
  unknown: '1'.repeat(64),
};

const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function object(objectHash: string, ageMs: number, rawBytes?: number, storedBytes?: number) {
  return {
    objectHash,
    createdAt: new Date(NOW - ageMs).toISOString(),
    ...(rawBytes === undefined ? {} : { rawBytes }),
    ...(storedBytes === undefined ? {} : { storedBytes }),
  };
}

test('empty inventory produces an empty deterministic dry-run plan', async () => {
  const result = await runUiPreviewObjectGc({
    roots: [],
    inventory: [],
    now: () => NOW,
    gracePeriodMs: HOUR,
  });

  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.plan.referenced, []);
  assert.deepEqual(result.plan.unreachable, []);
  assert.deepEqual(result.plan.protected, []);
  assert.deepEqual(result.plan.deletable, []);
  assert.equal(result.plan.metrics.referenced.count, 0);
  assert.equal(result.plan.metrics.unreachable.count, 0);
  assert.equal(result.deletions.attempted, 0);
});

test('duplicate roots are deduplicated and every supplied root remains referenced', async () => {
  const result = await runUiPreviewObjectGc({
    roots: [H.referenced, H.referenced, H.secondReferenced],
    inventory: [
      object(H.secondReferenced, 10 * HOUR, 20, 10),
      object(H.referenced, 10 * HOUR, 100, 80),
    ],
    now: () => NOW,
    gracePeriodMs: HOUR,
  });

  assert.deepEqual(result.plan.referenced, [H.referenced, H.secondReferenced]);
  assert.deepEqual(result.plan.deletable, []);
  assert.deepEqual(result.plan.metrics.referenced, { count: 2, rawBytes: 120, storedBytes: 90 });
});

test('unreachable inventory is split by grace age and exact cutoff remains protected', async () => {
  const result = await runUiPreviewObjectGc({
    roots: [H.referenced],
    inventory: [
      object(H.young, HOUR / 2, 30, 20),
      object(H.old, HOUR * 2, 50, 40),
      object(H.boundary, HOUR, 70, 60),
      object(H.referenced, HOUR * 3, 100, 90),
    ],
    now: () => NOW,
    gracePeriodMs: HOUR,
  });

  assert.deepEqual(result.plan.referenced, [H.referenced]);
  assert.deepEqual(result.plan.unreachable, [H.old, H.young, H.boundary].sort());
  assert.deepEqual(result.plan.protected, [H.young, H.boundary].sort());
  assert.deepEqual(result.plan.deletable, [H.old]);
  assert.deepEqual(result.plan.metrics.unreachable, { count: 3, rawBytes: 150, storedBytes: 120 });
  assert.deepEqual(result.plan.metrics.protected, { count: 2, rawBytes: 100, storedBytes: 80 });
  assert.deepEqual(result.plan.metrics.deletable, { count: 1, rawBytes: 50, storedBytes: 40 });
});

test('dry-run never calls delete even when deletable objects exist', async () => {
  const deleted: string[] = [];
  const result = await runUiPreviewObjectGc({
    roots: [],
    inventory: [object(H.old, HOUR * 2)],
    deleteObject: async (hash) => { deleted.push(hash); },
    now: () => NOW,
    gracePeriodMs: HOUR,
  });

  assert.deepEqual(result.plan.deletable, [H.old]);
  assert.deepEqual(deleted, []);
  assert.equal(result.deletions.attempted, 0);
});

test('apply deletes only the exact computed deletable set and reports partial failures', async () => {
  const deleted: string[] = [];
  const result = await runUiPreviewObjectGc({
    roots: [H.referenced],
    inventory: [
      object(H.referenced, HOUR * 10),
      object(H.young, HOUR / 2),
      object(H.old, HOUR * 2),
      object(H.failing, HOUR * 3),
    ],
    deleteObject: async (hash) => {
      deleted.push(hash);
      if (hash === H.failing) throw new Error('simulated delete failure');
    },
    now: () => NOW,
    gracePeriodMs: HOUR,
    apply: true,
  });

  assert.deepEqual(result.plan.deletable, [H.old, H.failing].sort());
  assert.deepEqual(deleted, result.plan.deletable);
  assert.equal(deleted.includes(H.referenced), false);
  assert.equal(deleted.includes(H.young), false);
  assert.equal(result.deletions.attempted, 2);
  assert.deepEqual(result.deletions.succeeded, [H.old]);
  assert.equal(result.deletions.failed.length, 1);
  assert.equal(result.deletions.failed[0]?.objectHash, H.failing);
  assert.match(result.deletions.failed[0]?.error || '', /simulated delete failure/);
});

test('unknown or malformed identities fail closed before deletion', async () => {
  const deleted: string[] = [];
  const base = {
    deleteObject: async (hash: string) => { deleted.push(hash); },
    now: () => NOW,
    gracePeriodMs: HOUR,
    apply: true,
  };

  await assert.rejects(() => runUiPreviewObjectGc({
    ...base,
    roots: [H.unknown],
    inventory: [object(H.old, HOUR * 2)],
  }), (error: any) => error?.code === 'UI_PREVIEW_GC_UNKNOWN_ROOT');

  await assert.rejects(() => runUiPreviewObjectGc({
    ...base,
    roots: [],
    inventory: [{ objectHash: 'NOT-A-HASH', createdAt: new Date(NOW - HOUR * 2).toISOString() }],
  }), (error: any) => error?.code === 'UI_PREVIEW_GC_INVALID_HASH');

  await assert.rejects(() => runUiPreviewObjectGc({
    ...base,
    roots: ['A'.repeat(64)],
    inventory: [],
  }), (error: any) => error?.code === 'UI_PREVIEW_GC_INVALID_HASH');

  assert.deepEqual(deleted, []);
});
