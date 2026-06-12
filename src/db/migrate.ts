import fs from 'fs';
import path from 'path';
import db from './index';

const DATA_DIR = process.cwd();
const MIGRATION_DONE_MARKER = path.join(DATA_DIR, 'data', '.migration_done');

type Migration = {
  id: string;
  run: () => void;
};

type TaskRow = {
  id: string;
  displayId: string | null;
  projectId: string | null;
  parentId: string | null;
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



function getNextDisplayId(prefix: string, usedIds: Set<string>) {
  let counter = 1;
  const normalizedPrefix = prefix || 'task';
  let candidate = `${normalizedPrefix}-${counter.toString().padStart(4, '0')}`;
  while (usedIds.has(candidate)) {
    counter += 1;
    candidate = `${normalizedPrefix}-${counter.toString().padStart(4, '0')}`;
  }
  usedIds.add(candidate);
  return candidate;
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
  },
  {
    id: '002-sqlite-integrity-repair-and-indexes',
    run: () => {
      const projectRows = db.prepare('SELECT id, name, taskIdPrefix FROM projects').all() as Array<{ id: string; name: string; taskIdPrefix?: string | null }>;
      const projectIds = new Set(projectRows.map((project) => project.id));
      const projectByName = new Map(projectRows.map((project) => [project.name.toLowerCase(), project.id]));
      const projectById = new Map(projectRows.map((project) => [project.id, project]));
      const tasks = db.prepare('SELECT id, displayId, projectId, parentId FROM tasks ORDER BY createdAt, id').all() as TaskRow[];
      const validTaskIds = new Set(tasks.map((task) => task.id));
      const usedDisplayIds = new Set<string>();
      const updateTask = db.prepare('UPDATE tasks SET displayId = ?, projectId = ?, parentId = ? WHERE id = ?');

      for (const task of tasks) {
        const normalizedProjectId = task.projectId && projectIds.has(task.projectId)
          ? task.projectId
          : task.projectId && projectByName.has(task.projectId.toLowerCase())
            ? projectByName.get(task.projectId.toLowerCase())!
            : null;

        const normalizedParentId = task.parentId && validTaskIds.has(task.parentId) && task.parentId !== task.id
          ? task.parentId
          : null;

        let normalizedDisplayId = task.displayId && task.displayId.trim() !== '' ? task.displayId : null;
        if (normalizedDisplayId && usedDisplayIds.has(normalizedDisplayId)) {
          const prefix = normalizedDisplayId.includes('-') ? normalizedDisplayId.split('-')[0] : 'task';
          normalizedDisplayId = getNextDisplayId(prefix, usedDisplayIds);
        } else if (normalizedDisplayId) {
          usedDisplayIds.add(normalizedDisplayId);
        }

        if (!normalizedDisplayId) {
          const project = projectById.get(normalizedProjectId);
          const prefix = project?.taskIdPrefix || normalizedProjectId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'task';
          normalizedDisplayId = getNextDisplayId(prefix, usedDisplayIds);
        }

        updateTask.run(normalizedDisplayId, normalizedProjectId, normalizedParentId, task.id);
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_display_id_unique
        ON tasks(displayId)
        WHERE displayId IS NOT NULL AND displayId != '';

        CREATE INDEX IF NOT EXISTS idx_tasks_project_status
        ON tasks(projectId, status);

        CREATE INDEX IF NOT EXISTS idx_tasks_parent_id
        ON tasks(parentId);

        CREATE INDEX IF NOT EXISTS idx_tasks_project_parent
        ON tasks(projectId, parentId);

        CREATE TRIGGER IF NOT EXISTS trg_tasks_validate_project_insert
        BEFORE INSERT ON tasks
        FOR EACH ROW
        WHEN NEW.projectId IS NOT NULL AND NEW.projectId != '' AND NOT EXISTS (
          SELECT 1 FROM projects WHERE id = NEW.projectId
        )
        BEGIN
          SELECT RAISE(ABORT, 'Invalid task.projectId');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_tasks_validate_project_update
        BEFORE UPDATE OF projectId ON tasks
        FOR EACH ROW
        WHEN NEW.projectId IS NOT NULL AND NEW.projectId != '' AND NOT EXISTS (
          SELECT 1 FROM projects WHERE id = NEW.projectId
        )
        BEGIN
          SELECT RAISE(ABORT, 'Invalid task.projectId');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_tasks_validate_parent_insert
        BEFORE INSERT ON tasks
        FOR EACH ROW
        WHEN NEW.parentId IS NOT NULL AND NEW.parentId != '' AND (
          NEW.parentId = NEW.id OR NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.parentId)
        )
        BEGIN
          SELECT RAISE(ABORT, 'Invalid task.parentId');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_tasks_validate_parent_update
        BEFORE UPDATE OF parentId ON tasks
        FOR EACH ROW
        WHEN NEW.parentId IS NOT NULL AND NEW.parentId != '' AND (
          NEW.parentId = NEW.id OR NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.parentId)
        )
        BEGIN
          SELECT RAISE(ABORT, 'Invalid task.parentId');
        END;
      `);

      console.log('[migration] Repaired invalid task relations, duplicate display IDs, and created integrity indexes');
    }
  },
  {
    id: '003-skills-master-custom-metadata',
    run: () => {
      const tableInfo = db.pragma('table_info(skills)') as Array<{ name: string }>;
      const existingColumns = new Set(tableInfo.map((column) => column.name));
      const columnDefinitions = [
        { name: 'kind', sql: "ALTER TABLE skills ADD COLUMN kind TEXT DEFAULT 'master'" },
        { name: 'isProtected', sql: 'ALTER TABLE skills ADD COLUMN isProtected INTEGER DEFAULT 0' },
        { name: 'sourceType', sql: 'ALTER TABLE skills ADD COLUMN sourceType TEXT' },
        { name: 'sourcePath', sql: 'ALTER TABLE skills ADD COLUMN sourcePath TEXT' },
        { name: 'createdAt', sql: 'ALTER TABLE skills ADD COLUMN createdAt TEXT' },
        { name: 'updatedAt', sql: 'ALTER TABLE skills ADD COLUMN updatedAt TEXT' }
      ];

      for (const column of columnDefinitions) {
        if (!existingColumns.has(column.name)) {
          db.prepare(column.sql).run();
        }
      }

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE skills
        SET
          kind = COALESCE(kind, CASE WHEN COALESCE(isCustom, 0) = 1 THEN 'custom' ELSE 'master' END),
          isProtected = COALESCE(isProtected, CASE WHEN COALESCE(isCustom, 0) = 1 THEN 0 ELSE 1 END),
          sourceType = COALESCE(sourceType, CASE WHEN COALESCE(isCustom, 0) = 1 THEN 'import' ELSE 'repo-file' END),
          createdAt = COALESCE(createdAt, ?),
          updatedAt = COALESCE(updatedAt, ?)
      `).run(now, now);

      console.log('[migration] Added master/custom skill metadata columns');
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
