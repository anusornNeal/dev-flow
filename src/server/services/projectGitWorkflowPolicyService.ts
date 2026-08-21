import fs from 'node:fs';
import path from 'node:path';
import type { GitWorkflowPolicy, Project, ResolvedGitWorkflowPolicy } from '../../types.js';
import { createApiError } from './api.js';

const DEFAULT_POLICY: ResolvedGitWorkflowPolicy = {
  integrationStrategy: 'rebase-ff',
  commitMessageTemplate: '[{ticket}] {type}: {title}',
  mergeMessageTemplate: 'Merge {ticket}',
};

export const REPOSITORY_PROJECT_POLICY_RELATIVE_PATH = '.devflow/project.json';
export const REPOSITORY_PROJECT_POLICY_MAX_BYTES = 100_000;
const REPOSITORY_PROJECT_POLICY_FIELDS = new Set(['version', 'gitWorkflowPolicy']);
const ALLOWED_TEMPLATE_FIELDS = new Set(['ticket', 'title', 'type']);
const MAX_TEMPLATE_LENGTH = 200;

type RepositoryProjectPolicy = {
  version: 1;
  gitWorkflowPolicy?: GitWorkflowPolicy;
};

type TaskTicketSource = {
  id?: string;
  displayId?: string;
  jiraKey?: string;
  title?: string;
  category?: string;
  type?: string;
};

type TemplateContext = {
  ticket: string;
  title: string;
  type: string;
};

type ProjectPolicyResolutionOptions = {
  repositoryRoot?: string | null;
};

function validateTemplate(value: unknown, field: 'commitMessageTemplate' | 'mergeMessageTemplate') {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw createApiError(400, 'PROJECT_GIT_POLICY_INVALID', `${field} must be a non-empty string when provided.`);
  }
  const template = value.trim();
  if (template.length > MAX_TEMPLATE_LENGTH) {
    throw createApiError(400, 'PROJECT_GIT_POLICY_INVALID', `${field} must be at most ${MAX_TEMPLATE_LENGTH} characters.`);
  }
  const placeholders = Array.from(template.matchAll(/\{([^{}]+)\}/g), (match) => match[1]);
  const unknown = placeholders.find((placeholder) => !ALLOWED_TEMPLATE_FIELDS.has(placeholder));
  if (unknown) {
    throw createApiError(400, 'PROJECT_GIT_POLICY_INVALID', `${field} contains unsupported placeholder {${unknown}}. Allowed placeholders: {ticket}, {title}, {type}.`);
  }
  const stripped = template.replace(/\{(?:ticket|title|type)\}/g, '');
  if (/[{}]/.test(stripped)) {
    throw createApiError(400, 'PROJECT_GIT_POLICY_INVALID', `${field} contains malformed template braces. Allowed placeholders: {ticket}, {title}, {type}.`);
  }
  return template;
}

export function validateGitWorkflowPolicy(value: unknown): GitWorkflowPolicy | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw createApiError(400, 'PROJECT_GIT_POLICY_INVALID', 'gitWorkflowPolicy must be an object when provided.');
  }
  const input = value as Record<string, unknown>;
  const knownFields = new Set(['integrationStrategy', 'commitMessageTemplate', 'mergeMessageTemplate']);
  const unknownField = Object.keys(input).find((key) => !knownFields.has(key));
  if (unknownField) {
    throw createApiError(400, 'PROJECT_GIT_POLICY_INVALID', `gitWorkflowPolicy contains unsupported field '${unknownField}'.`);
  }
  const strategy = input.integrationStrategy;
  if (strategy !== undefined && strategy !== 'rebase-ff' && strategy !== 'merge') {
    throw createApiError(400, 'PROJECT_GIT_POLICY_INVALID', "integrationStrategy must be either 'rebase-ff' or 'merge'.");
  }
  const commitMessageTemplate = validateTemplate(input.commitMessageTemplate, 'commitMessageTemplate');
  const mergeMessageTemplate = validateTemplate(input.mergeMessageTemplate, 'mergeMessageTemplate');
  const policy: GitWorkflowPolicy = {};
  if (strategy === 'rebase-ff' || strategy === 'merge') policy.integrationStrategy = strategy;
  if (commitMessageTemplate !== undefined) policy.commitMessageTemplate = commitMessageTemplate;
  if (mergeMessageTemplate !== undefined) policy.mergeMessageTemplate = mergeMessageTemplate;
  return policy;
}

function invalidRepositoryProjectPolicy(message: string, details?: Record<string, unknown>) {
  return createApiError(400, 'REPOSITORY_PROJECT_POLICY_INVALID', message, details ? { details } : undefined);
}

export function loadRepositoryProjectPolicy(repositoryRoot: string): RepositoryProjectPolicy | null {
  const root = String(repositoryRoot || '').trim();
  if (!root) return null;
  const policyPath = path.resolve(root, REPOSITORY_PROJECT_POLICY_RELATIVE_PATH);
  if (!fs.existsSync(policyPath)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(policyPath);
  } catch (error: any) {
    throw invalidRepositoryProjectPolicy(`Repository project policy '${REPOSITORY_PROJECT_POLICY_RELATIVE_PATH}' could not be inspected.`, {
      cause: String(error?.message || error || 'unknown file inspection failure'),
    });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw invalidRepositoryProjectPolicy(`Repository project policy '${REPOSITORY_PROJECT_POLICY_RELATIVE_PATH}' must be a regular non-symlink file.`);
  }
  if (stat.size > REPOSITORY_PROJECT_POLICY_MAX_BYTES) {
    throw createApiError(400, 'REPOSITORY_PROJECT_POLICY_TOO_LARGE', `Repository project policy must be ${REPOSITORY_PROJECT_POLICY_MAX_BYTES} bytes or less.`, {
      details: { path: REPOSITORY_PROJECT_POLICY_RELATIVE_PATH, size: stat.size },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (error: any) {
    throw invalidRepositoryProjectPolicy(`Repository project policy '${REPOSITORY_PROJECT_POLICY_RELATIVE_PATH}' must contain valid JSON.`, {
      cause: String(error?.message || error || 'invalid JSON'),
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidRepositoryProjectPolicy(`Repository project policy '${REPOSITORY_PROJECT_POLICY_RELATIVE_PATH}' must be a JSON object.`);
  }
  const input = parsed as Record<string, unknown>;
  const unknownField = Object.keys(input).find((key) => !REPOSITORY_PROJECT_POLICY_FIELDS.has(key));
  if (unknownField) {
    throw invalidRepositoryProjectPolicy(`Repository project policy contains unsupported field '${unknownField}'.`);
  }
  if (input.version !== 1) {
    throw invalidRepositoryProjectPolicy("Repository project policy 'version' must be exactly 1.");
  }

  let gitWorkflowPolicy: GitWorkflowPolicy | undefined;
  try {
    gitWorkflowPolicy = validateGitWorkflowPolicy(input.gitWorkflowPolicy);
  } catch (error: any) {
    throw invalidRepositoryProjectPolicy(`Repository project policy has invalid gitWorkflowPolicy: ${String(error?.message || error || 'invalid policy')}`, {
      causeCode: error?.payload?.code || null,
    });
  }
  return {
    version: 1,
    ...(gitWorkflowPolicy ? { gitWorkflowPolicy } : {}),
  };
}

export function resolveProjectGitWorkflowPolicy(
  project: Pick<Project, 'gitWorkflowPolicy'> | null | undefined,
  options: ProjectPolicyResolutionOptions = {},
): ResolvedGitWorkflowPolicy {
  const repositoryPolicy = options.repositoryRoot ? loadRepositoryProjectPolicy(options.repositoryRoot) : null;
  const policy = repositoryPolicy
    ? repositoryPolicy.gitWorkflowPolicy
    : validateGitWorkflowPolicy(project?.gitWorkflowPolicy);
  return {
    integrationStrategy: policy?.integrationStrategy ?? DEFAULT_POLICY.integrationStrategy,
    commitMessageTemplate: policy?.commitMessageTemplate ?? DEFAULT_POLICY.commitMessageTemplate,
    mergeMessageTemplate: policy?.mergeMessageTemplate ?? DEFAULT_POLICY.mergeMessageTemplate,
  };
}

export function resolveTaskTicketContext(task: TaskTicketSource): TemplateContext {
  return {
    ticket: String(task?.jiraKey || task?.displayId || task?.id || '').trim(),
    title: String(task?.title || '').trim(),
    type: String(task?.type || task?.category || 'Task').trim(),
  };
}

export function renderGitWorkflowTemplate(template: string, context: Partial<TemplateContext>) {
  const normalized = validateTemplate(template, 'commitMessageTemplate');
  if (!normalized) throw createApiError(400, 'PROJECT_GIT_POLICY_INVALID', 'Git workflow template must be a non-empty string.');
  return normalized.replace(/\{(ticket|title|type)\}/g, (_match, field: keyof TemplateContext) => {
    const value = String(context[field] || '').trim();
    if (!value) {
      throw createApiError(400, 'GIT_WORKFLOW_TEMPLATE_VALUE_REQUIRED', `Template requires '${field}' context, but no value was provided.`, {
        details: { field, template: normalized },
      });
    }
    return value;
  });
}

export function renderTaskCommitMessage(
  message: unknown,
  task: TaskTicketSource,
  project?: Pick<Project, 'gitWorkflowPolicy'> | null,
) {
  const raw = String(message || '').trim();
  if (!raw) {
    throw createApiError(400, 'GIT_COMMIT_MESSAGE_REQUIRED', 'Task-aware commit message must be a non-empty string.');
  }

  const withoutTicketPrefix = raw.replace(/^\[[^\]\r\n]+\]\s*/, '').trim();
  const conventional = withoutTicketPrefix.match(/^([A-Za-z][A-Za-z0-9-]*)(?:\([^)\r\n]+\))?!?:\s*([\s\S]+)$/);
  const type = String(conventional?.[1] || 'chore').trim().toLowerCase();
  const title = String(conventional?.[2] || withoutTicketPrefix).trim();
  if (!title) {
    throw createApiError(400, 'GIT_COMMIT_MESSAGE_REQUIRED', 'Task-aware commit description must be non-empty.');
  }

  const ticketContext = resolveTaskTicketContext(task);
  const policy = resolveProjectGitWorkflowPolicy(project);
  return renderGitWorkflowTemplate(policy.commitMessageTemplate, {
    ticket: ticketContext.ticket,
    type,
    title,
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function taskCommitSubjectMatchesPolicy(
  subject: unknown,
  task: TaskTicketSource,
  project?: Pick<Project, 'gitWorkflowPolicy'> | null,
) {
  const actual = String(subject || '').trim();
  if (!actual || /[\r\n]/.test(actual)) return false;
  const ticketContext = resolveTaskTicketContext(task);
  const template = resolveProjectGitWorkflowPolicy(project).commitMessageTemplate;
  let pattern = '^';
  let cursor = 0;
  for (const match of template.matchAll(/\{(ticket|title|type)\}/g)) {
    pattern += escapeRegExp(template.slice(cursor, match.index));
    const field = match[1] as keyof TemplateContext;
    if (field === 'ticket') {
      if (!ticketContext.ticket) return false;
      pattern += escapeRegExp(ticketContext.ticket);
    } else if (field === 'type') {
      pattern += '[a-z][a-z0-9-]*';
    } else {
      pattern += '[^\\r\\n]+';
    }
    cursor = (match.index || 0) + match[0].length;
  }
  pattern += `${escapeRegExp(template.slice(cursor))}$`;
  return new RegExp(pattern).test(actual);
}
