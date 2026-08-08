import { VALID_AGENTS, VALID_BUG_STATUSES, VALID_MODELS, VALID_STATUSES } from '../constants';
import {
  booleanFlagSchema,
  bugThreadMutationProperties,
  encodePathSegment,
  manualMoveOverrideProperties,
  mutationControlProperties,
  mutationResponseModeProperty,
  projectIdentifierProperties,
  stripToolOnlyArgs,
  taskIdentifierProperty,
  taskMutationProperties,
  withQuery,
  type DevFlowToolDefinition,
} from './devflowContractCore';

export const taskToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'list_tasks',
    description: 'List tasks with optional filters. Local-first and ChatGPT-friendly: defaults to a small minimal page; pass projectId/status/q and an explicit limit before asking for broader context.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        parentId: { type: 'string', description: 'Parent task identifier.' },
        status: { type: 'string', enum: VALID_STATUSES, description: 'Task status filter.' },
        q: { type: 'string', description: 'Search query.' },
        limit: { type: 'number', description: 'Max tasks returned.' },
        offset: { type: 'number', description: 'Offset for pagination.' },
        mode: { type: 'string', enum: ['minimal', 'summary', 'standard', 'full', 'debug'], description: 'Response density.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/tasks', { ...args, mode: args.mode || 'minimal', limit: args.limit || 50 }) }),
  },
  {
    name: 'search_tasks',
    description: 'Search local DevFlow tasks without fetching the full board. Prefer this over list_tasks when the user gives any title, id, status, keyword, or repository hint.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        q: { type: 'string', description: 'Search query.' },
        status: { type: 'string', enum: VALID_STATUSES, description: 'Task status filter.' },
        limit: { type: 'number', description: 'Max tasks returned.' },
        mode: { type: 'string', enum: ['minimal', 'summary', 'standard'], description: 'Response density.' },
      },
      required: ['q'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/tasks', { ...args, mode: args.mode || 'summary' }) }),
  },
  {
    name: 'get_task',
    description: 'Read a single local DevFlow task by internal id or displayId. Prefer get_agent_task_context for agent work, and use this before remote GitHub reads when the user did not explicitly ask for GitHub.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, mode: { type: 'string', enum: ['minimal', 'summary', 'standard', 'full', 'agent-context', 'debug'], description: 'Response density.' } }, required: ['taskId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery(`/api/tasks/${encodePathSegment(String(args.taskId))}`, { mode: args.mode || 'standard' }) }),
  },
  {
    name: 'get_task_images',
    description: 'Get design images attached to a task without fetching the full task.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty }, required: ['taskId'] },
    outputSchema: { type: 'object' }, lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: `/api/tasks/${encodePathSegment(String(args.taskId))}/images` }),
  },
  {
    name: 'get_agent_task_context', aliases: ['get_agent_context'],
    description: 'Get the token-efficient local agent task context package. Prefer this first for ChatGPT/Codex work on a DevFlow card unless the user explicitly asks to inspect GitHub, Jira, or another remote source.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, includeLogs: { type: 'boolean' }, mode: { type: 'string', enum: ['agent-context', 'full', 'debug'] } }, required: ['taskId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery(`/api/tasks/${encodePathSegment(String(args.taskId))}/agent-context`, { includeLogs: args.includeLogs, mode: args.mode }) }),
  },
  {
    name: 'get_task_prompt', description: 'Render the task prompt that DevFlow would give to an agent.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, includeLogs: { type: 'boolean' }, mode: { type: 'string', enum: ['standard', 'full', 'debug'] } }, required: ['taskId'] },
    outputSchema: { type: 'object', properties: { content: { type: 'string' } } },
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery(`/api/tasks/${encodePathSegment(String(args.taskId))}/prompt-json`, { includeLogs: args.includeLogs, mode: args.mode }) }),
  },
  {
    name: 'open_task_bug', aliases: ['create_bug_thread', 'add_task_bug'],
    description: 'Open an embedded bug thread under an existing task. Use this for review/user defect feedback on existing work instead of creating a new top-level task.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, ...bugThreadMutationProperties, ...booleanFlagSchema.properties, ...mutationResponseModeProperty }, required: ['taskId', 'title'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, responseMode, isAgentRequest, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/bugs`, { responseMode: responseMode || 'summary' }), body, headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'update_task_bug_status', description: 'Update the status of an embedded bug thread after a fix or verification result.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, bugId: { type: 'string', description: 'Embedded bug thread id.' }, status: { type: 'string', enum: VALID_BUG_STATUSES, description: 'New bug thread status.' }, ...booleanFlagSchema.properties, ...mutationResponseModeProperty }, required: ['taskId', 'bugId', 'status'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, bugId, status, responseMode, isAgentRequest, emergency }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/bugs/${encodePathSegment(String(bugId))}/status`, { responseMode: responseMode || 'summary' }), body: emergency === undefined ? { status } : { status, emergency }, headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'create_task', description: 'Create a task. For implementation-ready cards, run validate_task_quality first and include focused targetFiles plus an Implementation map in repoContext.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, ...taskMutationProperties, ...mutationControlProperties, ...mutationResponseModeProperty }, required: ['title', 'category'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: withQuery('/api/tasks', { responseMode: args.responseMode || 'summary' }), body: stripToolOnlyArgs(args, ['responseMode']) }),
  },
  {
    name: 'update_task', description: 'Update a task by internal id or displayId. For implementation-ready card updates, run validate_task_quality first and keep targetFiles aligned with the Implementation map.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, ...taskMutationProperties, ...projectIdentifierProperties, ...booleanFlagSchema.properties, ...mutationControlProperties, ...mutationResponseModeProperty }, required: ['taskId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, responseMode, ...body }) => ({ method: 'PUT', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}`, { responseMode: responseMode || 'summary' }), body, headers: body.isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'batch_upsert_tasks', description: 'Create or update multiple tasks in one round trip.',
    inputSchema: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object' } } }, required: ['tasks'] }, outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks/batch', body: args.tasks ?? args }),
  },
  {
    name: 'import_tasks_from_file', description: 'Import task patches from a JSON file (devflow.taskPatch.v1 format). Supports dry-run and apply modes.',
    inputSchema: { type: 'object', properties: { fileUrl: { type: 'string', description: 'URL to a JSON patch file. Starts with http:// or https://.' }, patchFilePath: { type: 'string', description: 'Local patch file path inside the DevFlow project root.' }, mode: { type: 'string', enum: ['dry-run', 'apply'], description: 'dry-run validates and returns planned operations without writing. apply validates and writes.' }, maxTasks: { type: 'number', description: 'Max tasks to process (default 50).' }, strategy: { type: 'string', enum: ['patch', 'replace'], description: 'patch updates only supplied fields. replace overwrites supplied fields but preserves unrelated ones.' }, ...projectIdentifierProperties } },
    outputSchema: { type: 'object' }, buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks/import-file', body: args }),
  },
  {
    name: 'sync_task_with_git', description: 'Collect live branch/commit/remote synchronization evidence for a task and attach structured verification results to the task record.',
    inputSchema: {
      type: 'object', properties: {
        ...taskIdentifierProperty,
        remote: { type: 'string', description: 'Git remote name. Defaults to origin.' }, fetch: { type: 'boolean', description: 'Fetch the remote before collecting synchronization evidence. Defaults to true.' }, forceFresh: { type: 'boolean', description: 'Bypass reusable fresh remote evidence and force a new remote fetch.' },
        checks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed', 'not-run'] }, summary: { type: 'string' }, output: { type: 'string' }, recordedAt: { type: 'string' } }, required: ['command', 'status'] } },
        ...booleanFlagSchema.properties, ...mutationResponseModeProperty,
      }, required: ['taskId'],
    }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/sync-git`, { responseMode: responseMode || 'summary' }), body, headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'submit_task_for_review', description: 'Submit a task for review only after configured checklist, verification, branch, clean-tree, and published-head gates pass. Returns structured blocker reasons without changing status when blocked.',
    inputSchema: {
      type: 'object', properties: {
        ...taskIdentifierProperty,
        remote: { type: 'string', description: 'Git remote name. Defaults to origin.' }, fetch: { type: 'boolean', description: 'Fetch the remote before evaluating review readiness. Defaults to true.' }, forceFresh: { type: 'boolean', description: 'Bypass reusable fresh remote evidence and force a new remote fetch.' },
        checks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed', 'not-run'] }, summary: { type: 'string' }, output: { type: 'string' }, recordedAt: { type: 'string' } }, required: ['command', 'status'] } },
        requireCleanTree: { type: 'boolean' }, requirePushedHead: { type: 'boolean' }, requireBranchMatch: { type: 'boolean' }, requireChecklistComplete: { type: 'boolean' }, requireVerificationEvidence: { type: 'boolean' },
        ...booleanFlagSchema.properties, ...mutationResponseModeProperty,
      }, required: ['taskId'],
    }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/submit-review`, { responseMode: responseMode || 'summary' }), body, headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'move_task_status', description: 'Move a task to a new lane/status. Strict by default; use manualOverride only after a confirmation-required response for soft workflow gates.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, status: { type: 'string', enum: VALID_STATUSES }, ...booleanFlagSchema.properties, ...manualMoveOverrideProperties, ...mutationResponseModeProperty }, required: ['taskId', 'status'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/move`, { responseMode: responseMode || 'summary' }), body: body.manualOverride ? { ...body, intent: 'manual' } : body, headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'move_task_to_status', description: 'Move a task to a target status by following the allowed transition path automatically. Strict by default; explicit manualOverride may bypass only soft workflow gates.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, status: { type: 'string', enum: VALID_STATUSES }, ...booleanFlagSchema.properties, ...manualMoveOverrideProperties, ...mutationResponseModeProperty }, required: ['taskId', 'status'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/move-to`, { responseMode: responseMode || 'summary' }), body: body.manualOverride ? { ...body, intent: 'manual' } : body, headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'complete_task_review', description: 'Complete a reviewed task by moving it to done through the existing transition helper. Use after verification and self-review.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, ...booleanFlagSchema.properties, ...mutationResponseModeProperty }, required: ['taskId'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/move-to`, { responseMode: responseMode || 'summary' }), body: { ...body, status: 'done' }, headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'batch_move_task_status', description: 'Move multiple tasks in one round trip.',
    inputSchema: { type: 'object', properties: { moves: { type: 'array', items: { type: 'object', properties: { ...taskIdentifierProperty, status: { type: 'string', enum: VALID_STATUSES }, ...booleanFlagSchema.properties }, required: ['taskId', 'status'] } } }, required: ['moves'] }, outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks/batch/move', body: args }),
  },
  {
    name: 'toggle_task_checklist', description: 'Toggle one checklist item on a task.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, checklistId: { type: 'string', description: 'Checklist item id or text.' }, ...booleanFlagSchema.properties, ...mutationResponseModeProperty }, required: ['taskId', 'checklistId'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/checklist/toggle`, { responseMode: responseMode || 'summary' }), body, headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'batch_toggle_task_checklist', description: 'Toggle checklist items for multiple tasks.',
    inputSchema: { type: 'object', properties: { toggles: { type: 'array', items: { type: 'object', properties: { ...taskIdentifierProperty, checklistId: { type: 'string' }, ...booleanFlagSchema.properties }, required: ['taskId', 'checklistId'] } } }, required: ['toggles'] }, outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks/batch/checklist/toggle', body: args }),
  },
  {
    name: 'assign_agent', description: 'Assign or update agent/model/effort for a task.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, agent: { type: 'string', enum: VALID_AGENTS }, model: { type: 'string', enum: VALID_MODELS }, effort: { type: 'string', description: 'Reasoning effort level. Valid values strictly depend on the selected agent/model pair.' }, ...booleanFlagSchema.properties, ...mutationResponseModeProperty }, required: ['taskId'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/assign`, { responseMode: responseMode || 'summary' }), body, headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'batch_assign_agent', description: 'Assign agent configuration for multiple tasks.',
    inputSchema: { type: 'object', properties: { assignments: { type: 'array', items: { type: 'object', properties: { ...taskIdentifierProperty, agent: { type: 'string', enum: VALID_AGENTS }, model: { type: 'string', enum: VALID_MODELS }, effort: { type: 'string', description: 'Reasoning effort level. Valid values strictly depend on the selected agent/model pair.' }, ...booleanFlagSchema.properties }, required: ['taskId'] } } }, required: ['assignments'] }, outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks/batch/assign', body: args }),
  },
  {
    name: 'delete_task', description: 'Delete a task by internal id or displayId.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, ...booleanFlagSchema.properties }, required: ['taskId'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, emergency }) => ({ method: 'DELETE', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}`, { emergency }), headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'list_agent_runs', description: 'List agent runs for a task.', inputSchema: { type: 'object', properties: taskIdentifierProperty, required: ['taskId'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId }) => ({ method: 'GET', path: `/api/tasks/${encodePathSegment(String(taskId))}/agent-runs` }),
  },
  {
    name: 'retry_agent_run', description: 'Retry the latest failed agent run for a task.', inputSchema: { type: 'object', properties: taskIdentifierProperty, required: ['taskId'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId }) => ({ method: 'POST', path: `/api/tasks/${encodePathSegment(String(taskId))}/agent-runs/retry`, body: {} }),
  },
  {
    name: 'cancel_agent_run', description: 'Cancel active agent runs for a task.', inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, reason: { type: 'string', description: 'Optional cancellation reason.' } }, required: ['taskId'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, ...body }) => ({ method: 'POST', path: `/api/tasks/${encodePathSegment(String(taskId))}/agent-runs/cancel`, body }),
  },
  {
    name: 'complete_agent_run', aliases: ['agent_complete_task'], description: 'Official completion callback for external agents/workers to close or report an agent run.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, runId: { type: 'string', description: 'Optional explicit run id. Defaults to the active run.' }, status: { type: 'string', enum: ['success', 'failed', 'cancelled'], description: 'Completion outcome.' }, summary: { type: 'string', description: 'Human-readable summary of the result.' }, changedFiles: { type: 'array', items: { type: 'string' }, description: 'Changed files reported by the agent.' }, tests: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string', enum: ['passed', 'failed', 'not-run'] }, output: { type: 'string' } }, required: ['command', 'result'] } }, notes: { type: 'string', description: 'Optional extra notes.' }, moveTo: { type: 'string', enum: ['backlog', 'todo', 'in-progress', 'ready-for-review'], description: 'Optional non-done target status.' } }, required: ['taskId', 'status', 'summary'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, ...body }) => ({ method: 'POST', path: `/api/tasks/${encodePathSegment(String(taskId))}/agent-complete`, body, headers: { 'x-agent-request': 'true' } }),
  },
];
