import db from '../../db/index';
import type { AppState } from '../types';
import { getActiveRunForTask, getLatestAgentRunForTask, listAgentRunsForTask } from './agentRunRepository';
import { normalizeTaskCategoryAndTags } from '../services/taskService';

const TASK_COLUMNS = [
  'id',
  'displayId',
  'title',
  'description',
  'projectId',
  'status',
  'priority',
  'branch',
  'category',
  'tags',
  'targetFiles',
  'checklist',
  'effort',
  'model',
  'agent',
  'parentId',
  'reasoning',
  'acceptanceCriteria',
  'verification',
  'repoContext',
  'jiraKey',
  'repo',
  'createdAt',
  'updatedAt',
  'logs',
  'designImages',
  'images',
] as const;

const TASK_UPSERT_SQL = `INSERT OR REPLACE INTO tasks (${TASK_COLUMNS.join(', ')}) VALUES (${TASK_COLUMNS.map(() => '?').join(', ')})`;

let categoryColumnEnsured = false;

function ensureTaskCategoryColumn() {
  const tableInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  const hasCategory = tableInfo.some((column) => column.name === 'category');
  if (!hasCategory) {
    db.prepare('ALTER TABLE tasks ADD COLUMN category TEXT').run();
  }
}

function loadCounters(state: AppState) {
  state.countersCache = {};
  const rows = db.prepare('SELECT prefix, count FROM counters').all() as Array<{ prefix: string; count: number }>;
  for (const row of rows) {
    state.countersCache[row.prefix] = row.count;
  }
}

function saveCounters(state: AppState) {
  const stmt = db.prepare('INSERT OR REPLACE INTO counters (prefix, count) VALUES (?, ?)');
  db.transaction(() => {
    for (const [prefix, count] of Object.entries(state.countersCache)) {
      stmt.run(prefix, count);
    }
  })();
}

export function generateDisplayId(state: AppState, projectId: string): string {
  const project = state.projectsCache.find((entry) => entry.id === projectId);

  let prefix = 'task';
  if (project && project.taskIdPrefix) {
    prefix = project.taskIdPrefix;
  } else if (project && project.name) {
    prefix = project.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  } else if (projectId) {
    prefix = projectId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }

  if (!prefix) prefix = 'task';

  let maxNum = state.countersCache[prefix] || 0;
  for (const task of state.tasksCache) {
    if (task.displayId && task.displayId.startsWith(prefix + '-')) {
      const numPart = task.displayId.split('-').pop();
      if (numPart && !Number.isNaN(parseInt(numPart, 10))) {
        maxNum = Math.max(maxNum, parseInt(numPart, 10));
      }
    }
  }
  state.countersCache[prefix] = maxNum;

  let newId = '';
  do {
    state.countersCache[prefix] += 1;
    newId = `${prefix}-${state.countersCache[prefix].toString().padStart(4, '0')}`;
  } while (state.tasksCache.some((task) => task.displayId === newId));

  saveCounters(state);
  return newId;
}

export function loadTasks(state: AppState) {
  ensureTaskCategoryColumn();
  loadCounters(state);
  const rows = db.prepare('SELECT * FROM tasks').all() as any[];
  state.tasksCache = rows.map((item) => ({
    ...item,
    tags: item.tags ? JSON.parse(item.tags) : [],
    targetFiles: item.targetFiles ? JSON.parse(item.targetFiles) : undefined,
    checklist: item.checklist ? JSON.parse(item.checklist) : undefined,
    logs: item.logs ? JSON.parse(item.logs) : undefined,
    images: (() => {
      let imgs = item.images ? JSON.parse(item.images) : [];
      // Auto-migrate legacy designImages if any
      const legacy = item.designImages ? JSON.parse(item.designImages) : [];
      if (legacy.length > 0) {
        for (const url of legacy) {
          imgs.push({ id: 'legacy-' + Math.random().toString(36).substr(2, 9), url, filename: 'legacy-design-image' });
        }
      }
      return imgs.length > 0 ? imgs : undefined;
    })(),
    ...normalizeTaskCategoryAndTags({
      category: item.category,
      tags: item.tags ? JSON.parse(item.tags) : [],
      title: item.title,
      description: item.description,
      repoContext: item.repoContext,
      reasoning: item.reasoning,
    }),
  })).map((task) => {
    const activeRun = getActiveRunForTask(task.id);
    const latestRun = getLatestAgentRunForTask(task.id);
    const allRuns = listAgentRunsForTask(task.id);
    return {
      ...task,
      activeAgent: activeRun?.agent || undefined,
      latestAgentRun: latestRun ? {
        id: latestRun.id,
        status: latestRun.status,
        agent: latestRun.agent,
        errorMessage: latestRun.errorMessage,
        createdAt: latestRun.createdAt,
        startedAt: latestRun.startedAt,
        endedAt: latestRun.endedAt,
      } : undefined,
      agentRuns: allRuns.map((r) => ({
        id: r.id,
        status: r.status,
        logFile: r.logPath,
      })),
    };
  });
  console.log('Loaded ' + state.tasksCache.length + ' tasks from DB');
}

function serializeTaskForRow(item: any) {
  const normalized = normalizeTaskCategoryAndTags({
    category: item.category,
    tags: item.tags,
    title: item.title,
    description: item.description,
    repoContext: item.repoContext,
    reasoning: item.reasoning,
  });

  return [
    item.id,
    item.displayId,
    item.title,
    item.description,
    item.projectId,
    item.status,
    item.priority,
    item.branch,
    normalized.category,
    normalized.tags.length > 0 ? JSON.stringify(normalized.tags) : null,
    item.targetFiles ? JSON.stringify(item.targetFiles) : null,
    item.checklist ? JSON.stringify(item.checklist) : null,
    item.effort,
    item.model,
    item.agent,
    item.parentId,
    item.reasoning,
    item.acceptanceCriteria,
    item.verification,
    item.repoContext,
    item.jiraKey,
    item.repo,
    item.createdAt,
    item.updatedAt,
    item.logs ? JSON.stringify(item.logs) : null,
    null,
    item.images ? JSON.stringify(item.images) : null,
  ];
}

export function saveTask(task: any) {
  ensureTaskCategoryColumn();
  db.prepare(TASK_UPSERT_SQL).run(...serializeTaskForRow(task));
}

export function deleteTasksByIds(taskIds: string[]) {
  if (taskIds.length === 0) return;
  const placeholders = taskIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...taskIds);
}

export function saveTasks(state: AppState) {
  ensureTaskCategoryColumn();
  const stmt = db.prepare(TASK_UPSERT_SQL);
  db.transaction(() => {
    const currentIds = state.tasksCache.map((task) => task.id);
    const tasksById = new Map(state.tasksCache.map((task) => [task.id, task]));
    const sortedTasks: any[] = [];
    const visited = new Set<string>();

    const visit = (taskId: string) => {
      if (visited.has(taskId)) return;
      visited.add(taskId);
      const task = tasksById.get(taskId);
      if (!task) return;
      if (task.parentId && tasksById.has(task.parentId)) {
        visit(task.parentId);
      }
      sortedTasks.push(task);
    };

    for (const task of state.tasksCache) {
      visit(task.id);
    }

    if (currentIds.length > 0) {
      const placeholders = currentIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM tasks WHERE id NOT IN (${placeholders})`).run(...currentIds);
    } else {
      db.prepare('DELETE FROM tasks').run();
    }
    for (const item of sortedTasks) {
      stmt.run(...serializeTaskForRow(item));
    }
  })();
}
