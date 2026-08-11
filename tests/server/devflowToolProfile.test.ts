import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { devFlowToolDefinitions, getCapabilityCatalog, getMcpConsolidationReplacement, getMcpToolList, getMcpToolSurfaceIdentity, getToolProfileSummary, resolveDevFlowToolProfile } = await import('../../src/server/contracts/devflowContract.js');
const { buildMcpToolSurfaceInventory, summarizeMcpToolSurfaceInventory } = await import('../../src/server/contracts/mcpToolSurfaceClassification.js');

const PROTECTED_MASTER_SKILLS = [
  '00-skill-router.md',
  '01-authoring-core.md',
  '02-schema-reference.md',
  '07-authoring-execution.md',
  'prompt.execution-rules.md',
  'ready-for-review-reviewer-skill.md',
  'schema.md',
];

const UI_OR_INTERNAL_ONLY_TOOL_REFERENCES = new Set([
  'update_skill',
  'update_prompt_override',
  'delete_prompt_override',
  'cancel_tool_job',
]);

const MAINTAINED_SKILLS = fs.readdirSync(new URL('../../skills/', import.meta.url))
  .filter((name) => name.endsWith('.md'))
  .sort();

function findActionableHiddenToolReferences(content: string, advertisedNames: Set<string>) {
  const knownNames = new Set<string>();
  for (const tool of devFlowToolDefinitions) {
    knownNames.add(tool.name);
    for (const alias of tool.aliases || []) knownNames.add(alias);
  }

  const references: string[] = [];
  for (const name of knownNames) {
    if (advertisedNames.has(name) || UI_OR_INTERNAL_ONLY_TOOL_REFERENCES.has(name)) continue;
    const inlineName = '`' + name + '`';
    const inlineCall = '`' + name + '(';
    const namespaced = 'Dev_Flow.' + name;
    if (content.includes(inlineName) || content.includes(inlineCall) || content.includes(namespaced)) references.push(name);
  }
  return references.sort();
}

test('protected DevFlow skills only recommend tools advertised by the full MCP surface', () => {
  const advertisedNames = new Set(getMcpToolList('full').map((tool: any) => tool.name));
  const staleReferences: string[] = [];

  for (const skillName of PROTECTED_MASTER_SKILLS) {
    const content = fs.readFileSync(new URL('../../skills/' + skillName, import.meta.url), 'utf8');
    for (const name of findActionableHiddenToolReferences(content, advertisedNames)) {
      staleReferences.push(skillName + ': ' + name + ' -> ' + (getMcpConsolidationReplacement(name) || 'no canonical MCP replacement'));
    }
  }

  assert.deepEqual(staleReferences, [], 'master skills must not recommend hidden/removed MCP tools');
});

test('all maintained DevFlow skills avoid stale tool namespaces and direct managed-workspace path placeholders', () => {
  const advertisedNames = new Set(getMcpToolList('full').map((tool: any) => tool.name));
  const staleReferences: string[] = [];

  for (const skillName of MAINTAINED_SKILLS) {
    const content = fs.readFileSync(new URL('../../skills/' + skillName, import.meta.url), 'utf8');
    for (const name of findActionableHiddenToolReferences(content, advertisedNames)) {
      staleReferences.push(skillName + ': hidden tool ' + name);
    }
    if (/Dev_(?:Jira|Github|Flow)\./.test(content) || /`Dev_(?:Jira|Github|Flow)`/.test(content)) {
      staleReferences.push(skillName + ': stale Dev_* namespace');
    }
    if (/\{\{?workspace\.localPath\}?\}|\{project\.localPath\}/.test(content)) {
      staleReferences.push(skillName + ': direct managed-workspace path placeholder');
    }
  }

  assert.deepEqual(staleReferences, [], 'maintained skills must use current consolidated intents and opaque workspace identity');
});

test('execution and review guidance resolves repository Git policy instead of assuming merge topology', () => {
  for (const skillName of [
    '07-authoring-execution.md',
    'prompt.execution-rules.md',
    'agent-task-prompt-template.md',
    'ready-for-review-reviewer-skill.md',
  ]) {
    const content = fs.readFileSync(new URL('../../skills/' + skillName, import.meta.url), 'utf8');
    assert.match(content, /repository Git policy|repo(?:sitory)?-aware Git policy/i, `${skillName} should resolve repository Git policy`);
    assert.match(content, /rebase-ff/i, `${skillName} should name the default rebase-ff strategy`);
    assert.match(content, /merge[^\n]*policy|policy[^\n]*merge/i, `${skillName} should preserve explicit merge-policy overrides`);
    assert.match(content, /commit[^\n]*(?:template|convention|policy)/i, `${skillName} should preserve repo-native commit naming`);
  }
});

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

  assert.equal(coding.length <= full.length, true);
  assert.equal(coding.length > 0, true);
  assert.equal(inventory.filter((item: any) => item.alias).some((item: any) => names.has(item.name)), false);
  for (const required of [
    'get_skill_router', 'get_authoring_skill', 'get_repo_context_bundle', 'read_local_file', 'read_file_snippets_batch',
    'search_local_files', 'create_task', 'search_tasks', 'get_task', 'move_task_to_status', 'open_task_bug',
    'prepare_compact_edit', 'apply_prepared_edit', 'edit_local_files_batch', 'apply_and_verify', 'run_project_command',
    'get_git_status', 'get_git_diff', 'commit_git_changes', 'push_git_branch', 'get_git_sync_status',
    'sync_task_with_git', 'submit_task_for_review', 'create_pull_request',
    'get_figma_authoring_context', 'attach_figma_context_to_task', 'get_jira_authoring_bundle', 'get_project_atlas',
    'prepare_session_workspace', 'integrate_workspace', 'get_tool_job_result', 'get_recovery_handoff', 'devflow_health_check',
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

test('diagnostics MCP profile keeps the recovery handoff surface available', () => {
  const names = new Set(getMcpToolList('diagnostics').map((tool: any) => tool.name));
  assert.equal(names.has('get_recovery_handoff'), true);
});

test('full MCP surface removes globally consolidated tools while keeping high-level intents', () => {
  const fullNames = new Set(getMcpToolList('full').map((tool: any) => tool.name));
  const removedTools = [
    'get_agent_task_context', 'get_agent_context', 'get_task_prompt', 'list_agent_runs', 'retry_agent_run', 'cancel_agent_run', 'complete_agent_run', 'agent_complete_task',
    'assign_agent', 'batch_assign_agent', 'resume_execution', 'handoff_execution',
    'list_tasks', 'get_task_images', 'validate_task_quality', 'batch_upsert_tasks', 'move_task_status', 'batch_move_task_status', 'batch_toggle_task_checklist', 'complete_task_review',
    'get_project_start_context', 'repo_read_snapshot', 'get_repo_inspection_index', 'get_repo_context_delta', 'get_repo_semantic_index',
    'safe_edit_local_file', 'prepare_edit_plan', 'apply_prepared_edit_plan', 'apply_patch',
    'get_figma_file', 'get_figma_node', 'get_figma_design_spec',
    'create_tool_job', 'get_tool_job_status', 'get_tool_job_log', 'cancel_tool_job',
    'get_change_summary', 'get_project_atlas_status', 'parse_test_report', 'apply_project_atlas_agent_update',
  ];
  for (const removed of removedTools) {
    assert.equal(fullNames.has(removed), false, 'full MCP surface should remove ' + removed);
  }
  const replacements = [
    'search_tasks', 'get_task', 'update_task', 'create_task', 'move_task_to_status', 'toggle_task_checklist',
    'get_repo_context_bundle', 'prepare_compact_edit', 'apply_prepared_edit', 'edit_local_files_batch',
    'get_figma_authoring_context', 'get_git_status', 'prepare_session_workspace', 'integrate_workspace',
    'run_project_command', 'get_tool_job_result', 'devflow_health_check', 'get_project_atlas',
  ];
  for (const replacement of replacements) {
    assert.equal(fullNames.has(replacement), true, 'full MCP surface should keep ' + replacement);
  }

  const searchTasks = devFlowToolDefinitions.find((tool: any) => tool.name === 'search_tasks')!;
  assert.equal(searchTasks.inputSchema.required?.includes('q') ?? false, false);
  assert.match(searchTasks.buildHttpRequest({ status: 'backlog' }).path, /status=backlog/);
  assert.match(searchTasks.buildHttpRequest({ status: 'backlog' }).path, /limit=50/);
  assert.match(searchTasks.buildHttpRequest({ status: 'backlog', limit: 75 }).path, /limit=75/);
  assert.match(searchTasks.description, /bounded|default page|defaults? to 50/i);
  assert.match(searchTasks.inputSchema.properties.limit.description, /default.*50|50.*default/i);
  assert.match(searchTasks.buildHttpRequest({ mode: 'full' }).path, /limit=50/);
  assert.match(searchTasks.buildHttpRequest({ mode: 'debug' }).path, /limit=50/);
  assert.match(searchTasks.buildHttpRequest({ mode: 'full', limit: 125 }).path, /limit=125/);
  assert.equal(searchTasks.inputSchema.properties.all.type, 'boolean');
  assert.match(searchTasks.inputSchema.properties.all.description, /all|entire|unbounded/i);
  assert.doesNotMatch(searchTasks.buildHttpRequest({ mode: 'full', all: true }).path, /limit=/);
  assert.match(searchTasks.buildHttpRequest({ mode: 'full', all: true }).path, /all=true/);

  const gitStatus = devFlowToolDefinitions.find((tool: any) => tool.name === 'get_git_status')!;
  assert.deepEqual(gitStatus.inputSchema.properties.mode.enum, ['compact', 'expanded']);
  assert.equal(gitStatus.buildHttpRequest({ mode: 'expanded' }).path, '/api/git/change-summary');
});

test('async tool guidance requires same-turn durable job completion', () => {
  const coding = getMcpToolList('coding');
  const command = coding.find((tool: any) => tool.name === 'run_project_command');
  assert.ok(command);
  assert.match(command.description, /same assistant turn/i);
  assert.match(command.description, /do not ask the user for another message/i);

  const executionRules = fs.readFileSync(new URL('../../skills/prompt.execution-rules.md', import.meta.url), 'utf8');
  assert.match(executionRules, /get_tool_job_result/);
  assert.match(executionRules, /same assistant turn/i);
  assert.match(executionRules, /do not ask the user for another message/i);
  assert.match(executionRules, /preserve.*jobId/i);
});

test('tool profile summary reports serialized schema bytes', () => {
  const summary = getToolProfileSummary();
  assert.ok(summary.full.toolCount > summary.coding.toolCount);
  assert.ok(summary.full.schemaBytes > summary.coding.schemaBytes);
});

test('MCP tool-surface identity is deterministic and changes when an advertised tool is removed', () => {
  assert.equal(typeof getMcpToolSurfaceIdentity, 'function');
  const full = getMcpToolList('full');
  const first = getMcpToolSurfaceIdentity(full);
  const second = getMcpToolSurfaceIdentity(full);
  const withoutLastTool = getMcpToolSurfaceIdentity(full.slice(0, -1));

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(second, first);
  assert.notEqual(withoutLastTool, first);
});

test('MCP inventory can retain backend compatibility while full advertises only consolidated canonical intents', () => {
  const inventory = buildMcpToolSurfaceInventory(devFlowToolDefinitions);
  const full = getMcpToolList('full');
  const summary = summarizeMcpToolSurfaceInventory(inventory);
  const inventoryNames = new Set(inventory.map((item: any) => item.name));

  assert.equal(full.length < inventory.length, true);
  assert.equal(full.every((tool: any) => inventoryNames.has(tool.name)), true);
  assert.equal(new Set(full.map((tool: any) => tool.name)).size, full.length);
  assert.equal(inventory.every((item: any) => item.classification && item.disposition && item.risk && item.intent), true);
  assert.equal(inventory.filter((item: any) => item.classification === 'alias-duplicate').every((item: any) => item.target), true);
  assert.equal(full.some((tool: any) => inventory.find((item: any) => item.name === tool.name)?.alias), false);
  assert.equal(summary.total, inventory.length);
  assert.equal(summary.byDisposition.keep + summary.byDisposition.combine + summary.byDisposition['hide-default'] + summary.byDisposition.deprecate, inventory.length);
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-capability-profile-'));
  fs.writeFileSync(path.join(tempRoot, '.env'), 'DEVFLOW_MCP_TOOL_PROFILE="coding"\n', 'utf8');
  const previousRoot = process.env.DEVFLOW_APP_ROOT;
  const previousSupervisor = process.env.DEVFLOW_RESTART_SUPERVISOR;
  const previousProfile = process.env.DEVFLOW_MCP_TOOL_PROFILE;
  process.env.DEVFLOW_APP_ROOT = tempRoot;
  process.env.DEVFLOW_RESTART_SUPERVISOR = 'start-all';
  process.env.DEVFLOW_MCP_TOOL_PROFILE = 'full';
  try {
    const catalog = getCapabilityCatalog();
    const repeatedCatalog = getCapabilityCatalog();
    const codingTools = getMcpToolList('coding');
    const repeatedCodingTools = getMcpToolList('coding');
    const profileSummary = getToolProfileSummary();
    const repeatedProfileSummary = getToolProfileSummary();
    const fullRead = getMcpToolList('full').find((tool: any) => tool.name === 'read_local_file');
    const codingRead = codingTools.find((tool: any) => tool.name === 'read_local_file');

    assert.equal(catalog.mcpProfile.active, 'coding');
    assert.equal(catalog.mcpProfile.toolCount, codingTools.length);
    assert.ok(catalog.mcpProfile.schemaBytes > 0);
    assert.equal(repeatedCodingTools, codingTools, 'unchanged profile should reuse the immutable MCP tool list');
    assert.equal(repeatedProfileSummary, profileSummary, 'profile schema-byte summary should be memoized');
    assert.equal(repeatedCatalog.tools, catalog.tools, 'capability catalog should reuse static tool materialization');
    assert.equal(repeatedCatalog.matrix, catalog.matrix, 'capability catalog should reuse static matrix materialization');
    assert.equal(repeatedCatalog.workflow, catalog.workflow, 'capability catalog should reuse static workflow materialization');
    assert.equal(fullRead?.inputSchema, codingRead?.inputSchema, 'transport normalization should be reused across profile lists');
    assert.equal(Object.isFrozen(codingTools), true, 'cached tool lists should be immutable');
    assert.equal(Object.isFrozen(codingRead?.inputSchema), true, 'cached transport schemas should be immutable');
  } finally {
    if (previousRoot === undefined) delete process.env.DEVFLOW_APP_ROOT; else process.env.DEVFLOW_APP_ROOT = previousRoot;
    if (previousSupervisor === undefined) delete process.env.DEVFLOW_RESTART_SUPERVISOR; else process.env.DEVFLOW_RESTART_SUPERVISOR = previousSupervisor;
    if (previousProfile === undefined) delete process.env.DEVFLOW_MCP_TOOL_PROFILE; else process.env.DEVFLOW_MCP_TOOL_PROFILE = previousProfile;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
