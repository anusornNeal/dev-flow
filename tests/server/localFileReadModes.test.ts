import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-local-read-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { readFileSnippetsBatch, readLocalFile } = await import('../../src/server/services/localFileService.js');

const state: any = {
  projectsCache: [
    { id: 'project-read-1', name: 'Read Fixture', repoUrl: 'https://example.com/read', localPath: tempDir },
  ],
};

fs.writeFileSync(path.join(tempDir, 'sample.txt'), ['one', 'two', 'three', 'four'].join('\n'), 'utf8');
fs.writeFileSync(path.join(tempDir, 'other.txt'), ['alpha', 'beta', 'gamma'].join('\n'), 'utf8');
fs.mkdirSync(path.join(tempDir, 'nested', 'folder'), { recursive: true });
fs.writeFileSync(path.join(tempDir, 'nested', 'folder', 'slash.txt'), 'slash path', 'utf8');

test('readLocalFile can return a line window instead of the full file', () => {
  const result = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
    startLine: 2,
    endLine: 3,
  });

  assert.equal(result.content, 'two\nthree');
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 3);
  assert.equal(result.totalLines, 4);
  assert.equal(result.truncated, true);
});

test('readLocalFile can return metadata without content', () => {
  const result = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
    mode: 'metadata',
  });

  assert.equal(result.content, undefined);
  assert.equal(result.bytes, Buffer.byteLength('one\ntwo\nthree\nfour', 'utf8'));
  assert.equal(result.totalLines, 4);
});

test('readLocalFile accepts Windows-style separators and returns slash-normalized paths', () => {
  const result = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'nested\\\\folder\\\\slash.txt',
  });

  assert.equal(result.path, 'nested/folder/slash.txt');
  assert.equal(result.content, 'slash path');
});


test('readLocalFile returns revision metadata with content and metadata modes', () => {
  const contentResult = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
  });

  assert.equal(typeof contentResult.revision, 'string');
  assert.equal(contentResult.revision, contentResult.fileRevision.token);
  assert.equal(contentResult.fileRevision.size, Buffer.byteLength('one\ntwo\nthree\nfour', 'utf8'));
  assert.equal(typeof contentResult.fileRevision.sha256, 'string');

  const metadataResult = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
    mode: 'metadata',
  });

  assert.equal(metadataResult.revision, contentResult.revision);
  assert.equal(metadataResult.fileRevision.sha256, contentResult.fileRevision.sha256);
});

test('readFileSnippetsBatch returns multiple snippets with revision metadata', () => {
  const result = readFileSnippetsBatch(state, {
    projectId: 'project-read-1',
    files: [
      { filePath: 'sample.txt', startLine: 2, endLine: 3 },
      { path: 'other.txt', startLine: 1, endLine: 2 },
    ],
  });

  assert.equal(result.count, 2);
  assert.equal(result.requestedCount, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.files[0].content, 'two\nthree');
  assert.equal(result.files[1].content, 'alpha\nbeta');
  assert.equal(result.files[0].revision, result.files[0].fileRevision.token);
  assert.equal(result.files[1].revision, result.files[1].fileRevision.token);
});

test('readFileSnippetsBatch supports metadata entries', () => {
  const result = readFileSnippetsBatch(state, {
    projectId: 'project-read-1',
    files: [
      { filePath: 'sample.txt', mode: 'metadata' },
    ],
  });

  assert.equal(result.count, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.files[0].content, undefined);
  assert.equal(result.files[0].totalLines, 4);
  assert.equal(typeof result.files[0].fileRevision.sha256, 'string');
});

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
