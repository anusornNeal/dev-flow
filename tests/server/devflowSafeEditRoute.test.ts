import test from 'node:test';
import assert from 'node:assert/strict';
import { getToolDefinitionByName } from '../../src/server/contracts/devflowContract.js';

test('devflowContract exposes safe_edit_local_file', () => {
  const tool = getToolDefinitionByName('safe_edit_local_file');
  assert.ok(tool, 'safe_edit_local_file should be defined');
  assert.equal(tool.name, 'safe_edit_local_file');
  const req = tool.buildHttpRequest({ filePath: 'foo.ts', edits: [] });
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/local-files/safe-edit');
});
