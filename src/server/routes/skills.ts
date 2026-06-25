import fs from 'fs';
import type express from 'express';
import type { ApiRouteDeps } from '../types.js';
import { getSkills, getSkill, createSkill, updateSkill, deleteSkill, readSkillContent } from '../repositories/skillsRepository.js';

const AUTHORING_SKILL_IDS = [
  '00-skill-router',
  '01-authoring-core',
  '02-schema-reference',
  '03-reviewer-core',
  '04-examples',
];
const AUTHORING_SKILL_ID_SET = new Set(AUTHORING_SKILL_IDS);

function sortAuthoringSkills(skills: any[]) {
  return [...skills].sort((left, right) => AUTHORING_SKILL_IDS.indexOf(left.id) - AUTHORING_SKILL_IDS.indexOf(right.id));
}

export function registerSkillRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/skills', (req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind.trim().toLowerCase() : '';
    let skills = getSkills();

    if (kind === 'authoring') {
      skills = sortAuthoringSkills(skills.filter((s) => AUTHORING_SKILL_ID_SET.has(s.id)));
    } else if (kind === 'workflow') {
      skills = skills.filter((s) => s.id.endsWith('-workflow'));
    } else if (kind === 'prompt') {
      skills = skills.filter((s) => s.id === 'agent-task-prompt-template');
    } else if (kind === 'custom') {
      skills = skills.filter((s) => s.isCustom);
    }

    res.json(skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      isCustom: skill.isCustom,
      isProtected: skill.isProtected,
      kind: skill.kind,
    })));
  });

  app.get('/api/skills/authoring', (_req, res) => {
    const authoring = sortAuthoringSkills(getSkills().filter((s) => AUTHORING_SKILL_ID_SET.has(s.id)));
    res.json(authoring.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      isCustom: skill.isCustom,
      isProtected: skill.isProtected,
      kind: skill.kind,
      content: readSkillContent(skill),
    })));
  });

  app.get('/api/skills/authoring/:id', (req, res) => {
    if (!AUTHORING_SKILL_ID_SET.has(req.params.id)) {
      return res.status(404).json({ error: 'Authoring skill not found' });
    }
    const skill = getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Authoring skill not found' });
    return res.json({
      ...skill,
      content: readSkillContent(skill),
    });
  });

  app.get('/api/skills/:id', (req, res) => {
    const skill = getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    return res.json({ ...skill, content: readSkillContent(skill) });
  });

  app.put('/api/skills/:id', (req, res) => {
    const skill = getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    try {
      const body = req.body;
      const updates: any = {};
      if (body.content !== undefined) updates.content = body.content || '';
      if (body.name) updates.name = body.name;
      if (body.description) updates.description = body.description;
      updateSkill(req.params.id, updates);
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: 'Failed to write skill' });
    }
  });

  app.post('/api/skills/import', (req, res) => {
    const { id, name, description, content } = req.body;
    if (!id || !name || !content) return res.status(400).json({ error: 'Missing required fields' });
    
    if (getSkill(id)) {
      return res.status(400).json({ error: 'Skill ID already exists' });
    }

    createSkill({
      id,
      name,
      description: description || '',
      isCustom: true,
      isProtected: false,
      kind: 'custom',
      sourceType: 'import',
      sourcePath: null,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return res.status(201).json({ success: true, id });
  });

  app.delete('/api/skills/:id', (req, res) => {
    const skill = getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    if (skill.isProtected || !skill.isCustom) {
      return res.status(403).json({ error: 'Cannot delete master skills' });
    }

    if (skill.sourcePath && fs.existsSync(skill.sourcePath)) {
      try { fs.unlinkSync(skill.sourcePath); } catch (e) { console.error('Failed to delete file', e); }
    } else if (skill.filePath && fs.existsSync(skill.filePath)) {
      try { fs.unlinkSync(skill.filePath); } catch (e) { console.error('Failed to delete file', e); }
    }

    deleteSkill(req.params.id);
    return res.json({ success: true });
  });
}
