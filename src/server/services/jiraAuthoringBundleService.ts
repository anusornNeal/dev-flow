import type { AppState } from '../types.js';
import { getSettings } from '../repositories/settingsRepository.js';
import { getTasks } from '../repositories/taskRepository.js';
import { createApiError } from './api';

const JIRA_FIELDS = [
  'summary',
  'description',
  'issuetype',
  'priority',
  'status',
  'labels',
  'components',
  'environment',
  'comment',
  'attachment',
  'subtasks',
  'issuelinks',
  'parent',
].join(',');

type FetchLike = typeof fetch;

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function jiraDocToText(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(jiraDocToText).filter(Boolean).join('\n').trim();
  if (typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (value.type === 'hardBreak') return '\n';
  const content = Array.isArray(value.content)
    ? value.content.map(jiraDocToText).filter(Boolean).join(value.type === 'paragraph' ? '' : '\n')
    : '';
  return content.trim();
}

function compactIssue(issue: any) {
  const fields = issue?.fields || {};
  return {
    key: issue?.key,
    summary: cleanText(fields.summary),
    type: fields.issuetype?.name || '',
    priority: fields.priority?.name || '',
    status: fields.status?.name || '',
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    components: Array.isArray(fields.components) ? fields.components.map((entry: any) => entry.name).filter(Boolean) : [],
    descriptionText: jiraDocToText(fields.description),
    environmentText: jiraDocToText(fields.environment),
    browseUrl: issue?.self ? undefined : undefined,
  };
}

function collectRelatedIssues(fields: any) {
  const related = new Map<string, any>();
  const add = (issue: any, relationship: string) => {
    if (!issue?.key) return;
    related.set(issue.key, {
      key: issue.key,
      relationship,
      summary: issue.fields?.summary || '',
      status: issue.fields?.status?.name || '',
    });
  };

  add(fields.parent, 'parent');
  for (const subtask of Array.isArray(fields.subtasks) ? fields.subtasks : []) {
    add(subtask, 'subtask');
  }
  for (const link of Array.isArray(fields.issuelinks) ? fields.issuelinks : []) {
    add(link.outwardIssue || link.inwardIssue, link.type?.name || 'linked');
  }
  return Array.from(related.values());
}

function findExistingDevFlowTasks(jiraKey: string) {
  const key = jiraKey.toUpperCase();
  return (getTasks() || [])
    .filter((task: any) => String(task.jiraKey || '').toUpperCase() === key || String(task.title || '').toUpperCase().includes(key))
    .map((task: any) => ({
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      status: task.status,
      jiraKey: task.jiraKey,
      targetFiles: task.targetFiles || [],
    }));
}

function jiraAuthHeaders(email: string, token: string) {
  return {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
  };
}

export async function buildJiraAuthoringBundle(
  args: Record<string, any>,
  signalOrFetch?: AbortSignal | FetchLike,
  fetchImplArg?: FetchLike
) {
  const signal = typeof signalOrFetch === 'function' ? undefined : signalOrFetch;
  const fetchImpl = typeof signalOrFetch === 'function' ? signalOrFetch : (fetchImplArg || fetch);
  const jiraKey = String(args.jiraKey || args.issueKey || args.key || '').trim().toUpperCase();
  if (!jiraKey) {
    throw createApiError(400, 'JIRA_KEY_REQUIRED', 'jiraKey is required.');
  }

  const baseUrl = String(getSettings()?.jiraBaseUrl || process.env.JIRA_BASE_URL || '').trim().replace(/\/$/, '');
  const email = String(getSettings()?.jiraEmail || process.env.JIRA_EMAIL || '').trim();
  const token = String(getSettings()?.jiraToken || process.env.JIRA_API_TOKEN || process.env.JIRA_PERSONAL_ACCESS_TOKEN || '').trim();
  if (!baseUrl || !email || !token) {
    throw createApiError(400, 'JIRA_CONFIG_MISSING', 'Jira configuration is incomplete. Set jiraBaseUrl, jiraEmail, and jiraToken in DevFlow settings.');
  }

  const fields = typeof args.fields === 'string' && args.fields.trim() ? args.fields.trim() : JIRA_FIELDS;
  const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(jiraKey)}?fields=${encodeURIComponent(fields)}`;
  const response = await fetchImpl(url, { headers: jiraAuthHeaders(email, token), signal });
  if (!response.ok) {
    throw createApiError(response.status, 'JIRA_REQUEST_FAILED', `Jira request failed for ${jiraKey} with status ${response.status}.`, {
      affectedId: jiraKey,
      retryable: response.status >= 500,
    });
  }

  const issue = await response.json();
  const issueFields = issue.fields || {};
  const comments = Array.isArray(issueFields.comment?.comments)
    ? issueFields.comment.comments.map((comment: any) => ({
        author: comment.author?.displayName || '',
        created: comment.created || '',
        updated: comment.updated || '',
        bodyText: jiraDocToText(comment.body),
      })).filter((comment: any) => comment.bodyText)
    : [];
  const attachments = Array.isArray(issueFields.attachment)
    ? issueFields.attachment.map((attachment: any) => ({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
      }))
    : [];

  return {
    jira: compactIssue(issue),
    comments,
    attachments,
    relatedIssues: collectRelatedIssues(issueFields),
    existingDevFlowTasks: findExistingDevFlowTasks(jiraKey),
    authoringHints: [
      'Summarize Jira details into the DevFlow card; do not tell the implementer to reopen Jira.',
      'Use get_repo_inspection_index with the Jira summary, screen name, and visible strings before broad repo search.',
      'Read only likely target files, then write an Implementation map in repoContext.',
    ],
    nextSteps: [
      'Check existingDevFlowTasks before creating a duplicate card.',
      'Use the Jira text plus targeted repo inspection to fill description, targetFiles, checklist, acceptanceCriteria, verification, and repoContext.',
      'Run validate_task_quality before create_task or update_task for implementation-ready cards.',
    ],
  };
}
