import type { AppState } from '../types';
import { buildJiraAuthoringBundle } from './jiraAuthoringBundleService';
import { getRepoInspectionIndex } from './repoInspectionIndexService';
import { createApiError } from './api';

const DEFAULT_BUDGET_MS = 60000; // 60 seconds

function executeWithBudget<T>(budgetMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = controller.signal;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(createApiError(408, 'BUDGET_EXCEEDED', `Operation exceeded the time budget of ${budgetMs}ms.`));
    }, budgetMs);

    operation(signal)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function likelyFilesFromRepoHints(repoHints: any) {
  if (Array.isArray(repoHints?.likelyFiles)) return repoHints.likelyFiles.map(cleanText).filter(Boolean);
  if (Array.isArray(repoHints?.matches)) return repoHints.matches.map((entry: any) => cleanText(entry?.path)).filter(Boolean);
  return [];
}

function buildSplitSuggestion(jiraBundle: any, repoHints: any) {
  const jira = jiraBundle.jira || {};
  const likelyFiles = likelyFilesFromRepoHints(repoHints);
  const relatedIssues = Array.isArray(jiraBundle.relatedIssues) ? jiraBundle.relatedIssues : [];
  const joined = [
    jira.summary,
    jira.descriptionText,
    jira.environmentText,
    likelyFiles.join('\n'),
    relatedIssues.map((issue: any) => `${issue.relationship} ${issue.key} ${issue.summary}`).join('\n'),
  ].filter(Boolean).join('\n');

  const triggers: string[] = [];
  if (relatedIssues.some((issue: any) => ['subtask', 'parent'].includes(String(issue.relationship || '').toLowerCase()))) {
    triggers.push('Jira already has parent/subtask structure.');
  }
  if (/\b(frontend|ui|screen|compose|fragment|activity|viewmodel|navigation|route|layout)\b/i.test(joined)
    && /\b(backend|api|dto|model|mapper|repository|persistence|database|schema|cache|contract|service)\b/i.test(joined)) {
    triggers.push('Requirement appears to span frontend and backend/data layers.');
  }
  if (likelyFiles.length >= 6) {
    triggers.push('Repo hints include many likely files, which is a split trigger.');
  }

  const key = cleanText(jira.key) || 'JIRA-KEY';
  const summary = cleanText(jira.summary) || 'requested change';
  const normalizedFiles = likelyFiles.slice(0, 8);
  const frontendFiles = normalizedFiles.filter((file) => /screen|viewmodel|fragment|activity|compose|route|ui/i.test(file));
  const backendFiles = normalizedFiles.filter((file) => /api|dto|model|mapper|repository|service|schema|database|cache/i.test(file));
  const testFiles = normalizedFiles.filter((file) => /test|spec/i.test(file));
  const recommended = triggers.length > 0;

  const childCandidates = [
    {
      title: `${key} Define foundation and integration contract`,
      category: 'general',
      targetFiles: normalizedFiles.slice(0, 3),
      purpose: 'Confirm architecture, child boundaries, shared contracts, and final verification path.',
    },
    frontendFiles.length > 0 ? {
      title: `${key} Implement frontend/UI slice`,
      category: 'frontend',
      targetFiles: frontendFiles,
      purpose: 'Implement visible UI, navigation, state, copy, and screen behavior only.',
    } : null,
    backendFiles.length > 0 ? {
      title: `${key} Implement backend/data slice`,
      category: 'backend',
      targetFiles: backendFiles,
      purpose: 'Implement API, DTO/model, mapper, repository, persistence, or data contract behavior only.',
    } : null,
    testFiles.length > 0 ? {
      title: `${key} Add targeted verification slice`,
      category: 'general',
      targetFiles: testFiles,
      purpose: 'Add or update focused regression tests and verification commands.',
    } : null,
  ].filter(Boolean) as any[];

  const children = childCandidates.map((child, index) => ({
    ...child,
    status: 'backlog',
    branch: `${key.toLowerCase()}-${index === 0 ? 'foundation' : child.category}`.replace(/[^a-z0-9/-]+/g, '-'),
  }));

  return {
    recommended,
    triggers,
    defaultStatus: 'backlog',
    parent: {
      title: `${key} Foundation and child split for ${summary}`,
      status: 'backlog',
      category: 'general',
      purpose: 'Own source-of-truth requirement, child boundaries, integration, and final verification.',
    },
    children,
  };
}

function buildDraftRepoContext(splitSuggestion: any, repoHints: any) {
  const likelyFiles = likelyFilesFromRepoHints(repoHints);
  const childLines = splitSuggestion.children.length > 0
    ? splitSuggestion.children.map((child: any) => `- ${child.title} (${child.category}): ${child.purpose}`).join('\n')
    : '- Confirm whether this can remain one card or should split after targeted repo inspection.';
  return [
    'Implementation map:',
    '- File: likely target files from repo hints',
    '  Class/function: confirm exact classes/functions after reading target files.',
    '  Current behavior: summarize from Jira and targeted repo inspection before implementation.',
    '  Expected change: write the smallest safe change after target files are confirmed.',
    '',
    'Planned child breakdown:',
    childLines,
    '',
    likelyFiles.length > 0 ? `Repo hint files:\n- ${likelyFiles.slice(0, 8).join('\n- ')}` : 'Repo hint files: none yet.',
  ].join('\n');
}

export async function draftTaskFromJiraBundle(state: AppState, args: Record<string, any>) {
  const budgetMs = typeof args.budgetMs === 'number' ? args.budgetMs : DEFAULT_BUDGET_MS;

  return executeWithBudget(budgetMs, async (signal) => {
    // 1. Fetch Jira Context
    const jiraBundle = await buildJiraAuthoringBundle(args, signal);

    // 2. Fetch Repo Inspection Index (if project context is provided)
    let repoHints = null;
    const hasProjectContext = args.projectId || args.projectName || args.repo || args.repoUrl || args.localPath;

    if (hasProjectContext && jiraBundle.jira?.summary) {
      // Use Jira summary as query for repo inspection to get hints
      try {
        repoHints = await getRepoInspectionIndex(state, {
          ...args,
          q: jiraBundle.jira.summary,
          limit: args.limit || 10,
        }, signal);
      } catch (err) {
        // If repo inspection fails, we don't want to fail the whole composite tool, just omit hints
        console.error('Failed to fetch repo inspection index during composite authoring:', err);
      }
    }

    // 3. Construct a backlog-first draft payload plus split guidance.
    const splitSuggestion = buildSplitSuggestion(jiraBundle, repoHints);
    const draftTaskPayload = {
      title: splitSuggestion.recommended
        ? splitSuggestion.parent.title
        : `${jiraBundle.jira.key} ${jiraBundle.jira.summary}`,
      description: jiraBundle.jira.descriptionText || '',
      status: 'backlog',
      category: 'general',
      priority: 'medium',
      jiraKey: jiraBundle.jira.key,
      targetFiles: likelyFilesFromRepoHints(repoHints),
      reasoning: splitSuggestion.recommended
        ? `Backlog parent draft recommended because: ${splitSuggestion.triggers.join(' ')}`
        : 'Backlog draft. Move to todo only when the user explicitly asks to queue/start execution.',
      repoContext: buildDraftRepoContext(splitSuggestion, repoHints),
    };

    return {
      draftPayload: draftTaskPayload,
      splitSuggestion,
      jiraContext: jiraBundle,
      repoHints: repoHints || { info: 'No project context provided or repo inspection failed.' },
      duplicates: jiraBundle.existingDevFlowTasks || [],
      message: splitSuggestion.recommended
        ? 'Draft generated as a backlog parent candidate with child split suggestions. Review the parent/children before create_task or batch_upsert_tasks.'
        : 'Draft generated as backlog by default. Please review the payload, fill missing fields, and call create_task only when ready.',
    };
  });
}
