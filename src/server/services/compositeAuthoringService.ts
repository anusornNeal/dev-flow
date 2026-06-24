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

    // 3. Construct a Draft Payload
    const draftTaskPayload = {
      title: `[${jiraBundle.jira.key}] ${jiraBundle.jira.summary}`,
      description: jiraBundle.jira.descriptionText || '',
      category: 'general',
      priority: 'medium',
      jiraKey: jiraBundle.jira.key,
      targetFiles: repoHints?.likelyFiles || [],
    };

    return {
      draftPayload: draftTaskPayload,
      jiraContext: jiraBundle,
      repoHints: repoHints || { info: 'No project context provided or repo inspection failed.' },
      duplicates: jiraBundle.existingDevFlowTasks || [],
      message: 'Draft generated successfully. Please review the payload, fill missing fields, and call create_task with it.',
    };
  });
}
