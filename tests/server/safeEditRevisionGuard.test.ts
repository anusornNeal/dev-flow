import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-safe-edit-revision-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { readLocalFile } = await import('../../src/server/services/localFileService.js');
const { safeEditFile } = await import('../../src/server/services/safeEditFileService.js');

const state: any = {
  projectsCache: [
    { id: 'project-safe-edit-revision-1', name: 'Safe Edit Revision Fixture', repoUrl: 'https://example.com/safe-edit-revision', localPath: tempDir },
  ],
};

test('safeEditFile applies when expectedRevision matches the current file', () => {
  fs.writeFileSync(path.join(tempDir, 'target.txt'), 'hello world', 'utf8');
  const readResult = readLocalFile(state, {
    projectId: 'project-safe-edit-revision-1',
    filePath: 'target.txt',
    mode: 'metadata',
  });

  const editResult = safeEditFile(state, {
    projectId: 'project-safe-edit-revision-1',
    filePath: 'target.txt',
    mode: 'apply',
    expectedRevision: readResult.revision,
    edits: [{ type: 'replace', find: 'world', replaceWith: 'tool' }],
  });

  assert.equal(editResult.ok, true);
  assert.equal(editResult.revisionBefore?.token, readResult.revision);
  assert.equal(typeof editResult.revisionAfter?.token, 'string');
  assert.equal(fs.readFileSync(path.join(tempDir, 'target.txt'), 'utf8'), 'hello tool');
});

test('safeEditFile rejects stale expectedRevision without writing', () => {
  fs.writeFileSync(path.join(tempDir, 'stale.txt'), 'first world', 'utf8');
  const readResult = readLocalFile(state, {
    projectId: 'project-safe-edit-revision-1',
    filePath: 'stale.txt',
    mode: 'metadata',
  });
  fs.writeFileSync(path.join(tempDir, 'stale.txt'), 'changed world', 'utf8');

  const editResult = safeEditFile(state, {
    projectId: 'project-safe-edit-revision-1',
    filePath: 'stale.txt',
    mode: 'apply',
    expectedRevision: readResult.revision,
    edits: [{ type: 'replace', find: 'world', replaceWith: 'tool' }],
  });

  assert.equal(editResult.ok, false);
  assert.equal(editResult.error?.code, 'CONTENT_CHANGED');
  assert.equal(fs.readFileSync(path.join(tempDir, 'stale.txt'), 'utf8'), 'changed world');
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
