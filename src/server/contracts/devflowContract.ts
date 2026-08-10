import { createHash } from 'node:crypto';
import { createApiError } from '../services/api';
import {
  booleanFlagSchema,
  emptyObjectSchema,
  encodePathSegment,
  mutationResponseModeProperty,
  projectIdentifierProperties,
  stripToolOnlyArgs,
  taskIdentifierProperty,
  taskMutationProperties,
  withQuery,
  type DevFlowToolDefinition,
} from './devflowContractCore';
import { taskToolDefinitions } from './devflowTaskTools';
import { gitToolDefinitions } from './devflowGitTools';
import { workspaceToolDefinitions } from './devflowWorkspaceTools';
import { buildMcpTransportInputSchema } from './mcpSchemaTransport';
import { resolveRuntimeMcpToolProfileValue } from './mcpToolProfileConfig';
export type { DevFlowToolDefinition, DevFlowToolHttpRequest } from './devflowContractCore';
export const DEVFLOW_CONTRACT_VERSION = '2026-08-09.5';

export const devFlowToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'get_capabilities',
    aliases: [],
    description: 'Get the compact DevFlow capability catalog, contract/runtime identity, enabled modules, transport metadata, and MCP tool surface in one call.',
    inputSchema: emptyObjectSchema,
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: () => ({ method: 'GET', path: '/api/capabilities' }),
  },
  {
    name: 'get_tool_schema',
    description: 'Return one exact DevFlow tool schema without serializing unrelated tool definitions.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'Exact DevFlow tool name or alias.' },
      },
      required: ['toolName'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: `/api/capabilities/tools/${encodePathSegment(String(args.toolName))}`,
    }),
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
    name: 'restart_devflow',
    description: 'Request a guarded restart of the DevFlow API runtime. Safe restart is available only when DevFlow is hosted by the start-all supervisor; active MCP tool jobs block restart.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', maxLength: 200, description: 'Optional short reason recorded with the restart ticket.' },
      },
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/restart',
      body: args,
    }),
  },
  {
    name: 'get_devflow_restart_status',
    description: 'Read the latest DevFlow restart ticket state after reconnecting, or query a specific restart ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'Optional restart ticket returned by restart_devflow.' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery('/api/restart/status', { ticket: args.ticket }),
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
        intent: { type: 'string', enum: ['authoring', 'small-bug', 'verification', 'cross-module', 'architecture', 'small-bug-fix', 'cross-module-change', 'verification-debugging', 'architecture-analysis'], description: 'Compatibility alias for contextIntent.' },
        contextIntent: { type: 'string', enum: ['authoring', 'small-bug-fix', 'cross-module-change', 'verification-debugging', 'architecture-analysis'], description: 'Optional intent override for deterministic context budgeting.' },
        deep: { type: 'boolean', description: 'Compatibility flag: with architecture intent, request the explicit full-file disclosure profile.' },
        complexity: { type: 'string', description: 'Optional complexity hint used when selecting the context profile.' },
        targetFiles: { type: 'array', items: { type: 'string' }, description: 'Explicit target files that rank as Must evidence.' },
        disclosureLevel: { type: 'string', enum: ['project-summary', 'symbols', 'snippets', 'callers-tests', 'full-file'], description: 'Optional progressive disclosure override; full-file is never selected automatically.' },
        maxContextBytes: { type: 'number', description: 'Maximum aggregate snippet-content byte budget for this bundle.' },
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
    description: 'Get capped Project Atlas knowledge graph context for a project. Modes include compact, standard, full, chatgpt-context, agent-context, task-focused, and diff-impact. Pass promptVariant to receive a copy-ready Atlas prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        mode: { type: 'string', enum: ['compact', 'standard', 'full', 'chatgpt-context', 'agent-context', 'task-focused', 'diff-impact'], description: 'Atlas response mode. Defaults to compact.' },
        limit: { type: 'number', description: 'Maximum nodes/edges returned. Defaults are capped; max 1000.' },
        query: { type: 'string', description: 'Search query for task-focused mode.' },
        focusPath: { type: 'string', description: 'Path focus for task-focused mode.' },
        taskId: { type: 'string', description: 'Task id/key for task-focused mode.' },
        taskTitle: { type: 'string', description: 'Task title to include in task-focused prompt templates.' },
        targetFiles: { type: 'array', items: { type: 'string' }, description: 'Explicit target files to include in task-focused prompt templates.' },
        selectedNodeId: { type: 'string', description: 'Atlas node id for module/node prompt templates.' },
        diffSummary: { type: 'string', description: 'Current diff summary for analyze-diff-impact prompt templates.' },
        changedFiles: { type: 'array', items: { type: 'string' }, description: 'Changed files for diff-impact mode. If omitted, current git status is used when localPath is available.' },
        promptVariant: {
          type: 'string',
          enum: ['explain-project', 'onboard-repo', 'find-affected-files', 'plan-implementation', 'build-read-order', 'explain-module', 'analyze-diff-impact'],
          description: 'Optional copy-ready prompt template to include in the response.',
        },
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
    name: 'apply_project_atlas_agent_update',
    description: 'Save a full ChatGPT-authored Project Atlas. ChatGPT owns domains, edges, summaries, read order, warnings, provenance, repo coverage, skipped-area reasons, grouping rationale, and evidence paths.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        provenance: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['ChatGPT', 'Codex', 'Agent', 'Other'] },
            model: { type: 'string' },
            prompt: { type: 'string' },
            runId: { type: 'string' },
          },
          required: ['provider'],
          additionalProperties: false,
        },
        generatedAt: { type: 'string' },
        repoFingerprint: { type: 'string' },
        coverage: {
          type: 'object',
          properties: {
            notes: { type: 'array', items: { type: 'string' } },
            skippedAreas: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['path', 'reason'],
                additionalProperties: false,
              },
            },
          },
          required: ['notes', 'skippedAreas'],
          additionalProperties: false,
        },
        groupingRationale: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            domainRationales: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  domainId: { type: 'string' },
                  rationale: { type: 'string' },
                  evidence: { type: 'array', items: { $ref: '#/$defs/atlasEvidence' } },
                },
                required: ['domainId', 'rationale'],
                additionalProperties: false,
              },
            },
          },
          required: ['summary'],
          additionalProperties: false,
        },
        nodes: { type: 'array', maxItems: 1000, items: { type: 'object' } },
        edges: { type: 'array', maxItems: 1000, items: { type: 'object' } },
        domains: {
          type: 'array',
          maxItems: 1000,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1000 },
              origin: { type: 'string', enum: ['verified', 'inferred', 'user-edited'] },
              summary: { type: 'string' },
              metadata: { type: 'object' },
            },
            required: ['id', 'name', 'nodeIds', 'origin'],
            additionalProperties: false,
          },
        },
        flows: { type: 'array', maxItems: 1000, items: { type: 'object' } },
        summary: { type: 'object' },
        readOrder: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string' },
              path: { type: 'string' },
              reason: { type: 'string' },
              evidence: { type: 'array', items: { $ref: '#/$defs/atlasEvidence' } },
            },
            required: ['nodeId', 'reason'],
            additionalProperties: false,
          },
        },
        warnings: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              severity: { type: 'string', enum: ['info', 'warning', 'error'] },
              evidence: { type: 'array', items: { $ref: '#/$defs/atlasEvidence' } },
            },
            required: ['message', 'severity'],
            additionalProperties: false,
          },
        },
        evidence: { type: 'array', items: { $ref: '#/$defs/atlasEvidence' } },
        sync: { type: 'boolean', description: 'HTTP-only escape hatch for tests/manual calls. MCP callers should omit this and use the queued job result.' },
      },
      required: ['provenance', 'coverage', 'groupingRationale', 'nodes', 'edges', 'domains'],
      additionalProperties: false,
      $defs: {
        atlasEvidence: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative existing repo file path.' },
            nodeId: { type: 'string', description: 'Authored Atlas node id.' },
            excerpt: { type: 'string' },
            startLine: { type: 'number' },
            endLine: { type: 'number' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    outputSchema: { type: 'object' },
    executionPolicy: { mode: 'job', jobKind: 'repo-write' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/project-atlas/agent-update',
      body: args,
    }),
  },
  ...taskToolDefinitions,
  ...workspaceToolDefinitions,
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
    description: 'Get the full content of all authoring skills, including lean common guidance and on-demand evidence, decomposition, and execution specialists.',
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
    description: 'Read one DevFlow authoring skill by id. Use the router first, then load only the common or specialist skill required for the current workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', enum: ['00-skill-router', '01-authoring-core', '02-schema-reference', '03-reviewer-core', '04-examples', '05-authoring-evidence', '06-authoring-decomposition', '07-authoring-execution', '08-board-loop-execution'] },
        skillId: { type: 'string', enum: ['00-skill-router', '01-authoring-core', '02-schema-reference', '03-reviewer-core', '04-examples', '05-authoring-evidence', '06-authoring-decomposition', '07-authoring-execution', '08-board-loop-execution'] },
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
        responseMode: { type: 'string', enum: ['compact', 'standard', 'debug'], description: 'Agent default is compact (4 KB content cap); standard/debug preserve larger explicit reads.' },
        includeFileRef: { type: 'boolean', description: 'Opt in to an opaque short-lived fileRef bound to this exact project, canonical file path, and content revision for prepare_compact_edit.' },
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
        responseMode: args.responseMode || 'compact',
      }),
    }),
  },
  {
    name: 'read_file_snippets_batch',
    description: 'Read multiple bounded local file snippets in one round trip. For multi-file Steno edit targets, set includeFileRef=true to return revision-bound refs for every successful file instead of calling read_local_file once per file.',
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
              responseMode: { type: 'string', enum: ['compact', 'standard', 'debug'], description: 'Override batch response mode for this entry.' },
              includeFileRef: { type: 'boolean', description: 'Override batch includeFileRef for this entry.' },
            },
            anyOf: [
              { required: ['filePath'] },
              { required: ['path'] },
            ],
          },
        },
        maxFiles: { type: 'number', description: 'Maximum file entries to process, capped at 25.' },
        includeFileRef: { type: 'boolean', description: 'Issue revision-bound Steno fileRefs for successful entries in this batch.' },
        responseMode: { type: 'string', enum: ['compact', 'standard', 'debug'], description: 'Agent default is compact for every entry unless overridden per file.' },
        allowPartial: { type: 'boolean', description: 'Return per-file errors while preserving successful reads instead of failing the whole batch.' },
        maxTotalBytes: { type: 'number', description: 'Aggregate returned content-byte budget for the batch, capped at 500000.' },
      },
      required: ['files'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/local-files/read-batch',
      body: { ...args, responseMode: args.responseMode || 'compact' },
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
    name: 'delete_local_path',
    executionPolicy: { mode: 'job', jobKind: 'repo-write' },
    description: 'Preview or apply guarded deletion of one or more files/directories inside the selected project. Supports file revision/hash guards and transactional rollback.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' }, description: 'Relative file or directory paths to delete.' },
        path: { type: 'string', description: 'Single relative path alias.' },
        filePath: { type: 'string', description: 'Single relative file path alias.' },
        expectedRevisions: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional path-to-revision/hash guards.' },
        expectedRevision: { type: 'string', description: 'Optional guard for a single path.' },
        expectedContentHash: { type: 'string', description: 'Optional SHA-256 guard for a single file.' },
        expectedSha256: { type: 'string', description: 'Alias for expectedContentHash.' },
        dryRun: { type: 'boolean', description: 'Preview the deletion plan without writing.' },
        check: { type: 'boolean', description: 'Alias for dryRun.' },
      },
      anyOf: [
        { required: ['paths'] },
        { required: ['path'] },
        { required: ['filePath'] },
      ],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/local-files/delete', body: args }),
  },
  {
    name: 'move_local_path',
    executionPolicy: { mode: 'job', jobKind: 'repo-write' },
    description: 'Preview or apply guarded file/directory move or rename operations inside one project with collision checks and transactional rollback.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        moves: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              expectedRevision: { type: 'string' },
              expectedContentHash: { type: 'string' },
              expectedSha256: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
        from: { type: 'string', description: 'Single move source alias.' },
        to: { type: 'string', description: 'Single move destination alias.' },
        dryRun: { type: 'boolean', description: 'Preview the move plan without writing.' },
        check: { type: 'boolean', description: 'Alias for dryRun.' },
      },
      anyOf: [
        { required: ['moves'] },
        { required: ['from', 'to'] },
      ],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/local-files/move', body: args }),
  },
  {
    name: 'apply_patch',
    executionPolicy: { mode: 'job', jobKind: 'repo-write' },
    description: 'Apply or dry-run an already-existing or trusted native Git unified diff, or perform structured guarded delete/move path operations inside a resolved local project root. For LLM-authored existing-file changes, prefer prepare_compact_edit + apply_prepared_edit instead of synthesizing patch text.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        patch: { type: 'string', description: 'native Git unified diff patch text, max 100 KB by default. `*** Begin Patch` / `*** Update File` pseudo-patch syntax is not valid input.' },
        operations: {
          type: 'array', minItems: 1, maxItems: 100,
          description: 'Structured semantic path operations. Use instead of patch for delete/move.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['delete', 'move', 'rename'] },
              path: { type: 'string', description: 'Delete target path.' },
              from: { type: 'string', description: 'Move source path.' },
              to: { type: 'string', description: 'Move destination path.' },
              expectedRevision: { type: 'string' },
              expectedContentHash: { type: 'string' },
              expectedSha256: { type: 'string' },
            },
            required: ['type'],
          },
        },
        dryRun: { type: 'boolean', description: 'When true, validate and check the patch without changing files.' },
        check: { type: 'boolean', description: 'Alias for dryRun.' },
        maxPatchBytes: { type: 'number', description: 'Optional patch size limit, capped at 1 MB.' },
        maxSummaryBytes: { type: 'number', description: 'Optional response summary limit, capped at 100 KB.' },
      },
      anyOf: [
        { required: ['patch'] },
        { required: ['operations'] },
      ],
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
              expectedRevision: { type: 'string', description: 'Optional file revision token from read_local_file.' },
              fileRevision: { type: 'string', description: 'Alias for expectedRevision.' },
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
    name: 'prepare_edit_plan',
    executionPolicy: { mode: 'job', jobKind: 'repo-read' },
    description: 'Prepare and validate a structured multi-file edit once, returning a short-lived editPlanId bound to current file revisions. Prefer this when a preview will be applied unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        files: { type: 'array', minItems: 1, items: { type: 'object' }, description: 'Same structured file entries accepted by edit_local_files_batch.' },
        ttlMs: { type: 'number', description: 'Optional prepared-plan lifetime in milliseconds, bounded by DevFlow.' },
        maxPayloadBytes: { type: 'number' },
        maxFileBytes: { type: 'number' },
      },
      required: ['files'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/local-files/edit-plans/prepare', body: args }),
  },
  {
    name: 'apply_prepared_edit_plan',
    executionPolicy: { mode: 'job', jobKind: 'repo-write' },
    description: 'Apply a previously prepared editPlanId without resending or recomputing its edit payload. Fails before mutation when any prepared target revision is stale.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        editPlanId: { type: 'string', description: 'Short-lived id returned by prepare_edit_plan.' },
      },
      required: ['editPlanId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/local-files/edit-plans/apply', body: args }),
  },
  {
    name: 'prepare_compact_edit',
    executionPolicy: { mode: 'job', jobKind: 'repo-read' },
    description: 'Prepare Steno Edit v1 without writing. First read targets with read_local_file(includeFileRef=true), then send v=1, optional request-local string table `s`, and `f` file tuples. Operations are compact tuples: R=["R", find, replacement, occurrence?], IB=["IB", find, text, occurrence?], IA=["IA", find, text, occurrence?], DB=["DB", start, end, occurrence?]. String positions accept a literal string or a non-negative index into `s`. Returns a short-lived editPlanId; use apply_prepared_edit with only that id. Fall back to safe_edit_local_file/edit_local_files_batch when compact preparation is not suitable.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        v: { type: 'number', enum: [1], description: 'Steno Edit protocol version. v1 is currently supported.' },
        s: { type: 'array', items: { type: 'string' }, description: 'Optional request-local UTF-8 string table. Entries are literals only; recursive references are not supported.' },
        f: {
          type: 'array', minItems: 1, maxItems: 100,
          description: 'File tuples shaped as [fileRef, operations]. fileRef must come from read_local_file(includeFileRef=true).',
          items: { type: 'array', minItems: 2, maxItems: 2 },
        },
        ttlMs: { type: 'number', description: 'Optional prepared-plan TTL; bounded by DevFlow (default 180s, max 300s).' },
        maxPayloadBytes: { type: 'number', description: 'Maximum expanded safe-edit payload bytes per file.' },
        maxFileBytes: { type: 'number', description: 'Maximum target file size per file.' },
        responseMode: { type: 'string', enum: ['compact', 'standard', 'debug'], description: 'Agent default is compact and omits expanded before/after previews while retaining plan/file safety metadata.' },
      },
      required: ['v', 'f'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/local-files/compact-edit/prepare', body: { ...args, responseMode: args.responseMode || 'compact' } }),
  },
  {
    name: 'apply_prepared_edit',
    executionPolicy: { mode: 'job', jobKind: 'repo-write' },
    description: 'Apply a Steno Edit prepared plan by editPlanId only. Plans are single-use; stale, expired, failed, or already-consumed plans must be re-read and re-prepared rather than replayed.',
    inputSchema: {
      type: 'object',
      properties: {
        editPlanId: { type: 'string', description: 'Opaque short-lived plan id returned by prepare_compact_edit.' },
      },
      required: ['editPlanId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/local-files/compact-edit/apply', body: { editPlanId: args.editPlanId } }),
  },
  {
    name: 'apply_and_verify',
    executionPolicy: { mode: 'job', jobKind: 'repo-command' },
    description: 'Composite fast path: apply a prepared plan or structured batch, capture the diff, run a risk-aware verification plan, and return one normalized result.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        editPlanId: { type: 'string' },
        files: { type: 'array', items: { type: 'object' } },
        lane: { type: 'string', enum: ['fast', 'safe'] },
        requestedCommands: { type: 'array', items: { type: 'string' }, description: 'Verification preset names available to run_project_command.' },
        resourceIsolatedCommands: { type: 'array', items: { type: 'string' }, description: 'Commands explicitly proven safe to parallelize by future schedulers.' },
        forceVerification: { type: 'boolean' },
        cacheVerificationResults: { type: 'boolean' },
        timeoutMs: { type: 'number' },
        maxOutputBytes: { type: 'number' },
      },
      anyOf: [{ required: ['editPlanId'] }, { required: ['files'] }],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workflows/apply-and-verify', body: args }),
  },
  {
    name: 'get_repo_context_delta',
    description: 'Reuse a repo context handle. Returns NOT_MODIFIED when the relevant repo revision is unchanged, otherwise only changed snippets/removals and compact metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        contextHandle: { type: 'string' },
        q: { type: 'string' },
        query: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'number' },
        snippetLimit: { type: 'number' },
        snippetLines: { type: 'number' },
        maxSnippetBytes: { type: 'number' },
        intent: { type: 'string', enum: ['authoring', 'small-bug', 'verification', 'cross-module', 'architecture', 'small-bug-fix', 'cross-module-change', 'verification-debugging', 'architecture-analysis'], description: 'Compatibility alias for contextIntent.' },
        contextIntent: { type: 'string', enum: ['authoring', 'small-bug-fix', 'cross-module-change', 'verification-debugging', 'architecture-analysis'] },
        deep: { type: 'boolean', description: 'Compatibility flag: with architecture intent, request the explicit full-file disclosure profile.' },
        complexity: { type: 'string' },
        targetFiles: { type: 'array', items: { type: 'string' } },
        disclosureLevel: { type: 'string', enum: ['project-summary', 'symbols', 'snippets', 'callers-tests', 'full-file'] },
        maxContextBytes: { type: 'number' },
        contextSufficient: { type: 'boolean', description: 'Set false when the current context is insufficient and provide concrete missing evidence fields.' },
        missingFiles: { type: 'array', items: { type: 'string' }, description: 'Specific relative files still required.' },
        missingSymbols: { type: 'array', items: { type: 'string' }, description: 'Specific symbols still required; returned evidence is centered around matching lines.' },
        missingTests: { type: 'array', items: { type: 'string' }, description: 'Specific relative tests still required.' },
        missingRelationships: { type: 'array', items: { type: 'string' }, description: 'Specific dependency/caller/relationship queries still required.' },
        includeDiff: { type: 'boolean' },
        diffPath: { type: 'string' },
        maxDiffBytes: { type: 'number' },
        includeIgnored: { type: 'boolean' },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/repo-context/delta', args) }),
  },
  {
    name: 'get_repo_semantic_index',
    description: 'Query the existing incremental repo index for exact symbol definitions, lexical references/imports, and likely related tests without repeated text-search/read rounds.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        symbol: { type: 'string' },
        path: { type: 'string' },
        includeIgnored: { type: 'boolean' },
      },
      required: ['symbol'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/repo-inspection/semantic', args) }),
  },
  {
    name: 'run_project_command',
    executionPolicy: { mode: 'job', jobKind: 'repo-command' },
    description: 'Run a built-in or repository-defined verification preset inside a resolved project root. Custom presets are loaded from .devflow/commands.yaml or .devflow/commands.json and never use a shell string.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        command: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9:_-]*$', description: 'Built-in or repository-defined verification preset name.' },
        preset: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9:_-]*$', description: 'Alias for command.' },
        cwd: { type: 'string', description: 'Optional safe subdirectory under the project root.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds, capped at 300000.' },
        maxOutputBytes: { type: 'number', description: 'Optional per-stream stdout/stderr byte limit, capped at 100000.' },
        cacheResult: { type: 'boolean', description: 'Opt in to revision-safe reuse of a prior successful result for the exact same command/environment.' },
        cacheTtlMs: { type: 'number', description: 'Optional bounded TTL for cacheResult entries.' },
        singleFlight: { type: 'boolean', description: 'Allow identical in-flight command requests at the same repo revision to share one execution.' },
        responseMode: { type: 'string', enum: ['compact', 'standard', 'debug'], description: 'Response density. compact uses a smaller output budget while preserving status/summary metadata.' },
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
    description: 'Search for text patterns inside a local project repository using exact match or regex. Uses cached ripgrep resolution when available and a bounded safe fallback when ripgrep is unavailable.',
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
  ...gitToolDefinitions,
  {
    name: 'get_figma_authoring_context',
    description: 'Fetch compact implementation-ready Figma evidence for an exact bounded node set in one call, including file metadata, normalized specs, exact source refs, and summary markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
        nodeId: { type: 'string', description: 'Single exact node id.' },
        nodeIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' }, description: 'Exact node ids to include, max 8.' },
      },
      required: ['fileKey'],
      anyOf: [{ required: ['nodeId'] }, { required: ['nodeIds'] }],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: '/api/figma/authoring-context',
      body: { fileKey: args.fileKey, nodeIds: Array.isArray(args.nodeIds) ? args.nodeIds : [args.nodeId] },
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
    description: 'Attach bounded Figma evidence and exact source references for one or more nodes to an existing DevFlow task. Single nodeId remains backward compatible.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task internal id or displayId such as DVF-0120.' },
        fileKey: { type: 'string' },
        nodeId: { type: 'string', description: 'Single exact node id.' },
        nodeIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' }, description: 'Exact node ids to attach, max 8.' },
      },
      required: ['taskId', 'fileKey'],
      anyOf: [{ required: ['nodeId'] }, { required: ['nodeIds'] }],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: `/api/tasks/${encodePathSegment(String(args.taskId))}/figma-context`,
      body: { fileKey: args.fileKey, ...(Array.isArray(args.nodeIds) ? { nodeIds: args.nodeIds } : { nodeId: args.nodeId }) },
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
    description: 'Diagnostic/manual status inspection for a tool job. Normal completion callers should long-poll with get_tool_job_result instead of status polling.',
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
    description: 'Normal completion path for async jobs. Long-poll for terminal completion and return the final normalized result directly; use status/log only for diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        waitMs: { type: 'number', description: 'Bounded long-poll wait in milliseconds, capped at 30000.' },
      },
      required: ['jobId'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery(`/api/tool-jobs/${encodePathSegment(String(args.jobId))}/result`, { waitMs: args.waitMs }),
    }),
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

export function getToolSchema(name: string) {
  const tool = getToolDefinitionByName(name);
  if (!tool) {
    throw createApiError(404, 'TOOL_NOT_FOUND', `DevFlow tool '${name}' was not found.`, {
      affectedId: name,
      details: { nextAction: 'Use the advertised MCP tool list or call devflow_health_check for runtime capability diagnostics.' },
    });
  }
  return {
    name: tool.name,
    aliases: tool.aliases || [],
    description: tool.description,
    lightweight: tool.lightweight === true,
    executionPolicy: tool.executionPolicy,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  };
}

export type DevFlowToolProfile = 'full' | 'coding' | 'authoring' | 'review' | 'atlas' | 'diagnostics';

export const DEVFLOW_TOOL_PROFILES: DevFlowToolProfile[] = ['full', 'coding', 'authoring', 'review', 'atlas', 'diagnostics'];

export function resolveDevFlowToolProfile(value?: string) {
  const resolvedValue = resolveRuntimeMcpToolProfileValue(value);
  const configured = typeof resolvedValue === 'string' ? resolvedValue.trim() : '';
  if (!configured) return { profile: 'coding' as DevFlowToolProfile, configured: null, fallback: false };
  if (DEVFLOW_TOOL_PROFILES.includes(configured as DevFlowToolProfile)) {
    return { profile: configured as DevFlowToolProfile, configured, fallback: false };
  }
  return { profile: 'coding' as DevFlowToolProfile, configured, fallback: true };
}

const CODING_PROFILE_TOOLS = new Set([
  'get_tool_schema', 'devflow_health_check', 'list_projects',
  'search_tasks', 'create_task', 'get_task', 'update_task', 'move_task_to_status', 'toggle_task_checklist', 'open_task_bug',
  'sync_task_with_git', 'submit_task_for_review',
  'get_skill_router', 'get_authoring_skill', 'get_jira_authoring_bundle',
  'get_figma_authoring_context', 'attach_figma_context_to_task', 'get_project_atlas',
  'get_repo_context_bundle', 'list_local_files', 'read_local_file', 'read_file_snippets_batch', 'search_local_files',
  'write_local_file', 'edit_local_files_batch', 'prepare_compact_edit', 'apply_prepared_edit', 'apply_and_verify', 'delete_local_path', 'move_local_path',
  'run_project_command',
  'get_git_status', 'get_git_diff', 'get_git_log', 'get_git_show', 'get_git_branch', 'get_git_sync_status',
  'ensure_git_branch', 'commit_git_changes', 'push_git_branch', 'create_pull_request',
  'prepare_session_workspace', 'integrate_workspace', 'get_tool_job_result',
]);

const MCP_CONSOLIDATION_REPLACEMENTS: Record<string, string> = {
  get_capabilities: 'devflow_health_check',
  get_tool_call_summary: 'devflow_health_check',
  get_change_summary: 'get_git_status',
  get_schema: 'get_task',
  validate_task_quality: 'create_task/update_task',
  get_project_start_context: 'get_repo_context_bundle',
  repo_read_snapshot: 'get_repo_context_bundle',
  get_repo_inspection_index: 'get_repo_context_bundle',
  get_repo_context_delta: 'get_repo_context_bundle',
  get_repo_semantic_index: 'get_repo_context_bundle',
  list_tasks: 'search_tasks',
  get_task_images: 'get_task',
  batch_upsert_tasks: 'create_task/update_task',
  move_task_status: 'move_task_to_status',
  batch_move_task_status: 'move_task_to_status',
  batch_toggle_task_checklist: 'toggle_task_checklist',
  complete_task_review: 'move_task_to_status',
  get_authoring_skills: 'get_authoring_skill',
  list_skills: 'get_authoring_skill',
  get_skill: 'get_authoring_skill',
  update_skill: 'DevFlow Settings UI',
  safe_edit_local_file: 'edit_local_files_batch',
  prepare_edit_plan: 'prepare_compact_edit',
  apply_prepared_edit_plan: 'apply_prepared_edit',
  apply_patch: 'edit_local_files_batch',
  get_figma_file: 'get_figma_authoring_context',
  get_figma_node: 'get_figma_authoring_context',
  get_figma_design_spec: 'get_figma_authoring_context',
  get_project_atlas_status: 'get_project_atlas',
  apply_project_atlas_agent_update: 'get_project_atlas',
  parse_test_report: 'run_project_command',
  create_tool_job: 'normal async tool invocation',
  get_tool_job_status: 'get_tool_job_result',
  get_tool_job_log: 'devflow_health_check',
  cancel_tool_job: 'DevFlow runtime UI',
  list_prompt_skills: 'get_authoring_skill',
  get_prompt_skill: 'get_authoring_skill',
  update_prompt_override: 'DevFlow Settings UI',
  delete_prompt_override: 'DevFlow Settings UI',
};

export function getMcpConsolidationReplacement(name: string) {
  const canonical = getToolDefinitionByName(name)?.name || name;
  return MCP_CONSOLIDATION_REPLACEMENTS[canonical];
}

export function isToolExposedInMcp(name: string) {
  const canonical = getToolDefinitionByName(name)?.name || name;
  return MCP_CONSOLIDATION_REPLACEMENTS[canonical] === undefined;
}

export function isToolAllowedInProfile(name: string, profile: DevFlowToolProfile) {
  if (!isToolExposedInMcp(name)) return false;
  if (profile === 'full') return true;
  if (profile === 'coding') return CODING_PROFILE_TOOLS.has(name);
  if (profile === 'atlas') return name.includes('atlas') || ['get_repo_context_bundle', 'read_local_file', 'read_file_snippets_batch', 'search_local_files'].includes(name);
  if (profile === 'diagnostics') return /health|diagnostic|job|tool_call|restart/.test(name);
  if (profile === 'review') return /task|review|bug|git|diff|test_report|health|execution/.test(name);
  return /task|jira|figma|repo_context|repo_inspection|read_local|search_local|authoring|skill/.test(name);
}

const ASYNC_JOB_TOOL_GUIDANCE = '\n\nNote: This tool may run asynchronously and return a durable `jobId` before completion. When that happens, call `get_tool_job_result(jobId, waitMs=30000)` immediately and continue bounded polling in the same assistant turn until the job is terminal whenever the DevFlow tool surface remains available. Do not ask the user for another message merely to continue an already-started job. If the tool surface disappears, preserve and report the `jobId` so a refreshed connection can resume it.';

function deepFreezeJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJsonValue(entry);
    return Object.freeze(value) as T;
  }
  if (!value || typeof value !== 'object') return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreezeJsonValue(entry);
  return Object.freeze(value) as T;
}

function cloneAndFreezeJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreezeJsonValue(entry))) as T;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cloneAndFreezeJsonValue(entry)]),
  )) as T;
}

const mcpToolPresentationCache = new WeakMap<DevFlowToolDefinition, Readonly<{ description: string; outputSchema: any }>>();
const mcpToolListCache = new Map<DevFlowToolProfile, readonly any[]>();
let toolProfileSummaryCache: Readonly<Record<DevFlowToolProfile, { toolCount: number; schemaBytes: number }>> | undefined;
let capabilityToolCatalogCache: readonly any[] | undefined;
const capabilityCatalogCache = new Map<string, any>();

function getMcpToolPresentation(tool: DevFlowToolDefinition) {
  const cached = mcpToolPresentationCache.get(tool);
  if (cached) return cached;

  let description = tool.description;
  let outputSchema = cloneAndFreezeJsonValue(tool.outputSchema);
  if (tool.executionPolicy?.mode === 'job') {
    description = `${description}${ASYNC_JOB_TOOL_GUIDANCE}`;
    if (outputSchema) {
      outputSchema = deepFreezeJsonValue({
        type: 'object',
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
      });
    }
  }

  const presentation = Object.freeze({ description, outputSchema });
  mcpToolPresentationCache.set(tool, presentation);
  return presentation;
}

function getCapabilityToolCatalog() {
  if (capabilityToolCatalogCache) return capabilityToolCatalogCache;
  capabilityToolCatalogCache = Object.freeze(devFlowToolDefinitions.map((tool) => {
    const presentation = getMcpToolPresentation(tool);
    return deepFreezeJsonValue({
      name: tool.name,
      aliases: [...(tool.aliases || [])],
      description: presentation.description,
      lightweight: tool.lightweight === true,
      executionPolicy: cloneAndFreezeJsonValue(tool.executionPolicy),
      inputSchema: cloneAndFreezeJsonValue(tool.inputSchema),
      outputSchema: presentation.outputSchema,
    });
  }));
  return capabilityToolCatalogCache;
}

export function getMcpToolList(profile: DevFlowToolProfile = 'full') {
  const cached = mcpToolListCache.get(profile);
  if (cached) return cached;

  const tools = [];
  for (const tool of devFlowToolDefinitions) {
    if (!isToolAllowedInProfile(tool.name, profile)) continue;
    const inputSchema = buildMcpTransportInputSchema(tool.inputSchema);
    const presentation = getMcpToolPresentation(tool);

    tools.push(deepFreezeJsonValue({
      name: tool.name,
      description: presentation.description,
      inputSchema,
      outputSchema: presentation.outputSchema,
    }));
  }

  const immutableTools = Object.freeze(tools);
  mcpToolListCache.set(profile, immutableTools);
  return immutableTools;
}

function stableToolSurfaceJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '"__undefined__"';
  if (Array.isArray(value)) return `[${value.map(stableToolSurfaceJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableToolSurfaceJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function getMcpToolSurfaceIdentity(tools: readonly any[]) {
  const surface = tools
    .map((tool) => ({
      name: String(tool?.name || ''),
      inputSchema: tool?.inputSchema ?? null,
      outputSchema: tool?.outputSchema ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash('sha256').update(stableToolSurfaceJson(surface), 'utf8').digest('hex');
}

export function getToolProfileSummary() {
  if (toolProfileSummaryCache) return toolProfileSummaryCache;
  toolProfileSummaryCache = deepFreezeJsonValue(Object.fromEntries(DEVFLOW_TOOL_PROFILES.map((profile) => {
    const tools = getMcpToolList(profile);
    return [profile, {
      toolCount: tools.length,
      schemaBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
    }];
  })) as Record<DevFlowToolProfile, { toolCount: number; schemaBytes: number }>);
  return toolProfileSummaryCache;
}

export function getCapabilityCatalog() {
  const profileResolution = resolveDevFlowToolProfile();
  const cacheKey = `${profileResolution.profile}|${profileResolution.configured ?? ''}|${profileResolution.fallback ? '1' : '0'}`;
  const cached = capabilityCatalogCache.get(cacheKey);
  if (cached) return cached;

  const toolNames = new Set(devFlowToolDefinitions.map((tool) => tool.name));
  const activeProfileSummary = getToolProfileSummary()[profileResolution.profile];
  const activeToolSurfaceIdentity = getMcpToolSurfaceIdentity(getMcpToolList(profileResolution.profile));
  const hasTool = (name: string) => toolNames.has(name);
  const matrix = {
    git: {
      readBranch: hasTool('get_git_branch'),
      ensureBranch: hasTool('ensure_git_branch'),
      commit: hasTool('commit_git_changes'),
      push: hasTool('push_git_branch'),
      syncStatus: hasTool('get_git_sync_status'),
      changeSummary: hasTool('get_change_summary'),
    },
    files: {
      read: hasTool('read_local_file'),
      write: hasTool('write_local_file'),
      edit: hasTool('edit_local_files_batch'),
      delete: hasTool('delete_local_path'),
      move: hasTool('move_local_path'),
      structuredPatch: hasTool('apply_patch'),
    },
    commands: {
      verificationRunner: hasTool('run_project_command'),
      builtInPresets: hasTool('run_project_command'),
      repositoryPresets: hasTool('run_project_command'),
    },
    tasks: {
      syncGit: hasTool('sync_task_with_git'),
      reviewGate: hasTool('submit_task_for_review'),
      branchWarnings: hasTool('get_agent_task_context'),
      verificationEvidence: hasTool('sync_task_with_git'),
    },
    collaboration: {
      createPullRequest: hasTool('create_pull_request'),
    },
    runtime: {
      restart: hasTool('restart_devflow'),
      restartStatus: hasTool('get_devflow_restart_status'),
    },
    discovery: {
      exactToolSchema: hasTool('get_tool_schema'),
      capabilityCatalog: hasTool('get_capabilities'),
    },
  };
  const steps = {
    readContext: hasTool('get_repo_context_bundle'),
    ensureBranch: matrix.git.ensureBranch,
    guardedEdit: matrix.files.edit,
    verify: matrix.commands.verificationRunner,
    commit: matrix.git.commit,
    push: matrix.git.push,
    syncStatus: matrix.git.syncStatus,
    syncTask: matrix.tasks.syncGit,
    submitReview: matrix.tasks.reviewGate,
    createPullRequest: matrix.collaboration.createPullRequest,
  };
  const missingSteps = Object.entries(steps).filter(([, available]) => !available).map(([name]) => name);
  const catalog = deepFreezeJsonValue({
    contractVersion: DEVFLOW_CONTRACT_VERSION,
    mcpProfile: {
      active: profileResolution.profile,
      configured: profileResolution.configured,
      fallback: profileResolution.fallback,
      toolCount: activeProfileSummary.toolCount,
      schemaBytes: activeProfileSummary.schemaBytes,
      toolSurfaceIdentity: activeToolSurfaceIdentity,
      availableProfiles: [...DEVFLOW_TOOL_PROFILES],
    },
    matrix,
    workflow: {
      ready: missingSteps.length === 0,
      steps,
      missingSteps,
    },
    tools: getCapabilityToolCatalog(),
  });
  capabilityCatalogCache.set(cacheKey, catalog);
  return catalog;
}
