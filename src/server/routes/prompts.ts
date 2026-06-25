import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { sendApiError } from '../services/api';
import {
  deletePromptOverrideForWorkspace,
  isAllowedPromptSkillId,
  listPromptSectionsForWorkspace,
  renderPromptTemplate,
  readPromptSectionForWorkspace,
  readPromptSectionFromMaster,
  resolvePromptProjectLocalPath,
  writePromptSectionToMaster,
  writePromptOverrideForWorkspace,
} from '../services/promptTemplateService';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import { getProjectRulesContext } from '../services/projectRulesService';
import { getActiveRunForTask, getLatestAgentRunForTask } from '../repositories/agentRunRepository';
import { getAgentTaskContext, renderTaskPrompt } from '../services/taskService';

type ProjectIdentifier = {
  projectId?: string;
  projectName?: string;
  repo?: string;
  repoUrl?: string;
  localPath?: string;
};

function readIdentifierFromQuery(query: express.Request['query']): ProjectIdentifier {
  const pick = (key: string) => (typeof query[key] === 'string' ? query[key] : undefined);
  return {
    projectId: pick('projectId'),
    projectName: pick('projectName'),
    repo: pick('repo'),
    repoUrl: pick('repoUrl'),
    localPath: pick('localPath'),
  };
}

function readStringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function registerPromptOverrideRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/tasks/:id/prompt-json', (req, res) => {
    try {
      const includeLogs = req.query.includeLogs === 'true' || req.query.mode === 'full' || req.query.mode === 'debug';
      const context = getAgentTaskContext(deps.state, req.params.id, includeLogs);
      if (!context) return res.status(404).json({ error: 'Task not found' });

      const activeRun = getActiveRunForTask(context.task.id) || getLatestAgentRunForTask(context.task.id);
      const runId = activeRun?.id || 'preview-run-id';
      const renderResult = renderTaskPrompt(deps.state, context.task.id, { runId, includeLogs }).renderResult;
      return res.json({
        content: renderResult.content,
        taskId: context.task.id,
        displayId: context.task.displayId,
        runId,
        usedSkills: renderResult.usedSkills || [],
      });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/prompt-template/sections', (req, res) => {
    try {
      const agent = readStringField(req.query.agent) || 'default';
      const pipelineId = readStringField(req.query.pipeline) || 'default';
      const sections = listPromptSectionsForWorkspace({ pipelineId, agent });
      return res.json({ sections });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/prompt-template/section', (req, res) => {
    try {
      const sectionId = readStringField(req.query.sectionId);
      if (!sectionId) {
        return res.status(400).json({ error: { code: 'INVALID_SECTION_ID', message: 'sectionId is required' } });
      }
      const agent = readStringField(req.query.agent) || 'default';
      const pipelineId = readStringField(req.query.pipeline) || 'default';
      const section = readPromptSectionFromMaster(sectionId, { pipelineId, agent });
      if (!section) {
        return res.status(404).json({ error: { code: 'SECTION_NOT_FOUND', message: `Section not in pipeline: ${sectionId}`, affectedId: sectionId } });
      }
      return res.json({ section });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.put('/api/prompt-template/section', (req, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const sectionId = readStringField(body.sectionId);
      if (!sectionId) {
        return res.status(400).json({ error: { code: 'INVALID_SECTION_ID', message: 'sectionId is required' } });
      }
      if (typeof body.content !== 'string') {
        return res.status(400).json({ error: { code: 'INVALID_CONTENT', message: 'content must be a string' } });
      }
      const agent = readStringField(body.agent) || 'default';
      const pipelineId = readStringField(body.pipeline) || 'default';
      const result = writePromptSectionToMaster(sectionId, body.content, { pipelineId, agent });
      return res.json(result);
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/prompt-template/preview', (req, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const agent = readStringField(body.agent) || 'preview-agent';
      const pipelineId = readStringField(body.pipeline) || 'default';
      const renderResult = renderPromptTemplate(pipelineId, {
        run: { id: 'preview-run' },
        task: { id: 'preview-task', displayId: 'PREVIEW-1', title: 'Preview Task' },
        assignment: { agent, model: readStringField(body.model) || 'preview-model', effort: readStringField(body.effort) || 'medium' },
        workspace: { repo: 'global-template', localPath: getDevFlowAppRoot() },
        instruction: {},
        requirements: {},
        projectRules: getProjectRulesContext(),
        repoContext: '',
        orchestration: {},
        agent,
        model: readStringField(body.model) || 'preview-model',
        effort: readStringField(body.effort) || 'medium',
      }, 'preview');
      return res.json({ content: renderResult.content, sections: renderResult.sections });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/prompt-overrides/sections', (req, res) => {
    try {
      const identifier = readIdentifierFromQuery(req.query);
      const localPath = resolvePromptProjectLocalPath(deps.state, identifier);
      const agent = readStringField(req.query.agent) || 'default';
      const pipelineId = readStringField(req.query.pipeline) || 'default';
      const sections = listPromptSectionsForWorkspace({ pipelineId, agent, localPath });
      return res.json({ sections });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/prompt-overrides/section', (req, res) => {
    try {
      const sectionId = readStringField(req.query.sectionId);
      if (!sectionId) {
        return res.status(400).json({ error: { code: 'INVALID_SECTION_ID', message: 'sectionId is required' } });
      }
      const identifier = readIdentifierFromQuery(req.query);
      const localPath = resolvePromptProjectLocalPath(deps.state, identifier);
      const agent = readStringField(req.query.agent) || 'default';
      const pipelineId = readStringField(req.query.pipeline) || 'default';
      const section = readPromptSectionForWorkspace(sectionId, { pipelineId, agent, localPath });
      if (!section) {
        return res.status(404).json({ error: { code: 'SECTION_NOT_FOUND', message: `Section not in pipeline: ${sectionId}`, affectedId: sectionId } });
      }
      return res.json({ section });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.put('/api/prompt-overrides/section', (req, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const sectionId = readStringField(body.sectionId);
      if (!sectionId) {
        return res.status(400).json({ error: { code: 'INVALID_SECTION_ID', message: 'sectionId is required' } });
      }
      if (typeof body.content !== 'string') {
        return res.status(400).json({ error: { code: 'INVALID_CONTENT', message: 'content must be a string' } });
      }
      const identifier: ProjectIdentifier = {
        projectId: readStringField(body.projectId),
        projectName: readStringField(body.projectName),
        repo: readStringField(body.repo),
        repoUrl: readStringField(body.repoUrl),
        localPath: readStringField(body.localPath),
      };
      const localPath = resolvePromptProjectLocalPath(deps.state, identifier);
      const agent = readStringField(body.agent) || 'default';
      const pipelineId = readStringField(body.pipeline) || 'default';
      if (!isAllowedPromptSkillId(sectionId, agent, pipelineId)) {
        return res.status(400).json({ error: { code: 'INVALID_SECTION_ID', message: `Section id not in pipeline: ${sectionId}`, affectedId: sectionId } });
      }
      const result = writePromptOverrideForWorkspace(localPath, sectionId, body.content, { pipelineId, agent });
      return res.json(result);
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.delete('/api/prompt-overrides/section', (req, res) => {
    try {
      const sectionId = readStringField(req.query.sectionId);
      if (!sectionId) {
        return res.status(400).json({ error: { code: 'INVALID_SECTION_ID', message: 'sectionId is required' } });
      }
      const identifier = readIdentifierFromQuery(req.query);
      const localPath = resolvePromptProjectLocalPath(deps.state, identifier);
      const agent = readStringField(req.query.agent) || 'default';
      const pipelineId = readStringField(req.query.pipeline) || 'default';
      if (!isAllowedPromptSkillId(sectionId, agent, pipelineId)) {
        return res.status(400).json({ error: { code: 'INVALID_SECTION_ID', message: `Section id not in pipeline: ${sectionId}`, affectedId: sectionId } });
      }
      const result = deletePromptOverrideForWorkspace(localPath, sectionId, { pipelineId, agent });
      return res.json(result);
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}
