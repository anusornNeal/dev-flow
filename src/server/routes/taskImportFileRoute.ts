import fs from 'fs';
import path from 'path';
import type express from 'express';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import type { ApiRouteDeps } from '../types';
import { sendApiError } from '../services/api';
import { applyTaskCategoryAndTagsUpdate, extractDesignImages, extractImages, normalizeTaskCategoryAndTags, resolveProjectIdFromRepo, validateTaskPayload } from '../services/taskService';
import { generateDisplayId, saveTasks } from '../repositories/taskRepository';

function getTaskIndexByIdentifier(tasks: any[], targetId: string) {
  return tasks.findIndex((task) => task.id === targetId || task.displayId === targetId);
}

export function registerTaskImportFileRoute(app: express.Express, deps: ApiRouteDeps) {
  app.post('/api/tasks/import-file', async (req, res) => {
    try {

      const mode = req.body.mode === 'apply' ? 'apply' : 'dry-run';
      const strategy = req.body.strategy === 'replace' ? 'replace' : 'patch';
      const fileUrl = typeof req.body.fileUrl === 'string' ? req.body.fileUrl.trim() : '';
      const patchFilePath = typeof req.body.patchFilePath === 'string' ? req.body.patchFilePath.trim() : '';
      const maxTasks = Number.isFinite(Number(req.body.maxTasks)) ? Math.max(1, Math.min(50, Number(req.body.maxTasks))) : 50;

      if (!fileUrl && !patchFilePath) {
        return res.status(400).json({ error: 'fileUrl or patchFilePath is required.' });
      }

      let raw = '';
      if (fileUrl) {
        if (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://')) {
          return res.status(400).json({ error: 'fileUrl must start with http:// or https://' });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const fetchRes = await fetch(fileUrl, { signal: controller.signal });
          const contentLength = Number(fetchRes.headers.get('content-length') || '0');
          if (contentLength > 5_000_000) {
            return res.status(400).json({ error: 'File too large. Maximum 5 MB.' });
          }
          raw = await fetchRes.text();
          if (raw.length > 5_000_000) {
            return res.status(400).json({ error: 'File too large. Maximum 5 MB.' });
          }
        } finally {
          clearTimeout(timer);
        }
      } else {
        const resolved = path.resolve(patchFilePath);
        const allowed = path.resolve(getDevFlowAppRoot());
        if (!resolved.startsWith(allowed + path.sep) && resolved !== allowed) {
          return res.status(400).json({ error: 'patchFilePath must be inside the DevFlow project root.' });
        }
        if (!fs.existsSync(resolved)) {
          return res.status(400).json({ error: `File not found: ${patchFilePath}` });
        }
        const stat = fs.statSync(resolved);
        if (stat.size > 5_000_000) {
          return res.status(400).json({ error: 'File too large. Maximum 5 MB.' });
        }
        raw = fs.readFileSync(resolved, 'utf8');
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return res.status(400).json({ error: 'Invalid JSON.' });
      }

      if (parsed.version !== 'devflow.taskPatch.v1') {
        return res.status(400).json({ error: 'Unsupported version. Expected devflow.taskPatch.v1.' });
      }

      const defaults = parsed.defaults || {};
      const items = Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, maxTasks) : [];

      const VALID_FIELDS: Set<string> = new Set([
        'title', 'description', 'status', 'priority', 'branch', 'category', 'tags', 'targetFiles',
        'checklist', 'effort', 'model', 'agent', 'parentId', 'reasoning',
        'acceptanceCriteria', 'verification', 'repoContext', 'specUrl', 'designImages', 'images', 'jiraKey', 'sourceUrl',
      ]);

      const projectDefaults = {
        projectId: defaults.projectId || req.body.projectId || '',
        projectName: defaults.projectName || req.body.projectName || '',
        repo: defaults.repo || req.body.repo || '',
        repoUrl: defaults.repoUrl || req.body.repoUrl || '',
      };

      const buildProjectInfo = (item: any) => ({
        projectId: (typeof item.projectId === 'string' ? item.projectId : '') || projectDefaults.projectId,
        projectName: (typeof item.projectName === 'string' ? item.projectName : '') || projectDefaults.projectName,
        repo: (typeof item.repo === 'string' ? item.repo : '') || projectDefaults.repo,
        repoUrl: (typeof item.repoUrl === 'string' ? item.repoUrl : '') || projectDefaults.repoUrl,
      });

      interface PlannedOp {
        type: 'create' | 'update';
        item: any;
        fields: Record<string, any>;
        taskId?: string;
        existingIndex?: number;
        title?: string;
        error?: string;
        resolvedProjectId?: string;
      }

      const planned: PlannedOp[] = [];
      let hasValidationError = false;

      for (const item of items) {
        if (!item.operation || !['create', 'update'].includes(item.operation)) {
          planned.push({ type: 'create' as const, item, fields: {}, error: 'Missing or unsupported operation. Use "create" or "update".' });
          hasValidationError = true;
          continue;
        }

        const fields = item.fields || {};
        const unknown = Object.keys(fields).find((k) => !VALID_FIELDS.has(k));
        if (unknown) {
          planned.push({ type: item.operation, item, fields, error: `Unknown field: ${unknown}` });
          hasValidationError = true;
          continue;
        }

        if (item.operation === 'update') {
          const taskId = item.taskId || item.id;
          const updateValidationError = validateTaskPayload(fields, true);
          if (updateValidationError) {
            planned.push({ type: 'update', item, fields, taskId, error: updateValidationError });
            hasValidationError = true;
            continue;
          }
          if (!taskId) {
            planned.push({ type: 'update', item, fields, error: 'taskId is required for update operations.' });
            hasValidationError = true;
            continue;
          }
          const existingIndex = getTaskIndexByIdentifier(deps.state.tasksCache, String(taskId));
          if (existingIndex === -1) {
            planned.push({ type: 'update', item, fields, taskId, error: 'Task not found.' });
            hasValidationError = true;
            continue;
          }
          planned.push({ type: 'update', item, fields, taskId, existingIndex });
        } else {
          const itemProject = buildProjectInfo(item);
          const title = item.title || fields.title || '';
          const createValidationError = validateTaskPayload({ ...fields, title }, false);
          if (createValidationError) {
            planned.push({ type: 'create', item, fields, title: title.trim(), error: createValidationError });
            hasValidationError = true;
            continue;
          }
          if (!title.trim()) {
            planned.push({ type: 'create', item, fields, error: 'title is required for create operations.' });
            hasValidationError = true;
            continue;
          }
          const resolvedName = itemProject.projectName || itemProject.repo || itemProject.repoUrl || itemProject.projectId;
          if (!resolvedName) {
            planned.push({ type: 'create', item, fields, title, error: 'Project resolver (projectName, repo, repoUrl, or projectId) is required for create.' });
            hasValidationError = true;
            continue;
          }
          let resolvedProjectId = '';
          try {
            resolvedProjectId = resolveProjectIdFromRepo(deps.state, itemProject, req as any);
          } catch {
            planned.push({ type: 'create', item, fields, title: title.trim(), error: 'Could not resolve project.' });
            hasValidationError = true;
            continue;
          }
          planned.push({ type: 'create', item, fields, title: title.trim(), error: undefined, resolvedProjectId });
        }
      }

      if (planned.length === 0) {
        return res.status(400).json({ error: 'No valid operations to process. Check format: version devflow.taskPatch.v1, tasks array with operation + fields.' });
      }

      if (mode === 'dry-run' || hasValidationError) {
        return res.json({
          mode: hasValidationError ? 'dry-run' : mode,
          strategy,
          summary: {
            planned: planned.length,
            created: planned.filter((p) => p.type === 'create' && !p.error).length,
            updated: planned.filter((p) => p.type === 'update' && !p.error).length,
            failed: planned.filter((p) => p.error).length,
            operations: planned.map((p) => ({
              type: p.type,
              taskId: p.taskId,
              title: p.title,
              error: p.error,
            })),
          },
        });
      }

      const cloned = deps.state.tasksCache.map((t) => ({ ...t, checklist: Array.isArray(t.checklist) ? [...t.checklist] : t.checklist, logs: Array.isArray(t.logs) ? [...t.logs] : t.logs, tags: Array.isArray(t.tags) ? [...t.tags] : t.tags }));
      const created: string[] = [];
      const updated: string[] = [];

      for (const op of planned) {
        if (op.type === 'update' && op.existingIndex !== undefined && op.taskId) {
          const currentTask = cloned[op.existingIndex];
          const classification = applyTaskCategoryAndTagsUpdate(op.fields, currentTask);
          if (strategy === 'replace') {
            cloned[op.existingIndex] = { ...currentTask, ...op.fields, ...classification, updatedAt: new Date().toISOString() };
          } else {
            Object.assign(currentTask, op.fields, classification, { updatedAt: new Date().toISOString() });
          }
          updated.push(op.taskId);
        } else if (op.type === 'create' && op.resolvedProjectId) {
          const f = op.fields;
          const classification = normalizeTaskCategoryAndTags(f, { requireCategory: true });
          const newTask: any = {
            id: op.item.id || `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
            displayId: op.item.displayId || generateDisplayId(deps.state, op.resolvedProjectId),
            projectId: op.resolvedProjectId,
            title: op.title || 'untitled',
            description: f.description || '',
            status: f.status || 'backlog',
            priority: f.priority || 'medium',
            branch: f.branch || undefined,
            category: classification.category,
            tags: classification.tags,
            targetFiles: Array.isArray(f.targetFiles) ? f.targetFiles : [],
            checklist: Array.isArray(f.checklist) ? f.checklist : [],
            designImages: extractDesignImages(f) || [],
        images: extractImages(f) || [],
            effort: f.effort || undefined,
            model: f.model || undefined,
            agent: f.agent || undefined,
            parentId: f.parentId || undefined,
            reasoning: f.reasoning || undefined,
            acceptanceCriteria: f.acceptanceCriteria || undefined,
            verification: f.verification || undefined,
            repoContext: f.repoContext || undefined,
            specUrl: f.specUrl || undefined,
            jiraKey: f.jiraKey || undefined,
            sourceUrl: f.sourceUrl || undefined,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            logs: [{ id: `log-${Date.now()}-im`, timestamp: new Date().toISOString(), message: 'Task created via import-file.', type: 'create' }],
          };
          cloned.push(newTask);
          created.push(newTask.displayId || newTask.id);
        }
      }

      deps.state.tasksCache = cloned;
      saveTasks(deps.state);

      return res.json({
        mode,
        strategy,
        summary: {
          created: created.length,
          updated: updated.length,
          failed: 0,
          createdIds: created,
          updatedIds: updated,
        },
      });
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}

