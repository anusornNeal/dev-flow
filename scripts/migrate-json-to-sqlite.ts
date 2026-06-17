import fs from 'fs';
import path from 'path';
import { getDevFlowAppRoot, getDevFlowDbPath, getDevFlowDataDir } from '../src/lib/devFlowPaths';
import db from '../src/db/index';

interface LegacyProject {
  id: string;
  name: string;
  repoUrl?: string;
  description?: string;
  createdAt?: string;
  localPath?: string;
  taskIdPrefix?: string;
}

interface LegacyTask {
  id: string;
  displayId?: string;
  title: string;
  description?: string;
  projectId?: string;
  status?: string;
  priority?: string;
  branch?: string;
  tags?: string[];
  targetFiles?: string[];
  checklist?: Array<{ id: string; text: string; completed: boolean }>;
  designImages?: string[];
  effort?: string;
  model?: string;
  agent?: string;
  parentId?: string;
  reasoning?: string;
  acceptanceCriteria?: string;
  verification?: string;
  repoContext?: string;
  jiraKey?: string;
  repo?: string;
  createdAt?: string;
  updatedAt?: string;
  logs?: any[];
  [k: string]: any;
}

interface LegacyCounters {
  [prefix: string]: number;
}

interface MigrationSummary {
  importedProjects: number;
  importedTasks: number;
  importedCounters: number;
  skippedDuplicates: number;
  errors: string[];
  dryRun: boolean;
  forced: boolean;
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');

const appRoot = getDevFlowAppRoot();
const dataDir = getDevFlowDataDir();
const tasksJsonPath = path.join(appRoot, 'tasks.json');
const projectsJsonPath = path.join(appRoot, 'projects.json');
const countersJsonPath = path.join(appRoot, 'counters.json');

function readJsonOrNull<T>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch (e) {
    console.error(`[migrate] failed to parse ${p}:`, (e as Error).message);
    return null;
  }
}

function backupCurrentDb(): string {
  const dbPath = getDevFlowDbPath();
  if (!fs.existsSync(dbPath)) return '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dataDir, `devflow-pre-migrate-${ts}.db`);
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

function renameLegacyFile(p: string): void {
  if (!fs.existsSync(p)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  fs.renameSync(p, path.join(dir, `${base}.migrated-${ts}.bak`));
}

function tableHasRows(table: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
  return row.c > 0;
}

function importProjects(projects: LegacyProject[], summary: MigrationSummary) {
  if (projects.length === 0) return;
  const existingIds = new Set(
    (db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((r) => r.id),
  );
  const insert = db.prepare(
    `INSERT OR REPLACE INTO projects (id, name, repoUrl, description, createdAt, localPath, taskIdPrefix)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of projects) {
    if (!p.id || !p.name) {
      summary.errors.push(`skip project missing id/name: ${JSON.stringify(p)}`);
      continue;
    }
    if (existingIds.has(p.id) && !summary.forced) {
      summary.skippedDuplicates += 1;
      continue;
    }
    if (!summary.dryRun) insert.run(p.id, p.name, p.repoUrl || null, p.description || null, p.createdAt || null, p.localPath || null, p.taskIdPrefix || null);
    summary.importedProjects += 1;
  }
}

function importTasks(tasks: LegacyTask[], summary: MigrationSummary) {
  if (tasks.length === 0) return;
  const existingIds = new Set(
    (db.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>).map((r) => r.id),
  );
  const insert = db.prepare(
    `INSERT OR REPLACE INTO tasks (
      id, displayId, title, description, projectId, status, priority, branch, tags, targetFiles, checklist,
      effort, model, agent, parentId, reasoning, acceptanceCriteria, verification, repoContext, jiraKey, repo,
      createdAt, updatedAt, logs, designImages
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of tasks) {
    if (!t.id || !t.title) {
      summary.errors.push(`skip task missing id/title: ${JSON.stringify(t).slice(0, 120)}`);
      continue;
    }
    if (existingIds.has(t.id) && !summary.forced) {
      summary.skippedDuplicates += 1;
      continue;
    }
    if (!summary.dryRun) {
      insert.run(
        t.id,
        t.displayId || null,
        t.title,
        t.description || null,
        t.projectId || null,
        t.status || null,
        t.priority || null,
        t.branch || null,
        JSON.stringify(t.tags || []),
        JSON.stringify(t.targetFiles || []),
        JSON.stringify(t.checklist || []),
        t.effort || null,
        t.model || null,
        t.agent || null,
        t.parentId || null,
        t.reasoning || null,
        t.acceptanceCriteria || null,
        t.verification || null,
        t.repoContext || null,
        t.jiraKey || null,
        t.repo || null,
        t.createdAt || null,
        t.updatedAt || null,
        JSON.stringify(t.logs || []),
        JSON.stringify(t.designImages || []),
      );
    }
    summary.importedTasks += 1;
  }
}

function importCounters(counters: LegacyCounters, summary: MigrationSummary) {
  const entries = Object.entries(counters || {});
  if (entries.length === 0) return;
  const upsert = db.prepare(`INSERT OR REPLACE INTO counters (prefix, count) VALUES (?, ?)`);
  for (const [prefix, count] of entries) {
    if (!summary.dryRun) upsert.run(prefix, count);
    summary.importedCounters += 1;
  }
}

function main() {
  const legacyTasks = readJsonOrNull<LegacyTask[]>(tasksJsonPath);
  const legacyProjects = readJsonOrNull<LegacyProject[]>(projectsJsonPath);
  const legacyCounters = readJsonOrNull<LegacyCounters>(countersJsonPath);

  if (!legacyTasks && !legacyProjects && !legacyCounters) {
    console.log('No legacy JSON files found');
    process.exit(0);
  }

  const summary: MigrationSummary = {
    importedProjects: 0,
    importedTasks: 0,
    importedCounters: 0,
    skippedDuplicates: 0,
    errors: [],
    dryRun,
    forced: force,
  };

  const dbHasRows = tableHasRows('projects') || tableHasRows('tasks') || tableHasRows('counters');
  if (dbHasRows && !force && !dryRun) {
    console.log('[migrate] DB already has rows. Re-run with --force to overwrite matching IDs, or --dry-run to preview.');
  }

  if (!dryRun && !dbHasRows) {
    const backup = backupCurrentDb();
    if (backup) console.log(`[migrate] backed up current DB to ${backup}`);
  }

  const txnItems: Array<{ name: string; data: any[] | LegacyCounters | null; fn: (data: any, s: MigrationSummary) => void }> = [
    { name: 'projects', data: legacyProjects, fn: (data, s) => importProjects(data as LegacyProject[], s) },
    { name: 'tasks', data: legacyTasks, fn: (data, s) => importTasks(data as LegacyTask[], s) },
    { name: 'counters', data: legacyCounters, fn: (data, s) => importCounters(data as LegacyCounters, s) },
  ];

  for (const item of txnItems) {
    if (!item.data) continue;
    if (!dryRun) {
      db.transaction(() => item.fn(item.data, summary))();
    } else {
      item.fn(item.data, summary);
    }
  }

  if (!dryRun) {
    renameLegacyFile(tasksJsonPath);
    renameLegacyFile(projectsJsonPath);
    renameLegacyFile(countersJsonPath);
  }

  console.log('[migrate] summary', JSON.stringify(summary, null, 2));
  if (summary.errors.length > 0) {
    process.exit(1);
  }
}

main();
