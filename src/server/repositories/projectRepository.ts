import db, { withDbTransaction } from '../../db/index.js';

export function getProjects(): any[] {
  return db.prepare('SELECT * FROM projects').all() as any[];
}

export function getProject(id: string): any | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any | undefined;
}

export function createProject(project: any): void {
  withDbTransaction(() => {
    const stmt = db.prepare(`
      INSERT INTO projects (id, name, repoUrl, description, createdAt, localPath, taskIdPrefix)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        repoUrl = excluded.repoUrl,
        description = excluded.description,
        createdAt = COALESCE(projects.createdAt, excluded.createdAt),
        localPath = excluded.localPath,
        taskIdPrefix = excluded.taskIdPrefix
    `);
    stmt.run(
      project.id,
      project.name,
      project.repoUrl || null,
      project.description || null,
      project.createdAt || new Date().toISOString(),
      project.localPath || null,
      project.taskIdPrefix || null,
    );
  });
}

export function updateProject(project: any): void {
  withDbTransaction(() => {
    const stmt = db.prepare('UPDATE projects SET name = ?, repoUrl = ?, description = ?, createdAt = ?, localPath = ?, taskIdPrefix = ? WHERE id = ?');
    stmt.run(project.name, project.repoUrl || null, project.description || null, project.createdAt, project.localPath || null, project.taskIdPrefix || null, project.id);
  });
}

export function deleteProject(id: string): void {
  withDbTransaction(() => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  });
}
