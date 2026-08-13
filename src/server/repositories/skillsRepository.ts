import fs from 'fs';
import path from 'path';
import db from '../../db/index.js';
import { getDevFlowSkillsDir } from '../../lib/devFlowPaths.js';
import { invalidateRepoCacheDependencies, recordRepoCacheAccess, registerRepoCacheInvalidator } from '../services/repoCacheInvalidationService.js';

const SKILLS_DIR = getDevFlowSkillsDir();
const LEGACY_REGISTRY_BACKUP_FILE = path.join(SKILLS_DIR, 'registry.json.bak');
const SKILL_FILE_CACHE_TTL_MS = 30_000;
const MASTER_SKILL_SEEDS = [
  { id: '00-skill-router', name: 'Skill Router', description: 'Routes each DevFlow action to the smallest canonical authoring skill set.' },
  { id: '01-authoring-core', name: 'Authoring Core Skill', description: 'Common rules for concise, implementation-ready DevFlow card authoring.' },
  { id: '02-schema-reference', name: 'Schema Reference', description: 'Semantic task-field placement guidance backed by live tool schemas.' },
  { id: '03-reviewer-core', name: 'Reviewer Core Skill', description: 'Canonical ready-for-review and existing-task defect review policy.' },
  { id: '04-examples', name: 'Examples', description: 'Optional concise examples for DevFlow card shapes and task patterns.' },
  { id: '05-authoring-evidence', name: 'Authoring Evidence Skill', description: 'Source evidence and requirement-authority guidance for Jira, Figma, and Project Atlas.' },
  { id: '06-authoring-decomposition', name: 'Authoring Decomposition Skill', description: 'Parent/child boundaries, parallel slices, and prerequisite direction.' },
  { id: '07-authoring-execution', name: 'Authoring Execution Skill', description: 'Task-owned implementation, verification, commit, and managed workspace lifecycle.' },
  { id: '08-board-loop-execution', name: 'Board Loop Execution Skill', description: 'Board claim, parallel scheduling, finalization, and recovery orchestration.' }
];

const GUIDANCE_SKILL_SEEDS = [
  { id: 'brainstorming-guidance', name: 'Brainstorming Guidance', description: 'On-demand design-process guidance for shaping ideas into an approved design before implementation.', kind: 'guidance', isProtected: false },
  { id: 'ui-ux-guidance', name: 'UI/UX Guidance', description: 'On-demand visual, interaction, accessibility, and product UI quality guidance.', kind: 'guidance', isProtected: false },
];

const REPO_SKILL_SEEDS = [
  ...MASTER_SKILL_SEEDS.map((skill) => ({ ...skill, kind: 'master', isProtected: true })),
  ...GUIDANCE_SKILL_SEEDS,
];
const REPO_SKILL_IDS = new Set(REPO_SKILL_SEEDS.map((skill) => skill.id));
const REPO_SKILL_SEEDS_BY_ID = new Map(REPO_SKILL_SEEDS.map((skill) => [skill.id, skill]));

const skillFileCache = new Map<string, { content: string; mtimeMs: number; cachedAt: number }>();

export function clearSkillFileCache() {
  const count = skillFileCache.size;
  skillFileCache.clear();
  return count;
}

registerRepoCacheInvalidator('skills', () => clearSkillFileCache(), { dependencies: ['skills'] });

function masterSkillSourcePath(id: string) {
  return path.posix.join('skills', `${id}.md`);
}

function masterSkillFilePath(id: string) {
  return path.join(SKILLS_DIR, `${id}.md`);
}

function readSkillFileWithCache(filePath: string) {
  const stat = fs.statSync(filePath);
  const now = Date.now();
  const cached = skillFileCache.get(filePath);
  if (cached && stat.mtimeMs <= cached.mtimeMs && now - cached.cachedAt < SKILL_FILE_CACHE_TTL_MS) {
    recordRepoCacheAccess('skills', true);
    return cached.content;
  }
  recordRepoCacheAccess('skills', false);
  const content = fs.readFileSync(filePath, 'utf8');
  skillFileCache.set(filePath, { content, mtimeMs: stat.mtimeMs, cachedAt: now });
  return content;
}

function ensureLegacySkillsColumns() {
  try {
    const tableInfo = db.pragma('table_info(skills)') as any[];
    const hasIsCustom = tableInfo.some((column) => column.name === 'isCustom');
    const hasContent = tableInfo.some((column) => column.name === 'content');
    if (!hasIsCustom) db.prepare('ALTER TABLE skills ADD COLUMN isCustom INTEGER DEFAULT 0').run();
    if (!hasContent) db.prepare('ALTER TABLE skills ADD COLUMN content TEXT').run();
  } catch (error) {
    console.error('Failed to migrate skills table', error);
  }
}

function getSkillColumns() {
  return (db.pragma('table_info(skills)') as any[]).map((column) => column.name);
}

function readLegacySkillSeeds() {
  if (!fs.existsSync(LEGACY_REGISTRY_BACKUP_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(LEGACY_REGISTRY_BACKUP_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string') : [];
  } catch (error) {
    return [];
  }
}

export function initSkillsRepository() {
  ensureLegacySkillsColumns();
  const currentSkills = db.prepare('SELECT * FROM skills').all() as any[];
  const existingIds = new Set(currentSkills.map((s) => s.id));
  let needsSave = false;

  const legacySeedsById = new Map(readLegacySkillSeeds().map((seed) => [seed.id, seed]));

  const additions = REPO_SKILL_SEEDS
    .filter((seed) => !existingIds.has(seed.id))
    .map((seed) => {
      const legacySeed = legacySeedsById.get(seed.id);
      const filePath = masterSkillFilePath(seed.id);
      return {
        id: seed.id,
        name: legacySeed?.name || seed.name,
        description: legacySeed?.description || seed.description || '',
        kind: seed.kind,
        isCustom: false,
        isProtected: seed.isProtected,
        sourceType: 'repo-file',
        sourcePath: masterSkillSourcePath(seed.id),
        filePath,
        content: fs.existsSync(filePath) ? readSkillFileWithCache(filePath) : '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

  if (additions.length > 0) {
    currentSkills.push(...additions);
    needsSave = true;
  }

  currentSkills.forEach((skill) => {
    skill.isCustom = Boolean(skill.isCustom);
    skill.isProtected = Boolean(skill.isProtected);
    if (!skill.isCustom) {
      const repoSeed = REPO_SKILL_SEEDS_BY_ID.get(skill.id);
      if (repoSeed) {
        if (skill.name !== repoSeed.name) {
          skill.name = repoSeed.name;
          needsSave = true;
        }
        if (skill.description !== repoSeed.description) {
          skill.description = repoSeed.description;
          needsSave = true;
        }
        if (skill.kind !== repoSeed.kind) {
          skill.kind = repoSeed.kind;
          needsSave = true;
        }
        if (skill.isProtected !== repoSeed.isProtected) {
          skill.isProtected = repoSeed.isProtected;
          needsSave = true;
        }
        if (skill.sourceType !== 'repo-file') {
          skill.sourceType = 'repo-file';
          needsSave = true;
        }
      }

      const expectedSourcePath = masterSkillSourcePath(skill.id);
      if (skill.sourcePath !== expectedSourcePath) {
        skill.sourcePath = expectedSourcePath;
        needsSave = true;
      }
      skill.filePath = masterSkillFilePath(skill.id);
    } else {
      skill.filePath = skill.sourcePath || skill.filePath;
    }

    if (!skill.isCustom && skill.filePath && fs.existsSync(skill.filePath)) {
      const fileContent = readSkillFileWithCache(skill.filePath);
      if (skill.content !== fileContent) {
        skill.content = fileContent;
        needsSave = true;
      }
    } else if (!skill.isCustom && (!skill.content || skill.content.length === 0)) {
      const filePath = skill.filePath || path.join(SKILLS_DIR, `${skill.id}.md`);
      if (fs.existsSync(filePath)) {
        skill.content = readSkillFileWithCache(filePath);
        needsSave = true;
      }
    }
  });

  if (currentSkills.some((skill) => REPO_SKILL_IDS.has(skill.id) && !skill.content)) needsSave = true;
  if (needsSave) saveAllSkills(currentSkills);
}

function saveAllSkills(skills: any[]) {
  const columns = getSkillColumns();
  const hasExtendedMetadata = columns.includes('kind');
  if (hasExtendedMetadata) {
    const stmt = db.prepare('INSERT OR REPLACE INTO skills (id, name, description, kind, isCustom, isProtected, sourceType, sourcePath, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      const currentIds = skills.map((skill) => skill.id);
      if (currentIds.length > 0) {
        const placeholders = currentIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM skills WHERE id NOT IN (${placeholders})`).run(...currentIds);
      } else {
        db.prepare('DELETE FROM skills').run();
      }
      for (const item of skills) {
        stmt.run(item.id, item.name, item.description, item.kind || (item.isCustom ? 'custom' : 'master'), item.isCustom ? 1 : 0, item.isProtected ? 1 : 0, item.sourceType || (item.isCustom ? 'database' : 'file'), item.sourcePath || item.filePath || null, item.content || null, item.createdAt || new Date().toISOString(), item.updatedAt || new Date().toISOString());
      }
    })();
    return;
  }
  const stmt = db.prepare('INSERT OR REPLACE INTO skills (id, name, description, isCustom, content) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    const currentIds = skills.map((skill) => skill.id);
    if (currentIds.length > 0) {
      const placeholders = currentIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM skills WHERE id NOT IN (${placeholders})`).run(...currentIds);
    } else {
      db.prepare('DELETE FROM skills').run();
    }
    for (const item of skills) {
      stmt.run(item.id, item.name, item.description, item.isCustom ? 1 : 0, item.content || null);
    }
  })();
}

export function getSkills(): any[] {
  const skills = db.prepare('SELECT * FROM skills').all() as any[];
  skills.forEach(skill => {
    skill.isCustom = Boolean(skill.isCustom);
    skill.isProtected = Boolean(skill.isProtected);
  });
  skills.sort((left, right) => {
    if (left.isCustom !== right.isCustom) return left.isCustom ? 1 : -1;
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
  return skills;
}

export function getSkill(id: string): any {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as any;
  if (skill) {
    skill.isCustom = Boolean(skill.isCustom);
    skill.isProtected = Boolean(skill.isProtected);
  }
  return skill;
}

export function createSkill(skill: any): void {
  const columns = getSkillColumns();
  if (columns.includes('kind')) {
    db.prepare('INSERT INTO skills (id, name, description, kind, isCustom, isProtected, sourceType, sourcePath, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(skill.id, skill.name, skill.description, skill.kind || 'custom', skill.isCustom ? 1 : 0, skill.isProtected ? 1 : 0, skill.sourceType || 'import', skill.sourcePath || null, skill.content || null, skill.createdAt || new Date().toISOString(), skill.updatedAt || new Date().toISOString());
  } else {
    db.prepare('INSERT INTO skills (id, name, description, isCustom, content) VALUES (?, ?, ?, ?, ?)').run(skill.id, skill.name, skill.description, skill.isCustom ? 1 : 0, skill.content || null);
  }
  invalidateRepoCacheDependencies({ reason: 'createSkill', dependencies: ['skills'] });
}

export function updateSkill(id: string, updates: any): void {
  const existing = getSkill(id);
  if (!existing) return;
  const merged = { ...existing, ...updates };
  const columns = getSkillColumns();
  if (columns.includes('kind')) {
    db.prepare('UPDATE skills SET name = ?, description = ?, kind = ?, isCustom = ?, isProtected = ?, sourceType = ?, sourcePath = ?, content = ?, updatedAt = ? WHERE id = ?').run(merged.name, merged.description, merged.kind, merged.isCustom ? 1 : 0, merged.isProtected ? 1 : 0, merged.sourceType, merged.sourcePath, merged.content, new Date().toISOString(), id);
  } else {
    db.prepare('UPDATE skills SET name = ?, description = ?, isCustom = ?, content = ? WHERE id = ?').run(merged.name, merged.description, merged.isCustom ? 1 : 0, merged.content, id);
  }
  invalidateRepoCacheDependencies({ reason: 'updateSkill', dependencies: ['skills'] });
}

export function deleteSkill(id: string): void {
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  invalidateRepoCacheDependencies({ reason: 'deleteSkill', dependencies: ['skills'] });
}

export function readSkillContent(skill: any) {
  if (!skill?.isCustom && skill?.id) {
    const filePath = masterSkillFilePath(String(skill.id));
    if (fs.existsSync(filePath)) return readSkillFileWithCache(filePath);
  }
  return skill?.content || '';
}
