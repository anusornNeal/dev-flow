import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-local-search-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
createProject({ id: 'project-search-1', name: 'Search Fixture', repoUrl: 'https://example.com/search', localPath: tempDir });
const { clearLocalFileSearchCache, clearLocalSearchRuntimeState, getLocalSearchRuntimeStatus, searchLocalFiles, searchLocalFilesAsync, writeLocalFile } = await import('../../src/server/services/localFileService.js');

const state: any = {
  projectsCache: [
    { id: 'project-search-1', name: 'Search Fixture', repoUrl: 'https://example.com/search', localPath: tempDir },
  ],
};

fs.writeFileSync(path.join(tempDir, 'a.txt'), ['needle one', 'needle two', 'needle three'].join('\n'), 'utf8');
fs.writeFileSync(path.join(tempDir, 'b.txt'), ['needle four', 'needle five', 'other'].join('\n'), 'utf8');

test.beforeEach(() => {
  clearLocalFileSearchCache();
  clearLocalSearchRuntimeState();
});

test('getLocalSearchRuntimeStatus resolves a DevFlow-bundled ripgrep before PATH', () => {
  const appRoot = path.join(tempDir, 'app-root');
  const target = `${process.platform}-${process.arch}`;
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const bundledPath = path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', target, binary);
  fs.mkdirSync(path.dirname(bundledPath), { recursive: true });
  fs.writeFileSync(bundledPath, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n', 'utf8');
  if (process.platform !== 'win32') fs.chmodSync(bundledPath, 0o755);

  const previousAppRoot = process.env.DEVFLOW_APP_ROOT;
  const previousPath = process.env.PATH;
  process.env.DEVFLOW_APP_ROOT = appRoot;
  process.env.PATH = '';
  try {
    const status = getLocalSearchRuntimeStatus();
    assert.equal(status.backend, 'ripgrep');
    assert.equal(path.resolve(status.ripgrepPath!), path.resolve(bundledPath));
    assert.equal(status.ripgrepSource, 'devflow-bundled');
  } finally {
    if (previousAppRoot === undefined) delete process.env.DEVFLOW_APP_ROOT;
    else process.env.DEVFLOW_APP_ROOT = previousAppRoot;
    process.env.PATH = previousPath;
  }
});

test('searchLocalFiles falls back when no ripgrep source is available', () => {
  const previousPath = process.env.PATH;
  const previousAppRoot = process.env.DEVFLOW_APP_ROOT;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousProgramFiles = process.env.ProgramFiles;
  process.env.PATH = '';
  process.env.DEVFLOW_APP_ROOT = path.join(tempDir, 'missing-app-root');
  process.env.LOCALAPPDATA = path.join(tempDir, 'missing-local-app-data');
  process.env.ProgramFiles = path.join(tempDir, 'missing-program-files');
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
    if (previousAppRoot === undefined) delete process.env.DEVFLOW_APP_ROOT;
    else process.env.DEVFLOW_APP_ROOT = previousAppRoot;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = previousProgramFiles;
  }
});

test('searchLocalFilesAsync falls back when no ripgrep source is available', async () => {
  const previousPath = process.env.PATH;
  const previousAppRoot = process.env.DEVFLOW_APP_ROOT;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousProgramFiles = process.env.ProgramFiles;
  process.env.PATH = '';
  process.env.DEVFLOW_APP_ROOT = path.join(tempDir, 'missing-app-root');
  process.env.LOCALAPPDATA = path.join(tempDir, 'missing-local-app-data');
  process.env.ProgramFiles = path.join(tempDir, 'missing-program-files');
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
    if (previousAppRoot === undefined) delete process.env.DEVFLOW_APP_ROOT;
    else process.env.DEVFLOW_APP_ROOT = previousAppRoot;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = previousProgramFiles;
  }
});
test('searchLocalFiles rejects invalid regex before changing search backend semantics', () => {
  assert.throws(
    () => searchLocalFiles(state, { projectId: 'project-search-1', query: '(', limit: 2 }),
    (error: any) => error?.status === 400 && error?.payload?.code === 'SEARCH_QUERY_INVALID',
  );
});

test('searchLocalFiles falls back on ripgrep runtime failure and opens a short circuit', () => {
  const previousRgPath = process.env.DEVFLOW_RG_PATH;
  process.env.DEVFLOW_RG_PATH = process.execPath;
  try {
    const first = searchLocalFiles(state, { projectId: 'project-search-1', query: 'needle', limit: 2 });
    assert.equal(first.backend, 'fallback');
    assert.equal(first.fallbackReason, 'ripgrep-runtime-failure');
    const afterFailure = getLocalSearchRuntimeStatus();
    assert.equal(afterFailure.circuitOpen, true);
    assert.equal(afterFailure.infrastructureFailureCount, 1);

    const second = searchLocalFiles(state, { projectId: 'project-search-1', query: 'other', limit: 2 });
    assert.equal(second.backend, 'fallback');
    assert.equal(second.fallbackReason, 'circuit-open');
    const afterCircuit = getLocalSearchRuntimeStatus();
    assert.equal(afterCircuit.infrastructureFailureCount, 1);
    assert.equal(afterCircuit.circuitBypassCount >= 1, true);
  } finally {
    if (previousRgPath === undefined) delete process.env.DEVFLOW_RG_PATH;
    else process.env.DEVFLOW_RG_PATH = previousRgPath;
    clearLocalSearchRuntimeState();
  }
});

test('searchLocalFilesAsync falls back in the same call on ripgrep runtime failure', async () => {
  const previousRgPath = process.env.DEVFLOW_RG_PATH;
  process.env.DEVFLOW_RG_PATH = process.execPath;
  try {
    const result = await searchLocalFilesAsync(
      state,
      { projectId: 'project-search-1', query: 'needle', limit: 2 },
      { stdout: () => {}, stderr: () => {} },
      () => {},
    );
    assert.equal(result.backend, 'fallback');
    assert.equal(result.fallbackReason, 'ripgrep-runtime-failure');
  } finally {
    if (previousRgPath === undefined) delete process.env.DEVFLOW_RG_PATH;
    else process.env.DEVFLOW_RG_PATH = previousRgPath;
    clearLocalSearchRuntimeState();
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

test('recovery-forced fallback bypasses an existing search cache in sync and async modes', async () => {
  const cached = searchLocalFiles(state, {
    projectId: 'project-search-1',
    query: 'needle',
    limit: 2,
  });
  assert.equal(cached.count, 2);

  const forced = searchLocalFiles(state, {
    projectId: 'project-search-1',
    query: 'needle',
    limit: 2,
    forceFallbackSearch: true,
  });
  assert.equal(forced.backend, 'fallback');
  assert.equal(forced.fallbackReason, 'recovery-forced');
  assert.equal(forced.cache.hit, false);

  const asyncForced = await searchLocalFilesAsync(
    state,
    {
      projectId: 'project-search-1',
      query: 'needle',
      limit: 2,
      forceFallbackSearch: true,
    },
    { stdout: () => {}, stderr: () => {} },
    () => {},
  );
  assert.equal(asyncForced.backend, 'fallback');
  assert.equal(asyncForced.fallbackReason, 'recovery-forced');
  assert.equal(asyncForced.cache.hit, false);
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

// SQLite keeps a process-level connection open on Windows; OS temp cleanup owns tempDir.
