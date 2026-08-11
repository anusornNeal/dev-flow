import { getProject } from './projectRepository.js';
import db, { withDbTransaction } from '../../db/index';
import type { AppState } from '../types';
import { ACTIVE_AGENT_RUN_STATUSES, type AgentRun } from './agentRunRepository';
import { normalizeTaskCategoryAndTags } from '../services/taskService';
import { publishServerEvent } from '../services/serverEventService.js';

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
  'bugs',
  'gitEvidence',
  'verificationEvidence',
  'archivedAt',
  'claim',
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
    createdAt = COALESCE(tasks.createdAt, excluded.createdAt),
    updatedAt = excluded.updatedAt,
    logs = excluded.logs,
    designImages = excluded.designImages,
    images = excluded.images,
    bugs = excluded.bugs,
    gitEvidence = excluded.gitEvidence,
    verificationEvidence = excluded.verificationEvidence,
    archivedAt = COALESCE(excluded.archivedAt, tasks.archivedAt),
    claim = excluded.claim
`;

export class StaleTaskUpdateError extends Error {
  code = 'STALE_TASK_UPDATE';

  constructor(taskId: string) {
    super(`Task '${taskId}' has changed since it was read.`);
    this.name = 'StaleTaskUpdateError';
  }
}

let categoryColumnEnsured = false;
let bugsColumnEnsured = false;
let workflowEvidenceColumnsEnsured = false;
let archiveColumnEnsured = false;
const DISPLAY_ID_COUNTER_MAX = 999999;

function isSafeDisplayIdCounter(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= DISPLAY_ID_COUNTER_MAX;
}

export function parseDisplayIdCounter(displayId: string | null | undefined, prefix: string): number | null {
  if (!displayId || !displayId.startsWith(`${prefix}-`)) return null;
  const suffix = displayId.slice(prefix.length + 1);
  if (!/^\d{1,6}$/.test(suffix)) return null;
  const value = Number.parseInt(suffix, 10);
  return isSafeDisplayIdCounter(value) ? value : null;
}

function getDisplayIdPrefix(projectId: string): string {
  const project = getProject(projectId);

  let prefix = 'task';
  if (project && project.taskIdPrefix) {
    prefix = project.taskIdPrefix;
  } else if (project && project.name) {
    prefix = project.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  } else if (projectId) {
    prefix = projectId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }

  return prefix || 'task';
}

function getSafeCachedCounter(state: AppState, prefix: string): number {
  const cached = state.countersCache[prefix];
  return isSafeDisplayIdCounter(cached) ? cached : 0;
}

export function findHighestDisplayIdCounter(prefix: string, database = db): number {
  let maxNum = 0;
  const tasksWithPrefix = database.prepare('SELECT displayId FROM tasks WHERE displayId LIKE ?').all(`${prefix}-%`) as Array<{ displayId?: string | null }>;
  for (const task of tasksWithPrefix) {
    const parsed = parseDisplayIdCounter(task.displayId, prefix);
    if (parsed !== null) {
      maxNum = Math.max(maxNum, parsed);
    }
  }
  return maxNum;
}

export function repairDisplayIdsForPrefix(prefix: string, database = db): number {
  let nextCounter = findHighestDisplayIdCounter(prefix, database);
  const pollutedTasks = database.prepare(`
    SELECT id, displayId
    FROM tasks
    WHERE displayId LIKE ?
    ORDER BY datetime(COALESCE(createdAt, updatedAt)) ASC, id ASC
  `).all(`${prefix}-%`) as Array<{ id: string; displayId?: string | null }>;

  const updateTaskDisplayId = database.prepare('UPDATE tasks SET displayId = ?, updatedAt = ? WHERE id = ?');
  for (const task of pollutedTasks) {
    if (parseDisplayIdCounter(task.displayId, prefix) !== null) continue;
    nextCounter += 1;
    updateTaskDisplayId.run(`${prefix}-${nextCounter.toString().padStart(4, '0')}`, new Date().toISOString(), task.id);
  }

  database.prepare(`
    INSERT INTO counters (prefix, count)
    VALUES (?, ?)
    ON CONFLICT(prefix) DO UPDATE SET count = excluded.count
  `).run(prefix, nextCounter);

  return nextCounter;
}

function ensureTaskCategoryColumn() {
  if (categoryColumnEnsured) return;
  const tableInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  const hasCategory = tableInfo.some((column) => column.name === 'category');
  if (!hasCategory) {
    db.prepare('ALTER TABLE tasks ADD COLUMN category TEXT').run();
  }
  categoryColumnEnsured = true;
}

function ensureTaskBugsColumn() {
  if (bugsColumnEnsured) return;
  const tableInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  const hasBugs = tableInfo.some((column) => column.name === 'bugs');
  if (!hasBugs) {
    db.prepare('ALTER TABLE tasks ADD COLUMN bugs TEXT').run();
  }
  bugsColumnEnsured = true;
}

function ensureTaskWorkflowEvidenceColumns() {
  if (workflowEvidenceColumnsEnsured) return;
  const tableInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  const columns = new Set(tableInfo.map((column) => column.name));
  if (!columns.has('gitEvidence')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN gitEvidence TEXT').run();
  }
  if (!columns.has('verificationEvidence')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN verificationEvidence TEXT').run();
  }
  workflowEvidenceColumnsEnsured = true;
}

function ensureTaskArchiveColumn() {
  if (archiveColumnEnsured) return;
  const tableInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  const columns = new Set(tableInfo.map((column) => column.name));
  if (!columns.has('archivedAt')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN archivedAt TEXT').run();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_board_page
      ON tasks(projectId, status, archivedAt, parentId, createdAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_archive_age
      ON tasks(status, archivedAt, updatedAt);
  `);
  archiveColumnEnsured = true;
}

function ensureTaskColumns() {
  ensureTaskCategoryColumn();
  ensureTaskBugsColumn();
  ensureTaskWorkflowEvidenceColumns();
  ensureTaskArchiveColumn();
}

export function loadCounters(state: AppState) {
  state.countersCache = {};
  const rows = db.prepare('SELECT prefix, count FROM counters').all() as Array<{ prefix: string; count: number }>;
  for (const row of rows) {
    state.countersCache[row.prefix] = row.count;
  }
}

function saveCounters(state: AppState) {
  const stmt = db.prepare('INSERT INTO counters (prefix, count) VALUES (?, ?) ON CONFLICT(prefix) DO UPDATE SET count = excluded.count');
  withDbTransaction(() => {
    for (const [prefix, count] of Object.entries(state.countersCache)) {
      stmt.run(prefix, count);
    }
  });
}

export function generateDisplayId(state: AppState, projectId: string): string {
  const prefix = getDisplayIdPrefix(projectId);

  return withDbTransaction(() => {
    let maxNum = Math.max(getSafeCachedCounter(state, prefix), findHighestDisplayIdCounter(prefix));
    state.countersCache[prefix] = maxNum;

    let newId = '';
    const checkStmt = db.prepare('SELECT id FROM tasks WHERE displayId = ?');
    do {
      state.countersCache[prefix] += 1;
      newId = `${prefix}-${state.countersCache[prefix].toString().padStart(4, '0')}`;
    } while (checkStmt.get(newId));

    saveCounters(state);
    return newId;
  });
}

export function resolveDisplayIdForNewTask(state: AppState, projectId: string, suppliedDisplayId: unknown): string {
  const displayId = typeof suppliedDisplayId === 'string' ? suppliedDisplayId.trim() : '';
  if (!displayId) return generateDisplayId(state, projectId);

  const prefix = getDisplayIdPrefix(projectId);
  if (displayId.startsWith(`${prefix}-`) && parseDisplayIdCounter(displayId, prefix) === null) {
    return generateDisplayId(state, projectId);
  }

  return displayId;
}

function parseJsonArray(value: unknown): any[] {
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseTaskRow(item: any, runsByTaskId: Map<string, AgentRun[]>) {
  const parsedTags = parseJsonArray(item.tags);
  const task = {
    ...item,    hasUiDesign: item.hasUiDesign === undefined ? undefined : Boolean(item.hasUiDesign),
    tags: parsedTags,
    targetFiles: parseJsonArray(item.targetFiles),
    checklist: parseJsonArray(item.checklist),
    logs: parseJsonArray(item.logs),
    bugs: parseJsonArray(item.bugs),
    gitEvidence: parseJsonObject(item.gitEvidence),
    verificationEvidence: parseJsonArray(item.verificationEvidence),
    claim: parseJsonObject(item.claim),
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
  ensureTaskColumns();
  const rows = db.prepare('SELECT * FROM tasks').all() as any[];
  const runsByTaskId = getAllAgentRunsByTaskId(rows.map(r => r.id));
  return rows.map(row => parseTaskRow(row, runsByTaskId));
}

export function getTask(id: string): any | undefined {
  ensureTaskColumns();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  if (!row) return undefined;
  const runsByTaskId = getAllAgentRunsByTaskId([id]);
  return parseTaskRow(row, runsByTaskId);
}

export type TaskSingleReadMode = 'minimal' | 'summary' | 'standard' | 'full';

function getTaskRowByIdentifier(identifier: string, columns: string) {
  return db.prepare(`
    SELECT ${columns}
    FROM tasks
    WHERE id = ? OR displayId = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(identifier, identifier, identifier) as any | undefined;
}

export function getTaskByIdentifier(identifier: string, mode: TaskSingleReadMode = 'full'): any | undefined {
  ensureTaskColumns();
  if (mode === 'minimal') {
    return getTaskRowByIdentifier(identifier, 'id, displayId, title, status, projectId');
  }

  if (mode === 'summary') {
    const row = getTaskRowByIdentifier(
      identifier,
      'id, displayId, title, status, priority, projectId, parentId, agent, model, effort, updatedAt, archivedAt, bugs, claim',
    );
    if (!row) return undefined;
    const latestRun = db.prepare(`
      SELECT id, status, agent, errorMessage, createdAt, startedAt, endedAt
      FROM agent_runs
      WHERE taskId = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `).get(row.id) as Partial<AgentRun> | undefined;
    return {
      ...row,
      bugs: parseJsonArray(row.bugs),
      claim: parseJsonObject(row.claim),
      latestAgentRun: latestRun || undefined,
    };
  }

  const row = getTaskRowByIdentifier(identifier, '*');
  if (!row) return undefined;
  const runsByTaskId = getAllAgentRunsByTaskId([row.id]);
  return parseTaskRow(row, runsByTaskId);
}

export function getTasksByProjectId(projectId: string): any[] {
  ensureTaskColumns();
  const rows = db.prepare('SELECT * FROM tasks WHERE projectId = ?').all(projectId) as any[];
  const runsByTaskId = getAllAgentRunsByTaskId(rows.map(r => r.id));
  return rows.map(row => parseTaskRow(row, runsByTaskId));
}

export type TaskBoardPageOptions = {
  projectId?: string;
  status?: string;
  parentId?: string;
  query?: string;
  archived?: boolean;
  limit?: number;
  offset?: number;
};

export function queryTaskBoardPage(options: TaskBoardPageOptions) {
  ensureTaskColumns();
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(500, Number(options.limit))) : 25;
  const offset = Number.isFinite(Number(options.offset)) ? Math.max(0, Math.floor(Number(options.offset))) : 0;
  const archived = options.archived === true;
  const where: string[] = [archived ? 'archivedAt IS NOT NULL' : 'archivedAt IS NULL'];
  const params: any[] = [];

  if (options.projectId) {
    where.push('projectId = ?');
    params.push(options.projectId);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.parentId) {
    where.push('parentId = ?');
    params.push(options.parentId);
  } else {
    where.push("(parentId IS NULL OR parentId = '')");
  }
  const query = String(options.query || '').trim().toLowerCase();
  if (query) {
    const like = `%${query}%`;
    where.push(`LOWER(COALESCE(id, '') || ' ' || COALESCE(displayId, '') || ' ' || COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(reasoning, '') || ' ' || COALESCE(acceptanceCriteria, '') || ' ' || COALESCE(verification, '')) LIKE ?`);
    params.push(like);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM tasks ${whereSql}`).get(...params) as { total: number };
  const rows = db.prepare(`
    SELECT tasks.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM task_ui_evidence e
        WHERE e.task_id = tasks.id AND e.is_current = 1
      ) THEN 1 ELSE 0 END AS hasUiDesign
    FROM tasks
    ${whereSql}
    ORDER BY createdAt DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];
  const runsByTaskId = getAllAgentRunsByTaskId(rows.map((row) => row.id));
  const items = rows.map((row) => parseTaskRow(row, runsByTaskId));
  const parentIds = rows.map((row) => row.id);
  const childRows = parentIds.length > 0
    ? db.prepare(`SELECT tasks.*,
        CASE WHEN EXISTS (
          SELECT 1 FROM task_ui_evidence e
          WHERE e.task_id = tasks.id AND e.is_current = 1
        ) THEN 1 ELSE 0 END AS hasUiDesign
      FROM tasks
      WHERE archivedAt IS NULL AND parentId IN (${parentIds.map(() => '?').join(', ')})
      ORDER BY createdAt ASC`).all(...parentIds) as any[]
    : [];
  const relatedItems = childRows.map((row) => parseTaskRow(row, new Map()));
  const total = Number(totalRow?.total || 0);
  return {
    items,
    relatedItems,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
    archived,
    hydratedTaskCount: rows.length,
  };
}

export function archiveInactiveDoneTasks(options: { now?: string; cutoff?: string } = {}) {
  ensureTaskColumns();
  const now = options.now || new Date().toISOString();
  const cutoff = options.cutoff || new Date(Date.parse(now) - 90 * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`
    UPDATE tasks
    SET archivedAt = ?
    WHERE status IN ('backlog', 'todo', 'done')
      AND archivedAt IS NULL
      AND updatedAt < ?
      AND NOT EXISTS (
        SELECT 1 FROM agent_runs
        WHERE agent_runs.taskId = tasks.id
          AND (
            agent_runs.status IN ('queued', 'starting', 'running')
            OR datetime(COALESCE(agent_runs.endedAt, agent_runs.startedAt, agent_runs.createdAt)) > datetime(?)
          )
      )
  `).run(now, cutoff, cutoff);
  if (result.changes > 0) publishServerEvent('task.changed', { reason: 'archive-inactive', status: 'archived' });
  return { archivedCount: result.changes, now, cutoff };
}

export function restoreArchivedTask(taskId: string, now = new Date().toISOString()) {
  ensureTaskColumns();
  db.prepare(`
    UPDATE tasks
    SET archivedAt = NULL, updatedAt = ?
    WHERE id = ? AND archivedAt IS NOT NULL
  `).run(now, taskId);
  const restored = getTask(taskId);
  if (restored) publishServerEvent('task.changed', { projectId: restored.projectId, entityId: restored.id, status: restored.status, reason: 'restored' });
  return restored;
}

export function getPendingTasks(): any[] {
  ensureTaskColumns();
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
    item.bugs ? JSON.stringify(item.bugs) : null,
    item.gitEvidence ? JSON.stringify(item.gitEvidence) : null,
    Array.isArray(item.verificationEvidence) ? JSON.stringify(item.verificationEvidence) : null,
    item.archivedAt ?? null,
    item.claim ? JSON.stringify(item.claim) : null,
  ];
}

export function saveTask(task: any) {
  ensureTaskColumns();
  withDbTransaction(() => {
    db.prepare(TASK_UPSERT_SQL).run(...serializeTaskForRow(task));
  });
  publishServerEvent('task.changed', { projectId: task.projectId, entityId: task.id, status: task.status, reason: 'saved' });
}

export function saveTasksAtomic(tasks: any[]) {
  if (tasks.length === 0) return;
  ensureTaskColumns();
  withDbTransaction(() => {
    const statement = db.prepare(TASK_UPSERT_SQL);
    for (const task of tasks) statement.run(...serializeTaskForRow(task));
  });
  const projectIds = Array.from(new Set(tasks.map((task) => String(task.projectId || '')).filter(Boolean)));
  if (projectIds.length === 0) publishServerEvent('task.changed', { reason: 'batch-saved' });
  for (const projectId of projectIds) publishServerEvent('task.changed', { projectId, reason: 'batch-saved' });
}

export function saveTaskWithExpectedUpdatedAt(task: any, expectedUpdatedAt: string | null | undefined) {
  ensureTaskColumns();
  const saved = withDbTransaction(() => {
    const existing = db.prepare('SELECT updatedAt FROM tasks WHERE id = ?').get(task.id) as { updatedAt?: string | null } | undefined;
    if (existing && expectedUpdatedAt !== undefined && (existing.updatedAt || null) !== (expectedUpdatedAt || null)) {
      throw new StaleTaskUpdateError(task.id);
    }
    db.prepare(TASK_UPSERT_SQL).run(...serializeTaskForRow(task));
    return getTask(task.id);
  });
  if (saved) publishServerEvent('task.changed', { projectId: saved.projectId, entityId: saved.id, status: saved.status, reason: 'saved-cas' });
  return saved;
}

export function deleteTask(taskId: string) {
  const existing = getTask(taskId);
  withDbTransaction(() => {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
  publishServerEvent('task.changed', { projectId: existing?.projectId, entityId: taskId, status: 'deleted', reason: 'deleted' });
}

export function deleteTasksByIds(taskIds: string[]) {
  if (taskIds.length === 0) return;
  const placeholders = taskIds.map(() => '?').join(',');
  const affected = db.prepare(`SELECT id, projectId FROM tasks WHERE id IN (${placeholders})`).all(...taskIds) as Array<{ id: string; projectId?: string }>;
  withDbTransaction(() => {
    db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...taskIds);
  });
  const projectIds = Array.from(new Set(affected.map((task) => String(task.projectId || '')).filter(Boolean)));
  if (projectIds.length === 0) publishServerEvent('task.changed', { status: 'deleted', reason: 'batch-deleted' });
  for (const projectId of projectIds) publishServerEvent('task.changed', { projectId, status: 'deleted', reason: 'batch-deleted' });
}

export function deleteTasksByProjectId(projectId: string) {
  withDbTransaction(() => {
    db.prepare('DELETE FROM tasks WHERE projectId = ?').run(projectId);
  });
  publishServerEvent('task.changed', { projectId, status: 'deleted', reason: 'project-deleted' });
}
