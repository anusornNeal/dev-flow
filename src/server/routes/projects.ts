import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { loadTasks, saveTasks } from '../repositories/taskRepository';
import { saveProjects } from '../repositories/projectRepository';
import { validateString } from '../validation';
import { getPromptPipelineStructure, renderPromptTemplate, PromptRenderContext } from '../services/promptTemplateService';
import fs from 'fs';
import path from 'path';
export function registerProjectRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/projects', (_req, res) => {
    res.json(deps.state.projectsCache);
  });

  app.post('/api/projects', (req, res) => {
    const { name, repoUrl, description, localPath, taskIdPrefix } = req.body;

    const nameErr = validateString(name, 'name', true);
    if (nameErr) return res.status(400).json({ error: nameErr });

    const repoErr = validateString(repoUrl, 'repoUrl', true);
    if (repoErr) return res.status(400).json({ error: repoErr });

    const newProject = {
      id: `project-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
      name: name.trim(),
      repoUrl: repoUrl.trim(),
      description: (description || '').trim(),
      localPath: (localPath || '').trim() || undefined,
      taskIdPrefix: (taskIdPrefix || '').trim() || undefined,
      createdAt: new Date().toISOString(),
    };

    deps.state.projectsCache.push(newProject);
    saveProjects(deps.state);
    return res.status(201).json(newProject);
  });

  app.put('/api/projects/:id', (req, res) => {
    const projectId = req.params.id;
    const index = deps.state.projectsCache.findIndex((project) => project.id === projectId);
    if (index === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { name, repoUrl, description, localPath, taskIdPrefix } = req.body;
    const project = deps.state.projectsCache[index];

    if (name !== undefined) project.name = name.trim();
    if (repoUrl !== undefined) project.repoUrl = repoUrl.trim();
    if (description !== undefined) project.description = description.trim();
    if (localPath !== undefined) project.localPath = localPath.trim() || undefined;
    if (taskIdPrefix !== undefined) project.taskIdPrefix = taskIdPrefix.trim() || undefined;

    saveProjects(deps.state);
    return res.json(project);
  });

  app.delete('/api/projects/:id', (req, res) => {
    loadTasks(deps.state);
    const projectId = req.params.id;
    if (projectId === 'project-default') {
      return res.status(400).json({ error: 'Cannot delete default project' });
    }

    const index = deps.state.projectsCache.findIndex((project) => project.id === projectId);
    if (index === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }

    deps.state.projectsCache.splice(index, 1);
    saveProjects(deps.state);

    deps.state.tasksCache = deps.state.tasksCache.filter((task) => task.projectId !== projectId);
    saveTasks(deps.state);

    return res.json({ success: true, removedId: projectId });
  });

  app.get('/api/projects/:id/prompt-sections', (req, res) => {
    const projectId = req.params.id;
    const project = deps.state.projectsCache.find((p) => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const agent = req.query.agent ? String(req.query.agent) : 'default';
    const pipelineId = req.query.pipeline ? String(req.query.pipeline) : 'default';

    const structure = getPromptPipelineStructure(pipelineId, agent, project.localPath);
    res.json({ sections: structure });
  });

  app.put('/api/projects/:id/prompt-overrides/:sectionId', (req, res) => {
    const projectId = req.params.id;
    const sectionId = req.params.sectionId;
    const { content } = req.body;

    const project = deps.state.projectsCache.find((p) => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.localPath) return res.status(400).json({ error: 'Project has no localPath configured' });

    const overrideDir = path.join(project.localPath, '.devflow', 'prompt-overrides');
    fs.mkdirSync(overrideDir, { recursive: true });

    const overridePath = path.join(overrideDir, `${sectionId}.md`);
    fs.writeFileSync(overridePath, content || '', 'utf8');

    res.json({ success: true });
  });

  app.delete('/api/projects/:id/prompt-overrides/:sectionId', (req, res) => {
    const projectId = req.params.id;
    const sectionId = req.params.sectionId;

    const project = deps.state.projectsCache.find((p) => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.localPath) return res.status(400).json({ error: 'Project has no localPath configured' });

    const overridePath = path.join(project.localPath, '.devflow', 'prompt-overrides', `${sectionId}.md`);
    if (fs.existsSync(overridePath)) {
      fs.unlinkSync(overridePath);
    }

    res.json({ success: true });
  });

  app.post('/api/projects/:id/prompt-preview', (req, res) => {
    const projectId = req.params.id;
    const project = deps.state.projectsCache.find((p) => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const pipelineId = req.body.pipeline || 'default';
    const agent = req.body.agent || 'preview-agent';

    const context: PromptRenderContext = {
      run: { id: 'preview-run' },
      task: { id: 'preview-task', title: 'Preview Task', description: 'This is a preview task.' },
      workspace: { projectId: project.id, localPath: project.localPath, repo: project.repoUrl },
      agent,
      model: req.body.model || 'preview-model',
      effort: req.body.effort || 'medium'
    };

    try {
      const renderResult = renderPromptTemplate(pipelineId, context, 'preview');
      res.json({ content: renderResult.content, sections: renderResult.sections });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
