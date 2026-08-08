import {
  VALID_AGENTS,
  VALID_BUG_SEVERITIES,
  VALID_BUG_SOURCES,
  VALID_MODELS,
  VALID_STATUSES,
  VALID_TASK_CATEGORIES,
} from '../constants';

export type JsonSchema = Record<string, any>;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

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

export const emptyObjectSchema = { type: 'object', properties: {} };

export const booleanFlagSchema = {
  type: 'object',
  properties: {
    isAgentRequest: { type: 'boolean', description: 'Marks this as an agent-owned mutation that may bypass normal task locks.' },
    emergency: { type: 'boolean', description: 'Override task lock protections for emergency/manual recovery operations.' },
  },
};

export const mutationResponseModeProperty = {
  responseMode: { type: 'string', enum: ['standard', 'summary', 'ack'], description: 'Mutation response density. Use summary or ack for faster ChatGPT tool calls.' },
};

export const manualMoveOverrideProperties = {
  manualOverride: { type: 'boolean', description: 'Explicitly confirm bypassing soft workflow gates for a human/manual status move. Hard safety blockers remain enforced.' },
};

export const mutationControlProperties = {
  idempotencyKey: { type: 'string', description: 'Stable client-provided key for safe retries. Reusing the key with a different request returns IDEMPOTENCY_CONFLICT.' },
};

export const taskIdentifierProperty = {
  taskId: { type: 'string', description: 'Task internal id or displayId such as DVF-0120.' },
};

export const projectIdentifierProperties = {
  projectId: { type: 'string', description: 'Project internal id.' },
  projectName: { type: 'string', description: 'Project name when it is unique and safe to resolve.' },
  repo: { type: 'string', description: 'Repository URL or shorthand.' },
  repoUrl: { type: 'string', description: 'Repository URL.' },
  localPath: { type: 'string', description: 'Absolute local project path.' },
};

export const taskMutationProperties = {
  title: { type: 'string', description: 'Task title.' },
  description: { type: 'string', description: 'Task description in markdown.' },
  status: { type: 'string', enum: VALID_STATUSES, description: 'Task lane/status.' },
  priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority.' },
  branch: { type: 'string', description: 'Git branch name.' },
  category: { type: 'string', enum: VALID_TASK_CATEGORIES, description: 'Primary task type classification. Required for new tasks.' },
  tags: { type: 'array', items: { type: 'string' }, description: 'Optional free-form labels. Do not repeat the primary task type here.' },
  targetFiles: { type: 'array', items: { type: 'string' }, description: 'Relevant file paths.' },
  checklist: {
    type: 'array', description: 'Checklist items.', items: {
      type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, completed: { type: 'boolean' } }, required: ['id', 'text', 'completed'],
    },
  },
  effort: { type: 'string', description: 'Reasoning effort level. Valid values strictly depend on the selected agent/model pair.' },
  model: { type: 'string', enum: VALID_MODELS, description: 'Assigned model.' },
  agent: { type: 'string', enum: VALID_AGENTS, description: 'Assigned agent.' },
  parentId: { type: 'string', description: 'Parent task id.' },
  reasoning: { type: 'string', description: 'Reasoning/context.' },
  acceptanceCriteria: { type: 'string', description: 'Acceptance criteria.' },
  verification: { type: 'string', description: 'Verification steps.' },
  repoContext: { type: 'string', description: 'Repository context.' },
  specUrl: { type: 'string', description: 'Specification URL.' },
  images: {
    type: 'array', description: 'Attached images with local file paths.', items: {
      type: 'object', properties: {
        filename: { type: 'string' },
        absolutePath: { type: 'string', description: 'Use view_file on this path to see the image natively.' },
        url: { type: 'string' },
      },
    },
  },
  designImages: { type: 'array', items: { type: 'string' }, description: 'Legacy design image URLs or data.' },
  jiraKey: { type: 'string', description: 'Jira issue key.' },
  sourceUrl: { type: 'string', description: 'Source URL.' },
};

export const bugThreadMutationProperties = {
  title: { type: 'string', description: 'Bug or defect title to open under the existing task.' },
  source: { type: 'string', enum: VALID_BUG_SOURCES, description: 'Where the bug report came from.' },
  severity: { type: 'string', enum: VALID_BUG_SEVERITIES, description: 'Bug severity.' },
  actual: { type: 'string', description: 'Observed wrong behavior.' },
  expected: { type: 'string', description: 'Expected behavior.' },
  evidence: { type: 'string', description: 'Screenshot, review note, log excerpt, or other evidence summary.' },
  relatedAreas: { type: 'array', items: { type: 'string' }, description: 'Files, components, screens, or areas related to this bug.' },
  prompt: { type: 'string', description: 'Copy-ready fix prompt for the next bug-fix attempt. Defaults to the title when omitted.' },
  summary: { type: 'string', description: 'Optional version summary for the first bug thread entry.' },
  createdBy: { type: 'string', description: 'Who created the bug thread.' },
};

export function withQuery(path: string, query?: Record<string, string | number | boolean | undefined | null>) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export function encodePathSegment(value: string) { return encodeURIComponent(value); }

export function stripToolOnlyArgs(args: Record<string, any>, keys: string[]) {
  const copy = { ...args };
  for (const key of keys) delete copy[key];
  return copy;
}
