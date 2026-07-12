import fs from 'fs';
import path from 'path';
import { getProject, getProjects } from '../repositories/projectRepository.js';
import { getTasks } from '../repositories/taskRepository.js';
import type { AgentCompletionPayload, AgentCompletionTest, TaskCategory } from '../../types';
import type { AppState } from '../types';
import { VALID_AGENTS, LEGACY_VALID_EFFORTS_FALLBACK, VALID_MODELS, VALID_PRIORITIES, VALID_STATUSES, VALID_TASK_CATEGORIES } from '../constants';
import { validateEnum, validateString } from '../validation';
import { buildLaunchMetadataBlock, resolveAgentLaunchPlan } from './agentLaunchConfig';
import { getModelConfig } from '../../lib/agentsConfig';
import { resolveAgentExecutionMode } from './agentRunService';
import { getProjectRulesContext } from './projectRulesService';
import { renderPromptTemplate } from './promptTemplateService';
import { getTaskFocusedAtlasContext } from './projectAtlasService';
import { buildTaskBugSummaryJson, renderTaskBugSummaryMarkdown } from '../../lib/bugThreadExport';

function normalizeRepoLike(value: string) {
  return value.trim().toLowerCase().replace(/\/$/, '');
}

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

export function findProjectByIdentifier(state: AppState, input: {
  projectId?: string;
  projectName?: string;
  repo?: string;
  repoUrl?: string;
  localPath?: string;
}) {
  if (input.projectId) {
    const project = getProject(input.projectId);
    if (project) return project;
  }

  if (input.projectName) {
    const normalizedName = input.projectName.trim().toLowerCase();
    const matches = getProjects().filter((entry) => String(entry.name || '').trim().toLowerCase() === normalizedName);
    if (matches.length === 1) return matches[0];
  }

  const repoInput = input.repo || input.repoUrl;
  if (repoInput && typeof repoInput === 'string' && repoInput.trim()) {
    const cleanInput = normalizeRepoLike(repoInput);
    const project = getProjects().find((entry) => {
      const cleanRepo = normalizeRepoLike(String(entry.repoUrl || ''));
      return cleanRepo === cleanInput || cleanRepo.includes(cleanInput) || cleanInput.includes(cleanRepo);
    });
    if (project) return project;
  }

  if (input.localPath) {
    const normalizedPath = path.resolve(input.localPath);
    const project = getProjects().find((entry) => entry.localPath && path.resolve(entry.localPath) === normalizedPath);
    if (project) return project;
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
    }),
    bugSummary: Array.isArray(task.bugs) && task.bugs.length > 0
      ? cleanObject({
          json: buildTaskBugSummaryJson(task),
          markdown: renderTaskBugSummaryMarkdown(task),
        })
      : undefined,
    projectRules: getProjectRulesContext(),
    repoContext: task.repoContext || undefined,
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
        spawnAgent: subtask.agent || 'Antigravity',
        spawnModel: subtask.model || 'Gemini 3.5 Flash',
        spawnEffort: subtask.effort || 'medium',
        instruction: cleanObject({
          description: subtask.description,
          reasoning: subtask.reasoning,
        }),
        acceptanceCriteria: subtask.acceptanceCriteria,
        verification: subtask.verification,
        checklist: subtask.checklist,
        targetFiles: subtask.targetFiles,
      })) : undefined,
      parentBoundary: parentRaw ? cleanObject({
        id: parentRaw.id,
        displayId: parentRaw.displayId,
        title: parentRaw.title,
        status: parentRaw.status,
        branch: parentRaw.branch,
        instruction: cleanObject({
          description: parentRaw.description,
        }),
      }) : undefined,
    }),
  };

  if (includeLogs) {
    agentContext.logs = task.logs;
  }

  if (project) {
    const projectAtlas = getTaskFocusedAtlasContext(project, task, {
      explicit: /\b(project atlas|attach atlas)\b/i.test([
        task.title,
        task.description,
        task.repoContext,
        task.reasoning,
      ].filter(Boolean).join(' ')),
    });
    if (projectAtlas) agentContext.projectAtlas = projectAtlas;
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
    projectRules: taskContext.projectRules || {},
    projectAtlas: taskContext.projectAtlas || {},
    repoContext: taskContext.repoContext || '',
    orchestration: taskContext.orchestration || {},
    agent: taskContext.assignment?.agent || '',
    model: taskContext.assignment?.model || '',
    effort: taskContext.assignment?.effort || '',
  };
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

