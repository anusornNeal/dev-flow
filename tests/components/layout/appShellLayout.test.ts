import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  clampSidebarWidth,
  composeLayoutSlots,
  resolveInitialSidebarLayout,
  resolveSidebarResize,
  serializeSidebarLayoutPreference,
  type AppLayoutSlots,
} from '../../../src/components/layout/appShellLayout.js';

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
test('sidebar width is clamped to safe desktop bounds', () => {
  assert.equal(SIDEBAR_RAIL_WIDTH, 64);
  assert.equal(clampSidebarWidth(100), SIDEBAR_MIN_WIDTH);
  assert.equal(clampSidebarWidth(320), 320);
  assert.equal(clampSidebarWidth(999), SIDEBAR_MAX_WIDTH);
  assert.equal(resolveSidebarResize(300, 80), 380);
  assert.equal(resolveSidebarResize(300, -500), SIDEBAR_MIN_WIDTH);
});

test('sidebar preference persists collapsed state and last expanded width', () => {
  const encoded = serializeSidebarLayoutPreference({ collapsed: true, width: 356 });
  const storage = { getItem: () => encoded };
  assert.deepEqual(resolveInitialSidebarLayout(storage, 1440), { collapsed: true, width: 356 });
});

test('sidebar defaults to rail on narrow desktops only when no preference exists', () => {
  const emptyStorage = { getItem: () => null };
  assert.deepEqual(resolveInitialSidebarLayout(emptyStorage, 980), { collapsed: true, width: SIDEBAR_DEFAULT_WIDTH });
  assert.deepEqual(resolveInitialSidebarLayout(emptyStorage, 1440), { collapsed: false, width: SIDEBAR_DEFAULT_WIDTH });
});

test('invalid persisted sidebar preference falls back safely', () => {
  const corruptStorage = { getItem: () => '{bad-json' };
  assert.deepEqual(resolveInitialSidebarLayout(corruptStorage, 1440), { collapsed: false, width: SIDEBAR_DEFAULT_WIDTH });
});
