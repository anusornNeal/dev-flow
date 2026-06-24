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

  await t.test('rejects oversized edit payloads before writing', () => {
    const before = fs.readFileSync(testFile, 'utf8');
    const result = safeEditFile(mockState, {
      filePath: relativeFilePath,
      mode: 'apply',
      maxPayloadBytes: 1,
      edits: [{ type: 'replace', find: 'line3', replaceWith: 'lineThree' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(fs.readFileSync(testFile, 'utf8'), before);
  });

  await t.test('rejects files larger than maxFileBytes', () => {
    const result = safeEditFile(mockState, {
      filePath: relativeFilePath,
      mode: 'apply',
      maxFileBytes: 1,
      edits: [{ type: 'replace', find: 'line3', replaceWith: 'lineThree' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'FILE_TOO_LARGE');
  });

  await t.test('rejects unsafe paths outside the project root', () => {
    const result = safeEditFile(mockState, {
      filePath: '../outside.txt',
      mode: 'apply',
      edits: [{ type: 'replace', find: 'x', replaceWith: 'y' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'UNSAFE_PATH');
  });

  await t.test('returns FILE_NOT_FOUND for missing files', () => {
    const result = safeEditFile(mockState, {
      filePath: 'tests/server/.tmp_safe_edit/missing.txt',
      mode: 'apply',
      edits: [{ type: 'replace', find: 'x', replaceWith: 'y' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'FILE_NOT_FOUND');
  });

  await t.test('matches LF anchors against CRLF files and preserves CRLF output', () => {
    fs.writeFileSync(testFile, 'alpha\r\nbeta\r\ngamma\r\n', 'utf8');
    const result = safeEditFile(mockState, {
      filePath: relativeFilePath,
      mode: 'apply',
      edits: [{ type: 'replace', find: 'alpha\nbeta', replaceWith: 'alpha\nBETA' }],
    });

    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.diagnostics?.newlineStyle, 'crlf');
    assert.equal(result.diagnostics?.matchedWithNormalizedNewlines, true);
    assert.equal(fs.readFileSync(testFile, 'utf8'), 'alpha\r\nBETA\r\ngamma\r\n');
  });

  await t.test('normalizes inserted content to the target CRLF style', () => {
    fs.writeFileSync(testFile, 'one\r\ntwo\r\n', 'utf8');
    const result = safeEditFile(mockState, {
      filePath: relativeFilePath,
      mode: 'apply',
      edits: [{ type: 'insert_after', find: 'one', content: '\ninserted' }],
    });

    assert.equal(result.ok, true, result.error?.message);
    assert.equal(fs.readFileSync(testFile, 'utf8'), 'one\r\ninserted\r\ntwo\r\n');
  });
});
