import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { getDevFlowAppRoot, getDevFlowDbPath, getDevFlowDataDir } from '../src/lib/devFlowPaths';
import db from '../src/db/index';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

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
  backupPath: string | null;
  renamed: string[];
  aborted: boolean;
  abortReason?: string;
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

async function backupCurrentDb(): Promise<string> {
  const dbPath = getDevFlowDbPath();
  if (!fs.existsSync(dbPath)) return '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(dataDir, { recursive: true });
  const backupPath = path.join(dataDir, `devflow-pre-migrate-${ts}.db`);
  // Use SQLite backup API for safety (consistent snapshot)
  const sourceDb = new Database(dbPath);
  try {
    await sourceDb.backup(backupPath);
  } finally {
    sourceDb.close();
  }
  return backupPath;
}

function renameLegacyFile(p: string, summary: MigrationSummary): void {
  if (!fs.existsSync(p)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  const newPath = path.join(dir, `${base}.migrated-${ts}.bak`);
  fs.renameSync(p, newPath);
  summary.renamed.push(newPath);
}

function tableHasRows(table: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
  return row.c > 0;
}

function validateProjects(projects: LegacyProject[] | null): string[] {
  if (!projects) return [];
  const errs: string[] = [];
  for (const p of projects) {
    if (!p || !p.id || !p.name) {
      errs.push(`project missing id/name: ${JSON.stringify(p).slice(0, 200)}`);
    }
  }
  return errs;
}

function validateTasks(tasks: LegacyTask[] | null): string[] {
  if (!tasks) return [];
  const errs: string[] = [];
  for (const t of tasks) {
    if (!t || !t.id || !t.title) {
      errs.push(`task missing id/title: ${JSON.stringify(t).slice(0, 200)}`);
    }
  }
  return errs;
}

function validateCounters(counters: LegacyCounters | null): string[] {
  if (!counters) return [];
  const errs: string[] = [];
  for (const [prefix, count] of Object.entries(counters)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      errs.push(`counter ${prefix} has non-numeric count: ${JSON.stringify(count)}`);
    }
  }
  return errs;
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
      // Pre-validation should have caught this; defensive only.
      summary.errors.push(`skip project missing id/name: ${JSON.stringify(p).slice(0, 200)}`);
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
      summary.errors.push(`skip task missing id/title: ${JSON.stringify(t).slice(0, 200)}`);
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

async function main() {
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
    backupPath: null,
    renamed: [],
    aborted: false,
  };

  // PRE-VALIDATION: collect all validation errors before any DB write.
  // If any validation fails, abort before opening a transaction so we never
  // produce a partial migration.
  const validationErrors: string[] = [
    ...validateProjects(legacyProjects),
    ...validateTasks(legacyTasks),
    ...validateCounters(legacyCounters),
  ];
  if (validationErrors.length > 0) {
    summary.errors = validationErrors;
    summary.aborted = true;
    summary.abortReason = `pre-validation failed with ${validationErrors.length} error(s); DB not touched, JSON files not renamed`;
    console.log('[migrate] summary', JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  const dbHasRows = tableHasRows('projects') || tableHasRows('tasks') || tableHasRows('counters');
  if (dbHasRows && !force && !dryRun) {
    console.log('[migrate] DB already has rows. Re-run with --force to overwrite matching IDs, or --dry-run to preview.');
    process.exit(2);
  }

  // Always create a safety backup before any non-dry-run DB write
  if (!dryRun) {
    try {
      const backup = await backupCurrentDb();
      if (backup) {
        summary.backupPath = backup;
        console.log(`[migrate] safety backup -> ${backup}`);
      }
    } catch (e) {
      summary.aborted = true;
      summary.abortReason = `safety backup failed: ${(e as Error).message}`;
      console.log('[migrate] summary', JSON.stringify(summary, null, 2));
      process.exit(1);
    }
  }

  const txnItems: Array<{ name: string; data: any[] | LegacyCounters | null; fn: (data: any, s: MigrationSummary) => void }> = [
    { name: 'projects', data: legacyProjects, fn: (data, s) => importProjects(data as LegacyProject[], s) },
    { name: 'tasks', data: legacyTasks, fn: (data, s) => importTasks(data as LegacyTask[], s) },
    { name: 'counters', data: legacyCounters, fn: (data, s) => importCounters(data as LegacyCounters, s) },
  ];

  let migrationSucceeded = true;

  if (dryRun) {
    // Dry-run: in-memory only, never write
    for (const item of txnItems) {
      if (!item.data) continue;
      item.fn(item.data, summary);
    }
  } else {
    // Real run: single transaction. Roll back on any error.
    try {
      db.transaction(() => {
        for (const item of txnItems) {
          if (!item.data) continue;
          item.fn(item.data, summary);
        }
      })();
    } catch (e) {
      migrationSucceeded = false;
      summary.aborted = true;
      summary.abortReason = `migration transaction failed: ${(e as Error).message}`;
    }

    // Defensive: if any errors slipped past pre-validation, treat as failure
    if (summary.errors.length > 0) {
      migrationSucceeded = false;
      if (!summary.abortReason) {
        summary.abortReason = `migration had ${summary.errors.length} error(s); rolled back`;
      }
    }
  }

  // Only rename legacy JSON files if migration fully succeeded
  if (migrationSucceeded && !dryRun) {
    renameLegacyFile(tasksJsonPath, summary);
    renameLegacyFile(projectsJsonPath, summary);
    renameLegacyFile(countersJsonPath, summary);
  }

  console.log('[migrate] summary', JSON.stringify(summary, null, 2));
  if (!migrationSucceeded) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[migrate] unexpected error:', e);
  process.exit(1);
});
