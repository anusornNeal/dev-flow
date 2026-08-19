import type { DevFlowToolDefinition } from './devflowContractCore';

export type McpToolSurfaceClassification =
  | 'first-class-intent'
  | 'alias-duplicate'
  | 'diagnostic-advanced'
  | 'internal-mechanic';

export type McpToolSurfaceDisposition = 'keep' | 'combine' | 'hide-default';
export type McpToolRisk = 'read' | 'write' | 'destructive' | 'external-effect' | 'runtime-control';

export type McpToolSurfaceInventoryItem = {
  name: string;
  canonicalName: string;
  alias: boolean;
  classification: McpToolSurfaceClassification;
  disposition: McpToolSurfaceDisposition;
  intent: string;
  risk: McpToolRisk;
  target?: string;
  rationale: string;
};

type CanonicalDecision = Omit<McpToolSurfaceInventoryItem, 'name' | 'canonicalName' | 'alias'>;

const DIAGNOSTIC_ADVANCED = new Set([
  'get_capabilities',
  'get_tool_schema',
  'get_tool_call_summary',
  'devflow_health_check',
  'restart_devflow',
  'get_devflow_restart_status',
  'get_project_atlas_status',
  'parse_test_report',
  'get_tool_job_status',
  'get_tool_job_log',
]);

const KEEP_DIAGNOSTICS = new Set(['devflow_health_check']);

const INTERNAL_TARGETS: Record<string, string> = {
  validate_task_quality: 'task_mutation',
  get_project_start_context: 'inspect_repo',
  repo_read_snapshot: 'inspect_repo',
  get_repo_inspection_index: 'inspect_repo',
  get_repo_context_delta: 'inspect_repo',
  get_repo_semantic_index: 'inspect_repo',
  get_task_images: 'get_task',
  get_authoring_skills: 'get_guidance',
  get_skill_router: 'get_guidance',
  get_authoring_skill: 'get_guidance',
  list_skills: 'get_guidance',
  get_skill: 'get_guidance',
  read_file_snippets_batch: 'read_local_file',
  safe_edit_local_file: 'edit_files',
  edit_local_files_batch: 'edit_files',
  prepare_edit_plan: 'edit_files',
  apply_prepared_edit_plan: 'edit_files',
  prepare_compact_edit: 'edit_files',
  apply_prepared_edit: 'edit_files',
  apply_patch: 'edit_files',
  prepare_session_workspace: 'session_workspace_runtime',
  cleanup_session_workspace: 'session_workspace_runtime',
  create_tool_job: 'async_runtime',
};

const COMBINE_TARGETS: Record<string, string> = {
  batch_upsert_tasks: 'task_mutation',
  move_task_status: 'move_task',
  move_task_to_status: 'move_task',
  batch_move_task_status: 'move_task',
  toggle_task_checklist: 'set_task_checklist',
  batch_toggle_task_checklist: 'set_task_checklist',
  assign_agent: 'assign_task_agent',
  batch_assign_agent: 'assign_task_agent',
  get_figma_file: 'get_figma_authoring_context',
  get_figma_node: 'get_figma_authoring_context',
  get_figma_design_spec: 'get_figma_authoring_context',
};

const ADMIN_ADVANCED = new Set([
  'update_skill',
  'list_prompt_skills',
  'get_prompt_skill',
  'update_prompt_override',
  'delete_prompt_override',
  'abort_workspace_integration',
  'retry_workspace_integration',
  'cancel_tool_job',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'delete_project',
  'delete_task',
  'delete_local_path',
  'cleanup_session_workspace',
  'abort_workspace_integration',
]);

const EXTERNAL_EFFECT_TOOLS = new Set(['push_git_branch', 'create_pull_request']);
const RUNTIME_CONTROL_TOOLS = new Set(['restart_devflow', 'cancel_tool_job', 'create_tool_job']);
const READ_ONLY_REPO_TOOLS = new Set(['execute_repo_query_plan']);

function inferRisk(name: string): McpToolRisk {
  if (EXTERNAL_EFFECT_TOOLS.has(name)) return 'external-effect';
  if (READ_ONLY_REPO_TOOLS.has(name)) return 'read';
  if (DESTRUCTIVE_TOOLS.has(name)) return 'destructive';
  if (RUNTIME_CONTROL_TOOLS.has(name)) return 'runtime-control';
  if (/^(create|update|write|apply|expand|move|toggle|batch_|assign|delete|import|sync|submit|complete|retry|cancel|prepare|integrate|cleanup|ensure|commit|attach|push|restart)/.test(name)) return 'write';
  return 'read';
}

function intentFor(name: string) {
  if (/task|bug|agent/.test(name)) return 'task-workflow';
  if (/repo|local_file|local_path|search_local|edit|patch/.test(name)) return 'repo-work';
  if (/git|pull_request/.test(name)) return 'git-workflow';
  if (/workspace/.test(name)) return 'workspace-integration';
  if (/figma/.test(name)) return 'figma-context';
  if (/skill|prompt/.test(name)) return 'guidance';
  if (/atlas/.test(name)) return 'project-atlas';
  if (/tool_job|tool_call|health|restart|capabil|schema|test_report/.test(name)) return 'runtime-diagnostics';
  if (/jira/.test(name)) return 'jira-authoring';
  if (/project/.test(name)) return 'project-management';
  if (/run_project_command/.test(name)) return 'verification';
  return 'agent-workflow';
}

function classifyCanonical(name: string): CanonicalDecision {
  const risk = inferRisk(name);
  const intent = intentFor(name);

  if (INTERNAL_TARGETS[name]) {
    return {
      classification: 'internal-mechanic',
      disposition: 'combine',
      intent,
      risk,
      target: INTERNAL_TARGETS[name],
      rationale: `This is an implementation strategy or narrow retrieval variant that DevFlow can select behind the higher-level ${INTERNAL_TARGETS[name]} intent.`,
    };
  }

  if (COMBINE_TARGETS[name]) {
    return {
      classification: 'first-class-intent',
      disposition: 'combine',
      intent,
      risk,
      target: COMBINE_TARGETS[name],
      rationale: `The operation shares intent and compatible safety semantics with other variants and should converge on ${COMBINE_TARGETS[name]} with one/many inputs where appropriate.`,
    };
  }

  if (DIAGNOSTIC_ADVANCED.has(name)) {
    return {
      classification: 'diagnostic-advanced',
      disposition: KEEP_DIAGNOSTICS.has(name) ? 'keep' : 'hide-default',
      intent,
      risk,
      rationale: KEEP_DIAGNOSTICS.has(name)
        ? 'This compact diagnostic is useful in normal workflows and has a distinct read-only intent.'
        : 'Useful for troubleshooting or discovery, but normal agent workflows should not pay its selection/schema cost by default.',
    };
  }

  if (ADMIN_ADVANCED.has(name)) {
    return {
      classification: 'diagnostic-advanced',
      disposition: 'hide-default',
      intent,
      risk,
      rationale: 'Advanced recovery or configuration operation; preserve capability but expose it only when the workflow explicitly enters this mode.',
    };
  }

  return {
    classification: 'first-class-intent',
    disposition: 'keep',
    intent,
    risk,
    rationale: 'Distinct agent-facing intent or safety boundary; keep first-class unless workflow evaluation demonstrates a safe higher-level replacement.',
  };
}

export function buildMcpToolSurfaceInventory(definitions: DevFlowToolDefinition[]): McpToolSurfaceInventoryItem[] {
  const inventory: McpToolSurfaceInventoryItem[] = [];
  for (const tool of definitions) {
    inventory.push({
      name: tool.name,
      canonicalName: tool.name,
      alias: false,
      ...classifyCanonical(tool.name),
    });
    for (const alias of tool.aliases || []) {
      inventory.push({
        name: alias,
        canonicalName: tool.name,
        alias: true,
        classification: 'alias-duplicate',
        disposition: 'hide-default',
        intent: intentFor(tool.name),
        risk: inferRisk(tool.name),
        target: tool.name,
        rationale: `Alias of ${tool.name}; preserve lookup compatibility but do not expose both names in the default MCP surface.`,
      });
    }
  }
  return inventory;
}

export function summarizeMcpToolSurfaceInventory(inventory: McpToolSurfaceInventoryItem[]) {
  const byClassification: Record<McpToolSurfaceClassification, number> = {
    'first-class-intent': 0,
    'alias-duplicate': 0,
    'diagnostic-advanced': 0,
    'internal-mechanic': 0,
  };
  const byDisposition: Record<McpToolSurfaceDisposition, number> = {
    keep: 0,
    combine: 0,
    'hide-default': 0,
  };
  const byRisk: Record<McpToolRisk, number> = {
    read: 0,
    write: 0,
    destructive: 0,
    'external-effect': 0,
    'runtime-control': 0,
  };
  for (const item of inventory) {
    byClassification[item.classification] += 1;
    byDisposition[item.disposition] += 1;
    byRisk[item.risk] += 1;
  }
  return { total: inventory.length, byClassification, byDisposition, byRisk };
}
