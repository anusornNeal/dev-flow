import type express from 'express';
import type { ApiRouteDeps } from '../types';
import type { BugStatus } from '../../types';
import { getTasks, saveTask } from '../repositories/taskRepository.js';
import { appendBugVersion, createBugThread, updateBugStatus } from '../useCases/taskUseCases';
import { validateEnum, validateString } from '../validation';
import { appendTaskLog, canOverrideTaskLock, getTaskIndexByIdentifier, toMutationResponse } from './taskRouteSupport';

export function registerTaskBugRoutes(app: express.Express, _deps: ApiRouteDeps) {
  app.post('/api/tasks/:id/bugs', (req, res) => {
    const taskIndex = getTaskIndexByIdentifier(getTasks(), req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });
    const task = getTasks()[taskIndex];
    if (task.status === 'in-progress' && !canOverrideTaskLock(task, req.body, req.query, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }
    const titleErr = validateString(req.body.title, 'title', true);
    if (titleErr) return res.status(400).json({ error: titleErr });
    const updatedTask = createBugThread(task, {
      title: req.body.title,
      source: req.body.source,
      severity: req.body.severity,
      actual: req.body.actual,
      expected: req.body.expected,
      evidence: req.body.evidence,
      relatedAreas: Array.isArray(req.body.relatedAreas) ? req.body.relatedAreas : [],
      prompt: req.body.prompt,
      summary: req.body.summary,
      createdBy: req.body.createdBy,
    });
    const bug = updatedTask.bugs[0];
    appendTaskLog(updatedTask, `Bug thread "${bug.title}" created inside task.`, 'update');
    saveTask(updatedTask);
    return res.status(201).json(toMutationResponse(req, updatedTask, { task: updatedTask, bug }, { bug }));
  });

  app.post('/api/tasks/:id/bugs/:bugId/versions', (req, res) => {
    const taskIndex = getTaskIndexByIdentifier(getTasks(), req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });
    const task = getTasks()[taskIndex];
    if (task.status === 'in-progress' && !canOverrideTaskLock(task, req.body, req.query, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }
    const promptErr = validateString(req.body.prompt, 'prompt', true);
    if (promptErr) return res.status(400).json({ error: promptErr });
    const updatedTask = appendBugVersion(task, req.params.bugId, {
      prompt: req.body.prompt,
      summary: req.body.summary,
      changedFiles: Array.isArray(req.body.changedFiles) ? req.body.changedFiles : [],
      createdBy: req.body.createdBy,
    });
    const bug = updatedTask.bugs.find((entry: any) => entry.id === req.params.bugId);
    if (!bug) return res.status(404).json({ error: 'Bug thread not found' });
    appendTaskLog(updatedTask, `Bug thread "${bug.title}" received version ${bug.versions.length}.`, 'update');
    saveTask(updatedTask);
    return res.status(201).json(toMutationResponse(req, updatedTask, { task: updatedTask, bug }, { bug }));
  });

  app.post('/api/tasks/:id/bugs/:bugId/status', (req, res) => {
    const taskIndex = getTaskIndexByIdentifier(getTasks(), req.params.id);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });
    const task = getTasks()[taskIndex];
    if (task.status === 'in-progress' && !canOverrideTaskLock(task, req.body, req.query, req.headers['x-agent-request'])) {
      return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
    }
    const statusErr = validateEnum(req.body.status, 'status', ['open', 'fixing', 'fixed', 'verified', 'reopened', 'archived'], true);
    if (statusErr) return res.status(400).json({ error: statusErr });
    const updatedTask = updateBugStatus(task, req.params.bugId, req.body.status as BugStatus);
    const bug = updatedTask.bugs.find((entry: any) => entry.id === req.params.bugId);
    if (!bug) return res.status(404).json({ error: 'Bug thread not found' });
    appendTaskLog(updatedTask, `Bug thread "${bug.title}" status set to ${bug.status}.`, 'update');
    saveTask(updatedTask);
    return res.json(toMutationResponse(req, updatedTask, { task: updatedTask, bug }, { bug }));
  });
}
