import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { loadTasks, saveTasks } from '../repositories/taskRepository';
import { saveProjects } from '../repositories/projectRepository';
import { validateString } from '../validation';

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
}
