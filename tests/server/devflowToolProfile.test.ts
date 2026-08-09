import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { devFlowToolDefinitions, getCapabilityCatalog, getMcpToolList, getToolProfileSummary, resolveDevFlowToolProfile } = await import('../../src/server/contracts/devflowContract.js');
const { buildMcpToolSurfaceInventory, summarizeMcpToolSurfaceInventory } = await import('../../src/server/contracts/mcpToolSurfaceClassification.js');

test('stdio MCP entrypoint loads dotenv before creating the server', () => {
  const entrypoint = fs.readFileSync(new URL('../../mcp-server.ts', import.meta.url), 'utf8');
  assert.match(entrypoint, /import ['\"]dotenv\/config['\"];?/);
  assert.ok(entrypoint.indexOf('dotenv/config') < entrypoint.indexOf('createDevFlowMcpServer'));
});

test('coding MCP profile is lean, alias-free, and preserves representative workflows', () => {
  const full = getMcpToolList('full');
  const coding = getMcpToolList('coding');
  const names = new Set(coding.map((tool: any) => tool.name));
  const inventory = buildMcpToolSurfaceInventory(devFlowToolDefinitions);

  assert.equal(coding.length < full.length, true);
  assert.equal(coding.length <= Math.ceil(full.length * 0.45), true);
  assert.equal(inventory.filter((item: any) => item.alias).some((item: any) => names.has(item.name)), false);
  for (const required of [
    'get_skill_router', 'get_authoring_skill', 'get_repo_context_bundle', 'read_local_file', 'read_file_snippets_batch',
    'search_local_files', 'create_task', 'search_tasks', 'get_task', 'move_task_to_status', 'open_task_bug',
    'prepare_compact_edit', 'apply_prepared_edit', 'edit_local_files_batch', 'apply_and_verify', 'run_project_command',
    'get_git_status', 'get_git_diff', 'commit_git_changes', 'push_git_branch', 'get_git_sync_status',
    'sync_task_with_git', 'submit_task_for_review', 'complete_task_review', 'create_pull_request',
    'get_figma_authoring_context', 'attach_figma_context_to_task', 'get_jira_authoring_bundle', 'get_project_atlas',
    'prepare_session_workspace', 'integrate_workspace', 'get_tool_job_result', 'devflow_health_check',
  ]) {
    assert.equal(names.has(required), true, `coding profile should include ${required}`);
  }
  for (const hidden of [
    'validate_task_quality', 'get_repo_context_delta', 'get_repo_inspection_index', 'get_repo_semantic_index',
    'safe_edit_local_file', 'prepare_edit_plan', 'apply_prepared_edit_plan', 'apply_patch',
    'get_tool_job_status', 'get_tool_job_log', 'get_tool_call_summary', 'get_task_prompt', 'list_agent_runs',
    'get_figma_file', 'get_figma_node', 'get_figma_design_spec',
  ]) {
    assert.equal(names.has(hidden), false, `coding profile should hide ${hidden}`);
  }
});

test('tool profile summary reports serialized schema bytes', () => {
  const summary = getToolProfileSummary();
  assert.ok(summary.full.toolCount > summary.coding.toolCount);
  assert.ok(summary.full.schemaBytes > summary.coding.schemaBytes);
});

test('MCP surface inventory classifies every exposed canonical tool and alias', () => {
  const inventory = buildMcpToolSurfaceInventory(devFlowToolDefinitions);
  const full = getMcpToolList('full');
  const summary = summarizeMcpToolSurfaceInventory(inventory);

  assert.equal(inventory.length, full.length);
  assert.equal(new Set(inventory.map((item: any) => item.name)).size, full.length);
  assert.equal(inventory.every((item: any) => item.classification && item.disposition && item.risk && item.intent), true);
  assert.equal(inventory.filter((item: any) => item.classification === 'alias-duplicate').every((item: any) => item.target), true);
  assert.equal(summary.total, full.length);
  assert.equal(summary.byDisposition.keep + summary.byDisposition.combine + summary.byDisposition['hide-default'] + summary.byDisposition.deprecate, full.length);
});

test('MCP profile resolution defaults to lean coding and preserves explicit valid profiles', () => {
  const previous = process.env.DEVFLOW_MCP_TOOL_PROFILE;
  delete process.env.DEVFLOW_MCP_TOOL_PROFILE;
  try {
    assert.deepEqual(resolveDevFlowToolProfile(''), { profile: 'coding', configured: null, fallback: false });
    for (const configured of ['full', 'coding', 'authoring', 'review', 'atlas', 'diagnostics'] as const) {
      const resolved = resolveDevFlowToolProfile(configured);
      assert.equal(resolved.profile, configured);
      assert.equal(resolved.fallback, false);
    }
    const invalid = resolveDevFlowToolProfile('unknown-profile');
    assert.equal(invalid.profile, 'coding');
    assert.equal(invalid.fallback, true);
  } finally {
    if (previous === undefined) delete process.env.DEVFLOW_MCP_TOOL_PROFILE;
    else process.env.DEVFLOW_MCP_TOOL_PROFILE = previous;
  }
});

test('guarded start-all restart refreshes MCP profile from the current env file', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-profile-refresh-'));
  fs.writeFileSync(path.join(tempRoot, '.env'), 'DEVFLOW_MCP_TOOL_PROFILE="coding"\n', 'utf8');
  const previousRoot = process.env.DEVFLOW_APP_ROOT;
  const previousSupervisor = process.env.DEVFLOW_RESTART_SUPERVISOR;
  const previousProfile = process.env.DEVFLOW_MCP_TOOL_PROFILE;
  process.env.DEVFLOW_APP_ROOT = tempRoot;
  process.env.DEVFLOW_RESTART_SUPERVISOR = 'start-all';
  process.env.DEVFLOW_MCP_TOOL_PROFILE = 'full';
  try {
    const resolved = resolveDevFlowToolProfile();
    assert.equal(resolved.profile, 'coding');
    assert.equal(resolved.configured, 'coding');
    assert.equal(resolved.fallback, false);
  } finally {
    if (previousRoot === undefined) delete process.env.DEVFLOW_APP_ROOT; else process.env.DEVFLOW_APP_ROOT = previousRoot;
    if (previousSupervisor === undefined) delete process.env.DEVFLOW_RESTART_SUPERVISOR; else process.env.DEVFLOW_RESTART_SUPERVISOR = previousSupervisor;
    if (previousProfile === undefined) delete process.env.DEVFLOW_MCP_TOOL_PROFILE; else process.env.DEVFLOW_MCP_TOOL_PROFILE = previousProfile;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('capability catalog exposes active MCP profile and schema bytes', () => {
  const previous = process.env.DEVFLOW_MCP_TOOL_PROFILE;
  delete process.env.DEVFLOW_MCP_TOOL_PROFILE;
  try {
    const catalog = getCapabilityCatalog();
    assert.equal(catalog.mcpProfile.active, 'coding');
    assert.equal(catalog.mcpProfile.toolCount, getMcpToolList('coding').length);
    assert.ok(catalog.mcpProfile.schemaBytes > 0);
  } finally {
    if (previous === undefined) delete process.env.DEVFLOW_MCP_TOOL_PROFILE;
    else process.env.DEVFLOW_MCP_TOOL_PROFILE = previous;
  }
});
