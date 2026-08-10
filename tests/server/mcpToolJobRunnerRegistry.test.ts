import test from 'node:test';
import assert from 'node:assert/strict';
import { getBuiltinToolRunnerNames, runBuiltinToolJob } from '../../src/server/services/mcpToolJobRunnerRegistry.js';

const EXPECTED_RUNNERS = [
  'run_project_command',
  'apply_patch',
  'search_local_files',
  'ensure_git_branch',
  'push_git_branch',
  'commit_git_changes',
  'commit_task_owned_changes',
  'edit_local_files_batch',
  'prepare_edit_plan',
  'apply_prepared_edit_plan',
  'prepare_compact_edit',
  'apply_prepared_edit',
  'apply_and_verify',
  'delete_local_path',
  'move_local_path',
  'apply_project_atlas_agent_update',
];

test('runner registry owns the complete built-in async dispatch surface', () => {
  assert.deepEqual(getBuiltinToolRunnerNames(), EXPECTED_RUNNERS);
});

test('runner registry rejects unknown async tools explicitly', async () => {
  await assert.rejects(
    runBuiltinToolJob({ toolName: 'missing_tool', state: {} as any, args: {} }, {
      logger: { stdout: () => {}, stderr: () => {} },
      setCancelFn: () => {},
      transitionAccess: () => {},
    }),
    /No async runner implemented for tool: missing_tool/,
  );
});
