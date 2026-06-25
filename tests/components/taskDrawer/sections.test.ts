import test from 'node:test';
import assert from 'node:assert/strict';
import { drawerSections, type DrawerSectionKey } from '../../../src/components/taskDrawer/sections.js';

test('drawerSections registers all six required section keys in order', () => {
  const expected: DrawerSectionKey[] = ['header', 'agent', 'checklist', 'image', 'comment', 'runHistory'];
  assert.deepEqual(drawerSections.map((s) => s.key), expected);
});

test('each section has a stable id matching its key', () => {
  for (const section of drawerSections) {
    assert.equal(section.id, section.key);
  }
});
