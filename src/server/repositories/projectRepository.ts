import db from '../../db/index.js';

export function getProjects(): any[] {
  return db.prepare('SELECT * FROM projects').all() as any[];
}

export function getProject(id: string): any | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any | undefined;
}

export function createProject(project: any): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO projects (id, name, repoUrl, description, createdAt, localPath, taskIdPrefix) VALUES (?, ?, ?, ?, ?, ?, ?)');
  stmt.run(project.id, project.name, project.repoUrl || null, project.description || null, project.createdAt, project.localPath || null, project.taskIdPrefix || null);
}

export function updateProject(project: any): void {
  const stmt = db.prepare('UPDATE projects SET name = ?, repoUrl = ?, description = ?, createdAt = ?, localPath = ?, taskIdPrefix = ? WHERE id = ?');
  stmt.run(project.name, project.repoUrl || null, project.description || null, project.createdAt, project.localPath || null, project.taskIdPrefix || null, project.id);
}

export function deleteProject(id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}
