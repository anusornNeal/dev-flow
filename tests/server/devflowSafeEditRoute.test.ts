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

test('devflowContract exposes edit_local_files_batch', () => {
  const tool = getToolDefinitionByName('edit_local_files_batch');
  assert.ok(tool, 'edit_local_files_batch should be defined');
  assert.equal(tool.name, 'edit_local_files_batch');
  assert.equal(tool.executionPolicy?.mode, 'job');
  assert.equal(tool.executionPolicy?.jobKind, 'repo-write');
  const req = tool.buildHttpRequest({ mode: 'dry-run', files: [] });
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/local-files/edit-batch');
});

test('devflowContract exposes read_file_snippets_batch', () => {
  const tool = getToolDefinitionByName('read_file_snippets_batch');
  assert.ok(tool, 'read_file_snippets_batch should be defined');
  assert.equal(tool.name, 'read_file_snippets_batch');
  const req = tool.buildHttpRequest({ files: [{ filePath: 'foo.ts', startLine: 1, endLine: 5 }] });
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/local-files/read-batch');
});

test('devflowContract exposes repo_read_snapshot', () => {
  const tool = getToolDefinitionByName('repo_read_snapshot');
  assert.ok(tool);
  const req = tool.buildHttpRequest({ projectId: 'project-1' });
  assert.equal(req.method, 'GET');
  assert.ok(req.path.startsWith('/api/repo-read-snapshot'));
});
