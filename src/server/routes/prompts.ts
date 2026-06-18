import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { sendApiError } from '../services/api';
import {
  deletePromptOverrideForWorkspace,
  isAllowedPromptSkillId,
  listPromptSectionsForWorkspace,
  readPromptSectionForWorkspace,
  resolvePromptProjectLocalPath,
  writePromptOverrideForWorkspace,
} from '../services/promptTemplateService';

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
