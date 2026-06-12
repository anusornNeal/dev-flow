import fs from 'fs';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { loadSkillsRegistry, saveSkillsRegistry } from '../repositories/skillsRepository';
import { getSkillById, getSkillDetail, updateSkillContent } from '../services/skillService';

export function registerSkillRoutes(app: express.Express, deps: ApiRouteDeps) {
  loadSkillsRegistry(deps.state);

  app.get('/api/skills', (_req, res) => {
    loadSkillsRegistry(deps.state);
    res.json(deps.state.skillsRegistry.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      isCustom: skill.isCustom,
      isProtected: skill.isProtected,
      kind: skill.kind,
    })));
  });

  app.get('/api/skills/:id', (req, res) => {
    loadSkillsRegistry(deps.state);
    const skill = getSkillDetail(deps.state, req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    return res.json(skill);
  });

  app.put('/api/skills/:id', (req, res) => {
    loadSkillsRegistry(deps.state);
    const skill = getSkillById(deps.state, req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.isProtected) {
      return res.status(403).json({ error: 'Master skills are read-only in the app. Edit the repo markdown file instead.' });
    }
    try {
      updateSkillContent(skill, req.body);
      skill.updatedAt = new Date().toISOString();
      saveSkillsRegistry(deps.state);
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: 'Failed to write skill' });
    }
  });

  app.post('/api/skills/import', (req, res) => {
    const { id, name, description, content } = req.body;
    if (!id || !name || !content) return res.status(400).json({ error: 'Missing required fields' });
    if (deps.state.skillsRegistry.some((skill) => skill.id === id)) {
      return res.status(400).json({ error: 'Skill ID already exists' });
    }

    deps.state.skillsRegistry.push({
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
    saveSkillsRegistry(deps.state);
    return res.status(201).json({ success: true, id });
  });

  app.delete('/api/skills/:id', (req, res) => {
    loadSkillsRegistry(deps.state);
    const index = deps.state.skillsRegistry.findIndex((skill) => skill.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Skill not found' });

    const skill = deps.state.skillsRegistry[index];
    if (skill.isProtected || !skill.isCustom) {
      return res.status(403).json({ error: 'Cannot delete master skills' });
    }

    if (skill.sourcePath && fs.existsSync(skill.sourcePath)) {
      try { fs.unlinkSync(skill.sourcePath); } catch (e) { console.error('Failed to delete file', e); }
    } else if (skill.filePath && fs.existsSync(skill.filePath)) {
      try { fs.unlinkSync(skill.filePath); } catch (e) { console.error('Failed to delete file', e); }
    }

    deps.state.skillsRegistry.splice(index, 1);
    saveSkillsRegistry(deps.state);
    return res.json({ success: true });
  });
}
