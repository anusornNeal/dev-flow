import db from '../../db/index';
import type { AppState } from '../types';

export function loadProjects(state: AppState) {
  state.projectsCache = db.prepare('SELECT * FROM projects').all() as any[];
  console.log('Loaded ' + state.projectsCache.length + ' projects from DB');
}

export function saveProjects(state: AppState) {
  const stmt = db.prepare('INSERT OR REPLACE INTO projects (id, name, repoUrl, description, createdAt, localPath, taskIdPrefix) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    const currentIds = state.projectsCache.map((project) => project.id);
    if (currentIds.length > 0) {
      const placeholders = currentIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM projects WHERE id NOT IN (${placeholders})`).run(...currentIds);
    } else {
      db.prepare('DELETE FROM projects').run();
    }
    for (const item of state.projectsCache) {
      stmt.run(item.id, item.name, item.repoUrl, item.description, item.createdAt, item.localPath, item.taskIdPrefix);
    }
  })();
}
