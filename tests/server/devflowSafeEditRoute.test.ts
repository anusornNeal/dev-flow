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

test('devflowContract exposes prepared edit and composite performance tools', () => {
  const prepare = getToolDefinitionByName('prepare_edit_plan');
  const apply = getToolDefinitionByName('apply_prepared_edit_plan');
  const composite = getToolDefinitionByName('apply_and_verify');
  const delta = getToolDefinitionByName('get_repo_context_delta');
  const semantic = getToolDefinitionByName('get_repo_semantic_index');

  assert.ok(prepare);
  assert.equal(prepare.executionPolicy?.jobKind, 'repo-read');
  assert.equal(prepare.buildHttpRequest({ projectId: 'project-1', files: [] }).path, '/api/local-files/edit-plans/prepare');

  assert.ok(apply);
  assert.equal(apply.executionPolicy?.jobKind, 'repo-write');
  assert.equal(apply.buildHttpRequest({ projectId: 'project-1', editPlanId: 'plan-1' }).path, '/api/local-files/edit-plans/apply');

  assert.ok(composite);
  assert.equal(composite.executionPolicy?.jobKind, 'repo-command');
  assert.equal(composite.buildHttpRequest({ projectId: 'project-1', editPlanId: 'plan-1' }).path, '/api/workflows/apply-and-verify');

  assert.ok(delta);
  assert.ok(delta.buildHttpRequest({ projectId: 'project-1', contextHandle: 'ctx-1' }).path.startsWith('/api/repo-context/delta'));

  assert.ok(semantic);
  assert.ok(semantic.buildHttpRequest({ projectId: 'project-1', symbol: 'Service' }).path.startsWith('/api/repo-inspection/semantic'));
});

test('devflowContract exposes apply_project_atlas_agent_update as a serialized write job', () => {
  const tool = getToolDefinitionByName('apply_project_atlas_agent_update');
  assert.ok(tool);
  assert.equal(tool.executionPolicy?.mode, 'job');
  assert.equal(tool.executionPolicy?.jobKind, 'repo-write');

  const req = tool.buildHttpRequest({
    projectId: 'project-1',
    provenance: { provider: 'ChatGPT' },
    coverage: { notes: ['Read source files.'], skippedAreas: [] },
    groupingRationale: { summary: 'Grouped by ChatGPT after staged repo reads.' },
    nodes: [],
    edges: [],
    domains: [],
  });

  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/project-atlas/agent-update');
  assert.deepEqual(req.body, {
    projectId: 'project-1',
    provenance: { provider: 'ChatGPT' },
    coverage: { notes: ['Read source files.'], skippedAreas: [] },
    groupingRationale: { summary: 'Grouped by ChatGPT after staged repo reads.' },
    nodes: [],
    edges: [],
    domains: [],
  });
  assert.ok(getMcpToolList().some((entry) => entry.name === 'apply_project_atlas_agent_update'));
  assert.equal(getToolDefinitionByName('rescan_project_atlas'), undefined);
  assert.equal(getMcpToolList().some((entry) => entry.name === 'rescan_project_atlas'), false);
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
