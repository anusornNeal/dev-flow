import test from 'node:test';
import assert from 'node:assert/strict';

const { getMcpToolList, getToolProfileSummary } = await import('../../src/server/contracts/devflowContract.js');

test('coding MCP profile is materially smaller than full while preserving core coding workflow tools', () => {
  const full = getMcpToolList('full');
  const coding = getMcpToolList('coding');
  const names = new Set(coding.map((tool: any) => tool.name));

  assert.equal(coding.length < full.length, true);
  assert.equal(coding.length <= Math.ceil(full.length * 0.65), true);
  for (const required of [
    'get_repo_context_bundle',
    'get_repo_context_delta',
    'get_repo_semantic_index',
    'read_local_file',
    'search_local_files',
    'edit_local_files_batch',
    'prepare_edit_plan',
    'apply_prepared_edit_plan',
    'apply_and_verify',
    'run_project_command',
    'get_git_diff',
    'commit_git_changes',
    'devflow_health_check',
  ]) {
    assert.equal(names.has(required), true, `coding profile should include ${required}`);
  }
});

test('tool profile summary reports serialized schema bytes', () => {
  const summary = getToolProfileSummary();
  assert.ok(summary.full.toolCount > summary.coding.toolCount);
  assert.ok(summary.full.schemaBytes > summary.coding.schemaBytes);
});
