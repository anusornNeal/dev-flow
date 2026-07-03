import test from 'node:test';
import assert from 'node:assert/strict';
import { getMcpToolList, getToolDefinitionByName } from '../../src/server/contracts/devflowContract.js';

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

test('devflowContract exposes complete_task_review', () => {
  const tool = getToolDefinitionByName('complete_task_review');
  assert.ok(tool);
  const req = tool.buildHttpRequest({ taskId: 'DVF-1', isAgentRequest: true, responseMode: 'summary' });
  assert.equal(req.method, 'POST');
  assert.ok(req.path.startsWith('/api/tasks/DVF-1/move-to'));
  assert.deepEqual(req.body, { status: 'done' });
  assert.equal(req.headers?.['x-agent-request'], 'true');
});

test('devflowContract maps get_task_prompt to JSON route', () => {
  const tool = getToolDefinitionByName('get_task_prompt');
  assert.ok(tool);
  const req = tool.buildHttpRequest({ taskId: 'DVF-1' });
  assert.equal(req.method, 'GET');
  assert.ok(req.path.startsWith('/api/tasks/DVF-1/prompt-json'));
});

test('devflowContract exposes open_task_bug for embedded task bug threads', () => {
  const tool = getToolDefinitionByName('open_task_bug');
  assert.ok(tool, 'open_task_bug should be defined');
  assert.equal(tool.name, 'open_task_bug');
  assert.equal(getToolDefinitionByName('create_bug_thread')?.name, 'open_task_bug');
  assert.equal(getToolDefinitionByName('add_task_bug')?.name, 'open_task_bug');

  const req = tool.buildHttpRequest({
    taskId: 'DVF-1',
    title: 'Theme mismatch',
    source: 'review',
    severity: 'high',
    actual: 'Atlas theme is inconsistent.',
    expected: 'Atlas matches project theme.',
    evidence: 'Reviewer screenshot',
    relatedAreas: ['ProjectAtlasPage'],
    prompt: 'Fix the Atlas theme mismatch.',
    summary: 'First report from review.',
    createdBy: 'ChatGPT',
    responseMode: 'summary',
    isAgentRequest: true,
    emergency: true,
  });

  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/tasks/DVF-1/bugs?responseMode=summary');
  assert.equal(req.headers?.['x-agent-request'], 'true');
  assert.deepEqual(req.body, {
    title: 'Theme mismatch',
    source: 'review',
    severity: 'high',
    actual: 'Atlas theme is inconsistent.',
    expected: 'Atlas matches project theme.',
    evidence: 'Reviewer screenshot',
    relatedAreas: ['ProjectAtlasPage'],
    prompt: 'Fix the Atlas theme mismatch.',
    summary: 'First report from review.',
    createdBy: 'ChatGPT',
    emergency: true,
  });

  const toolNames = getMcpToolList().map((entry) => entry.name);
  assert.ok(toolNames.includes('open_task_bug'));
  assert.ok(toolNames.includes('create_bug_thread'));
  assert.ok(toolNames.includes('add_task_bug'));
});
