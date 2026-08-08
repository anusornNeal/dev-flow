import { normalizeLocalPathIdentity } from '../../lib/platformRuntime.js';
import db, { withDbTransaction } from '../../db/index.js';

export function getProjects(): any[] {
  return db.prepare('SELECT * FROM projects').all() as any[];
}

export function getProject(id: string): any | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any | undefined;
}

export function normalizeProjectNameAlias(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function normalizeProjectRepoIdentity(value: unknown) {
  let normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';

  const scpMatch = normalized.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scpMatch) {
    normalized = `${scpMatch[1]}/${scpMatch[2]}`;
  } else {
    try {
      const parsed = new URL(normalized);
      normalized = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      normalized = normalized.replace(/^[a-z]+:\/\//i, '');
    }
  }

  normalized = normalized.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return normalized.toLowerCase();
}

export function normalizeProjectLocalPathIdentity(value: unknown) {
  return normalizeLocalPathIdentity(value);
}

export function projectsShareCanonicalRepository(left: any, right: any) {
  const leftRepo = normalizeProjectRepoIdentity(left?.repoUrl);
  const rightRepo = normalizeProjectRepoIdentity(right?.repoUrl);
  if (leftRepo && rightRepo && leftRepo === rightRepo) return true;
  const leftPath = normalizeProjectLocalPathIdentity(left?.localPath);
  const rightPath = normalizeProjectLocalPathIdentity(right?.localPath);
  return Boolean(leftPath && rightPath && leftPath === rightPath);
}

export function findProjectIdentityConflicts(project: any) {
  if (!project || !project.id) return [];
  return getProjects().filter((entry) => entry.id !== project.id && projectsShareCanonicalRepository(entry, project));
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
