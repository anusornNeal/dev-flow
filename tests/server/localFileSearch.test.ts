import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-local-search-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { clearLocalFileSearchCache, searchLocalFiles, searchLocalFilesAsync, writeLocalFile } = await import('../../src/server/services/localFileService.js');

const state: any = {
  projectsCache: [
    { id: 'project-search-1', name: 'Search Fixture', repoUrl: 'https://example.com/search', localPath: tempDir },
  ],
};

fs.writeFileSync(path.join(tempDir, 'a.txt'), ['needle one', 'needle two', 'needle three'].join('\n'), 'utf8');
fs.writeFileSync(path.join(tempDir, 'b.txt'), ['needle four', 'needle five', 'other'].join('\n'), 'utf8');

test.beforeEach(() => {
  clearLocalFileSearchCache();
});

test('searchLocalFiles falls back when ripgrep is unavailable on PATH', () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const result = searchLocalFiles(state, {
      projectId: 'project-search-1',
      query: 'needle',
      limit: 3,
    });

    assert.equal(result.count, 3);
    assert.equal(result.matches.length, 3);
    assert.equal(result.backend, 'fallback');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('searchLocalFilesAsync falls back when ripgrep is unavailable on PATH', async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const result = await searchLocalFilesAsync(
      state,
      {
        projectId: 'project-search-1',
        query: 'needle',
        limit: 2,
      },
      {
        stdout: () => {},
        stderr: () => {},
      },
      () => {},
    );

    assert.equal(result.count, 2);
    assert.equal(result.matches.length, 2);
    assert.equal(result.backend, 'fallback');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('searchLocalFiles returns cache metadata on repeated identical searches', () => {
  const first = searchLocalFiles(state, {
    projectId: 'project-search-1',
    query: 'needle',
    limit: 3,
  });
  const second = searchLocalFiles(state, {
    projectId: 'project-search-1',
    query: 'needle',
    limit: 3,
  });

  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.equal(second.count, first.count);
  assert.deepEqual(second.matches, first.matches);
});

test('searchLocalFiles respects the returned global limit and reports truncation', () => {
  const result = searchLocalFiles(state, {
    projectId: 'project-search-1',
    query: 'needle',
    limit: 2,
  });

  assert.equal(result.count, 2);
  assert.equal(result.matches.length, 2);
  assert.equal(result.truncated, true);
  assert.ok(result.scannedMatchCount >= 2);
});

test('searchLocalFilesAsync can terminate after the requested global result limit', async () => {
  const stdout: string[] = [];
  const result = await searchLocalFilesAsync(
    state,
    {
      projectId: 'project-search-1',
      query: 'needle',
      limit: 1,
    },
    {
      stdout: (data: string) => stdout.push(data),
      stderr: () => {},
    },
    () => {},
  );

  assert.equal(result.count, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.terminatedAfterLimit, true);
  assert.equal(result.truncated, true);
});

test('writeLocalFile invalidates cached search results for the same project root', () => {
  const first = searchLocalFiles(state, {
    projectId: 'project-search-1',
    query: 'fresh-cache-token',
    limit: 5,
  });
  const second = searchLocalFiles(state, {
    projectId: 'project-search-1',
    query: 'fresh-cache-token',
    limit: 5,
  });
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);

  writeLocalFile(state, {
    projectId: 'project-search-1',
    filePath: 'fresh.txt',
    content: 'fresh-cache-token',
  });

  const afterWrite = searchLocalFiles(state, {
    projectId: 'project-search-1',
    query: 'fresh-cache-token',
    limit: 5,
  });
  assert.equal(afterWrite.cache.hit, false);
  assert.equal(afterWrite.count, 1);
});

test('writeLocalFile preserves revision for identical existing content', () => {
  const first = writeLocalFile(state, {
    projectId: 'project-search-1',
    filePath: 'no-op.txt',
    content: 'same-content',
  });
  const second = writeLocalFile(state, {
    projectId: 'project-search-1',
    filePath: 'no-op.txt',
    content: 'same-content',
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.changed, false);
  assert.equal(second.revision, first.revision);
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
