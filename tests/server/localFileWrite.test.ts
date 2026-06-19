import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-local-write-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { writeLocalFile } = await import('../../src/server/services/localFileService.js');

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
