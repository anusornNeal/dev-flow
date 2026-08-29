import { randomUUID } from 'node:crypto';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { createApiError, sendApiError } from '../services/api';
import {
  applyTaskCategoryAndTagsUpdate,
  extractDesignImages,
  extractImages,
  normalizeTaskCategoryAndTags,
  resolveProjectIdFromRepo,
  validateAgentParams,
  validateTaskPayload,
} from '../services/taskService';
import { validateTaskQuality } from '../services/taskQualityService';
import { generateDisplayId, getTasks, saveTasksAtomic } from '../repositories/taskRepository.js';
import { buildIdempotencyFingerprint, withIdempotency } from '../services/lockAndIdempotencyService';
import { assertTaskPrerequisiteGraph, resolveTaskPrerequisiteIds } from '../services/taskDependencyService.js';

const MAX_TASK_SET_CHILDREN = 25;

type TaskSetRole = 'parent' | 'child';

type TaskSetFailure = {
  role: TaskSetRole;
  index: number;
  stage: 'shape' | 'linkage' | 'project' | 'agent' | 'quality';
  code: string;
  message: string;
  fields?: string[];
};

type PreparedEntry = {
  role: TaskSetRole;
  index: number;
  task: any;
};

function projectDefaults(body: any, parent: any) {
  const defaults: Record<string, unknown> = {};
  for (const key of ['projectId', 'projectName', 'repo', 'repoUrl', 'localPath']) {
    if (body?.[key] !== undefined) defaults[key] = body[key];
    else if (parent?.[key] !== undefined) defaults[key] = parent[key];
  }
  return defaults;
}

function withDefaults(item: any, defaults: Record<string, unknown>) {
  const next = { ...(item || {}) };
  for (const [key, value] of Object.entries(defaults)) {
    if (next[key] === undefined) next[key] = value;
  }
  return next;
}

function failure(role: TaskSetRole, index: number, stage: TaskSetFailure['stage'], code: string, message: string, fields?: string[]): TaskSetFailure {
  return { role, index, stage, code, message, ...(fields && fields.length > 0 ? { fields } : {}) };
}

function validationMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Validation failed');
}

function qualityFailureFields(errors: string[]) {
  const fields = new Set<string>();
  for (const error of errors) {
    const normalized = error.toLowerCase();
    if (normalized.includes('implementation map')) fields.add('repoContext');
    if (normalized.includes('targetfiles')) fields.add('targetFiles');
    if (normalized.includes('checklist')) fields.add('checklist');
    if (normalized.includes('status todo') || normalized.includes('default to backlog')) {
      fields.add('status');
      fields.add('reasoning');
    }
    if (normalized.includes('jira') || normalized.includes('external specs')) {
      fields.add('description');
      fields.add('repoContext');
    }
  }
  return [...fields];
}

function buildCandidate(item: any, projectId: string, id: string, parentId?: string) {
  const classification = normalizeTaskCategoryAndTags(item, { requireCategory: true });
  const now = new Date().toISOString();
  return {
    id,
    displayId: '',
    projectId,
    title: String(item.title || '').trim(),
    description: item.description || '',
    status: item.status || 'backlog',
    branch: item.branch || undefined,
    priority: item.priority || 'medium',
    category: classification.category,
    tags: classification.tags,
    targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : [],
    checklist: Array.isArray(item.checklist) ? item.checklist : [],
    designImages: extractDesignImages(item) || [],
    images: extractImages(item) || [],
    specUrl: item.specUrl || undefined,
    sourceUrl: item.sourceUrl || undefined,
    jiraKey: item.jiraKey || undefined,
    repo: item.repo || item.repoUrl || undefined,
    agent: item.agent || undefined,
    model: item.model || undefined,
    parentId: parentId ?? item.parentId ?? undefined,
    prerequisiteTaskIds: Array.isArray(item.prerequisiteTaskIds) ? [...item.prerequisiteTaskIds] : [],
    taskSetKey: typeof item.taskSetKey === 'string' ? item.taskSetKey.trim() : undefined,
    effort: item.effort || undefined,
    reasoning: item.reasoning || undefined,
    acceptanceCriteria: item.acceptanceCriteria || undefined,
    verification: item.verification || undefined,
    repoContext: item.repoContext || undefined,
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now,
    logs: [],
  };
}

function taskSummary(task: any) {
  return {
    id: task.id,
    displayId: task.displayId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    projectId: task.projectId,
    parentId: task.parentId,
    prerequisiteTaskIds: task.prerequisiteTaskIds,
  };
}

function responsePayload(req: express.Request, tasks: any[]) {
  const parent = tasks[0];
  const children = tasks.slice(1);
  const mode = String(req.query.responseMode || 'summary');
  if (mode === 'ack') {
    return { success: true, createdCount: tasks.length, parentId: parent.id, childCount: children.length };
  }
  if (mode === 'standard') {
    return { success: true, createdCount: tasks.length, parent, children, tasks };
  }
  return { success: true, createdCount: tasks.length, parent: taskSummary(parent), children: children.map(taskSummary) };
}

function preflightTaskSet(req: express.Request, deps: ApiRouteDeps) {
  const body = req.body || {};
  const parentInput = body.parent;
  const childrenInput = body.children;

  if (!parentInput || typeof parentInput !== 'object' || Array.isArray(parentInput)) {
    throw createApiError(400, 'TASK_SET_INVALID_SHAPE', 'Task-set authoring requires a parent object.');
  }
  if (!Array.isArray(childrenInput) || childrenInput.length === 0) {
    throw createApiError(400, 'TASK_SET_INVALID_SHAPE', 'Task-set authoring requires at least one child.');
  }
  if (childrenInput.length > MAX_TASK_SET_CHILDREN) {
    throw createApiError(400, 'TASK_SET_TOO_LARGE', `Task-set authoring supports at most ${MAX_TASK_SET_CHILDREN} children per request.`);
  }

  const parentId = `task-${randomUUID()}`;
  const defaults = projectDefaults(body, parentInput);
  const inheritedParent = withDefaults(parentInput, defaults);
  const rawEntries = [
    { role: 'parent' as const, index: 0, item: inheritedParent },
    ...childrenInput.map((rawChild: any, index: number) => ({
      role: 'child' as const,
      index,
      item: withDefaults({
        ...(rawChild || {}),
        agent: rawChild?.agent || inheritedParent.agent,
      }, defaults),
    })),
  ];

  const failures: TaskSetFailure[] = [];
  const prepared: PreparedEntry[] = [];
  let parentProjectId: string | null = null;

  for (const entry of rawEntries) {
    if (!entry.item || typeof entry.item !== 'object' || Array.isArray(entry.item)) {
      failures.push(failure(entry.role, entry.index, 'shape', 'TASK_SET_ITEM_INVALID', 'Task-set item must be an object.'));
      continue;
    }
    if (entry.role === 'child' && entry.item.parentId !== undefined) {
      failures.push(failure('child', entry.index, 'linkage', 'TASK_SET_CHILD_PARENT_CONFLICT', 'Child parentId is managed by the task-set contract and must not be supplied.', ['parentId']));
      continue;
    }

    const payloadError = validateTaskPayload(entry.item, false);
    if (payloadError) {
      failures.push(failure(entry.role, entry.index, 'shape', 'TASK_SET_PAYLOAD_INVALID', payloadError));
      continue;
    }

    let projectId = '';
    try {
      projectId = resolveProjectIdFromRepo(deps.state, entry.item, req);
    } catch (error) {
      failures.push(failure(entry.role, entry.index, 'project', 'TASK_SET_PROJECT_INVALID', validationMessage(error)));
      continue;
    }

    if (entry.role === 'parent') parentProjectId = projectId;
    if (entry.role === 'child' && parentProjectId && projectId !== parentProjectId) {
      failures.push(failure('child', entry.index, 'linkage', 'TASK_SET_PROJECT_CONFLICT', 'All children in a task set must resolve to the same project as the parent.', ['projectId', 'repo', 'repoUrl']));
      continue;
    }

    const agentError = validateAgentParams(entry.item, getTasks());
    if (agentError) {
      failures.push(failure(entry.role, entry.index, 'agent', 'TASK_SET_AGENT_INVALID', agentError));
      continue;
    }

    const id = entry.role === 'parent' ? parentId : `task-${randomUUID()}`;
    const candidate: any = buildCandidate(entry.item, projectId, id, entry.role === 'child' ? parentId : undefined);
    // Keep category/tag normalization aligned with the regular mutation path.
    const classification = applyTaskCategoryAndTagsUpdate(entry.item, candidate);
    candidate.category = classification.category;
    candidate.tags = classification.tags;

    const quality = validateTaskQuality(candidate);
    if (!quality.ok) {
      failures.push(failure(entry.role, entry.index, 'quality', 'TASK_SET_QUALITY_INVALID', quality.errors.join(' '), qualityFailureFields(quality.errors)));
      continue;
    }
    prepared.push({ role: entry.role, index: entry.index, task: candidate });
  }

  const localKeyToTaskId = new Map<string, string>();
  for (const entry of prepared) {
    const key = String(entry.task.taskSetKey || '').trim();
    if (!key) continue;
    const normalizedKey = key.toLowerCase();
    if (localKeyToTaskId.has(key) || localKeyToTaskId.has(normalizedKey)) {
      failures.push(failure(entry.role, entry.index, 'linkage', 'TASK_SET_KEY_DUPLICATE', `Duplicate taskSetKey '${key}'.`, ['taskSetKey']));
      continue;
    }
    localKeyToTaskId.set(key, entry.task.id);
    localKeyToTaskId.set(normalizedKey, entry.task.id);
  }

  if (failures.length > 0 || prepared.length !== rawEntries.length) {
    throw createApiError(400, 'TASK_SET_VALIDATION_FAILED', 'Task-set validation failed. No tasks were created.', { details: { failures } });
  }

  const existingTasks = getTasks();
  const allForResolution = [...existingTasks, ...prepared.map((entry) => entry.task)];
  try {
    for (const entry of prepared) {
      entry.task.prerequisiteTaskIds = resolveTaskPrerequisiteIds(entry.task, allForResolution, { localKeyToTaskId });
      delete entry.task.taskSetKey;
    }
    assertTaskPrerequisiteGraph([...existingTasks, ...prepared.map((entry) => entry.task)]);
  } catch (error: any) {
    throw createApiError(400, 'TASK_SET_VALIDATION_FAILED', 'Task-set prerequisite validation failed. No tasks were created.', {
      details: { failures: [failure('child', -1, 'linkage', error?.payload?.code || error?.code || 'TASK_PREREQUISITE_INVALID', validationMessage(error), ['prerequisiteTaskIds'])] },
    });
  }

  const tasks = prepared.map(({ task }) => ({
    ...task,
    displayId: generateDisplayId(deps.state, task.projectId),
    logs: [{
      id: `log-${Date.now()}-${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      message: task.parentId
        ? `Subtask initialized under parent task ${task.parentId} via atomic task-set authoring.`
        : 'Parent task initialized via atomic task-set authoring.',
      type: 'create',
    }],
  }));

  return tasks;
}

export function registerTaskSetAuthoringRoute(app: express.Express, deps: ApiRouteDeps) {
  app.post('/api/tasks/task-set', async (req, res) => {
    try {
      const fingerprint = buildIdempotencyFingerprint(req.method, req.path, req.body);
      const tasks = await withIdempotency(req.body?.idempotencyKey, fingerprint, async () => {
        const prepared = preflightTaskSet(req, deps);
        saveTasksAtomic(prepared);
        return prepared;
      });
      return res.status(201).json(responsePayload(req, tasks));
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}
