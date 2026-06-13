import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { VALID_AGENTS, VALID_EFFORTS, VALID_MODELS, VALID_PRIORITIES, VALID_STATUSES } from '../constants';
import { validateEnum, validateString } from '../validation';
import { buildLaunchMetadataBlock, resolveAgentLaunchPlan } from './agentLaunchConfig';
import { resolveAgentExecutionMode } from './agentRunService';
import { getProjectRulesContext } from './projectRulesService';
import { renderPromptTemplate } from './promptTemplateService';

export function validateTaskPayload(item: any, isUpdate = false): string | null {
  if (!item || typeof item !== 'object') return 'Task payload must be an object.';

  const titleErr = validateString(item.title, 'title', !isUpdate);
  if (titleErr) return titleErr;

  const statusErr = validateEnum(item.status, 'status', VALID_STATUSES, false);
  if (statusErr) return statusErr;

  const priorityErr = validateEnum(item.priority, 'priority', VALID_PRIORITIES, false);
  if (priorityErr) return priorityErr;

  const effortErr = validateEnum(item.effort, 'effort', VALID_EFFORTS, false);
  if (effortErr) return effortErr;

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
  if (item.effort && !VALID_EFFORTS.includes(item.effort)) {
    return `Invalid effort: ${item.effort}. Must be one of: ${VALID_EFFORTS.join(', ')}`;
  }
  if (item.model && !VALID_MODELS.includes(item.model)) {
    return `Invalid model: ${item.model}. Must be one of: ${VALID_MODELS.join(', ')}`;
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

export function resolveProjectIdFromRepo(state: AppState, item: any, req: any): string {
  if (item.projectId) {
    if (item.projectId === 'project-default') {
      throw new Error("Creating tasks in the default project is no longer allowed. Please provide a valid 'projectId'.");
    }
    const found = state.projectsCache.find((project) => project.id === item.projectId);
    if (found) {
      return found.id;
    }
    throw new Error(`Target project with ID '${item.projectId}' does not exist. Task creation blocked.`);
  }

  const repoInput = item.repo || item.repoUrl || (req.body && req.body.repo) || (req.body && req.body.repoUrl) || (req.query && req.query.repo) || (req.query && req.query.repoUrl) || (req.headers && req.headers['x-repo']) || (req.headers && req.headers['x-repo-url']);

  if (repoInput && typeof repoInput === 'string' && repoInput.trim()) {
    const cleanInput = repoInput.trim().toLowerCase().replace(/\/$/, '');

    const project = state.projectsCache.find((entry) => {
      const cleanRepo = entry.repoUrl.trim().toLowerCase().replace(/\/$/, '');
      return cleanRepo === cleanInput || cleanRepo.includes(cleanInput) || cleanInput.includes(cleanRepo);
    });

    if (project) {
      return project.id;
    }
    throw new Error(`Target project for repository '${repoInput}' does not exist. Please create the project first.`);
  }

  const activeProject = state.projectsCache.find((project) => project.localPath && path.resolve(project.localPath) === path.resolve(process.cwd()));
  if (activeProject) {
    return activeProject.id;
  }

  throw new Error("Target project could not be resolved. Please provide a valid 'projectId' or repository identifier.");
}

export function getAgentTaskContext(state: AppState, targetId: string, includeLogs = false) {
  const task = state.tasksCache.find((entry) => entry.id === targetId || entry.displayId === targetId);
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

