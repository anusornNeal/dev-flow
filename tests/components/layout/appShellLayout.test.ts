import test from 'node:test';
import assert from 'node:assert/strict';
import { composeLayoutSlots, type AppLayoutSlots } from '../../../src/components/layout/appShellLayout.js';

test('composeLayoutSlots returns slots in canonical order: header, sidebar, board, drawer', () => {
  const slots: AppLayoutSlots = {
    header: 'H',
    sidebar: 'S',
    board: 'B',
    drawer: 'D',
  };
  const composed = composeLayoutSlots(slots);
  assert.deepEqual(composed, ['H', 'S', 'B', 'D']);
});

test('composeLayoutSlots throws when any required slot is missing', () => {
  assert.throws(
    () => composeLayoutSlots({ header: 'H', sidebar: 'S', board: 'B' } as any),
    /drawer/,
  );
});
