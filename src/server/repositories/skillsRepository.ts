import fs from 'fs';
import path from 'path';
import db from '../../db/index';
import { getDevFlowSkillsDir } from '../../lib/devFlowPaths';
import type { AppState } from '../types';

const SKILLS_DIR = getDevFlowSkillsDir();
const LEGACY_REGISTRY_BACKUP_FILE = path.join(SKILLS_DIR, 'registry.json.bak');
const LEGACY_MASTER_SKILL_IDS = new Set(['00-skill-router', '01-authoring-core', '02-schema-reference', '03-reviewer-core', '04-examples']);

type LegacySkillSeed = {
  id: string;
  name: string;
  description?: string;
};

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

function readLegacySkillSeeds(): LegacySkillSeed[] {
  if (!fs.existsSync(LEGACY_REGISTRY_BACKUP_FILE)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(LEGACY_REGISTRY_BACKUP_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string') : [];
  } catch (error) {
    console.error('Failed to read legacy skill registry backup', error);
    return [];
  }
}

function seedMissingLegacySkills(state: AppState) {
  const existingIds = new Set(state.skillsRegistry.map((skill) => skill.id));
  const additions = readLegacySkillSeeds()
    .filter((seed) => LEGACY_MASTER_SKILL_IDS.has(seed.id) && !existingIds.has(seed.id))
    .map((seed) => {
      const filePath = path.join(SKILLS_DIR, `${seed.id}.md`);
      return {
        id: seed.id,
        name: seed.name,
        description: seed.description || '',
        kind: 'master',
        isCustom: false,
        isProtected: true,
        sourceType: 'repo-file',
        sourcePath: filePath,
        filePath,
        content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

  if (additions.length > 0) {
    state.skillsRegistry.push(...additions);
  }
}


export function loadSkillsRegistry(state: AppState) {
  ensureLegacySkillsColumns();

  state.skillsRegistry = db.prepare('SELECT * FROM skills').all() as any[];
  let needsSave = false;

  state.skillsRegistry.forEach((skill) => {
    skill.isCustom = Boolean(skill.isCustom);
    skill.isProtected = Boolean(skill.isProtected);
    skill.filePath = skill.sourcePath || skill.filePath || (!skill.isCustom ? path.join(SKILLS_DIR, `${skill.id}.md`) : undefined);

    if (!skill.isCustom && skill.filePath && fs.existsSync(skill.filePath)) {
      const fileContent = fs.readFileSync(skill.filePath, 'utf8');
      if (skill.content !== fileContent) {
        skill.content = fileContent;
        needsSave = true;
      }
    } else if (!skill.isCustom && (!skill.content || skill.content.length === 0)) {
      const filePath = skill.filePath || path.join(SKILLS_DIR, `${skill.id}.md`);
      if (fs.existsSync(filePath)) {
        skill.content = fs.readFileSync(filePath, 'utf8');
        needsSave = true;
      }
    }
  });

  const lengthBefore = state.skillsRegistry.length;
  seedMissingLegacySkills(state);

  if (needsSave || state.skillsRegistry.length > lengthBefore) {
    saveSkillsRegistry(state);
  }

  if (state.skillsRegistry.some((skill) => LEGACY_MASTER_SKILL_IDS.has(skill.id) && !skill.content)) {
    saveSkillsRegistry(state);
  }

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
  return skill.content || '';
}
