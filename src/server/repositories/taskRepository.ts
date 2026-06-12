import db from '../../db/index';
import type { AppState } from '../types';

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
  loadCounters(state);
  const rows = db.prepare('SELECT * FROM tasks').all() as any[];
  state.tasksCache = rows.map((item) => ({
    ...item,
    tags: item.tags ? JSON.parse(item.tags) : undefined,
    targetFiles: item.targetFiles ? JSON.parse(item.targetFiles) : undefined,
    checklist: item.checklist ? JSON.parse(item.checklist) : undefined,
    logs: item.logs ? JSON.parse(item.logs) : undefined,
    designImages: item.designImages ? JSON.parse(item.designImages) : undefined,
  }));
  console.log('Loaded ' + state.tasksCache.length + ' tasks from DB');
}

export function saveTasks(state: AppState) {
  const stmt = db.prepare('INSERT OR REPLACE INTO tasks (id, displayId, title, description, projectId, status, priority, branch, tags, targetFiles, checklist, effort, model, agent, parentId, reasoning, acceptanceCriteria, verification, repoContext, jiraKey, repo, createdAt, updatedAt, logs, designImages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
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
      stmt.run(
        item.id, item.displayId, item.title, item.description, item.projectId, item.status, item.priority, item.branch,
        item.tags ? JSON.stringify(item.tags) : null,
        item.targetFiles ? JSON.stringify(item.targetFiles) : null,
        item.checklist ? JSON.stringify(item.checklist) : null,
        item.effort, item.model, item.agent, item.parentId, item.reasoning, item.acceptanceCriteria, item.verification, item.repoContext, item.jiraKey, item.repo, item.createdAt, item.updatedAt,
        item.logs ? JSON.stringify(item.logs) : null,
        item.designImages ? JSON.stringify(item.designImages) : null,
      );
    }
  })();
}
