import { VALID_AGENTS, LEGACY_VALID_EFFORTS_FALLBACK, VALID_MODELS, VALID_STATUSES, VALID_TASK_CATEGORIES } from '../constants';

type JsonSchema = Record<string, any>;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface DevFlowToolHttpRequest {
  method: HttpMethod;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
}

export interface DevFlowToolDefinition {
  name: string;
  aliases?: string[];
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  lightweight?: boolean;
  executionPolicy?: {
    mode: 'direct' | 'job';
    jobKind?: 'repo-command' | 'repo-write' | 'repo-read' | 'skill-read';
  };
  buildHttpRequest: (args: Record<string, any>) => DevFlowToolHttpRequest;
}

const emptyObjectSchema = { type: 'object', properties: {} };

const booleanFlagSchema = {
  type: 'object',
  properties: {
    isAgentRequest: { type: 'boolean', description: 'Marks this as an agent-owned mutation that may bypass normal task locks.' },
    emergency: { type: 'boolean', description: 'Override task lock protections for emergency/manual recovery operations.' },
  },
};

const mutationResponseModeProperty = {
  responseMode: { type: 'string', enum: ['standard', 'summary', 'ack'], description: 'Mutation response density. Use summary or ack for faster ChatGPT tool calls.' },
};

const mutationControlProperties = {
  idempotencyKey: { type: 'string', description: 'Stable client-provided key for safe retries. Reusing the key with a different request returns IDEMPOTENCY_CONFLICT.' },
};

const taskIdentifierProperty = {
  taskId: { type: 'string', description: 'Task internal id or displayId such as DVF-0120.' },
};

const projectIdentifierProperties = {
  projectId: { type: 'string', description: 'Project internal id.' },
  projectName: { type: 'string', description: 'Project name when it is unique and safe to resolve.' },
  repo: { type: 'string', description: 'Repository URL or shorthand.' },
  repoUrl: { type: 'string', description: 'Repository URL.' },
  localPath: { type: 'string', description: 'Absolute local project path.' },
};

const taskMutationProperties = {
  title: { type: 'string', description: 'Task title.' },
  description: { type: 'string', description: 'Task description in markdown.' },
  status: { type: 'string', enum: VALID_STATUSES, description: 'Task lane/status.' },
  priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority.' },
  branch: { type: 'string', description: 'Git branch name.' },
  category: {
    type: 'string',
    enum: VALID_TASK_CATEGORIES,
    description: 'Primary task type classification. Required for new tasks.',
  },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional free-form labels. Do not repeat the primary task type here.',
  },
  targetFiles: { type: 'array', items: { type: 'string' }, description: 'Relevant file paths.' },
  checklist: {
    type: 'array',
    description: 'Checklist items.',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        completed: { type: 'boolean' },
      },
      required: ['id', 'text', 'completed'],
    },
  },
  effort: { type: 'string', description: 'Reasoning effort level. Valid values strictly depend on the selected agent/model pair (e.g. Codex + GPT-5.4 supports low, medium, high, xhigh. Antigravity + Gemini 3.5 Flash supports low, medium, high. Claude 4.8 Opus supports low, medium, high, xhigh, max).' },
  model: { type: 'string', enum: VALID_MODELS, description: 'Assigned model.' },
  agent: { type: 'string', enum: VALID_AGENTS, description: 'Assigned agent.' },
  parentId: { type: 'string', description: 'Parent task id.' },
  reasoning: { type: 'string', description: 'Reasoning/context.' },
  acceptanceCriteria: { type: 'string', description: 'Acceptance criteria.' },
  verification: { type: 'string', description: 'Verification steps.' },
  repoContext: { type: 'string', description: 'Repository context.' },
  specUrl: { type: 'string', description: 'Specification URL.' },
  images: {
    type: 'array',
    description: 'Attached images with local file paths.',
    items: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        absolutePath: { type: 'string', description: 'Use view_file on this path to see the image natively.' },
        url: { type: 'string' }
      }
    }
  },
  designImages: { type: 'array', items: { type: 'string' }, description: 'Legacy design image URLs or data.' },
  jiraKey: { type: 'string', description: 'Jira issue key.' },
  sourceUrl: { type: 'string', description: 'Source URL.' },
};

function withQuery(path: string, query?: Record<string, string | number | boolean | undefined | null>) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value);
}

function stripToolOnlyArgs(args: Record<string, any>, keys: string[]) {
  const copy = { ...args };
  for (const key of keys) delete copy[key];
  return copy;
}

export const DEVFLOW_CONTRACT_VERSION = '2026-06-24.2';

export const devFlowToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'get_capabilities',
    aliases: [],
    description: 'Get the compact DevFlow capability catalog, schema version, enabled modules, and MCP tool surface in one call.',
    inputSchema: emptyObjectSchema,
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: () => ({ method: 'GET', path: '/api/capabilities' }),
  },
  {
    name: 'get_tool_call_summary',
    description: 'Summarize recent DevFlow MCP tool calls, including top tools, duplicate bursts, latest calls, and recommendations for reducing redundant calls.',
    inputSchema: {
      type: 'object',
      properties: {
        windowMs: { type: 'number', description: 'Recent time window to summarize in milliseconds. Default is 10 minutes.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/tool-monitor/summary', { windowMs: args.windowMs }),
    }),
  },
  {
    name: 'devflow_health_check',
    description: 'Run a compact read-only DevFlow workflow health check: git cleanliness, tool capability counts, queue diagnostics, and recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        windowMs: { type: 'number', description: 'Recent telemetry window in milliseconds. Default is 10 minutes.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/workflow-health', args),
    }),
  },
  {
    name: 'validate_task_quality',
    description: 'Preflight a DevFlow task/card for authoring quality before create_task or update_task. Flags implementation-ready cards that still depend on Jira, lack focused targetFiles, or lack an Implementation map.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskMutationProperties,
        ...projectIdentifierProperties,
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/task-quality/validate',
      body: args,
    }),
  },
  {
    name: 'get_repo_inspection_index',
    description: 'Get a cached, lightweight repository index for targeted card authoring. Returns likely files and symbols/classes/functions matching a query without reading the whole repo.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        q: { type: 'string', description: 'Screen, string, Jira term, class, function, or flow query.' },
        query: { type: 'string', description: 'Alias for q.' },
        path: { type: 'string', description: 'Optional relative subdirectory to index.' },
        limit: { type: 'number', description: 'Maximum matched entries returned.' },
        includeIgnored: { type: 'boolean', description: 'Opt in to indexing normally skipped dot, heavy, and generated folders. Defaults to false; safe project file rules stay merged with built-in defaults.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/repo-inspection-index', args),
    }),
  },
  {
    name: 'get_jira_authoring_bundle',
    description: 'Fetch one compact Jira issue packet for DevFlow card authoring: issue summary/description, comments, attachment metadata, related issue keys, existing local DevFlow duplicates, and next-step hints. Prefer this before calling multiple jira_get_* proxy tools.',
    inputSchema: {
      type: 'object',
      properties: {
        jiraKey: { type: 'string', description: 'Jira issue key, e.g. QCA-3435.' },
        issueKey: { type: 'string', description: 'Alias for jiraKey.' },
        key: { type: 'string', description: 'Alias for jiraKey.' },
      },
      required: ['jiraKey'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/jira/authoring-bundle', {
        jiraKey: args.jiraKey || args.issueKey || args.key,
      }),
    }),
  },
  {
    name: 'draft_task_from_jira',
    aliases: ['draft_implementation_card_from_jira'],
    description: 'DevFlow Gateway composite tool: fetch Jira context, gather targeted repo hints when project context is provided, and return a create_task-compatible draft payload without requiring separate Dev Jira or Dev Github connectors.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        jiraKey: { type: 'string', description: 'Jira issue key, e.g. QCA-3435.' },
        issueKey: { type: 'string', description: 'Alias for jiraKey.' },
        key: { type: 'string', description: 'Alias for jiraKey.' },
        budgetMs: { type: 'number', description: 'Maximum composite authoring time in milliseconds. Default is 60000.' },
        limit: { type: 'number', description: 'Maximum repo hint entries returned.' },
        idempotencyKey: { type: 'string', description: 'Stable client-provided key for safe retries.' },
      },
      anyOf: [
        { required: ['jiraKey'] },
        { required: ['issueKey'] },
        { required: ['key'] },
      ],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/tasks/draft-from-jira',
      body: {
        ...args,
        jiraKey: args.jiraKey || args.issueKey || args.key,
      },
    }),
  },
  {
    name: 'get_schema',
    description: 'Get the DevFlow task JSON schema.',
    inputSchema: emptyObjectSchema,
    outputSchema: { type: 'object' },
    buildHttpRequest: () => ({ method: 'GET', path: '/api/schema/task' }),
  },
  {
    name: 'list_projects',
    description: 'List projects.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['summary', 'standard'], description: 'Project response density.' },
        q: { type: 'string', description: 'Optional project search string.' },
      },
    },
    outputSchema: { type: 'object', properties: { projects: { type: 'array', items: { type: 'object' } } } },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/projects', { mode: args.mode, q: args.q }),
    }),
  },
  {
    name: 'create_project',
    description: 'Create a project.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        repoUrl: { type: 'string' },
        description: { type: 'string' },
        localPath: { type: 'string' },
        taskIdPrefix: { type: 'string' },
      },
      required: ['name', 'repoUrl'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/projects', body: args }),
  },
  {
    name: 'delete_project',
    description: 'Delete a project and its tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
      },
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'DELETE',
      path: withQuery('/api/projects', {
        projectId: args.projectId || args.id,
        projectName: args.projectName,
        repo: args.repo,
        repoUrl: args.repoUrl,
        localPath: args.localPath,
      }),
    }),
  },
  {
    name: 'get_project_start_context',
    description: 'Get compact startup context for one project in a single call: project metadata, git branch/status when available, top-level files, common hint files, and recommended next tools.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        limit: { type: 'number', description: 'Maximum top-level file entries returned.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/project-start-context', args),
    }),
  },
  {
    name: 'get_repo_context_bundle',
    description: 'Get compact repo context in one call: project metadata, git status, repo index matches, focused file snippets, and optional diff.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        q: { type: 'string', description: 'Search query for repo index matches.' },
        query: { type: 'string', description: 'Alias for q.' },
        path: { type: 'string', description: 'Optional relative directory to index.' },
        limit: { type: 'number', description: 'Maximum repo index matches returned.' },
        snippetLimit: { type: 'number', description: 'Maximum snippets returned from top matches.' },
        snippetLines: { type: 'number', description: 'Maximum leading lines per snippet.' },
        maxSnippetBytes: { type: 'number', description: 'Maximum bytes per snippet.' },
        includeDiff: { type: 'boolean', description: 'Include current git diff summary and capped diff content.' },
        diffPath: { type: 'string', description: 'Optional path to limit diff.' },
        maxDiffBytes: { type: 'number', description: 'Maximum diff bytes returned.' },
        includeIgnored: { type: 'boolean', description: 'Allow index to include ignored/generated folders.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/repo-context-bundle', args),
    }),
  },
  {
    name: 'repo_read_snapshot',
    description: 'Get a compact server-side repo summary without file contents: git status, likely files, metadata, and recommended follow-up reads.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        q: { type: 'string', description: 'Search query for repo index matches.' },
        query: { type: 'string', description: 'Alias for q.' },
        path: { type: 'string', description: 'Optional relative directory to index.' },
        limit: { type: 'number', description: 'Maximum likely files returned.' },
        topLevelLimit: { type: 'number', description: 'Maximum top-level file entries considered in start context.' },
        includeIgnored: { type: 'boolean', description: 'Allow index to include ignored/generated folders.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/repo-read-snapshot', args),
    }),
  },
  {
    name: 'get_project_atlas',
    description: 'Get capped Project Atlas knowledge graph context for a project. Modes include compact, standard, full, chatgpt-context, agent-context, and task-focused.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        mode: { type: 'string', enum: ['compact', 'standard', 'full', 'chatgpt-context', 'agent-context', 'task-focused'], description: 'Atlas response mode. Defaults to compact.' },
        limit: { type: 'number', description: 'Maximum nodes/edges returned. Defaults are capped; max 1000.' },
        query: { type: 'string', description: 'Search query for task-focused mode.' },
        focusPath: { type: 'string', description: 'Path focus for task-focused mode.' },
        taskId: { type: 'string', description: 'Task id/key for task-focused mode.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/project-atlas', args),
    }),
  },
  {
    name: 'get_project_atlas_status',
    description: 'Read Project Atlas freshness and cache status, including stale/generatedAt counts and last error metadata.',
    inputSchema: {
      type: 'object',
      properties: projectIdentifierProperties,
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/project-atlas/status', args),
    }),
  },
  {
    name: 'rescan_project_atlas',
    description: 'Manually rebuild Project Atlas for a project using the deterministic scanner and update the latest cache.',
    inputSchema: {
      type: 'object',
      properties: projectIdentifierProperties,
    },
    outputSchema: { type: 'object' },
    executionPolicy: { mode: 'job', jobKind: 'repo-command' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/project-atlas/rescan',
      body: args,
    }),
  },
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
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/tasks', {
        ...args,
        mode: args.mode || 'minimal',
        limit: args.limit || 50,
      }),
    }),
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
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/tasks', {
        ...args,
        mode: args.mode || 'summary',
      }),
    }),
  },
  {
    name: 'get_task',
    description: 'Read a single local DevFlow task by internal id or displayId. Prefer get_agent_task_context for agent work, and use this before remote GitHub reads when the user did not explicitly ask for GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        mode: { type: 'string', enum: ['minimal', 'summary', 'standard', 'full', 'agent-context', 'debug'], description: 'Response density.' },
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery(`/api/tasks/${encodePathSegment(String(args.taskId))}`, { mode: args.mode || 'standard' }),
    }),
  },
  {
    name: 'get_task_images',
    description: 'Get design images attached to a task without fetching the full task.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: `/api/tasks/${encodePathSegment(String(args.taskId))}/images`,
    }),
  },
  {
    name: 'get_agent_task_context',
    aliases: ['get_agent_context'],
    description: 'Get the token-efficient local agent task context package. Prefer this first for ChatGPT/Codex work on a DevFlow card unless the user explicitly asks to inspect GitHub, Jira, or another remote source.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        includeLogs: { type: 'boolean' },
        mode: { type: 'string', enum: ['agent-context', 'full', 'debug'] },
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery(`/api/tasks/${encodePathSegment(String(args.taskId))}/agent-context`, {
        includeLogs: args.includeLogs,
        mode: args.mode,
      }),
    }),
  },
  {
    name: 'get_task_prompt',
    description: 'Render the task prompt that DevFlow would give to an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        includeLogs: { type: 'boolean' },
        mode: { type: 'string', enum: ['standard', 'full', 'debug'] },
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object', properties: { content: { type: 'string' } } },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery(`/api/tasks/${encodePathSegment(String(args.taskId))}/prompt-json`, {
        includeLogs: args.includeLogs,
        mode: args.mode,
      }),
    }),
  },
  {
    name: 'create_task',
    description: 'Create a task. For implementation-ready cards, run validate_task_quality first and include focused targetFiles plus an Implementation map in repoContext.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        ...taskMutationProperties,
        ...mutationControlProperties,
        ...mutationResponseModeProperty,
      },
      required: ['title', 'category'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: withQuery('/api/tasks', { responseMode: args.responseMode || 'summary' }),
      body: stripToolOnlyArgs(args, ['responseMode']),
    }),
  },
  {
    name: 'update_task',
    description: 'Update a task by internal id or displayId. For implementation-ready card updates, run validate_task_quality first and keep targetFiles aligned with the Implementation map.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        ...taskMutationProperties,
        ...projectIdentifierProperties,
        ...booleanFlagSchema.properties,
        ...mutationControlProperties,
        ...mutationResponseModeProperty,
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, responseMode, ...body }) => ({
      method: 'PUT',
      path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}`, { responseMode: responseMode || 'summary' }),
      body,
      headers: body.isAgentRequest ? { 'x-agent-request': 'true' } : undefined,
    }),
  },
  {
    name: 'batch_upsert_tasks',
    description: 'Create or update multiple tasks in one round trip.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: { type: 'object' } },
      },
      required: ['tasks'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks/batch', body: args.tasks ?? args }),
  },
  {
    name: 'import_tasks_from_file',
    description: 'Import task patches from a JSON file (devflow.taskPatch.v1 format). Supports dry-run and apply modes.',
    inputSchema: {
      type: 'object',
      properties: {
        fileUrl: { type: 'string', description: 'URL to a JSON patch file. Starts with http:// or https://.' },
        patchFilePath: { type: 'string', description: 'Local patch file path inside the DevFlow project root.' },
        mode: { type: 'string', enum: ['dry-run', 'apply'], description: 'dry-run validates and returns planned operations without writing. apply validates and writes.' },
        maxTasks: { type: 'number', description: 'Max tasks to process (default 50).' },
        strategy: { type: 'string', enum: ['patch', 'replace'], description: 'patch updates only supplied fields. replace overwrites supplied fields but preserves unrelated ones.' },
        ...projectIdentifierProperties,
      },
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks/import-file', body: args }),
  },
  {
    name: 'move_task_status',
    description: 'Move a task to a new lane/status.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        status: { type: 'string', enum: VALID_STATUSES },
        ...booleanFlagSchema.properties,
        ...mutationResponseModeProperty,
      },
      required: ['taskId', 'status'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({
      method: 'POST',
      path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/move`, { responseMode: responseMode || 'summary' }),
      body,
      headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined,
    }),
  },
  {
    name: 'move_task_to_status',
    description: 'Move a task to a target status by following the allowed transition path automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        status: { type: 'string', enum: VALID_STATUSES },
        ...booleanFlagSchema.properties,
        ...mutationResponseModeProperty,
      },
      required: ['taskId', 'status'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({
      method: 'POST',
      path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/move-to`, { responseMode: responseMode || 'summary' }),
      body,
      headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined,
    }),
  },
  {
    name: 'complete_task_review',
    description: 'Complete a reviewed task by moving it to done through the existing transition helper. Use after verification and self-review.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        ...booleanFlagSchema.properties,
        ...mutationResponseModeProperty,
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({
      method: 'POST',
      path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/move-to`, { responseMode: responseMode || 'summary' }),
      body: { ...body, status: 'done' },
      headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined,
    }),
  },
  {
    name: 'batch_move_task_status',
    description: 'Move multiple tasks in one round trip.',
    inputSchema: {
      type: 'object',
      properties: {
        moves: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ...taskIdentifierProperty,
              status: { type: 'string', enum: VALID_STATUSES },
              ...booleanFlagSchema.properties,
            },
            required: ['taskId', 'status'],
          },
        },
      },
      required: ['moves'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks/batch/move', body: args }),
  },
  {
    name: 'toggle_task_checklist',
    description: 'Toggle one checklist item on a task.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        checklistId: { type: 'string', description: 'Checklist item id or text.' },
        ...booleanFlagSchema.properties,
        ...mutationResponseModeProperty,
      },
      required: ['taskId', 'checklistId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({
      method: 'POST',
      path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/checklist/toggle`, { responseMode: responseMode || 'summary' }),
      body,
      headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined,
    }),
  },
  {
    name: 'batch_toggle_task_checklist',
    description: 'Toggle checklist items for multiple tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        toggles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ...taskIdentifierProperty,
              checklistId: { type: 'string' },
              ...booleanFlagSchema.properties,
            },
            required: ['taskId', 'checklistId'],
          },
        },
      },
      required: ['toggles'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks/batch/checklist/toggle', body: args }),
  },
  {
    name: 'assign_agent',
    description: 'Assign or update agent/model/effort for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        agent: { type: 'string', enum: VALID_AGENTS },
        model: { type: 'string', enum: VALID_MODELS },
        effort: { type: 'string', description: 'Reasoning effort level. Valid values strictly depend on the selected agent/model pair.' },
        ...booleanFlagSchema.properties,
        ...mutationResponseModeProperty,
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, responseMode, ...body }) => ({
      method: 'POST',
      path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}/assign`, { responseMode: responseMode || 'summary' }),
      body,
      headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined,
    }),
  },
  {
    name: 'batch_assign_agent',
    description: 'Assign agent configuration for multiple tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        assignments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ...taskIdentifierProperty,
              agent: { type: 'string', enum: VALID_AGENTS },
              model: { type: 'string', enum: VALID_MODELS },
              effort: { type: 'string', description: 'Reasoning effort level. Valid values strictly depend on the selected agent/model pair.' },
              ...booleanFlagSchema.properties,
            },
            required: ['taskId'],
          },
        },
      },
      required: ['assignments'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks/batch/assign', body: args }),
  },
  {
    name: 'delete_task',
    description: 'Delete a task by internal id or displayId.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        ...booleanFlagSchema.properties,
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, emergency }) => ({
      method: 'DELETE',
      path: withQuery(`/api/tasks/${encodePathSegment(String(taskId))}`, { emergency }),
      headers: isAgentRequest ? { 'x-agent-request': 'true' } : undefined,
    }),
  },
  {
    name: 'list_agent_runs',
    description: 'List agent runs for a task.',
    inputSchema: {
      type: 'object',
      properties: taskIdentifierProperty,
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId }) => ({
      method: 'GET',
      path: `/api/tasks/${encodePathSegment(String(taskId))}/agent-runs`,
    }),
  },
  {
    name: 'retry_agent_run',
    description: 'Retry the latest failed agent run for a task.',
    inputSchema: {
      type: 'object',
      properties: taskIdentifierProperty,
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId }) => ({
      method: 'POST',
      path: `/api/tasks/${encodePathSegment(String(taskId))}/agent-runs/retry`,
      body: {},
    }),
  },
  {
    name: 'cancel_agent_run',
    description: 'Cancel active agent runs for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        reason: { type: 'string', description: 'Optional cancellation reason.' },
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, ...body }) => ({
      method: 'POST',
      path: `/api/tasks/${encodePathSegment(String(taskId))}/agent-runs/cancel`,
      body,
    }),
  },
  {
    name: 'complete_agent_run',
    aliases: ['agent_complete_task'],
    description: 'Official completion callback for external agents/workers to close or report an agent run.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        runId: { type: 'string', description: 'Optional explicit run id. Defaults to the active run.' },
        status: { type: 'string', enum: ['success', 'failed', 'cancelled'], description: 'Completion outcome.' },
        summary: { type: 'string', description: 'Human-readable summary of the result.' },
        changedFiles: { type: 'array', items: { type: 'string' }, description: 'Changed files reported by the agent.' },
        tests: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              result: { type: 'string', enum: ['passed', 'failed', 'not-run'] },
              output: { type: 'string' },
            },
            required: ['command', 'result'],
          },
        },
        notes: { type: 'string', description: 'Optional extra notes.' },
        moveTo: { type: 'string', enum: ['backlog', 'todo', 'in-progress', 'ready-for-review'], description: 'Optional non-done target status.' },
      },
      required: ['taskId', 'status', 'summary'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, ...body }) => ({
      method: 'POST',
      path: `/api/tasks/${encodePathSegment(String(taskId))}/agent-complete`,
      body,
      headers: { 'x-agent-request': 'true' },
    }),
  },
  {
    name: 'list_skills',
    description: 'List DevFlow skills. Optionally filter by kind: authoring, workflow, prompt, or custom.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['authoring', 'workflow', 'prompt', 'custom'], description: 'Filter skills by category.' },
      },
    },
    outputSchema: { type: 'object', properties: { skills: { type: 'array', items: { type: 'object' } } } },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/skills', { kind: args.kind }),
    }),
  },
  {
    name: 'get_authoring_skills',
    description: 'Get the full content of all authoring skills (lean skills: router, core, schema, reviewer, examples) that define how tasks are structured in DevFlow.',
    inputSchema: emptyObjectSchema,
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: () => ({ method: 'GET', path: '/api/skills/authoring' }),
  },
  {
    name: 'get_skill_router',
    description: 'Read only the DevFlow authoring skill router (00-skill-router). Prefer this first before loading the full authoring skill set.',
    inputSchema: emptyObjectSchema,
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: () => ({ method: 'GET', path: '/api/skills/authoring/00-skill-router' }),
  },
  {
    name: 'get_authoring_skill',
    description: 'Read one DevFlow authoring skill by id, such as 00-skill-router, 01-authoring-core, 02-schema-reference, 03-reviewer-core, or 04-examples.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', enum: ['00-skill-router', '01-authoring-core', '02-schema-reference', '03-reviewer-core', '04-examples'] },
        skillId: { type: 'string', enum: ['00-skill-router', '01-authoring-core', '02-schema-reference', '03-reviewer-core', '04-examples'] },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: `/api/skills/authoring/${encodePathSegment(String(args.id || args.skillId))}`,
    }),
  },
  {
    name: 'get_skill',
    description: 'Read one skill by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        skillId: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: `/api/skills/${encodePathSegment(String(args.id || args.skillId))}`,
    }),
  },
  {
    name: 'update_skill',
    description: 'Update a mutable skill.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        skillId: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['content'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'PUT',
      path: `/api/skills/${encodePathSegment(String(args.id || args.skillId))}`,
      body: { content: args.content },
    }),
  },
  {
    name: 'list_prompt_skills',
    description: 'List effective prompt pipeline sections for a project/workspace. Returns compact metadata only for sections in the active pipeline (no large content fields).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        agent: { type: 'string', description: 'Agent id used to resolve prompt.agent-specific.{agent} entries (default: "default").' },
        pipeline: { type: 'string', description: 'Pipeline id from config/prompt-pipeline.json (default: "default").' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              order: { type: 'number' },
              required: { type: 'boolean' },
              sourceType: { type: 'string', enum: ['master', 'override'] },
              masterAvailable: { type: 'boolean' },
              overrideAvailable: { type: 'boolean' },
              effectiveEmpty: { type: 'boolean' },
              sourcePath: { type: 'string' },
              overridePath: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/prompt-overrides/sections', {
        projectId: args.projectId,
        projectName: args.projectName,
        repo: args.repo,
        repoUrl: args.repoUrl,
        localPath: args.localPath,
        agent: args.agent,
        pipeline: args.pipeline,
      }),
    }),
  },
  {
    name: 'get_prompt_skill',
    description: 'Read one prompt pipeline section by id (e.g. "prompt.header"). Returns master, override, effective content, and source paths.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        sectionId: { type: 'string', description: 'Prompt section id, e.g. "prompt.header" or "prompt.task-context".' },
        agent: { type: 'string', description: 'Agent id used to resolve prompt.agent-specific.{agent} entries.' },
        pipeline: { type: 'string', description: 'Pipeline id (default: "default").' },
      },
      required: ['sectionId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/prompt-overrides/section', {
        projectId: args.projectId,
        projectName: args.projectName,
        repo: args.repo,
        repoUrl: args.repoUrl,
        localPath: args.localPath,
        sectionId: args.sectionId,
        agent: args.agent,
        pipeline: args.pipeline,
      }),
    }),
  },
  {
    name: 'update_prompt_override',
    description: 'Create or update a per-workspace prompt section override. Writes only under <localPath>/.devflow/prompt-overrides/.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        sectionId: { type: 'string', description: 'Prompt section id, e.g. "prompt.header".' },
        content: { type: 'string', description: 'Override markdown content.' },
        agent: { type: 'string' },
        pipeline: { type: 'string' },
      },
      required: ['sectionId', 'content'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'PUT',
      path: '/api/prompt-overrides/section',
      body: {
        projectId: args.projectId,
        projectName: args.projectName,
        repo: args.repo,
        repoUrl: args.repoUrl,
        localPath: args.localPath,
        sectionId: args.sectionId,
        content: args.content,
        agent: args.agent,
        pipeline: args.pipeline,
      },
    }),
  },
  {
    name: 'delete_prompt_override',
    description: 'Delete a per-workspace prompt section override. Falls back to master content for that section. Does not touch master skill files.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        sectionId: { type: 'string' },
        agent: { type: 'string' },
        pipeline: { type: 'string' },
      },
      required: ['sectionId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'DELETE',
      path: withQuery('/api/prompt-overrides/section', {
        projectId: args.projectId,
        projectName: args.projectName,
        repo: args.repo,
        repoUrl: args.repoUrl,
        localPath: args.localPath,
        sectionId: args.sectionId,
        agent: args.agent,
        pipeline: args.pipeline,
      }),
    }),
  },
  {
    name: 'list_local_files',
    description: 'List local files safely within a project root. Prefer this local tool before remote GitHub listing when the user does not specify a source.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        path: { type: 'string', description: 'Relative path under the workspace root.' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories.' },
        limit: { type: 'number', description: 'Maximum entries returned.' },
      },
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/local-files', args),
    }),
  },
  {
    name: 'read_local_file',
    description: 'Prefer this local reader before remote GitHub reads when the user does not specify a source. Reads a file safely within a project root.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        filePath: { type: 'string', description: 'Relative file path under the workspace root.' },
        path: { type: 'string', description: 'Alias for filePath.' },
        mode: { type: 'string', enum: ['content', 'metadata'], description: 'Use metadata to avoid returning file content.' },
        startLine: { type: 'number', description: '1-based first line to return.' },
        endLine: { type: 'number', description: '1-based final line to return.' },
        maxBytes: { type: 'number', description: 'Maximum UTF-8 bytes of content to return.' },
      },
      required: ['filePath'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/local-files/read', {
        ...args,
        filePath: args.filePath || args.path,
        mode: args.mode,
        startLine: args.startLine,
        endLine: args.endLine,
        maxBytes: args.maxBytes,
      }),
    }),
  },
  {
    name: 'read_file_snippets_batch',
    description: 'Read multiple small local file snippets safely within a project root in one round trip. Prefer this when several focused snippets are needed.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        files: {
          type: 'array',
          description: 'File snippet requests. Each entry uses read_local_file semantics.',
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string', description: 'Relative file path under the workspace root.' },
              path: { type: 'string', description: 'Alias for filePath.' },
              mode: { type: 'string', enum: ['content', 'metadata'], description: 'Use metadata to avoid returning file content.' },
              startLine: { type: 'number', description: '1-based first line to return.' },
              endLine: { type: 'number', description: '1-based final line to return.' },
              maxBytes: { type: 'number', description: 'Maximum UTF-8 bytes of content to return for this file.' },
            },
            anyOf: [
              { required: ['filePath'] },
              { required: ['path'] },
            ],
          },
        },
        maxFiles: { type: 'number', description: 'Maximum file entries to process, capped at 25.' },
      },
      required: ['files'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/local-files/read-batch',
      body: args,
    }),
  },
  {
    name: 'write_local_file',
    description: 'Write a UTF-8 local file safely within a project root. Prefer this for small generated edits when a full-file replacement is faster than remote write flows.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        filePath: { type: 'string', description: 'Relative file path under the workspace root.' },
        path: { type: 'string', description: 'Alias for filePath.' },
        content: { type: 'string', description: 'Full UTF-8 file content, max 1 MB.' },
        createOnly: { type: 'boolean', description: 'Fail if the file already exists.' },
      },
      required: ['filePath', 'content'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/local-files/write',
      body: {
        ...args,
        filePath: args.filePath || args.path,
      },
    }),
  },
  {
    name: 'apply_patch',
    executionPolicy: { mode: 'job', jobKind: 'repo-write' },
    description: 'Apply or dry-run check a small unified diff patch safely within a resolved local project root.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        patch: { type: 'string', description: 'Unified diff patch text, max 100 KB by default.' },
        dryRun: { type: 'boolean', description: 'When true, validate and check the patch without changing files.' },
        check: { type: 'boolean', description: 'Alias for dryRun.' },
        maxPatchBytes: { type: 'number', description: 'Optional patch size limit, capped at 1 MB.' },
        maxSummaryBytes: { type: 'number', description: 'Optional response summary limit, capped at 100 KB.' },
      },
      required: ['patch'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        changedFiles: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' },
        applied: { type: 'boolean' },
        exitCode: { type: ['number', 'null'] },
        summary: { type: 'string' },
        truncated: { type: 'boolean' },
      },
    },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/local-files/apply-patch',
      body: args,
    }),
  },
  {
    name: 'safe_edit_local_file',
    description: 'Safely edit a small section of a large local file without sending the entire file content. Best for route, contract, and service files where patch payloads fail.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        filePath: { type: 'string', description: 'Relative file path under the workspace root.' },
        path: { type: 'string', description: 'Alias for filePath.' },
        mode: { type: 'string', enum: ['dry-run', 'apply'], description: 'dry-run validates and previews. apply writes the change atomically.' },
        edits: {
          type: 'array',
          description: 'List of focused edit operations.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['replace', 'insert_before', 'insert_after', 'delete_between'] },
              find: { type: 'string', description: 'Anchor text to find (for replace, insert_before, insert_after).' },
              replaceWith: { type: 'string', description: 'New text for replace operations.' },
              content: { type: 'string', description: 'Text to insert for insert operations.' },
              start: { type: 'string', description: 'Start anchor text for delete_between.' },
              end: { type: 'string', description: 'End anchor text for delete_between.' },
              occurrence: { type: 'number', description: 'Optional 1-based index if the anchor appears multiple times. Otherwise ambiguous matches fail.' },
            },
            required: ['type'],
          },
        },
        operations: { type: 'array', description: 'Alias for edits.' },
        maxPayloadBytes: { type: 'number', description: 'Max allowed edits payload in bytes.' },
        maxFileBytes: { type: 'number', description: 'Max allowed target file size in bytes.' },
        expectedContentHash: { type: 'string', description: 'Optional SHA-256 hash of the target file to prevent overwriting unexpected changes.' },
        expectedSha256: { type: 'string', description: 'Alias for expectedContentHash.' },
      },
      required: ['filePath'],
      anyOf: [
        { required: ['edits'] },
        { required: ['operations'] },
      ],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/local-files/safe-edit',
      body: {
        ...args,
        filePath: args.filePath || args.path,
        edits: args.edits || args.operations,
      },
    }),
  },
  {
    name: 'edit_local_files_batch',
    executionPolicy: { mode: 'job', jobKind: 'repo-write' },
    description: 'Preview or apply focused edits across multiple local files as one guarded batch. All files are dry-run checked first; apply mode rolls back previously changed files if any later edit fails.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        mode: { type: 'string', enum: ['dry-run', 'apply'], description: 'dry-run validates and previews. apply writes all edits after preflight succeeds.' },
        files: {
          type: 'array',
          description: 'File edit entries. Duplicate file paths are rejected.',
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string', description: 'Relative file path under the workspace root.' },
              path: { type: 'string', description: 'Alias for filePath.' },
              edits: { type: 'array', description: 'Focused edit operations for this file.' },
              operations: { type: 'array', description: 'Alias for edits.' },
              expectedRevision: { type: 'object', description: 'Optional file revision token from read_local_file.' },
              fileRevision: { type: 'object', description: 'Alias for expectedRevision.' },
              expectedContentHash: { type: 'string', description: 'Optional SHA-256 hash guard.' },
              expectedSha256: { type: 'string', description: 'Alias for expectedContentHash.' },
            },
            required: ['filePath'],
          },
        },
        maxPayloadBytes: { type: 'number', description: 'Max allowed edit payload in bytes per file.' },
        maxFileBytes: { type: 'number', description: 'Max allowed target file size in bytes per file.' },
      },
      required: ['files'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/local-files/edit-batch',
      body: args,
    }),
  },
  {
    name: 'run_project_command',
    executionPolicy: { mode: 'job', jobKind: 'repo-command' },
    description: 'Run an allowlisted local verification command such as typecheck, test, lint, build, or verify inside a resolved project root.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        command: { type: 'string', enum: ['typecheck', 'test', 'lint', 'build', 'verify'], description: 'Allowlisted verification command preset.' },
        preset: { type: 'string', enum: ['typecheck', 'test', 'lint', 'build', 'verify'], description: 'Alias for command.' },
        cwd: { type: 'string', description: 'Optional safe subdirectory under the project root.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds, capped at 300000.' },
        maxOutputBytes: { type: 'number', description: 'Optional per-stream stdout/stderr byte limit, capped at 100000.' },
      },
      anyOf: [
        { required: ['command'] },
        { required: ['preset'] },
      ],
    },
    outputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        exitCode: { type: ['number', 'null'] },
        durationMs: { type: 'number' },
        timedOut: { type: 'boolean' },
        signal: { type: ['string', 'null'] },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        stdoutTruncated: { type: 'boolean' },
        stderrTruncated: { type: 'boolean' },
      },
    },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/project-commands/run',
      body: {
        ...args,
        command: args.command || args.preset,
      },
    }),
  },
  {
    name: 'parse_test_report',
    description: 'Parse raw verification output and safe local report files into a compact normalized pass/fail summary.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        rawOutput: { type: 'string', description: 'Raw stdout/stderr or pasted report text to summarize.' },
        reportPaths: { type: 'array', items: { type: 'string' }, description: 'Optional safe report file paths under the project root.' },
        parserKind: { type: 'string', enum: ['auto', 'tsc', 'node-assertion', 'devflow-verify', 'npm-script', 'unknown'], description: 'Reserved parser hint for future expansion. Current behavior auto-detects.' },
        maxBytes: { type: 'number', description: 'Optional combined raw/report byte limit, capped at 100000.' },
      },
      anyOf: [
        { required: ['rawOutput'] },
        { required: ['reportPaths'] },
      ],
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['passed', 'failed', 'unknown'] },
        parserKind: { type: 'string', enum: ['tsc', 'node-assertion', 'devflow-verify', 'npm-script', 'unknown'] },
        source: {
          type: 'object',
          properties: {
            usedRawOutput: { type: 'boolean' },
            reportPaths: { type: 'array', items: { type: 'string' } },
          },
        },
        totals: {
          type: 'object',
          properties: {
            total: { type: ['number', 'null'] },
            passed: { type: ['number', 'null'] },
            failed: { type: ['number', 'null'] },
            errors: { type: ['number', 'null'] },
            warnings: { type: ['number', 'null'] },
          },
        },
        failingFiles: { type: 'array', items: { type: 'string' } },
        errorSnippets: { type: 'array', items: { type: 'string' } },
        suggestedNextCommand: { type: ['string', 'null'] },
        truncated: { type: 'boolean' },
        consumedBytes: { type: 'number' },
      },
    },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/test-reports/parse',
      body: args,
    }),
  },
  {
    name: 'search_local_files',
    executionPolicy: { mode: 'job', jobKind: 'repo-read' },
    description: 'Search for text patterns inside a local project repository using exact match or regex. Powered by ripgrep. Use this for discovery, not for listing directory contents.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        query: { type: 'string', description: 'Ripgrep-style search query.' },
        path: { type: 'string', description: 'Relative directory path.' },
        limit: { type: 'number', description: 'Maximum matches returned.' },
      },
      required: ['query'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/local-files/search', args),
    }),
  },
  {
    name: 'get_git_log',
    description: 'List recent git commits with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        limit: { type: 'number', description: 'Maximum number of commits returned (default 20, max 500).' },
        author: { type: 'string', description: 'Filter by commit author.' },
        since: { type: 'string', description: 'Only commits after this date (ISO 8601 or git-parseable).' },
        until: { type: 'string', description: 'Only commits before this date (ISO 8601 or git-parseable).' },
        grep: { type: 'string', description: 'Filter commits with message matching pattern.' },
        path: { type: 'string', description: 'Relative file or directory path to limit log to.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/git/log', args),
    }),
  },
  {
    name: 'get_git_diff',
    description: 'Show git diff between commits or working tree changes.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        commit1: { type: 'string', description: 'First commit hash for comparison.' },
        commit2: { type: 'string', description: 'Second commit hash for comparison.' },
        path: { type: 'string', description: 'Relative file or directory path to limit diff to.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/git/diff', args),
    }),
  },
  {
    name: 'get_git_show',
    description: 'Show detailed information for a single commit.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        commit: { type: 'string', description: 'Commit hash.' },
        path: { type: 'string', description: 'Relative file or directory path to limit output to.' },
      },
      required: ['commit'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/git/show', args),
    }),
  },
  {
    name: 'get_git_status',
    description: 'Show the working tree status (git status --porcelain).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/git/status', args),
    }),
  },
  {
    name: 'get_git_branch',
    description: 'List local git branches.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/git/branch', args),
    }),
  },
  {
    name: 'commit_git_changes',
    executionPolicy: { mode: 'job', jobKind: 'repo-command' },
    description: 'Safely create a local git commit in the resolved project repository. This tool must never push, amend, reset, checkout, rebase, or perform remote operations.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        message: { type: 'string', description: 'Commit message. Required.' },
        stageAll: { type: 'boolean', description: 'Stage all working tree changes before committing.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Specific files to stage before committing.' },
        dryRun: { type: 'boolean', description: 'Return a preview/status summary without creating the commit.' },
      },
      required: ['message'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/git/commit',
      body: args,
    }),
  },
  {
    name: 'get_figma_file',
    description: 'Fetch compact file metadata/context by fileKey.',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
      },
      required: ['fileKey'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: `/api/figma/file/${encodePathSegment(String(args.fileKey))}`,
    }),
  },
  {
    name: 'get_figma_node',
    description: 'Fetch one or more nodes by fileKey and nodeId(s).',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
        nodeId: { type: 'string', description: 'Single node id. For multiple nodes, prefer nodeIds.' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'One or more node ids.' },
      },
      required: ['fileKey'],
      anyOf: [{ required: ['nodeId'] }, { required: ['nodeIds'] }],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: `/api/figma/file/${encodePathSegment(String(args.fileKey))}/node/${encodePathSegment(Array.isArray(args.nodeIds) ? args.nodeIds.join(',') : String(args.nodeId))}`,
    }),
  },
  {
    name: 'get_figma_design_spec',
    description: 'Return normalized implementation-oriented spec for a node, including text, size, color, typography, layout, spacing, constraints, and asset/image references when available.',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
        nodeId: { type: 'string' },
      },
      required: ['fileKey', 'nodeId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: `/api/figma/file/${encodePathSegment(String(args.fileKey))}/node/${encodePathSegment(String(args.nodeId))}/spec`,
    }),
  },
  {
    name: 'attach_figma_context_to_task',
    description: 'Optionally add a Figma source reference and summarized visual/design requirement to an existing DevFlow task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task internal id or displayId such as DVF-0120.' },
        fileKey: { type: 'string' },
        nodeId: { type: 'string' },
      },
      required: ['taskId', 'fileKey', 'nodeId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: `/api/tasks/${encodePathSegment(String(args.taskId))}/figma-context`,
      body: { fileKey: args.fileKey, nodeId: args.nodeId },
    }),
  },
  {
    name: 'create_tool_job',
    description: 'Manually enqueue a tool job for tools that support it.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['toolName', 'args'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tool-jobs', body: args }),
  },
  {
    name: 'get_tool_job_status',
    description: 'Get the status and queue position of a tool job.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: `/api/tool-jobs/${encodePathSegment(String(args.jobId))}` }),
  },
  {
    name: 'get_tool_job_log',
    description: 'Tail the execution log of a running or completed tool job.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        stream: { type: 'string', enum: ['stdout', 'stderr', 'both'] },
      },
      required: ['jobId'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery(`/api/tool-jobs/${encodePathSegment(String(args.jobId))}/log`, { stream: args.stream }),
    }),
  },
  {
    name: 'get_tool_job_result',
    description: 'Get the final result and patch of a completed tool job.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: `/api/tool-jobs/${encodePathSegment(String(args.jobId))}/result` }),
  },
  {
    name: 'cancel_tool_job',
    description: 'Cancel a queued or running tool job.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: `/api/tool-jobs/${encodePathSegment(String(args.jobId))}/cancel` }),
  },
];

export function getToolDefinitionByName(name: string) {
  const direct = devFlowToolDefinitions.find((tool) => tool.name === name);
  if (direct) return direct;
  return devFlowToolDefinitions.find((tool) => tool.aliases?.includes(name));
}

export function getMcpToolList() {
  const tools = [];
  for (const tool of devFlowToolDefinitions) {
    let outputSchema = tool.outputSchema;
    let description = tool.description;

    if (tool.executionPolicy?.mode === 'job') {
      description = `${description}\n\nNote: This tool may run asynchronously. If it takes longer than 20 seconds, it will return a \`jobId\` instead of the final result. If it returns a \`jobId\`, you must use \`get_tool_job_status\`, \`get_tool_job_log\`, and \`get_tool_job_result\` to retrieve the outcome.`;
      if (outputSchema) {
        outputSchema = {
          anyOf: [
            outputSchema,
            {
              type: 'object',
              properties: {
                jobId: { type: 'string' },
                status: { type: 'string' },
              },
              required: ['jobId'],
            },
          ],
        };
      }
    }

    tools.push({
      name: tool.name,
      description,
      inputSchema: tool.inputSchema,
      outputSchema,
    });
    for (const alias of tool.aliases || []) {
      tools.push({
        name: alias,
        description: `${description} Alias for ${tool.name}.`,
        inputSchema: tool.inputSchema,
        outputSchema,
      });
    }
  }
  return tools;
}

export function getCapabilityCatalog() {
  return {
    contractVersion: DEVFLOW_CONTRACT_VERSION,
    tools: devFlowToolDefinitions.map((tool) => {
      let outputSchema = tool.outputSchema;
      let description = tool.description;

      if (tool.executionPolicy?.mode === 'job') {
        description = `${description}\n\nNote: This tool may run asynchronously. If it takes longer than 20 seconds, it will return a \`jobId\` instead of the final result. If it returns a \`jobId\`, you must use \`get_tool_job_status\`, \`get_tool_job_log\`, and \`get_tool_job_result\` to retrieve the outcome.`;
        if (outputSchema) {
          outputSchema = {
            anyOf: [
              outputSchema,
              {
                type: 'object',
                properties: {
                  jobId: { type: 'string' },
                  status: { type: 'string' },
                },
                required: ['jobId'],
              },
            ],
          };
        }
      }

      return {
        name: tool.name,
        aliases: tool.aliases || [],
        description,
        lightweight: tool.lightweight === true,
        inputSchema: tool.inputSchema,
        outputSchema,
      };
    }),
  };
}
