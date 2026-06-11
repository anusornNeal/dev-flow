import fs from 'fs';
import path from 'path';
import db from './index';

const DATA_DIR = process.cwd();
const MIGRATION_DONE_MARKER = path.join(DATA_DIR, 'data', '.migration_done');

export function migrateJsonToSqlite() {
  if (fs.existsSync(MIGRATION_DONE_MARKER)) {
    return; // Already migrated
  }
  
  console.log('--- Starting JSON to SQLite Migration ---');

  // Migrate projects
  const projectsFile = path.join(DATA_DIR, 'projects.json');
  if (fs.existsSync(projectsFile)) {
    try {
      const projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      const stmt = db.prepare('INSERT OR IGNORE INTO projects (id, name, repoUrl, description, createdAt, localPath, taskIdPrefix) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const insertMany = db.transaction((items) => {
        for (const item of items) stmt.run(item.id, item.name, item.repoUrl, item.description, item.createdAt, item.localPath, item.taskIdPrefix);
      });
      insertMany(projects);
      console.log(`Migrated ${projects.length} projects`);
      fs.renameSync(projectsFile, projectsFile + '.bak');
    } catch (e) { console.error('Failed to migrate projects', e); }
  }

  // Migrate tasks
  const tasksFile = path.join(DATA_DIR, 'tasks.json');
  if (fs.existsSync(tasksFile)) {
    try {
      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      const stmt = db.prepare(`INSERT OR IGNORE INTO tasks (id, displayId, title, description, projectId, status, priority, branch, tags, targetFiles, checklist, effort, model, agent, parentId, reasoning, acceptanceCriteria, verification, repoContext, jiraKey, repo, createdAt, updatedAt, logs, designImages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertMany = db.transaction((items) => {
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
      console.log(`Migrated ${tasks.length} tasks`);
      fs.renameSync(tasksFile, tasksFile + '.bak');
    } catch (e) { console.error('Failed to migrate tasks', e); }
  }

  // Migrate counters
  const countersFile = path.join(DATA_DIR, 'counters.json');
  if (fs.existsSync(countersFile)) {
    try {
      const counters = JSON.parse(fs.readFileSync(countersFile, 'utf8'));
      const stmt = db.prepare('INSERT OR IGNORE INTO counters (prefix, count) VALUES (?, ?)');
      const insertMany = db.transaction((entries) => {
        for (const [prefix, count] of entries) stmt.run(prefix, count);
      });
      insertMany(Object.entries(counters));
      console.log(`Migrated counters`);
      fs.renameSync(countersFile, countersFile + '.bak');
    } catch (e) { console.error('Failed to migrate counters', e); }
  }

  // Migrate settings
  const settingsFile = path.join(DATA_DIR, 'settings.json');
  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      const insertMany = db.transaction((entries) => {
        for (const [key, value] of entries) stmt.run(key, JSON.stringify(value));
      });
      insertMany(Object.entries(settings));
      console.log(`Migrated settings`);
      fs.renameSync(settingsFile, settingsFile + '.bak');
    } catch (e) { console.error('Failed to migrate settings', e); }
  }

  // Migrate skills registry
  const skillsFile = path.join(DATA_DIR, 'skills', 'registry.json');
  if (fs.existsSync(skillsFile)) {
    try {
      const skills = JSON.parse(fs.readFileSync(skillsFile, 'utf8'));
      const stmt = db.prepare('INSERT OR IGNORE INTO skills (id, name, description) VALUES (?, ?, ?)');
      const insertMany = db.transaction((items) => {
        for (const item of items) stmt.run(item.id, item.name, item.description);
      });
      insertMany(skills);
      console.log(`Migrated ${skills.length} skills`);
      fs.renameSync(skillsFile, skillsFile + '.bak');
    } catch (e) { console.error('Failed to migrate skills', e); }
  }

  fs.writeFileSync(MIGRATION_DONE_MARKER, 'done');
  console.log('--- Migration Complete ---');
}
