import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-change-journal-'));
const { clearRepoChangeJournal, getRepoChangesSince, recordRepoChanges } = await import('../../src/server/services/repoChangeJournalService.js');

test.beforeEach(() => {
  clearRepoChangeJournal(tempDir);
});

test('change journal returns normalized changes since a sequence', () => {
  const first = recordRepoChanges(tempDir, ['src\\a.ts'], 'write');
  const second = recordRepoChanges(tempDir, ['src/b.ts', 'src/a.ts'], 'batch');
  const delta = getRepoChangesSince(tempDir, first.sequence);

  assert.equal(second.sequence, first.sequence + 1);
  assert.equal(delta.uncertain, false);
  assert.deepEqual(delta.paths.sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal(delta.sequence, second.sequence);
});

test('change journal is bounded and marks too-old cursors uncertain', () => {
  for (let index = 0; index < 1100; index += 1) {
    recordRepoChanges(tempDir, [`src/file-${index}.ts`], 'write');
  }
  const delta = getRepoChangesSince(tempDir, 0);
  assert.equal(delta.uncertain, true);
  assert.ok(delta.sequence >= 1100);
});

test.after(() => {
  clearRepoChangeJournal(tempDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
