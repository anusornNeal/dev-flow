import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { getCapabilityCatalog, getMcpToolList, getToolProfileSummary, resolveDevFlowToolProfile } = await import('../../src/server/contracts/devflowContract.js');

test('stdio MCP entrypoint loads dotenv before creating the server', () => {
  const entrypoint = fs.readFileSync(new URL('../../mcp-server.ts', import.meta.url), 'utf8');
  assert.match(entrypoint, /import ['\"]dotenv\/config['\"];?/);
  assert.ok(entrypoint.indexOf('dotenv/config') < entrypoint.indexOf('createDevFlowMcpServer'));
});

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
    'push_git_branch',
    'get_git_sync_status',
    'sync_task_with_git',
    'submit_task_for_review',
    'complete_task_review',
    'get_tool_job_result',
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

test('MCP profile resolution is temporarily forced to full', () => {
  for (const configured of [undefined, '', 'full', 'coding', 'review', 'unknown-profile']) {
    const resolved = resolveDevFlowToolProfile(configured);
    assert.equal(resolved.profile, 'full');
    assert.equal(resolved.fallback, false);
  }
});

test('capability catalog exposes active MCP profile and schema bytes', () => {
  const previous = process.env.DEVFLOW_MCP_TOOL_PROFILE;
  delete process.env.DEVFLOW_MCP_TOOL_PROFILE;
  try {
    const catalog = getCapabilityCatalog();
    assert.equal(catalog.mcpProfile.active, 'full');
    assert.equal(catalog.mcpProfile.toolCount, getMcpToolList('full').length);
    assert.ok(catalog.mcpProfile.schemaBytes > 0);
  } finally {
    if (previous === undefined) delete process.env.DEVFLOW_MCP_TOOL_PROFILE;
    else process.env.DEVFLOW_MCP_TOOL_PROFILE = previous;
  }
});
