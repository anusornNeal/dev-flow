import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-steno-protocol-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { clearFileReferences, issueFileRef } = await import('../../src/server/services/fileReferenceService.js');
const { decodeStenoEditRequest } = await import('../../src/server/services/stenoEditProtocolService.js');

const state: any = {
  projectsCache: [
    { id: 'project-steno', name: 'Steno Fixture', repoUrl: 'https://example.com/steno', localPath: tempDir },
  ],
};

function revision(targetPath: string) {
  const stat = fs.statSync(targetPath);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
  return {
    token: `${stat.size}:${Math.trunc(stat.mtimeMs)}:${sha256.slice(0, 16)}`,
    sha256,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function refFor(name: string, content = 'anchor\nend\n') {
  const targetPath = path.join(tempDir, name);
  fs.writeFileSync(targetPath, content, 'utf8');
  return issueFileRef(state, { projectId: 'project-steno' }, {
    root: tempDir,
    targetPath,
    filePath: name,
    revision: revision(targetPath),
    nowMs: 1_000,
  }).fileRef;
}

function errorCode(error: unknown) {
  return (error as any)?.payload?.code;
}

test.beforeEach(() => clearFileReferences());

test('decodes R/IB/IA/DB tuples and request-local string references into SafeEditOperation inputs', () => {
  const fileRef = refFor('ops.txt');
  const decoded = decodeStenoEditRequest(state, {
    projectId: 'project-steno',
    v: 1,
    s: ['anchor', 'replacement', 'before\n', 'after\n', 'end'],
    f: [[fileRef, [
      ['R', 0, 1, 1],
      ['IB', 0, 2, 1],
      ['IA', 0, 3, 1],
      ['DB', 0, 4, 1],
    ]]],
  }, { nowMs: 2_000 });

  assert.deepEqual(decoded.files[0].edits, [
    { type: 'replace', find: 'anchor', replaceWith: 'replacement', occurrence: 1 },
    { type: 'insert_before', find: 'anchor', content: 'before\n', occurrence: 1 },
    { type: 'insert_after', find: 'anchor', content: 'after\n', occurrence: 1 },
    { type: 'delete_between', start: 'anchor', end: 'end', occurrence: 1 },
  ]);
  assert.equal(decoded.files[0].expectedSha256.length, 64);
  assert.equal(decoded.diagnostics.stringTableEntries, 5);
  assert.equal(decoded.diagnostics.stringReferences, 8);
  assert.equal(decoded.diagnostics.expandedOperations, 4);
});

test('supports literal Unicode and newlines without a string table', () => {
  const fileRef = refFor('unicode.txt', 'สวัสดี\n終わり\n');
  const decoded = decodeStenoEditRequest(state, {
    projectId: 'project-steno',
    v: 1,
    f: [[fileRef, [
      ['R', 'สวัสดี', 'こんにちは', 1],
      ['IA', 'こんにちは', '\nบรรทัดใหม่', 1],
    ]]],
  }, { nowMs: 2_000 });

  assert.equal(decoded.files[0].edits[0].find, 'สวัสดี');
  assert.equal(decoded.files[0].edits[0].replaceWith, 'こんにちは');
  assert.equal(decoded.files[0].edits[1].content, '\nบรรทัดใหม่');
  assert.equal(decoded.diagnostics.stringTableEntries, 0);
});

test('rejects unsupported protocol versions before preparation', () => {
  assert.throws(
    () => decodeStenoEditRequest(state, { projectId: 'project-steno', v: 2, f: [] }),
    (error: unknown) => errorCode(error) === 'EDIT_PROTOCOL_VERSION_UNSUPPORTED',
  );
});

test('rejects negative, out-of-range and non-string dictionary references', () => {
  const fileRef = refFor('dict.txt');
  for (const payload of [
    { v: 1, s: ['anchor'], f: [[fileRef, [['R', -1, 'x', 1]]]] },
    { v: 1, s: ['anchor'], f: [[fileRef, [['R', 9, 'x', 1]]]] },
    { v: 1, s: ['anchor', 123], f: [[fileRef, [['R', 0, 1, 1]]]] },
  ]) {
    assert.throws(
      () => decodeStenoEditRequest(state, { projectId: 'project-steno', ...payload }, { nowMs: 2_000 }),
      (error: unknown) => errorCode(error) === 'EDIT_DICT_REF_INVALID',
    );
  }
});

test('rejects malformed compact tuples and invalid occurrence values', () => {
  const fileRef = refFor('invalid.txt');
  for (const operation of [
    ['XX', 'a', 'b'],
    ['R', 'a'],
    ['IA', 'a', 'b', 0],
  ]) {
    assert.throws(
      () => decodeStenoEditRequest(state, {
        projectId: 'project-steno',
        v: 1,
        f: [[fileRef, [operation]]],
      }, { nowMs: 2_000 }),
      (error: unknown) => errorCode(error) === 'INVALID_ARGS',
    );
  }
});

test.after(() => {
  clearFileReferences();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
