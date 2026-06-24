import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-local-write-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { readLocalFile, writeLocalFile } = await import('../../src/server/services/localFileService.js');

const state: any = {
  projectsCache: [
    { id: 'project-write-1', name: 'Write Fixture', repoUrl: 'https://example.com/write', localPath: tempDir },
  ],
};

test('writeLocalFile writes content inside the resolved project root', () => {
  const result = writeLocalFile(state, {
    projectId: 'project-write-1',
    filePath: 'notes/result.txt',
    content: 'written by tool\n',
  });

  assert.equal(result.path, path.join('notes', 'result.txt'));
  assert.equal(result.bytes, Buffer.byteLength('written by tool\n', 'utf8'));
  assert.equal(fs.readFileSync(path.join(tempDir, 'notes', 'result.txt'), 'utf8'), 'written by tool\n');
});


test('writeLocalFile can guard writes with a read revision token', () => {
  fs.writeFileSync(path.join(tempDir, 'guarded.txt'), 'before', 'utf8');
  const readResult = readLocalFile(state, {
    projectId: 'project-write-1',
    filePath: 'guarded.txt',
    mode: 'metadata',
  });

  const writeResult = writeLocalFile(state, {
    projectId: 'project-write-1',
    filePath: 'guarded.txt',
    content: 'after',
    expectedRevision: readResult.revision,
  });

  assert.notEqual(writeResult.revision, readResult.revision);
  assert.equal(fs.readFileSync(path.join(tempDir, 'guarded.txt'), 'utf8'), 'after');
});

test('writeLocalFile rejects stale revision tokens before writing', () => {
  fs.writeFileSync(path.join(tempDir, 'stale.txt'), 'first', 'utf8');
  const readResult = readLocalFile(state, {
    projectId: 'project-write-1',
    filePath: 'stale.txt',
    mode: 'metadata',
  });
  fs.writeFileSync(path.join(tempDir, 'stale.txt'), 'changed elsewhere', 'utf8');

  assert.throws(
    () => writeLocalFile(state, {
      projectId: 'project-write-1',
      filePath: 'stale.txt',
      content: 'should not write',
      expectedRevision: readResult.revision,
    }),
    /changed since it was read/,
  );
  assert.equal(fs.readFileSync(path.join(tempDir, 'stale.txt'), 'utf8'), 'changed elsewhere');
});

test('writeLocalFile blocks paths outside the project root', () => {
  assert.throws(
    () => writeLocalFile(state, {
      projectId: 'project-write-1',
      filePath: '..\\escape.txt',
      content: 'nope',
    }),
    /outside the allowed project root/,
  );
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
