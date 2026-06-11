import fs from 'fs';
import path from 'path';
import db from './index';

const DATA_DIR = process.cwd();
const MIGRATION_DONE_MARKER = path.join(DATA_DIR, 'data', '.migration_done');

type Migration = {
  id: string;
  run: () => void;
};

function ensureMigrationTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL
    )
  `);
}

function getAppliedMigrationIds() {
  ensureMigrationTable();
  const rows = db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function markMigrationApplied(id: string) {
  db.prepare('INSERT OR IGNORE INTO schema_migrations (id, appliedAt) VALUES (?, ?)').run(id, new Date().toISOString());
}

function finalizeLegacyMarker() {
  if (!fs.existsSync(path.dirname(MIGRATION_DONE_MARKER))) {
    fs.mkdirSync(path.dirname(MIGRATION_DONE_MARKER), { recursive: true });
  }
  if (!fs.existsSync(MIGRATION_DONE_MARKER)) {
    fs.writeFileSync(MIGRATION_DONE_MARKER, 'migrated-with-versioned-history');
  }
}

function migrateProjectsFromJson() {
  const projectsFile = path.join(DATA_DIR, 'projects.json');
  if (!fs.existsSync(projectsFile)) return;

  const projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  const stmt = db.prepare('INSERT OR IGNORE INTO projects (id, name, repoUrl, description, createdAt, localPath, taskIdPrefix) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertMany = db.transaction((items: any[]) => {
    for (const item of items) stmt.run(item.id, item.name, item.repoUrl, item.description, item.createdAt, item.localPath, item.taskIdPrefix);
  });
  insertMany(projects);
  console.log(`[migration] Imported ${projects.length} project rows from projects.json`);
  fs.renameSync(projectsFile, projectsFile + '.bak');
}

function migrateTasksFromJson() {
  const tasksFile = path.join(DATA_DIR, 'tasks.json');
  if (!fs.existsSync(tasksFile)) return;

  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const stmt = db.prepare(`INSERT OR IGNORE INTO tasks (id, displayId, title, description, projectId, status, priority, branch, tags, targetFiles, checklist, effort, model, agent, parentId, reasoning, acceptanceCriteria, verification, repoContext, jiraKey, repo, createdAt, updatedAt, logs, designImages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertMany = db.transaction((items: any[]) => {
    for (const item of items) {
      stmt.run(
        item.id, item.displayId, item.title, item.description, item.projectId, item.status, item.priority, item.branch,
        item.tags ? JSON.stringify(item.tags) : null,
        item.targetFiles ? JSON.stringify(item.targetFiles) : null,
        item.checklist ? JSON.stringify(item.checklist) : null,
        item.effort, item.model, item.agent, item.parentId, item.reasoning, item.acceptanceCriteria, item.verification, item.repoContext, item.jiraKey, item.repo, item.createdAt, item.updatedAt,
        item.logs ? JSON.stringify(item.logs) : null,
        item.designImages ? JSON.stringify(item.designImages) : null
      );
    }
  });
  insertMany(tasks);
  console.log(`[migration] Imported ${tasks.length} task rows from tasks.json`);
  fs.renameSync(tasksFile, tasksFile + '.bak');
}

function migrateCountersFromJson() {
  const countersFile = path.join(DATA_DIR, 'counters.json');
  if (!fs.existsSync(countersFile)) return;

  const counters = JSON.parse(fs.readFileSync(countersFile, 'utf8'));
  const stmt = db.prepare('INSERT OR IGNORE INTO counters (prefix, count) VALUES (?, ?)');
  const insertMany = db.transaction((entries: Array<[string, number]>) => {
    for (const [prefix, count] of entries) stmt.run(prefix, count);
  });
  insertMany(Object.entries(counters) as Array<[string, number]>);
  console.log('[migration] Imported counters from counters.json');
  fs.renameSync(countersFile, countersFile + '.bak');
}

function migrateSettingsFromJson() {
  const settingsFile = path.join(DATA_DIR, 'settings.json');
  if (!fs.existsSync(settingsFile)) return;

  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const insertMany = db.transaction((entries: Array<[string, unknown]>) => {
    for (const [key, value] of entries) stmt.run(key, JSON.stringify(value));
  });
  insertMany(Object.entries(settings));
  console.log('[migration] Imported settings from settings.json');
  fs.renameSync(settingsFile, settingsFile + '.bak');
}

function migrateSkillsFromJson() {
  const skillsFile = path.join(DATA_DIR, 'skills', 'registry.json');
  if (!fs.existsSync(skillsFile)) return;

  const skills = JSON.parse(fs.readFileSync(skillsFile, 'utf8'));
  const stmt = db.prepare('INSERT OR IGNORE INTO skills (id, name, description) VALUES (?, ?, ?)');
  const insertMany = db.transaction((items: any[]) => {
    for (const item of items) stmt.run(item.id, item.name, item.description);
  });
  insertMany(skills);
  console.log(`[migration] Imported ${skills.length} skills from skills/registry.json`);
  fs.renameSync(skillsFile, skillsFile + '.bak');
}

const migrations: Migration[] = [
  {
    id: '001-json-to-sqlite-bootstrap',
    run: () => {
      migrateProjectsFromJson();
      migrateTasksFromJson();
      migrateCountersFromJson();
      migrateSettingsFromJson();
      migrateSkillsFromJson();
      finalizeLegacyMarker();
    }
  }
];

export function migrateJsonToSqlite() {
  console.log('--- Checking SQLite migrations ---');
  ensureMigrationTable();

  const appliedMigrationIds = getAppliedMigrationIds();
  if (fs.existsSync(MIGRATION_DONE_MARKER) && !appliedMigrationIds.has('001-json-to-sqlite-bootstrap')) {
    console.log('[migration] Legacy marker found; recording bootstrap migration as applied for compatibility.');
    markMigrationApplied('001-json-to-sqlite-bootstrap');
    appliedMigrationIds.add('001-json-to-sqlite-bootstrap');
  }

  for (const migration of migrations) {
    if (appliedMigrationIds.has(migration.id)) {
      console.log(`[migration] Skipping already applied migration ${migration.id}`);
      continue;
    }

    console.log(`[migration] Starting ${migration.id}`);
    try {
      migration.run();
      markMigrationApplied(migration.id);
      console.log(`[migration] Completed ${migration.id}`);
    } catch (error) {
      console.error(`[migration] Failed ${migration.id}`, error);
      throw error;
    }
  }

  console.log('--- SQLite migrations complete ---');
}
