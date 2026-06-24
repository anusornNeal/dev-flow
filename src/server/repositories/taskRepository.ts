import { getProject } from './projectRepository.js';
import db from '../../db/index';
import type { AppState } from '../types';
import { ACTIVE_AGENT_RUN_STATUSES, type AgentRun } from './agentRunRepository';
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

const TASK_UPSERT_SQL = `
  INSERT INTO tasks (${TASK_COLUMNS.join(', ')})
  VALUES (${TASK_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(id) DO UPDATE SET
    displayId = excluded.displayId,
    title = excluded.title,
    description = excluded.description,
    projectId = excluded.projectId,
    status = excluded.status,
    priority = excluded.priority,
    branch = excluded.branch,
    category = excluded.category,
    tags = excluded.tags,
    targetFiles = excluded.targetFiles,
    checklist = excluded.checklist,
    effort = excluded.effort,
    model = excluded.model,
    agent = excluded.agent,
    parentId = excluded.parentId,
    reasoning = excluded.reasoning,
    acceptanceCriteria = excluded.acceptanceCriteria,
    verification = excluded.verification,
    repoContext = excluded.repoContext,
    jiraKey = excluded.jiraKey,
    repo = excluded.repo,
    createdAt = excluded.createdAt,
    updatedAt = excluded.updatedAt,
    logs = excluded.logs,
    designImages = excluded.designImages,
    images = excluded.images
`;

let categoryColumnEnsured = false;

function ensureTaskCategoryColumn() {
  if (categoryColumnEnsured) return;
  const tableInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  const hasCategory = tableInfo.some((column) => column.name === 'category');
  if (!hasCategory) {
    db.prepare('ALTER TABLE tasks ADD COLUMN category TEXT').run();
  }
  categoryColumnEnsured = true;
}

export function loadCounters(state: AppState) {
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
  const project = getProject(projectId);

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
  
  const tasksWithPrefix = db.prepare(`SELECT displayId FROM tasks WHERE displayId LIKE ?`).all(`${prefix}-%`) as any[];
  for (const task of tasksWithPrefix) {
    if (task.displayId) {
      const numPart = task.displayId.split('-').pop();
      if (numPart && !Number.isNaN(parseInt(numPart, 10))) {
        maxNum = Math.max(maxNum, parseInt(numPart, 10));
      }
    }
  }
  
  state.countersCache[prefix] = maxNum;

  let newId = '';
  const checkStmt = db.prepare('SELECT id FROM tasks WHERE displayId = ?');
  do {
    state.countersCache[prefix] += 1;
    newId = `${prefix}-${state.countersCache[prefix].toString().padStart(4, '0')}`;
  } while (checkStmt.get(newId));

  saveCounters(state);
  return newId;
}

function parseJsonArray(value: unknown): any[] {
  if (!value || typeof value !== 'string') return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseTaskRow(item: any, runsByTaskId: Map<string, AgentRun[]>) {
  const parsedTags = parseJsonArray(item.tags);
  const task = {
    ...item,
    tags: parsedTags,
    targetFiles: item.targetFiles ? JSON.parse(item.targetFiles) : undefined,
    checklist: item.checklist ? JSON.parse(item.checklist) : undefined,
    logs: item.logs ? JSON.parse(item.logs) : undefined,
    images: (() => {
      const imgs = parseJsonArray(item.images);
      const legacy = parseJsonArray(item.designImages);
      if (legacy.length > 0) {
        for (const url of legacy) {
          imgs.push({ id: 'legacy-' + Math.random().toString(36).substr(2, 9), url, filename: 'legacy-design-image' });
        }
      }
      return imgs.length > 0 ? imgs : undefined;
    })(),
    ...normalizeTaskCategoryAndTags({
      category: item.category,
      tags: parsedTags,
      title: item.title,
      description: item.description,
      repoContext: item.repoContext,
      reasoning: item.reasoning,
    }),
  };

  const taskRuns = runsByTaskId.get(task.id) || [];
  const activeRun = taskRuns.find(r => ACTIVE_AGENT_RUN_STATUSES.includes(r.status as any)) || null;
  const latestRun = taskRuns[0] || null;
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
    agentRuns: taskRuns.map((r: AgentRun) => ({
      id: r.id,
      status: r.status,
      logFile: r.logPath,
    })),
  };
}

function getAllAgentRunsByTaskId(taskIds?: string[]): Map<string, AgentRun[]> {
  let allAgentRuns: AgentRun[] = [];
  if (taskIds && taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(',');
    allAgentRuns = db.prepare(`SELECT * FROM agent_runs WHERE taskId IN (${placeholders}) ORDER BY createdAt DESC`).all(...taskIds) as AgentRun[];
  } else if (!taskIds) {
    allAgentRuns = db.prepare('SELECT * FROM agent_runs ORDER BY createdAt DESC').all() as AgentRun[];
  }

  const runsByTaskId = new Map<string, AgentRun[]>();
  for (const run of allAgentRuns) {
    const existing = runsByTaskId.get(run.taskId);
    if (existing) {
      existing.push(run);
    } else {
      runsByTaskId.set(run.taskId, [run]);
    }
  }
  return runsByTaskId;
}

export function getTasks(): any[] {
  ensureTaskCategoryColumn();
  const rows = db.prepare('SELECT * FROM tasks').all() as any[];
  const runsByTaskId = getAllAgentRunsByTaskId(rows.map(r => r.id));
  return rows.map(row => parseTaskRow(row, runsByTaskId));
}

export function getTask(id: string): any | undefined {
  ensureTaskCategoryColumn();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  if (!row) return undefined;
  const runsByTaskId = getAllAgentRunsByTaskId([id]);
  return parseTaskRow(row, runsByTaskId);
}

export function getTasksByProjectId(projectId: string): any[] {
  ensureTaskCategoryColumn();
  const rows = db.prepare('SELECT * FROM tasks WHERE projectId = ?').all(projectId) as any[];
  const runsByTaskId = getAllAgentRunsByTaskId(rows.map(r => r.id));
  return rows.map(row => parseTaskRow(row, runsByTaskId));
}

export function getPendingTasks(): any[] {
  ensureTaskCategoryColumn();
  const rows = db.prepare("SELECT * FROM tasks WHERE status = 'todo' AND agent IS NOT NULL AND agent != ''").all() as any[];
  const runsByTaskId = getAllAgentRunsByTaskId(rows.map(r => r.id));
  return rows.map(row => parseTaskRow(row, runsByTaskId));
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
    normalized.tags && normalized.tags.length > 0 ? JSON.stringify(normalized.tags) : null,
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

export function deleteTask(taskId: string) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
}

export function deleteTasksByIds(taskIds: string[]) {
  if (taskIds.length === 0) return;
  const placeholders = taskIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...taskIds);
}

export function deleteTasksByProjectId(projectId: string) {
  db.prepare('DELETE FROM tasks WHERE projectId = ?').run(projectId);
}
