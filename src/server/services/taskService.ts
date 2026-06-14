import fs from 'fs';
import path from 'path';
import type { AgentCompletionPayload, AgentCompletionTest } from '../../types';
import type { AppState } from '../types';
import { VALID_AGENTS, LEGACY_VALID_EFFORTS_FALLBACK, VALID_MODELS, VALID_PRIORITIES, VALID_STATUSES } from '../constants';
import { validateEnum, validateString } from '../validation';
import { buildLaunchMetadataBlock, resolveAgentLaunchPlan } from './agentLaunchConfig';
import { getModelConfig } from '../../lib/agentsConfig';
import { resolveAgentExecutionMode } from './agentRunService';
import { getProjectRulesContext } from './projectRulesService';
import { renderPromptTemplate } from './promptTemplateService';

function normalizeRepoLike(value: string) {
  return value.trim().toLowerCase().replace(/\/$/, '');
}

export function findTaskByIdentifier(state: AppState, targetId: string) {
  return state.tasksCache.find((entry) => entry.id === targetId || entry.displayId === targetId) || null;
}

export function findProjectByIdentifier(state: AppState, input: {
  projectId?: string;
  projectName?: string;
  repo?: string;
  repoUrl?: string;
  localPath?: string;
}) {
  if (input.projectId) {
    const project = state.projectsCache.find((entry) => entry.id === input.projectId);
    if (project) return project;
  }

  if (input.projectName) {
    const normalizedName = input.projectName.trim().toLowerCase();
    const matches = state.projectsCache.filter((entry) => String(entry.name || '').trim().toLowerCase() === normalizedName);
    if (matches.length === 1) return matches[0];
  }

  const repoInput = input.repo || input.repoUrl;
  if (repoInput && typeof repoInput === 'string' && repoInput.trim()) {
    const cleanInput = normalizeRepoLike(repoInput);
    const project = state.projectsCache.find((entry) => {
      const cleanRepo = normalizeRepoLike(String(entry.repoUrl || ''));
      return cleanRepo === cleanInput || cleanRepo.includes(cleanInput) || cleanInput.includes(cleanRepo);
    });
    if (project) return project;
  }

  if (input.localPath) {
    const normalizedPath = path.resolve(input.localPath);
    const project = state.projectsCache.find((entry) => entry.localPath && path.resolve(entry.localPath) === normalizedPath);
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



  const modelErr = validateEnum(item.model, 'model', VALID_MODELS, false);
  if (modelErr) return modelErr;

  const agentErr = validateEnum(item.agent, 'agent', VALID_AGENTS, false);
  if (agentErr) return agentErr;

  if (item.tags !== undefined && !Array.isArray(item.tags)) return "Field 'tags' must be an array.";
  if (item.targetFiles !== undefined && !Array.isArray(item.targetFiles)) return "Field 'targetFiles' must be an array.";
  if (item.checklist !== undefined && !Array.isArray(item.checklist)) return "Field 'checklist' must be an array.";
  if (item.designImages !== undefined) {
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

export function extractDesignImages(item: any, currentTask?: any): string[] | undefined {
  if (item.designImages !== undefined) return item.designImages;
  if (item.designImage !== undefined) return item.designImage ? [item.designImage] : [];
  if (currentTask) return currentTask.designImages || (currentTask.designImage ? [currentTask.designImage] : undefined);
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
    const found = state.projectsCache.find((project) => project.id === explicitProjectId);
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

  const activeProject = state.projectsCache.find((project) => project.localPath && path.resolve(project.localPath) === path.resolve(process.cwd()));
  if (activeProject) {
    return activeProject.id;
  }

  throw new Error("Target project could not be resolved. Please provide a valid 'projectId' or repository identifier.");
}

export function getAgentTaskContext(state: AppState, targetId: string, includeLogs = false) {
  const task = findTaskByIdentifier(state, targetId);
  if (!task) return null;

  const subtasksRaw = state.tasksCache.filter((entry) => entry.parentId === task.id);
  const parentRaw = task.parentId ? state.tasksCache.find((entry) => entry.id === task.parentId) : null;

  const hasSubtasks = subtasksRaw.length > 0;
  let role = 'standalone';
  if (hasSubtasks) role = 'parent';
  else if (parentRaw) role = 'subtask';

  const project = state.projectsCache.find((entry) => entry.id === task.projectId);

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

