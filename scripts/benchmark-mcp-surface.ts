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
  reviewAndPublish: ['submit_task_for_review', 'move_task_to_status', 'create_pull_request', 'push_git_branch'],
};

const workflowResults = Object.fromEntries(Object.entries(workflows).map(([name, tools]) => {
  const missing = tools.filter((tool) => !codingNames.has(tool));
  return [name, { tools, missing, ready: missing.length === 0 }];
}));

for (const [name, result] of Object.entries(workflowResults) as any) {
  assert.equal(result.ready, true, `${name} is missing ${result.missing.join(', ')}`);
}

const aliasNames = inventory.filter((item) => item.alias).map((item) => item.name);
assert.equal(inventory.some((item) => item.name === 'get_schema'), false);
assert.equal(fullNames.has('get_tool_schema'), true);
assert.equal(aliasNames.some((name) => codingNames.has(name)), false);
assert.equal(aliasNames.some((name) => fullNames.has(name)), false);

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
  'get_figma_file',
  'get_figma_node',
  'get_figma_design_spec',
];
assert.equal(compatibilityOnly.every((name) => !codingNames.has(name)), true);
assert.equal(compatibilityOnly.every((name) => !fullNames.has(name)), true);

const LEGACY_FULL_BASELINE = { toolCount: 109, schemaBytes: 173_705 };
const summary = getToolProfileSummary();
const reduction = (before: number, after: number) => Math.round(((before - after) / before) * 10_000) / 100;
const approximateTokens = (bytes: number) => Math.ceil(bytes / 4);

console.log(JSON.stringify({
  before: {
    profile: 'legacy-full-baseline',
    toolCount: LEGACY_FULL_BASELINE.toolCount,
    schemaBytes: LEGACY_FULL_BASELINE.schemaBytes,
    approximateSchemaTokens: approximateTokens(LEGACY_FULL_BASELINE.schemaBytes),
  },
  after: {
    profile: 'full-consolidated',
    toolCount: summary.full.toolCount,
    schemaBytes: summary.full.schemaBytes,
    approximateSchemaTokens: approximateTokens(summary.full.schemaBytes),
  },
  reduction: {
    toolCountPercent: reduction(LEGACY_FULL_BASELINE.toolCount, summary.full.toolCount),
    schemaBytesPercent: reduction(LEGACY_FULL_BASELINE.schemaBytes, summary.full.schemaBytes),
    approximateSchemaTokensPercent: reduction(approximateTokens(LEGACY_FULL_BASELINE.schemaBytes), approximateTokens(summary.full.schemaBytes)),
  },
  workflowResults,
  compatibility: {
    backendAliasesNotAdvertised: aliasNames.length,
    compatibilityOnlyToolsNotAdvertised: compatibilityOnly.length,
    backendDefinitionsRemainAvailableInternally: true,
  },
  note: 'Structural evaluation: measures catalog/schema decision surface and workflow tool availability; it does not claim a measured model wrong-tool rate.',
}, null, 2));
