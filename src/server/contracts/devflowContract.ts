import { VALID_AGENTS, LEGACY_VALID_EFFORTS_FALLBACK, VALID_MODELS, VALID_STATUSES } from '../constants';

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
  tags: { type: 'array', items: { type: 'string' }, description: 'Task tags.' },
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

export const DEVFLOW_CONTRACT_VERSION = '2026-06-13.1';

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
    outputSchema: { type: 'array', items: { type: 'object' } },
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
    name: 'list_tasks',
    description: 'List tasks with optional filters and summary/full modes.',
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
        mode: args.mode || 'summary',
      }),
    }),
  },
  {
    name: 'search_tasks',
    description: 'Search tasks without fetching the full board.',
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
    description: 'Read a single task by internal id or displayId.',
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
    description: 'Get the token-efficient agent task context package.',
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
      path: withQuery(`/api/tasks/${encodePathSegment(String(args.taskId))}/prompt`, {
        includeLogs: args.includeLogs,
        mode: args.mode,
      }),
    }),
  },
  {
    name: 'create_task',
    description: 'Create a task.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        ...taskMutationProperties,
      },
      required: ['title'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/tasks', body: args }),
  },
  {
    name: 'update_task',
    description: 'Update a task by internal id or displayId.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskIdentifierProperty,
        ...taskMutationProperties,
        ...projectIdentifierProperties,
        ...booleanFlagSchema.properties,
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, ...body }) => ({
      method: 'PUT',
      path: `/api/tasks/${encodePathSegment(String(taskId))}`,
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
      },
      required: ['taskId', 'status'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, ...body }) => ({
      method: 'POST',
      path: `/api/tasks/${encodePathSegment(String(taskId))}/move`,
      body,
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
      },
      required: ['taskId', 'checklistId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, ...body }) => ({
      method: 'POST',
      path: `/api/tasks/${encodePathSegment(String(taskId))}/checklist/toggle`,
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
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, isAgentRequest, ...body }) => ({
      method: 'POST',
      path: `/api/tasks/${encodePathSegment(String(taskId))}/assign`,
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
    outputSchema: { type: 'array', items: { type: 'object' } },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/skills', { kind: args.kind }),
    }),
  },
  {
    name: 'get_authoring_skills',
    description: 'Get the full content of all authoring skills (schema and playbook) that define how tasks are structured in DevFlow.',
    inputSchema: emptyObjectSchema,
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: () => ({ method: 'GET', path: '/api/skills/authoring' }),
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
    name: 'list_local_files',
    description: 'List local files safely within a project root.',
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
    description: 'Read a local file safely within a project root.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        filePath: { type: 'string', description: 'Relative file path under the workspace root.' },
        path: { type: 'string', description: 'Alias for filePath.' },
      },
      required: ['filePath'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/local-files/read', {
        ...args,
        filePath: args.filePath || args.path,
      }),
    }),
  },
  {
    name: 'search_local_files',
    description: 'Search local files without reading the full repo.',
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
];

export function getToolDefinitionByName(name: string) {
  const direct = devFlowToolDefinitions.find((tool) => tool.name === name);
  if (direct) return direct;
  return devFlowToolDefinitions.find((tool) => tool.aliases?.includes(name));
}

export function getMcpToolList() {
  const tools = [];
  for (const tool of devFlowToolDefinitions) {
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    });
    for (const alias of tool.aliases || []) {
      tools.push({
        name: alias,
        description: `${tool.description} Alias for ${tool.name}.`,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      });
    }
  }
  return tools;
}

export function getCapabilityCatalog() {
  return {
    contractVersion: DEVFLOW_CONTRACT_VERSION,
    tools: devFlowToolDefinitions.map((tool) => ({
      name: tool.name,
      aliases: tool.aliases || [],
      description: tool.description,
      lightweight: tool.lightweight === true,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    })),
  };
}
