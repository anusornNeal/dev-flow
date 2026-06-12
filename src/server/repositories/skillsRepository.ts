import fs from 'fs';
import path from 'path';
import db from '../../db/index';
import type { AppState } from '../types';

const SKILLS_DIR = path.join(process.cwd(), 'skills');
const LEGACY_REGISTRY_BACKUP_FILE = path.join(SKILLS_DIR, 'registry.json.bak');

function ensureLegacySkillsColumns() {
  try {
    const tableInfo = db.pragma('table_info(skills)') as any[];
    const hasIsCustom = tableInfo.some((column) => column.name === 'isCustom');
    const hasContent = tableInfo.some((column) => column.name === 'content');
    if (!hasIsCustom) {
      db.prepare('ALTER TABLE skills ADD COLUMN isCustom INTEGER DEFAULT 0').run();
    }
    if (!hasContent) {
      db.prepare('ALTER TABLE skills ADD COLUMN content TEXT').run();
    }
  } catch (error) {
    console.error('Failed to migrate skills table', error);
  }
}

function getSkillColumns() {
  return (db.pragma('table_info(skills)') as any[]).map((column) => column.name);
}


export function loadSkillsRegistry(state: AppState) {
  ensureLegacySkillsColumns();

  state.skillsRegistry = db.prepare('SELECT * FROM skills').all() as any[];
  state.skillsRegistry.forEach((skill) => {
    skill.isCustom = Boolean(skill.isCustom);
    skill.isProtected = Boolean(skill.isProtected);
    skill.filePath = skill.sourcePath || skill.filePath || (!skill.isCustom ? path.join(process.cwd(), 'skills', skill.id + '.md') : undefined);
  });
  state.skillsRegistry.sort((left, right) => {
    if (left.isCustom !== right.isCustom) {
      return left.isCustom ? 1 : -1;
    }
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
}

export function saveSkillsRegistry(state: AppState) {
  const columns = getSkillColumns();
  const hasExtendedMetadata = columns.includes('kind');
  if (hasExtendedMetadata) {
    const stmt = db.prepare('INSERT OR REPLACE INTO skills (id, name, description, kind, isCustom, isProtected, sourceType, sourcePath, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      const currentIds = state.skillsRegistry.map((skill) => skill.id);
      if (currentIds.length > 0) {
        const placeholders = currentIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM skills WHERE id NOT IN (${placeholders})`).run(...currentIds);
      } else {
        db.prepare('DELETE FROM skills').run();
      }

      for (const item of state.skillsRegistry) {
        stmt.run(
          item.id,
          item.name,
          item.description,
          item.kind || (item.isCustom ? 'custom' : 'master'),
          item.isCustom ? 1 : 0,
          item.isProtected ? 1 : 0,
          item.sourceType || (item.isCustom ? 'database' : 'file'),
          item.sourcePath || item.filePath || null,
          item.content || null,
          item.createdAt || new Date().toISOString(),
          item.updatedAt || new Date().toISOString(),
        );
      }
    })();
    return;
  }

  const stmt = db.prepare('INSERT OR REPLACE INTO skills (id, name, description, isCustom, content) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    const currentIds = state.skillsRegistry.map((skill) => skill.id);
    if (currentIds.length > 0) {
      const placeholders = currentIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM skills WHERE id NOT IN (${placeholders})`).run(...currentIds);
    } else {
      db.prepare('DELETE FROM skills').run();
    }

    for (const item of state.skillsRegistry) {
      stmt.run(item.id, item.name, item.description, item.isCustom ? 1 : 0, item.content || null);
    }
  })();
}

export function readSkillContent(skill: any) {
  if (typeof skill.content === 'string' && skill.content.length > 0) {
    return skill.content || '';
  }
  if (!skill.filePath) {
    skill.filePath = path.join(process.cwd(), 'skills', skill.id + '.md');
  }
  return fs.existsSync(skill.filePath) ? fs.readFileSync(skill.filePath, 'utf8') : '';
}
