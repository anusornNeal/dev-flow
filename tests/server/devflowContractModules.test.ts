import test from 'node:test';
import assert from 'node:assert/strict';
import { devFlowToolDefinitions } from '../../src/server/contracts/devflowContract.js';
import { taskToolDefinitions } from '../../src/server/contracts/devflowTaskTools.js';
import { gitToolDefinitions } from '../../src/server/contracts/devflowGitTools.js';

const TASK_TOOL_NAMES = [
  'list_tasks', 'search_tasks', 'get_task', 'get_task_images', 'get_agent_task_context', 'get_task_prompt',
  'open_task_bug', 'update_task_bug_status', 'create_task', 'update_task', 'batch_upsert_tasks', 'import_tasks_from_file',
  'sync_task_with_git', 'submit_task_for_review', 'move_task_status', 'move_task_to_status', 'complete_task_review',
  'batch_move_task_status', 'toggle_task_checklist', 'batch_toggle_task_checklist', 'assign_agent', 'batch_assign_agent',
  'delete_task', 'list_agent_runs', 'retry_agent_run', 'cancel_agent_run', 'complete_agent_run',
];

const GIT_TOOL_NAMES = [
  'get_git_log', 'get_git_diff', 'get_git_show', 'get_git_status', 'get_change_summary', 'get_git_branch',
  'ensure_git_branch', 'push_git_branch', 'get_git_sync_status', 'create_pull_request', 'commit_git_changes',
];

test('task-domain contracts are owned by a focused module and composed into the aggregate catalog', () => {
  assert.deepEqual(taskToolDefinitions.map((tool) => tool.name), TASK_TOOL_NAMES);
  const aggregateNames = devFlowToolDefinitions.map((tool) => tool.name);
  const first = aggregateNames.indexOf(TASK_TOOL_NAMES[0]);
  assert.ok(first >= 0);
  assert.deepEqual(aggregateNames.slice(first, first + TASK_TOOL_NAMES.length), TASK_TOOL_NAMES);
});

test('git-domain contracts are owned by a focused module and composed into the aggregate catalog', () => {
  assert.deepEqual(gitToolDefinitions.map((tool) => tool.name), GIT_TOOL_NAMES);
  const aggregateNames = devFlowToolDefinitions.map((tool) => tool.name);
  const first = aggregateNames.indexOf(GIT_TOOL_NAMES[0]);
  assert.ok(first >= 0);
  assert.deepEqual(aggregateNames.slice(first, first + GIT_TOOL_NAMES.length), GIT_TOOL_NAMES);
});

test('task-domain aliases remain available through aggregate definitions', () => {
  assert.deepEqual(taskToolDefinitions.find((tool) => tool.name === 'get_agent_task_context')?.aliases, ['get_agent_context']);
  assert.deepEqual(taskToolDefinitions.find((tool) => tool.name === 'open_task_bug')?.aliases, ['create_bug_thread', 'add_task_bug']);
  assert.deepEqual(taskToolDefinitions.find((tool) => tool.name === 'complete_agent_run')?.aliases, ['agent_complete_task']);
});
