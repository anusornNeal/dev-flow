import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-local-read-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { readLocalFile } = await import('../../src/server/services/localFileService.js');

const state: any = {
  projectsCache: [
    { id: 'project-read-1', name: 'Read Fixture', repoUrl: 'https://example.com/read', localPath: tempDir },
  ],
};

fs.writeFileSync(path.join(tempDir, 'sample.txt'), ['one', 'two', 'three', 'four'].join('\n'), 'utf8');

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

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
