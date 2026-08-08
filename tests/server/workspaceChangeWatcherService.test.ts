import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-change-watcher-'));
const { clearRepoChangeJournal, getRepoChangesSince } = await import('../../src/server/services/repoChangeJournalService.js');
const { ensureRepoChangeWatcher, stopAllRepoChangeWatchers } = await import('../../src/server/services/workspaceChangeWatcherService.js');

async function waitFor(predicate: () => boolean, timeoutMs = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('condition was not observed before timeout');
}

test('workspace watcher records external source-file changes when supported', async () => {
  clearRepoChangeJournal(tempDir);
  const status = ensureRepoChangeWatcher(tempDir);
  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'src', 'watch.ts'), 'export const value = 1;\n', 'utf8');

  if (status.active) {
    await waitFor(() => getRepoChangesSince(tempDir, 0).paths.some((entry: string) => entry === 'src/watch.ts'));
  } else {
    assert.equal(status.degraded, true);
  }
});

test.after(() => {
  stopAllRepoChangeWatchers();
  clearRepoChangeJournal(tempDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
