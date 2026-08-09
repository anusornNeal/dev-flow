import assert from 'node:assert/strict';
import { devFlowToolDefinitions, getMcpToolList, getToolProfileSummary } from '../src/server/contracts/devflowContract.js';
import { buildMcpToolSurfaceInventory } from '../src/server/contracts/mcpToolSurfaceClassification.js';

const full = getMcpToolList('full');
const coding = getMcpToolList('coding');
const fullNames = new Set(full.map((tool: any) => tool.name));
const codingNames = new Set(coding.map((tool: any) => tool.name));
const inventory = buildMcpToolSurfaceInventory(devFlowToolDefinitions);

const workflows: Record<string, string[]> = {
  cardAuthoring: ['get_skill_router', 'get_authoring_skill', 'get_repo_context_bundle', 'create_task'],
  repoInspection: ['get_repo_context_bundle', 'read_local_file', 'read_file_snippets_batch', 'search_local_files'],
  editAndVerify: ['read_file_snippets_batch', 'prepare_compact_edit', 'apply_prepared_edit', 'edit_local_files_batch', 'apply_and_verify', 'run_project_command'],
  taskWorkflow: ['search_tasks', 'get_task', 'move_task_to_status', 'open_task_bug'],
  commitWorkflow: ['get_git_status', 'get_git_diff', 'commit_git_changes', 'get_git_sync_status', 'sync_task_with_git'],
  figmaAuthoring: ['get_figma_authoring_context', 'attach_figma_context_to_task'],
  workspaceIsolation: ['prepare_session_workspace', 'integrate_workspace'],
  reviewAndPublish: ['submit_task_for_review', 'complete_task_review', 'create_pull_request', 'push_git_branch'],
};

const workflowResults = Object.fromEntries(Object.entries(workflows).map(([name, tools]) => {
  const missing = tools.filter((tool) => !codingNames.has(tool));
  return [name, { tools, missing, ready: missing.length === 0 }];
}));

for (const [name, result] of Object.entries(workflowResults) as any) {
  assert.equal(result.ready, true, `${name} is missing ${result.missing.join(', ')}`);
}

const aliasNames = inventory.filter((item) => item.alias).map((item) => item.name);
assert.equal(aliasNames.some((name) => codingNames.has(name)), false);
assert.equal(aliasNames.every((name) => fullNames.has(name)), true);

const compatibilityOnly = [
  'validate_task_quality',
  'get_repo_context_delta',
  'get_repo_inspection_index',
  'get_repo_semantic_index',
  'safe_edit_local_file',
  'prepare_edit_plan',
  'apply_prepared_edit_plan',
  'apply_patch',
  'get_tool_job_status',
  'get_tool_job_log',
  'get_tool_call_summary',
  'get_task_prompt',
  'list_agent_runs',
  'get_figma_file',
  'get_figma_node',
  'get_figma_design_spec',
];
assert.equal(compatibilityOnly.every((name) => !codingNames.has(name)), true);
assert.equal(compatibilityOnly.every((name) => fullNames.has(name)), true);

const summary = getToolProfileSummary();
const reduction = (before: number, after: number) => Math.round(((before - after) / before) * 10_000) / 100;
const approximateTokens = (bytes: number) => Math.ceil(bytes / 4);

console.log(JSON.stringify({
  before: {
    profile: 'full',
    toolCount: summary.full.toolCount,
    schemaBytes: summary.full.schemaBytes,
    approximateSchemaTokens: approximateTokens(summary.full.schemaBytes),
  },
  after: {
    profile: 'coding',
    toolCount: summary.coding.toolCount,
    schemaBytes: summary.coding.schemaBytes,
    approximateSchemaTokens: approximateTokens(summary.coding.schemaBytes),
  },
  reduction: {
    toolCountPercent: reduction(summary.full.toolCount, summary.coding.toolCount),
    schemaBytesPercent: reduction(summary.full.schemaBytes, summary.coding.schemaBytes),
    approximateSchemaTokensPercent: reduction(approximateTokens(summary.full.schemaBytes), approximateTokens(summary.coding.schemaBytes)),
  },
  workflowResults,
  compatibility: {
    aliasesHiddenFromDefault: aliasNames.length,
    compatibilityOnlyToolsHiddenFromDefault: compatibilityOnly.length,
    fullProfileRetainsCompatibility: true,
  },
  note: 'Structural evaluation: measures catalog/schema decision surface and workflow tool availability; it does not claim a measured model wrong-tool rate.',
}, null, 2));
