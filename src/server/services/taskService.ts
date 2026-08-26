import fs from 'fs';
import path from 'path';
import {
  getProject,
  getProjects,
  normalizeProjectLocalPathIdentity,
  normalizeProjectNameAlias,
  normalizeProjectRepoIdentity,
  projectsShareCanonicalRepository,
} from '../repositories/projectRepository.js';
import { getTasks } from '../repositories/taskRepository.js';
import { getLatestTaskFinalizationOperation } from '../repositories/taskFinalizationOperationRepository.js';
import { summarizeQualityDebt } from './qualityDebtService.js';
import type { AgentCompletionPayload, AgentCompletionTest, TaskCategory } from '../../types';
import type { AppState } from '../types';
import { VALID_AGENTS, LEGACY_VALID_EFFORTS_FALLBACK, VALID_MODELS, VALID_PRIORITIES, VALID_STATUSES, VALID_TASK_CATEGORIES } from '../constants';
import { validateEnum, validateString } from '../validation';
import { buildLaunchMetadataBlock, resolveAgentLaunchPlan } from './agentLaunchConfig';
import { getModelConfig } from '../../lib/agentsConfig';
import { resolveAgentExecutionMode } from './agentRunService';
import { isPromptValuePresent, renderPromptTemplate } from './promptTemplateService';
import { createApiError } from './api';
import { listTaskUiEvidenceForAgent } from './taskUiEvidenceService';
import { computeLifecycleAuthoritySnapshot } from './lifecycleAuthorityService.js';
import { getLatestExecutionCheckpoint } from './executionCheckpointService.js';
import { preflightHarnessExecutionGuard } from './harnessExecutionGuardService.js';
import { HARNESS_POLICY_VERSION } from './harnessPolicyService.js';
import { HARNESS_STRATEGY_VERSION, recommendHarnessStrategy } from './harnessStrategyService.js';

const TASK_CATEGORY_SET = new Set<string>(VALID_TASK_CATEGORIES);

function isTaskCategory(value: unknown): value is TaskCategory {
  return typeof value === 'string' && TASK_CATEGORY_SET.has(value);
}

function getLegacyCategoryTags(tags: string[]): TaskCategory[] {
  return [...new Set(tags.filter(isTaskCategory))] as TaskCategory[];
}

function inferCategoryFromText(item: { title?: unknown; description?: unknown; repoContext?: unknown; reasoning?: unknown }): TaskCategory | undefined {
  const haystack = [
    typeof item.title === 'string' ? item.title : '',
    typeof item.description === 'string' ? item.description : '',
    typeof item.repoContext === 'string' ? item.repoContext : '',
    typeof item.reasoning === 'string' ? item.reasoning : '',
  ].join(' ').toLowerCase();

  const hasFrontend = /\b(frontend|ui|ux|react|vite|css|component|modal|drawer|sidebar|card)\b/.test(haystack);
  const hasBackend = /\b(backend|api|server|sqlite|schema|repository|route|db|database|mcp|contract)\b/.test(haystack);

  if (hasFrontend === hasBackend) return undefined;
  return hasBackend ? 'backend' : 'frontend';
}

export function normalizeTaskCategoryAndTags(
  item: { category?: unknown; tags?: unknown; title?: unknown; description?: unknown; repoContext?: unknown; reasoning?: unknown },
  options?: {
    fallbackCategory?: TaskCategory;
    requireCategory?: boolean;
  },
): { category: TaskCategory; tags: string[] } {
  const rawTags = Array.isArray(item.tags)
    ? item.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : [];
  const legacyCategoryTags = getLegacyCategoryTags(rawTags);
  const inferredCategory = inferCategoryFromText(item);
  const resolvedCategory = isTaskCategory(item.category)
    ? item.category
    : legacyCategoryTags[0]
      || options?.fallbackCategory
      || inferredCategory;

  if (options?.requireCategory && !resolvedCategory) {
    throw new Error(`Field 'category' is required and must be one of: ${VALID_TASK_CATEGORIES.join(', ')}.`);
  }
  const category = resolvedCategory || 'general';

  return {
    category,
    tags: [...new Set(rawTags.filter((tag) => !TASK_CATEGORY_SET.has(tag)))],
  };
}

export function applyTaskCategoryAndTagsUpdate(
  updatePayload: any,
  currentTask: any
): { category: string; tags: string[] } {
  const hasCategory = updatePayload.category !== undefined;
  const hasTags = updatePayload.tags !== undefined;

  if (!hasCategory && !hasTags) {
    return {
      category: currentTask.category || 'general',
      tags: Array.isArray(currentTask.tags) ? currentTask.tags : [],
    };
  }

  const normalized = normalizeTaskCategoryAndTags(
    {
      ...updatePayload,
      tags: hasTags ? updatePayload.tags : currentTask.tags,
    },
    { fallbackCategory: currentTask.category }
  );

  return {
    category: normalized.category,
    tags: normalized.tags,
  };
}

export function findTaskByIdentifier(state: AppState, targetId: string) {
  return getTasks().find((entry) => entry.id === targetId || entry.displayId === targetId) || null;
}

function chooseCanonicalProject(matches: any[], identifier: string) {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const groups: any[][] = [];
  for (const candidate of matches) {
    const matchingGroupIndexes = groups
      .map((group, index) => group.some((entry) => projectsShareCanonicalRepository(entry, candidate)) ? index : -1)
      .filter((index) => index >= 0);
    if (matchingGroupIndexes.length === 0) {
      groups.push([candidate]);
      continue;
    }
    const primary = groups[matchingGroupIndexes[0]];
    primary.push(candidate);
    for (let index = matchingGroupIndexes.length - 1; index >= 1; index -= 1) {
      primary.push(...groups[matchingGroupIndexes[index]]);
      groups.splice(matchingGroupIndexes[index], 1);
    }
  }

  if (groups.length > 1) {
    throw createApiError(409, 'PROJECT_AMBIGUOUS', `More than one project matches '${identifier}'. Use projectId.`, {
      affectedId: identifier,
      retryable: false,
      details: {
        candidates: matches.map((project) => ({
          id: project.id,
          name: project.name,
          repoUrl: project.repoUrl || null,
          localPath: project.localPath || null,
        })),
      },
    });
  }

  return [...matches].sort((left, right) => {
    const createdCompare = String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    return createdCompare || String(left.id || '').localeCompare(String(right.id || ''));
  })[0];
}

export function findProjectByIdentifier(state: AppState, input: {
  projectId?: string;
  projectName?: string;
  repo?: string;
  repoUrl?: string;
  localPath?: string;
}) {
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  if (projectId) return getProject(projectId) || null;

  const projects = getProjects();
  const localPathInput = typeof input.localPath === 'string' ? input.localPath.trim() : '';
  if (localPathInput) {
    const normalizedPath = normalizeProjectLocalPathIdentity(localPathInput);
    const matches = projects.filter((entry) => normalizeProjectLocalPathIdentity(entry.localPath) === normalizedPath);
    return chooseCanonicalProject(matches, localPathInput);
  }

  const repoInput = typeof (input.repo || input.repoUrl) === 'string' ? String(input.repo || input.repoUrl).trim() : '';
  if (repoInput) {
    const normalizedRepo = normalizeProjectRepoIdentity(repoInput);
    const matches = projects.filter((entry) => normalizeProjectRepoIdentity(entry.repoUrl) === normalizedRepo);
    return chooseCanonicalProject(matches, repoInput);
  }

  const projectName = typeof input.projectName === 'string' ? input.projectName.trim() : '';
  if (projectName) {
    const normalizedName = normalizeProjectNameAlias(projectName);
    const matches = projects.filter((entry) => normalizeProjectNameAlias(entry.name) === normalizedName);
    return chooseCanonicalProject(matches, projectName);
  }

  return null;
}

export function validateTaskPayload(item: any, isUpdate = false): string | null {
  if (!item || typeof item !== 'object') return 'Task payload must be an object.';

  const titleErr = validateString(item.title, 'title', !isUpdate);
  if (titleErr) return titleErr;

  const statusErr = validateEnum(item.status, 'status', VALID_STATUSES, false);
  if (statusErr) return statusErr;

  const priorityErr = validateEnum(item.priority, 'priority', VALID_PRIORITIES, false);
  if (priorityErr) return priorityErr;
  const categoryErr = validateEnum(item.category, 'category', VALID_TASK_CATEGORIES, false);
  if (categoryErr) return categoryErr;

  const modelErr = validateEnum(item.model, 'model', VALID_MODELS, false);
  if (modelErr) return modelErr;

  const agentErr = validateEnum(item.agent, 'agent', VALID_AGENTS, false);
  if (agentErr) return agentErr;

  if (item.tags !== undefined && !Array.isArray(item.tags)) return "Field 'tags' must be an array.";
  if (Array.isArray(item.tags)) {
    const invalidTag = item.tags.find((tag: unknown) => typeof tag !== 'string' || !String(tag).trim());
    if (invalidTag !== undefined) {
      return "Field 'tags' must contain only non-empty strings.";
    }
  }
  const normalizedTags = Array.isArray(item.tags)
    ? item.tags.map((tag: string) => tag.trim()).filter(Boolean)
    : [];
  const legacyCategoryTags = getLegacyCategoryTags(normalizedTags);
  if (item.category === undefined && legacyCategoryTags.length > 1) {
    return "Field 'tags' can contain at most one legacy category tag when 'category' is omitted.";
  }
  if (!isUpdate && item.category === undefined && legacyCategoryTags.length === 0) {
    return `Field 'category' is required and must be one of: ${VALID_TASK_CATEGORIES.join(', ')}.`;
  }
  if (item.targetFiles !== undefined && !Array.isArray(item.targetFiles)) return "Field 'targetFiles' must be an array.";
  if (item.checklist !== undefined && !Array.isArray(item.checklist)) return "Field 'checklist' must be an array.";
  if (item.prerequisiteTaskIds !== undefined && !Array.isArray(item.prerequisiteTaskIds)) return "Field 'prerequisiteTaskIds' must be an array.";
  if (Array.isArray(item.prerequisiteTaskIds)) {
    if (item.prerequisiteTaskIds.length > 50) return "Field 'prerequisiteTaskIds' can contain at most 50 entries.";
    if (item.prerequisiteTaskIds.some((entry: unknown) => typeof entry !== 'string' || !String(entry).trim())) return "Field 'prerequisiteTaskIds' must contain only non-empty strings.";
  }
  if (item.designImages !== undefined && item.designImages !== null) {
    if (!Array.isArray(item.designImages)) return "Field 'designImages' must be an array.";
    if (item.designImages.length > 5) return "Field 'designImages' can contain at most 5 images.";
  }

  return null;
}

export function validateAgentParams(item: any, tasks: any[]): string | null {
  if (item.agent && !VALID_AGENTS.includes(item.agent)) {
    return `Invalid agent: ${item.agent}. Must be one of: ${VALID_AGENTS.join(', ')}`;
  }
  if (item.effort && !LEGACY_VALID_EFFORTS_FALLBACK.includes(item.effort)) {
    return `Invalid effort: ${item.effort}. Must be one of: ${LEGACY_VALID_EFFORTS_FALLBACK.join(', ')}`;
  }
  if (item.model && !VALID_MODELS.includes(item.model)) {
    return `Invalid model: ${item.model}. Must be one of: ${VALID_MODELS.join(', ')}`;
  }
  if (item.agent && item.model) {
    const config = getModelConfig(item.agent, item.model);
    if (config && item.effort && !config.availableEfforts.includes(item.effort)) {
      return `Invalid effort '${item.effort}' for model '${item.model}'. Must be one of: ${config.availableEfforts.join(', ')}`;
    }
  }
  if (item.agent && item.model) {
    const plan = resolveAgentLaunchPlan({
      agent: item.agent,
      model: item.model,
      effort: item.effort,
      executionMode: 'safe',
    });
    if (!plan.ok) return plan.error || `Invalid model ${item.model} for ${item.agent}.`;
  }

  if (item.parentId) {
    const parent = tasks.find((task) => task.id === item.parentId);
    if (parent && parent.agent && item.agent && item.agent !== parent.agent) {
      return `Subtask must use the same agent as its parent (${parent.agent}).`;
    }
  }

  return null;
}

export function extractImages(item: any, currentTask?: any): any[] | undefined {
  let imgs: any[] = [];
  if (item.images !== undefined) imgs = imgs.concat(item.images);
  
  // Auto-convert legacy fields in payload
  const legacy = item.designImages || (item.designImage ? [item.designImage] : undefined);
  if (legacy && legacy.length > 0) {
    for (const url of legacy) {
      imgs.push({ id: 'legacy-' + Math.random().toString(36).substr(2, 9), url, filename: 'legacy-design-image' });
    }
  }
  
  if (imgs.length > 0) return imgs;
  if (currentTask && currentTask.images !== undefined) return currentTask.images;
  return undefined;
}

export function extractDesignImages(item: any, currentTask?: any): string[] | undefined {
  if (item.designImages !== undefined) {
    return Array.isArray(item.designImages) ? item.designImages : undefined;
  }

  if (item.designImage !== undefined) {
    return typeof item.designImage === 'string' && item.designImage.trim()
      ? [item.designImage]
      : undefined;
  }

  if (currentTask && currentTask.designImages !== undefined) {
    return currentTask.designImages;
  }

  return undefined;
}

function validateAgentCompletionTest(item: any, index: number): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return `tests[${index}] must be an object.`;
  }
  const commandErr = validateString(item.command, `tests[${index}].command`, true);
  if (commandErr) return commandErr;
  const resultErr = validateEnum(item.result, `tests[${index}].result`, ['passed', 'failed', 'not-run'], true);
  if (resultErr) return resultErr;
  const outputErr = validateString(item.output, `tests[${index}].output`, false);
  if (outputErr) return outputErr;
  return null;
}

export function validateAgentCompletionPayload(payload: any): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'Completion payload must be an object.';
  }

  const runIdErr = validateString(payload.runId, 'runId', false);
  if (runIdErr) return runIdErr;
  const statusErr = validateEnum(payload.status, 'status', ['success', 'failed', 'cancelled'], true);
  if (statusErr) return statusErr;
  const summaryErr = validateString(payload.summary, 'summary', true);
  if (summaryErr) return summaryErr;
  const notesErr = validateString(payload.notes, 'notes', false);
  if (notesErr) return notesErr;
  const moveToErr = validateEnum(payload.moveTo, 'moveTo', ['backlog', 'todo', 'in-progress', 'ready-for-review'], false);
  if (moveToErr) return moveToErr;

  if (payload.changedFiles !== undefined) {
    if (!Array.isArray(payload.changedFiles)) return "Field 'changedFiles' must be an array.";
    const invalidChangedFile = payload.changedFiles.find((entry: any) => typeof entry !== 'string' || entry.trim() === '');
    if (invalidChangedFile !== undefined) return "Field 'changedFiles' must contain only non-empty strings.";
  }

  if (payload.tests !== undefined) {
    if (!Array.isArray(payload.tests)) return "Field 'tests' must be an array.";
    for (let index = 0; index < payload.tests.length; index += 1) {
      const error = validateAgentCompletionTest(payload.tests[index], index);
      if (error) return error;
    }
  }

  return null;
}

export function normalizeAgentCompletionPayload(payload: any): AgentCompletionPayload {
  return {
    runId: typeof payload.runId === 'string' && payload.runId.trim() ? payload.runId.trim() : undefined,
    status: payload.status,
    summary: String(payload.summary || '').trim(),
    changedFiles: Array.isArray(payload.changedFiles)
      ? payload.changedFiles.map((entry: string) => entry.trim()).filter(Boolean)
      : [],
    tests: Array.isArray(payload.tests)
      ? payload.tests.map((entry: AgentCompletionTest) => ({
          command: String(entry.command || '').trim(),
          result: entry.result,
          output: typeof entry.output === 'string' && entry.output.trim() ? entry.output.trim() : undefined,
        }))
      : [],
    notes: typeof payload.notes === 'string' && payload.notes.trim() ? payload.notes.trim() : undefined,
    moveTo: payload.moveTo || undefined,
  };
}

export function resolveProjectIdFromRepo(state: AppState, item: any, req: any): string {
  const explicitProjectId = typeof item.projectId === 'string' ? item.projectId.trim() : '';
  if (explicitProjectId) {
    if (explicitProjectId === 'project-default') {
      throw new Error("Creating tasks in the default project is no longer allowed. Please provide a valid 'projectId'.");
    }
    const found = getProject(explicitProjectId);
    if (found) {
      return found.id;
    }
    throw new Error(`Target project with ID '${explicitProjectId}' does not exist. Task creation blocked.`);
  }

  const project = findProjectByIdentifier(state, {
    projectName: item.projectName || req.body?.projectName || req.query?.projectName,
    repo: item.repo || req.body?.repo || req.query?.repo || req.headers?.['x-repo'],
    repoUrl: item.repoUrl || req.body?.repoUrl || req.query?.repoUrl || req.headers?.['x-repo-url'],
    localPath: item.localPath || req.body?.localPath || req.query?.localPath || req.headers?.['x-local-path'],
  });

  if (project) {
    return project.id;
  }

  const repoInput = item.repo || item.repoUrl || req.body?.repo || req.body?.repoUrl || req.query?.repo || req.query?.repoUrl || req.headers?.['x-repo'] || req.headers?.['x-repo-url'];
  const projectNameInput = item.projectName || req.body?.projectName || req.query?.projectName;
  const localPathInput = item.localPath || req.body?.localPath || req.query?.localPath || req.headers?.['x-local-path'];

  if (repoInput || projectNameInput || localPathInput) {
    const identifier = repoInput || projectNameInput || localPathInput;
    throw new Error(`Target project for identifier '${identifier}' does not exist. Please create the project first.`);
  }

  const activeProject = getProjects().find((project) => project.localPath && path.resolve(project.localPath) === path.resolve(process.cwd()));
  if (activeProject) {
    return activeProject.id;
  }

  throw new Error("Target project could not be resolved. Please provide a valid 'projectId' or repository identifier.");
}

const UNRESOLVED_AGENT_BUG_STATUSES = new Set(['open', 'fixing', 'fixed', 'reopened']);

function compactAgentContextText(value: unknown, maxLength = 2000) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`;
}

function buildCompactAgentBugSummary(task: any) {
  const bugs = Array.isArray(task.bugs) ? task.bugs : [];
  if (bugs.length === 0) return undefined;
  const unresolved = bugs
    .filter((bug: any) => UNRESOLVED_AGENT_BUG_STATUSES.has(String(bug?.status || '')))
    .sort((left: any, right: any) => {
      const latestTime = (bug: any) => {
        const versions = Array.isArray(bug?.versions) ? bug.versions : [];
        const latestVersion = versions[versions.length - 1];
        return Date.parse(latestVersion?.createdAt || bug?.updatedAt || bug?.createdAt || '') || 0;
      };
      return latestTime(right) - latestTime(left);
    });
  const latest = unresolved[0];
  const versions = Array.isArray(latest?.versions) ? latest.versions : [];
  const latestVersion = versions[versions.length - 1];
  return {
    unresolvedBugCount: unresolved.length,
    latestUnresolvedBug: latest ? {
      id: latest.id,
      title: latest.title,
      status: latest.status,
      severity: latest.severity,
      source: latest.source,
      actual: compactAgentContextText(latest.actual),
      expected: compactAgentContextText(latest.expected),
      relatedAreas: Array.isArray(latest.relatedAreas) ? latest.relatedAreas.slice(0, 20) : undefined,
      fixPrompt: compactAgentContextText(latestVersion?.prompt, 3000),
    } : null,
  };
}

export const CHATGPT_HARNESS_ENVELOPE_VERSION = 'chatgpt-harness-envelope.v1' as const;

const HARNESS_ACTION_PROBES = [
  { action: 'mutation', toolName: 'write_local_file' },
  { action: 'verification', toolName: 'run_project_command' },
  { action: 'commit', toolName: 'commit_task_owned_changes' },
  { action: 'finalization', toolName: 'finalize_task_workspace' },
] as const;

function harnessRiskForTask(task: any) {
  if (task?.priority === 'high') return 'high' as const;
  if (task?.priority === 'low') return 'low' as const;
  return 'medium' as const;
}

function harnessKindForTask(task: any) {
  const targets = Array.isArray(task?.targetFiles) ? task.targetFiles : [];
  const text = [task?.title, task?.description, ...(Array.isArray(task?.tags) ? task.tags : [])]
    .map((entry) => String(entry || '').toLowerCase())
    .join(' ');
  if (targets.length >= 5) return 'cross-module' as const;
  if (/\bbug|fix|defect|regression\b/.test(text)) return 'bug-fix' as const;
  if (task?.category === 'frontend' && targets.length <= 1) return 'small-ui' as const;
  return 'unknown' as const;
}

export function buildChatGptHarnessEnvelope(state: AppState, task: any) {
  let authority: ReturnType<typeof computeLifecycleAuthoritySnapshot> | null = null;
  let bindingError: string | null = null;
  try {
    authority = computeLifecycleAuthoritySnapshot(task.id, { workspaceId: task?.claim?.workspaceId });
  } catch (error: any) {
    bindingError = String(error?.code || error?.message || 'LIFECYCLE_AUTHORITY_UNAVAILABLE').slice(0, 160);
  }
  const workspaceId = authority?.workspace.selectedWorkspaceId || null;
  const currentExecution = authority?.execution.current || null;
  const session = currentExecution ? {
    id: currentExecution.id,
    repoRevision: currentExecution.repoRevision,
    contextHandle: currentExecution.contextHandle,
    lifecycle: { stage: currentExecution.lifecycleStage },
  } : null;

  const checkpoint = session ? getLatestExecutionCheckpoint(session.id) : null;
  const targetPath = Array.isArray(task?.targetFiles) && task.targetFiles.length > 0
    ? String(task.targetFiles[0])
    : 'README.md';
  const decisions = session && workspaceId && authority?.claim.active
    ? HARNESS_ACTION_PROBES.map(({ action, toolName }) => {
        const args: Record<string, any> = {
          workspaceId,
          taskId: task.id,
          harnessOperationId: `agent-context:${action}`,
        };
        if (action === 'mutation') args.filePath = targetPath;
        return { action, decision: preflightHarnessExecutionGuard(state, toolName, args) };
      })
    : [];
  const policy = decisions.find((entry) => entry.decision.policy)?.decision.policy || null;
  const deniedReasonCodes = decisions
    .filter((entry) => !entry.decision.allowed)
    .map((entry) => entry.decision.reasonCode)
    .filter(Boolean);
  const hardPolicyReasonCodes = new Set([
    'EXECUTION_BINDING_REQUIRED',
    'MANAGED_WORKSPACE_REQUIRED',
    'REPO_RELATIVE_PATH_SAFETY_REQUIRED',
    'TASK_OWNED_COMMIT_REQUIRED',
    'HARNESS_POLICY_STALE',
  ]);
  const hardBlockers = [...new Set([
    ...(authority?.guardrails.hardBlockers.map((entry) => entry.code) || []),
    ...deniedReasonCodes.filter((code) => hardPolicyReasonCodes.has(code)),
    ...(bindingError ? [bindingError] : []),
  ])].slice(0, 12);
  const terminalFinalization = task?.status === 'done'
    ? getLatestTaskFinalizationOperation(task.id)
    : null;
  const terminalDebtEntries = terminalFinalization?.status === 'completed'
    && Array.isArray(terminalFinalization.verification?.qualityDebt)
      ? terminalFinalization.verification.qualityDebt as any[]
      : null;
  const terminalQualityDebt = terminalDebtEntries === null
    ? null
    : summarizeQualityDebt(terminalDebtEntries);
  const liveQualityDebt = terminalQualityDebt ? [] : [
    ...(authority?.guardrails.debts.map((entry) => entry.code) || []),
    ...(Array.isArray(checkpoint?.blockers) ? checkpoint.blockers.map(String) : []),
    ...deniedReasonCodes.filter((code) => !hardPolicyReasonCodes.has(code)),
  ];
  const qualityDebt = [...new Set([
    ...(terminalQualityDebt?.codes || []),
    ...liveQualityDebt,
  ])].slice(0, 12);
  const warnings = [...new Set(authority?.guardrails.warnings.map((entry) => entry.code) || [])].slice(0, 12);

  const strategy = recommendHarnessStrategy({
    task: {
      risk: harnessRiskForTask(task),
      kind: harnessKindForTask(task),
      targetFileCount: Array.isArray(task?.targetFiles) ? task.targetFiles.length : undefined,
      sharedContract: Array.isArray(task?.targetFiles) ? task.targetFiles.length > 1 : undefined,
      hardSafetyAffected: hardBlockers.length > 0,
    },
    policy: policy ? {
      planningEvidence: policy.planningEvidence,
      verification: policy.verification,
      hardSafetyBlocked: hardBlockers.length > 0,
    } : undefined,
    rollout: { mode: 'shadow' },
  });

  const checkpointFreshness = !checkpoint
    ? 'missing'
    : !checkpoint.sourceRepoRevision || !session?.repoRevision || checkpoint.sourceRepoRevision === session.repoRevision
      ? 'fresh'
      : 'stale';
  const contextFreshness = !session?.contextHandle
    ? 'missing'
    : !checkpoint || checkpoint.contextHandle === session.contextHandle
      ? 'fresh'
      : 'stale';
  const allowedNextActionClasses = session
    ? decisions.filter((entry) => entry.decision.allowed).map((entry) => entry.action)
    : ['claim'];

  return {
    version: CHATGPT_HARNESS_ENVELOPE_VERSION,
    target: 'chatgpt',
    routing: 'chatgpt-only',
    execution: {
      claimed: authority?.claim.active === true,
      sessionId: session?.id || null,
      workspaceId: workspaceId || null,
      stage: session?.lifecycle?.stage || 'unclaimed',
      checkpointRef: checkpoint?.id || null,
      checkpointFreshness,
    },
    policy: {
      version: policy?.version || HARNESS_POLICY_VERSION,
      policyId: policy?.policyId || null,
      inputFingerprint: policy?.inputFingerprint || null,
      freshness: policy ? 'fresh' : 'unavailable',
    },
    strategy: {
      version: HARNESS_STRATEGY_VERSION,
      strategyVersion: strategy.strategyVersion,
      decisionId: strategy.decisionId,
      mode: strategy.rollout.mode,
      status: strategy.status,
      confidence: strategy.confidence,
      reasonCodes: strategy.reasonCodes.slice(0, 8),
    },
    context: {
      handle: session?.contextHandle || null,
      freshness: contextFreshness,
    },
    recovery: {
      checkpointRef: checkpoint?.id || null,
      pendingOperationIds: Array.isArray(checkpoint?.pendingOperations)
        ? checkpoint.pendingOperations.map((entry: any) => entry.operationId).filter(Boolean).slice(0, 8)
        : [],
    },
    authority: authority ? {
      version: authority.version,
      classification: authority.classification,
      hardReasonCodes: authority.guardrails.hardBlockers.map((entry) => entry.code),
      softReasonCodes: [...authority.guardrails.debts, ...authority.guardrails.warnings].map((entry) => entry.code),
      commitReady: authority.commit.ready,
    } : null,
    allowedNextActionClasses,
    hardBlockers,
    qualityDebt,
    terminalQualityDebt,
    warnings,
  };
}

export function getAgentTaskContext(state: AppState, targetId: string, includeLogs = false) {
  const task = findTaskByIdentifier(state, targetId);
  if (!task) return null;

  const subtasksRaw = getTasks().filter((entry) => entry.parentId === task.id);
  const parentRaw = task.parentId ? getTasks().find((entry) => entry.id === task.parentId) : null;

  const hasSubtasks = subtasksRaw.length > 0;
  let role = 'standalone';
  if (hasSubtasks) role = 'parent';
  else if (parentRaw) role = 'subtask';

  const project = getProjects().find((entry) => entry.id === task.projectId);

  const cleanObject = (value: any) => {
    const cleaned = { ...value };
    for (const key in cleaned) {
      if (
        cleaned[key] === undefined ||
        cleaned[key] === null ||
        cleaned[key] === '' ||
        (Array.isArray(cleaned[key]) && cleaned[key].length === 0) ||
        (typeof cleaned[key] === 'object' && !Array.isArray(cleaned[key]) && Object.keys(cleaned[key]).length === 0)
      ) {
        delete cleaned[key];
      }
    }
    return cleaned;
  };

  const agentContext: any = {
    task: cleanObject({
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      status: task.status,
      priority: task.priority,
      branch: task.branch,
      imagesApi: Array.isArray(task.images) && task.images.length > 0
        ? `**Attached Images API:** GET /api/tasks/${task.displayId || task.id}/images`
        : undefined,
    }),
    assignment: cleanObject({
      agent: task.agent,
      model: task.model,
      effort: task.effort,
    }),
    workspace: cleanObject({
      projectId: task.projectId,
      repo: task.repo || project?.repoUrl,
      localPath: project?.localPath,
    }),
    instruction: cleanObject({
      description: task.description,
      reasoning: task.reasoning,
    }),
    requirements: cleanObject({
      acceptanceCriteria: task.acceptanceCriteria,
      verification: task.verification,
      checklist: task.checklist,
      targetFiles: task.targetFiles,
      prerequisiteTaskIds: task.prerequisiteTaskIds,
    }),
    bugSummary: buildCompactAgentBugSummary(task),
    repoContext: task.repoContext || undefined,
    harness: buildChatGptHarnessEnvelope(state, task),
    orchestration: cleanObject({
      role,
      hasSubtasks,
      subtasks: hasSubtasks ? subtasksRaw.map((subtask) => cleanObject({
        id: subtask.id,
        displayId: subtask.displayId,
        title: subtask.title,
        status: subtask.status,
        priority: subtask.priority,
        branch: subtask.branch,
        targetFiles: subtask.targetFiles,
        prerequisiteTaskIds: subtask.prerequisiteTaskIds,
      })) : undefined,
      parentBoundary: parentRaw ? cleanObject({
        id: parentRaw.id,
        displayId: parentRaw.displayId,
        title: parentRaw.title,
        status: parentRaw.status,
        branch: parentRaw.branch,
        targetFiles: parentRaw.targetFiles,
      }) : undefined,
    }),
  };

  const uiEvidencePage = listTaskUiEvidenceForAgent(task.id, { limit: 5 });
  if (uiEvidencePage.items.length > 0) {
    agentContext.uiDesignEvidence = {
      items: uiEvidencePage.items.map((item: any) => ({
        evidenceId: item.evidenceId,
        previewId: item.previewId,
        title: item.title,
        frozenRevision: item.frozenRevision,
        latestRevision: item.latestRevision,
        current: item.current,
        attachedAt: item.attachedAt,
        frozenPreviewUrl: item.frozenPreviewUrl,
        latestPreviewUrl: item.latestPreviewUrl,
        screenshotUrl: item.screenshotUrl,
        primaryScreenId: item.primaryScreenId,
        primaryScreenSummary: item.primaryScreenSummary,
        specSummary: item.spec?.summary,
      })),
      nextCursor: uiEvidencePage.nextCursor,
      limit: uiEvidencePage.limit,
    };
  }

  if (includeLogs) {
    agentContext.logs = task.logs;
  }

  if (!agentContext.repoContext) delete agentContext.repoContext;
  if (Object.keys(agentContext.requirements).length === 0) delete agentContext.requirements;
  if (Object.keys(agentContext.assignment).length === 0) delete agentContext.assignment;

  return agentContext;
}

export function buildTaskPromptRenderContext(taskContext: NonNullable<ReturnType<typeof getAgentTaskContext>>, runId: string) {
  return {
    run: { id: runId },
    task: taskContext.task,
    assignment: taskContext.assignment || {},
    workspace: taskContext.workspace || {},
    instruction: taskContext.instruction || {},
    requirements: taskContext.requirements || {},
    repoContext: taskContext.repoContext || '',
    orchestration: taskContext.orchestration || {},
    agent: taskContext.assignment?.agent || '',
    model: taskContext.assignment?.model || '',
    effort: taskContext.assignment?.effort || '',
  };
}

function promptText(value: unknown): string {
  if (!isPromptValuePresent(value)) return '';
  return String(value).trim();
}

function buildCodexCardContext(task: any, taskContext: NonNullable<ReturnType<typeof getAgentTaskContext>>): string {
  const displayId = promptText(task.displayId) || promptText(task.id);
  const lines = ['## Task card', `- Display ID: ${displayId}`];
  if (promptText(task.id) && task.id !== displayId) lines.push(`- Task ID: ${task.id}`);
  lines.push(`- Title: ${promptText(task.title)}`);
  const repo = promptText(taskContext.workspace?.repo);
  if (repo) lines.push(`- Repository: ${repo}`);

  const addTextSection = (heading: string, value: unknown) => {
    const text = promptText(value);
    if (text) lines.push('', `## ${heading}`, text);
  };
  const addListSection = (heading: string, values: string[]) => {
    if (values.length > 0) lines.push('', `## ${heading}`, ...values.map((value) => `- ${value}`));
  };

  addTextSection('Description', task.description);
  addTextSection('Reasoning', task.reasoning);
  addTextSection('Acceptance criteria', task.acceptanceCriteria);
  const checklist = Array.isArray(task.checklist)
    ? task.checklist.filter((item: any) => promptText(item?.text)).map((item: any) => `[${item.completed ? 'x' : ' '}] ${promptText(item.text)}`)
    : [];
  addListSection('Checklist', checklist);
  addTextSection('Verification guidance', task.verification);
  addListSection('Target files', Array.isArray(task.targetFiles) ? task.targetFiles.map(promptText).filter(Boolean) : []);
  addTextSection('Repository context', task.repoContext);

  const references: string[] = [];
  if (promptText(task.sourceUrl)) references.push(`Source: ${promptText(task.sourceUrl)}`);
  if (promptText(task.specUrl)) references.push(`Spec: ${promptText(task.specUrl)}`);
  if (promptText(task.jiraKey)) references.push(`Jira: ${promptText(task.jiraKey)}`);
  addListSection('References', references);

  const evidence: string[] = [];
  if (Array.isArray(task.images)) {
    for (const image of task.images) {
      const label = promptText(image?.filename) || promptText(image?.id) || 'attached image';
      const ref = promptText(image?.url);
      evidence.push(ref ? `${label} — ${ref}` : label);
    }
  }
  if (Array.isArray((task as any).designImages)) {
    for (const designImage of (task as any).designImages) {
      const ref = promptText(designImage);
      if (ref) evidence.push(`Design image — ${ref}`);
    }
  }
  const uiItems = Array.isArray((taskContext as any).uiDesignEvidence?.items) ? (taskContext as any).uiDesignEvidence.items : [];
  for (const item of uiItems) {
    const label = promptText(item?.title) || promptText(item?.evidenceId) || 'UI design evidence';
    const ref = promptText(item?.screenshotUrl) || promptText(item?.frozenPreviewUrl) || promptText(item?.latestPreviewUrl);
    const summary = promptText(item?.primaryScreenSummary);
    evidence.push([label, ref, summary].filter(Boolean).join(' — '));
  }
  addListSection('Attached design/image evidence', evidence.filter(Boolean).slice(0, 5));
  return lines.join('\n');
}

export function renderCodexTaskPrompt(state: AppState, targetId: string) {
  const task = findTaskByIdentifier(state, targetId);
  if (!task) throw new Error('Task agent context could not be built.');
  const context = getAgentTaskContext(state, targetId, false);
  if (!context) throw new Error('Task agent context could not be built.');

  const renderContext = buildTaskPromptRenderContext(context, '');
  renderContext.workspace = context.workspace?.repo ? { repo: context.workspace.repo } : {};
  renderContext.repoContext = buildCodexCardContext(task, context);
  renderContext.agent = 'Codex';
  renderContext.model = '';
  renderContext.effort = '';
  renderContext.assignment = {};

  const renderResult = renderPromptTemplate('codex', renderContext);
  if (!renderResult.content.trim()) throw new Error('Task prompt could not be built.');
  return { context, renderResult };
}

export function renderTaskPrompt(state: AppState, targetId: string, options?: {
  runId?: string;
  includeLogs?: boolean;
}) {
  const context = getAgentTaskContext(state, targetId, options?.includeLogs ?? false);
  if (!context) {
    throw new Error('Task agent context could not be built.');
  }

  const renderResult = renderPromptTemplate('default', buildTaskPromptRenderContext(context, options?.runId || 'preview-run-id'));
  if (!renderResult.content.trim()) {
    throw new Error('Task prompt could not be built.');
  }

  return { context, renderResult };
}

