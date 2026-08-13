import { VALID_BUG_STATUSES, VALID_STATUSES } from '../constants';
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
    description: 'Search or list local DevFlow tasks with optional query, parent, status, paging, and response-density filters. This is the single task-collection read intent for ChatGPT. Every response-density mode defaults to a bounded page of 50 items; set all=true only when the caller explicitly needs the entire matching collection.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        q: { type: 'string', description: 'Optional search query. Omit to list by the supplied filters.' },
        parentId: { type: 'string', description: 'Optional parent task identifier.' },
        status: { type: 'string', enum: VALID_STATUSES, description: 'Task status filter.' },
        limit: { type: 'number', description: 'Max tasks returned. Defaults to 50 for search_tasks reads unless all=true is explicitly requested.' },
        offset: { type: 'number', description: 'Offset for pagination.' },
        all: { type: 'boolean', description: 'Explicitly return the entire matching task collection when no limit is supplied. Use only when an all-task read is actually required.' },
        mode: { type: 'string', enum: ['minimal', 'summary', 'standard', 'full', 'debug'], description: 'Response density.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => {
      const mode = args.mode || 'summary';
      const defaultLimit = args.all === true ? undefined : 50;
      return { method: 'GET', path: withQuery('/api/tasks', { ...args, mode, limit: args.limit ?? defaultLimit }) };
    },
  },
  {
    name: 'get_task',
    description: 'Read a single local DevFlow task by internal id or displayId. Use mode="agent-context" for the compact implementation context package, and prefer this before remote GitHub reads when the user did not explicitly ask for GitHub.',
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
    name: 'create_task',
    description: 'Create one task or an atomic parent/children task set. Server-side mutation validation is authoritative; provide implementation-ready fields directly instead of using a separate preflight tool.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        ...taskMutationProperties,
        parent: { type: 'object', properties: { ...projectIdentifierProperties, ...taskMutationProperties }, required: ['title', 'category'], description: 'Parent card for atomic task-set authoring.' },
        children: { type: 'array', minItems: 1, maxItems: 25, items: { type: 'object', properties: { ...projectIdentifierProperties, ...taskMutationProperties }, required: ['title', 'category'] }, description: 'Child cards created atomically under parent.' },
        ...mutationControlProperties,
        ...mutationResponseModeProperty,
      },
      anyOf: [{ required: ['title', 'category'] }, { required: ['parent', 'children'] }],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => {
      const taskSet = args.parent && Array.isArray(args.children);
      return {
        method: 'POST',
        path: withQuery(taskSet ? '/api/tasks/task-set' : '/api/tasks', { responseMode: args.responseMode || 'summary' }),
        body: stripToolOnlyArgs(args, ['responseMode']),
      };
    },
  },
  {
    name: 'update_task', description: 'Update a task by internal id or displayId. Server-side mutation validation is authoritative; keep targetFiles aligned with the Implementation map and provide implementation-ready fields directly.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, ...taskMutationProperties, ...projectIdentifierProperties, ...booleanFlagSchema.properties, ...mutationControlProperties, ...mutationResponseModeProperty }, required: ['taskId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, responseMode, ...body }) => ({ method: 'PUT', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}`, { responseMode: responseMode || 'summary' }), body, headers: body.isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
  {
    name: 'claim_next_task',
    description: 'Atomically select and claim the next deterministic eligible leaf task for one board-loop worker. Selection is bounded and conservative; use search_tasks + claim_task as the fallback for explicit or ambiguous work.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project internal id used for bounded next-task selection.' },
        sessionId: { type: 'string', description: 'Opaque caller chat/session id. The raw value is never persisted on the task.' },
        ownerKind: { type: 'string', enum: ['chat', 'codex', 'claude', 'antigravity', 'agent'], description: 'Optional short owner kind for UI display.' },
        ownerLabel: { type: 'string', description: 'Optional compact owner label such as Chat A3 or Codex C7.' },
        limit: { type: 'number', description: 'Maximum runnable tasks to inspect. Defaults to 50 and is capped at 100.' },
        ...mutationResponseModeProperty,
      },
      required: ['projectId', 'sessionId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ responseMode, ...body }) => ({ method: 'POST', path: withQuery('/api/tasks/claim-next', { responseMode: responseMode || 'summary' }), body }),
  },
  {
    name: 'claim_task',
    description: 'Atomically claim one eligible task for this caller session. Successful claims move the task to in-progress, bind a managed workspace, and reject duplicate or overlapping active work.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        sessionId: { type: 'string', description: 'Opaque caller chat/session id. The raw value is never persisted on the task.' },
        ownerKind: { type: 'string', enum: ['chat', 'codex', 'claude', 'antigravity', 'agent'], description: 'Optional short owner kind for UI display.' },
        ownerLabel: { type: 'string', description: 'Optional compact owner label such as Chat A3 or Codex C7.' },
        allowScopeConflict: { type: 'boolean', description: 'Explicitly allow a target-file overlap with another active claim. Defaults to false.' },
        ...mutationResponseModeProperty,
      },
      required: ['taskId', 'sessionId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, responseMode, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/claim`, { responseMode: responseMode || 'summary' }), body }),
  },
  {
    name: 'expand_task_scope',
    description: 'Explicitly extend the active claimed file scope for one task after runtime dependency discovery. The caller must own the active claim; new paths are normalized, persisted on the claim, and rejected on overlap with other active claimed scopes.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        sessionId: { type: 'string', description: 'Opaque caller session id that owns the active task claim.' },
        paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 500 }, description: 'Repository-relative paths to reserve in addition to the task targetFiles.' },
        ...mutationResponseModeProperty,
      },
      required: ['taskId', 'sessionId', 'paths'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, responseMode, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/claim/scope`, { responseMode: responseMode || 'summary' }), body }),
  },
  {
    name: 'release_task_claim',
    description: 'Release a task claim owned by this caller session and return the task to backlog or todo. Use emergency only for explicit recovery.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        sessionId: { type: 'string', description: 'Opaque caller chat/session id that owns the claim.' },
        nextStatus: { type: 'string', enum: ['backlog', 'todo'], description: 'Lane after release. Defaults to backlog.' },
        emergency: { type: 'boolean', description: 'Explicit recovery override for a claim owned by another session.' },
        ...mutationResponseModeProperty,
      },
      required: ['taskId', 'sessionId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, responseMode, ...body }) => ({ method: 'POST', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/claim/release`, { responseMode: responseMode || 'summary' }), body }),
  },
  {
    name: 'batch_upsert_tasks', description: 'Create or update multiple independent tasks in one round trip. For an atomic parent/children authoring set, prefer create_task with parent and children.',
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
        workspaceId: { type: 'string', description: 'Opaque managed workspace id. Use this when the task was implemented in an isolated DevFlow worktree so Git evidence is collected from that exact workspace.' },
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
        workspaceId: { type: 'string', description: 'Opaque managed workspace id. Use this when review evidence must be collected from an isolated DevFlow worktree.' },
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
    name: 'delete_task', description: 'Delete a task by internal id or displayId.',
    inputSchema: { type: 'object', properties: { ...taskIdentifierProperty, ...booleanFlagSchema.properties }, required: ['taskId'] }, outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, emergency }) => ({ method: 'DELETE', path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}`, { emergency }), headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined }),
  },
];
