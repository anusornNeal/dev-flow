import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspaceFinalizationHttpStatus } from '../../src/server/routes/devflow.js';
import { devFlowToolDefinitions } from '../../src/server/contracts/devflowContract.js';
import { taskToolDefinitions } from '../../src/server/contracts/devflowTaskTools.js';
import { gitToolDefinitions } from '../../src/server/contracts/devflowGitTools.js';
import { workspaceToolDefinitions } from '../../src/server/contracts/devflowWorkspaceTools.js';

const TASK_TOOL_NAMES = [
  'list_tasks', 'search_tasks', 'get_task', 'get_task_images',
  'open_task_bug', 'update_task_bug_status', 'create_task', 'update_task', 'claim_next_task', 'claim_task', 'expand_task_scope', 'release_task_claim', 'batch_upsert_tasks', 'import_tasks_from_file',
  'sync_task_with_git', 'submit_task_for_review', 'move_task_status', 'move_task_to_status', 'complete_task_review',
  'batch_move_task_status', 'toggle_task_checklist', 'batch_toggle_task_checklist', 'delete_task',
];

const GIT_TOOL_NAMES = [
  'get_git_log', 'get_git_diff', 'get_git_show', 'get_git_status', 'get_change_summary', 'get_git_branch',
  'ensure_git_branch', 'push_git_branch', 'get_git_sync_status', 'create_pull_request', 'plan_task_commit', 'commit_task_owned_changes', 'commit_git_changes',
];

test('task-domain contracts are owned by a focused module and composed into the aggregate catalog', () => {
  assert.deepEqual(taskToolDefinitions.map((tool) => tool.name), TASK_TOOL_NAMES);
  const aggregateNames = devFlowToolDefinitions.map((tool) => tool.name);
  const first = aggregateNames.indexOf(TASK_TOOL_NAMES[0]);
  assert.ok(first >= 0);
  assert.deepEqual(aggregateNames.slice(first, first + TASK_TOOL_NAMES.length), TASK_TOOL_NAMES);
});

test('task scope expansion keeps a first-class owner-guarded mutation contract', () => {
  const tool = taskToolDefinitions.find((entry) => entry.name === 'expand_task_scope');
  assert.ok(tool);
  assert.equal((tool?.inputSchema as any)?.required?.includes('taskId'), true);
  assert.equal((tool?.inputSchema as any)?.required?.includes('sessionId'), true);
  assert.equal((tool?.inputSchema as any)?.required?.includes('paths'), true);
  const req = tool?.buildHttpRequest({ taskId: 'DVF-1', sessionId: 'chat-secret', paths: ['src/New.ts'] });
  assert.equal(req?.method, 'POST');
  assert.equal(req?.path, '/api/tasks/DVF-1/claim/scope?responseMode=summary');
  assert.deepEqual((req?.body as any)?.paths, ['src/New.ts']);
});

test('task Git workflow contracts expose opaque workspace provenance inputs', () => {
  for (const toolName of ['sync_task_with_git', 'submit_task_for_review']) {
    const tool = taskToolDefinitions.find((entry) => entry.name === toolName);
    assert.ok(tool, `${toolName} contract must exist`);
    const workspaceId = (tool?.inputSchema as any)?.properties?.workspaceId;
    assert.equal(workspaceId?.type, 'string', `${toolName} must expose workspaceId as a string`);
    assert.match(String(workspaceId?.description || ''), /workspace/i);
  }
});

test('git-domain contracts are owned by a focused module and composed into the aggregate catalog', () => {
  assert.deepEqual(gitToolDefinitions.map((tool) => tool.name), GIT_TOOL_NAMES);
  const aggregateNames = devFlowToolDefinitions.map((tool) => tool.name);
  const first = aggregateNames.indexOf(GIT_TOOL_NAMES[0]);
  assert.ok(first >= 0);
  assert.deepEqual(aggregateNames.slice(first, first + GIT_TOOL_NAMES.length), GIT_TOOL_NAMES);
});

test('task-aware commit tools expose scoped planning and async commit wiring', () => {
  const plan = gitToolDefinitions.find((tool) => tool.name === 'plan_task_commit');
  const commit = gitToolDefinitions.find((tool) => tool.name === 'commit_task_owned_changes');
  assert.equal(plan?.lightweight, true);
  assert.equal((plan?.inputSchema as any)?.required?.includes('taskId'), true);
  assert.equal((plan?.inputSchema as any)?.required?.includes('workspaceId'), true);
  assert.equal((commit?.executionPolicy as any)?.mode, 'job');
  assert.equal((commit?.inputSchema as any)?.required?.includes('message'), true);
  const messageDescription = String((commit?.inputSchema as any)?.properties?.message?.description || '');
  assert.match(messageDescription, /conventional/i);
  assert.match(messageDescription, /task|ticket|card/i);
  const routeSource = fs.readFileSync('src/server/routes/devflow.ts', 'utf8');
  assert.match(routeSource, /\/api\/git\/task-commit\/plan/);
  assert.match(routeSource, /\/api\/git\/task-commit\/commit/);
});

test('workspace finalization is a first-class local-only terminal tool', () => {
  const tool = workspaceToolDefinitions.find((entry) => entry.name === 'finalize_task_workspace');
  assert.ok(tool);
  assert.equal((tool?.inputSchema as any)?.required?.includes('workspaceId'), true);
  assert.equal((tool?.inputSchema as any)?.required?.includes('taskId'), true);
  assert.equal((tool?.inputSchema as any)?.required?.includes('checks'), true);
  assert.match(String(tool?.description || ''), /Never pushes or fetches/i);
  assert.equal(tool?.buildHttpRequest({ taskId: 'DVF-1', workspaceId: 'ws_1', checks: [] }).path, '/api/workspaces/finalize-task');
});

test('workspace finalization transport preserves verification continuation without weakening hard conflicts', () => {
  assert.equal(workspaceFinalizationHttpStatus({ status: 'completed' }), 200);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'continuation', code: 'POST_INTEGRATION_VERIFICATION_REQUIRED' }), 200);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'continuation', code: 'POST_INTEGRATION_FINALIZATION_REQUIRED' }), 200);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'needs-recovery', code: 'INTEGRATION_CONFLICT' }), 409);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'needs-recovery', code: 'WORKSPACE_DIRTY' }), 409);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'blocked', code: 'VERIFICATION_NOT_PASSED' }), 409);
});

test('task-domain aliases remain available through focused definitions', () => {
  assert.deepEqual(taskToolDefinitions.find((tool) => tool.name === 'open_task_bug')?.aliases, ['create_bug_thread', 'add_task_bug']);
});
