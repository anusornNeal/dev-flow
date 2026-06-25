import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-file-edit-batch-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { editFilesBatch } = await import('../../src/server/services/fileEditBatchService.js');

const state: any = {
  projectsCache: [
    { id: 'project-file-edit-batch-1', name: 'File Edit Batch Fixture', repoUrl: 'https://example.com/file-edit-batch', localPath: tempDir },
  ],
};

function writeFixture(name: string, content: string) {
  fs.writeFileSync(path.join(tempDir, name), content, 'utf8');
}

function readFixture(name: string) {
  return fs.readFileSync(path.join(tempDir, name), 'utf8');
}

test('editFilesBatch previews multiple files without writing', () => {
  writeFixture('a.txt', 'alpha one');
  writeFixture('b.txt', 'beta two');

  const result = editFilesBatch(state, {
    projectId: 'project-file-edit-batch-1',
    mode: 'dry-run',
    files: [
      { filePath: 'a.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] },
      { filePath: 'b.txt', edits: [{ type: 'replace', find: 'two', replaceWith: 'dos' }] },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.files.length, 2);
  assert.equal(readFixture('a.txt'), 'alpha one');
  assert.equal(readFixture('b.txt'), 'beta two');
});

test('editFilesBatch applies multiple files after preflight succeeds', () => {
  writeFixture('apply-a.txt', 'alpha one');
  writeFixture('apply-b.txt', 'beta two');

  const result = editFilesBatch(state, {
    projectId: 'project-file-edit-batch-1',
    mode: 'apply',
    files: [
      { filePath: 'apply-a.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] },
      { filePath: 'apply-b.txt', edits: [{ type: 'replace', find: 'two', replaceWith: 'dos' }] },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(readFixture('apply-a.txt'), 'alpha uno');
  assert.equal(readFixture('apply-b.txt'), 'beta dos');
});

test('editFilesBatch rejects duplicate file paths before writing', () => {
  writeFixture('duplicate.txt', 'same file');

  const result = editFilesBatch(state, {
    projectId: 'project-file-edit-batch-1',
    mode: 'apply',
    files: [
      { filePath: 'duplicate.txt', edits: [{ type: 'replace', find: 'same', replaceWith: 'first' }] },
      { filePath: 'duplicate.txt', edits: [{ type: 'replace', find: 'file', replaceWith: 'second' }] },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors?.[0]?.code, 'DUPLICATE_FILE');
  assert.equal(readFixture('duplicate.txt'), 'same file');
});

test('editFilesBatch stops before writing when any preflight edit fails', () => {
  writeFixture('preflight-a.txt', 'alpha one');
  writeFixture('preflight-b.txt', 'beta two');

  const result = editFilesBatch(state, {
    projectId: 'project-file-edit-batch-1',
    mode: 'apply',
    files: [
      { filePath: 'preflight-a.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] },
      { filePath: 'preflight-b.txt', edits: [{ type: 'replace', find: 'missing', replaceWith: 'dos' }] },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(readFixture('preflight-a.txt'), 'alpha one');
  assert.equal(readFixture('preflight-b.txt'), 'beta two');
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
