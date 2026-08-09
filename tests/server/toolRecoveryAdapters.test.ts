import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-recovery-adapters-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.sqlite');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const {
  combineFileSnippetBatchRecoveryResults,
  splitFileSnippetBatchArgsForRecovery,
} = await import('../../src/server/services/localFileService.js');
const { createDevFlowRecoveryAdapters } = await import('../../src/server/services/devFlowRecoveryAdapters.js');

const state: any = { projectsCache: [] };

test('batch recovery primitive splits by bounded byte estimate and combines semantic results', () => {
  const payload = {
    files: [
      { filePath: 'a.ts', maxBytes: 40_000 },
      { filePath: 'b.ts', maxBytes: 40_000 },
      { filePath: 'c.ts', maxBytes: 40_000 },
      { filePath: 'd.ts', maxBytes: 40_000 },
    ],
    maxTotalBytes: 80_000,
  };
  const chunks = splitFileSnippetBatchArgsForRecovery(payload);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk: any) => chunk.files.map((entry: any) => entry.filePath)), [['a.ts', 'b.ts'], ['c.ts', 'd.ts']]);
  assert.ok(chunks.every((chunk: any) => chunk !== payload));

  const combined = combineFileSnippetBatchRecoveryResults([
    { root: '/repo', requestedCount: 2, successCount: 2, errorCount: 0, totalReturnedBytes: 100, maxTotalBytes: 80_000, truncated: false, files: [{ ok: true }, { ok: true }] },
    { root: '/repo', requestedCount: 2, successCount: 1, errorCount: 1, totalReturnedBytes: 50, maxTotalBytes: 80_000, truncated: true, files: [{ ok: true }, { ok: false }] },
  ]);
  assert.equal(combined.count, 4);
  assert.equal(combined.successCount, 3);
  assert.equal(combined.errorCount, 1);
  assert.equal(combined.partial, true);
  assert.equal(combined.totalReturnedBytes, 150);
  assert.equal(combined.maxTotalBytes, 80_000);
  assert.equal(combined.truncated, true);
});

test('adapter factory exposes only strategy hooks relevant to each semantic tool', async () => {
  const batch = createDevFlowRecoveryAdapters(state, 'read_file_snippets_batch');
  assert.equal(typeof batch.splitBatch, 'function');
  assert.equal(batch.refreshContext, undefined);

  const context = createDevFlowRecoveryAdapters(state, 'get_repo_context_delta');
  assert.equal(typeof context.refreshContext, 'function');

  const job = createDevFlowRecoveryAdapters(state, 'get_tool_job_result');
  assert.equal(typeof job.waitResult, 'function');

  const search = createDevFlowRecoveryAdapters(state, 'search_local_files');
  assert.equal(typeof search.fallbackSearch, 'function');
  const fallbackPayload = await search.fallbackSearch!({ query: 'needle' }, new Error('rg unavailable'));
  assert.deepEqual(fallbackPayload, { query: 'needle', forceFallbackSearch: true });

  const edit = createDevFlowRecoveryAdapters(state, 'apply_prepared_edit');
  assert.equal(typeof edit.refreshPreview, 'function');
  assert.equal((edit as any).apply, undefined);
});

test.after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
