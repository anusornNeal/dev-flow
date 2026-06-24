import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { safeEditFile } from '../../src/server/services/safeEditFileService.js';

const tempDir = path.join(process.cwd(), 'tests', 'server', '.tmp_safe_edit');
const testFile = path.join(tempDir, 'test.txt');

const mockState = {} as any;
const relativeFilePath = `tests/server/.tmp_safe_edit/test.txt`;

test('safeEditFileService test suite', async (t) => {
  t.before(() => {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  });

  t.after(() => {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  t.beforeEach(() => {
    fs.writeFileSync(testFile, 'line1\nline2\nline3\nline4\nline5\n', 'utf8');
  });

  await t.test('replaces text', () => {
    const result = safeEditFile(mockState, {
      filePath: relativeFilePath,
      mode: 'apply',
      edits: [{ type: 'replace', find: 'line3', replaceWith: 'lineThree' }],
    });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(fs.readFileSync(testFile, 'utf8'), 'line1\nline2\nlineThree\nline4\nline5\n');
  });

  await t.test('supports occurrence', () => {
    fs.writeFileSync(testFile, 'apple\nbanana\napple\ncherry\n', 'utf8');
    const result = safeEditFile(mockState, {
      filePath: relativeFilePath,
      mode: 'apply',
      edits: [{ type: 'replace', find: 'apple', replaceWith: 'orange', occurrence: 2 }],
    });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(fs.readFileSync(testFile, 'utf8'), 'apple\nbanana\norange\ncherry\n');
  });

  await t.test('rejects ambiguous match without occurrence', () => {
    fs.writeFileSync(testFile, 'apple\nbanana\napple\ncherry\n', 'utf8');
    const result = safeEditFile(mockState, {
      filePath: relativeFilePath,
      mode: 'apply',
      edits: [{ type: 'replace', find: 'apple', replaceWith: 'orange' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'AMBIGUOUS_MATCH');
  });

  await t.test('rejects missing match', () => {
    const result = safeEditFile(mockState, {
      filePath: relativeFilePath,
      mode: 'apply',
      edits: [{ type: 'replace', find: 'notfound', replaceWith: 'found' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'NO_MATCH');
  });

  await t.test('respects dryRun', () => {
    const result = safeEditFile(mockState, {
      filePath: relativeFilePath,
      mode: 'dry-run',
      edits: [{ type: 'replace', find: 'line3', replaceWith: 'lineThree' }],
    });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.dryRun, true);
    assert.equal(fs.readFileSync(testFile, 'utf8'), 'line1\nline2\nline3\nline4\nline5\n');
  });

  await t.test('checks expectedSha256', () => {
    const wrongHash = 'abc';
    const result = safeEditFile(mockState, {
      filePath: relativeFilePath,
      mode: 'apply',
      expectedSha256: wrongHash,
      edits: [{ type: 'replace', find: 'line3', replaceWith: 'lineThree' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'CONTENT_CHANGED');
  });
});
