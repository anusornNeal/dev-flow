import fs from 'fs';
import path from 'path';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import { createApiError } from './api';
import { findProjectByIdentifier } from './taskService';
import type { ProjectRulesContext } from './projectRulesService';

export interface PromptRenderContext {
  run: { id: string };
  task: any;
  assignment?: any;
  workspace?: any;
  instruction?: any;
  requirements?: any;
  projectRules?: ProjectRulesContext;
  repoContext?: any;
  orchestration?: any;
  agent: string;
  model: string;
  effort: string;
}

export function isPromptValuePresent(val: any): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    return normalized !== '' && normalized !== 'none' && normalized !== '(none)' && normalized !== 'null' && normalized !== 'undefined';
  }
  if (Array.isArray(val)) {
    return val.some((item) => isPromptValuePresent(item));
  }
  if (typeof val === 'object') {
    return Object.values(val).some((item) => isPromptValuePresent(item));
  }
  return true;
}

function getPromptPipelineConfigPath() {
  return path.join(getDevFlowAppRoot(), 'config', 'prompt-pipeline.json');
}

function getPromptSkillsDir() {
  return path.join(getDevFlowAppRoot(), 'skills');
}

export function getPromptPipeline(pipelineId: string = 'default'): string[] {
  const configPath = getPromptPipelineConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config[pipelineId] || config['default'] || [];
    } catch (e) {
      console.error('Error parsing prompt-pipeline.json', e);
    }
  }
  return [
    'prompt.header',
    'prompt.task-context',
    'prompt.repo-context',
    'prompt.checklist',
    'prompt.subtasks',
    'prompt.execution-rules',
    'prompt.agent-specific.{agent}',
    'prompt.completion-contract',
    'prompt.footer'
  ];
}

function renderValue(val: any, isChecklistOrSubtasks = false): string {
  if (val === null || val === undefined || val === '') return '';
  if (Array.isArray(val)) {
    if (val.length === 0) return '';
    if (isChecklistOrSubtasks) {
      return val.map((item: any) => {
        if (typeof item === 'string') return `- ${item}`;
        if (item.text) {
          return `- [${item.completed ? 'x' : ' '}] ${item.text}`;
        }
        if (item.displayId || item.title || item.id) {
          const identifier = item.displayId || item.id || 'task';
          const title = item.title ? `: ${item.title}` : '';
          const details = [
            item.status || null,
            item.spawnAgent ? `agent=${item.spawnAgent}` : null,
            item.spawnModel ? `model=${item.spawnModel}` : null,
            item.spawnEffort ? `effort=${item.spawnEffort}` : null,
            item.branch ? `branch=${item.branch}` : null,
          ].filter(Boolean);
          return `- ${identifier}${title}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
        }
        return `- ${JSON.stringify(item)}`;
      }).join('\n');
    }
    return val.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join('\n');
  }
  if (typeof val === 'object') return JSON.stringify(val, null, 2);
  return String(val);
}

export function interpolate(template: string, context: PromptRenderContext): { text: string, hasDynamicTags: boolean, hasData: boolean } {
  let hasDynamicTags = false;
  let hasData = false;

  const text = template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    hasDynamicTags = true;
    const cleanKey = key.trim();
    const path = cleanKey.split('.');
    let current: any = context;
    for (const p of path) {
      if (current === undefined || current === null) {
        return '';
      }
      current = current[p];
    }
    
    if (isPromptValuePresent(current)) {
      hasData = true;
    } else {
      return '';
    }

    const isChecklistOrSubtasks = [
      'task.checklist',
      'task.subtasks',
      'requirements.checklist',
      'orchestration.subtasks',
    ].includes(cleanKey);
    return renderValue(current, isChecklistOrSubtasks);
  });

  return { text, hasDynamicTags, hasData };
}

export function renderPromptTemplate(pipelineId: string, context: PromptRenderContext, mode: 'agent' | 'preview' = 'agent') {
  const pipeline = getPromptPipeline(pipelineId);
  const usedSkills: string[] = [];
  const sections: string[] = [];
  const previewSections: { skillId: string; content: string; isEmpty: boolean }[] = [];
  const renderContext = { ...context };

  for (const rawSkillId of pipeline) {
    const skillId = rawSkillId.replace('{agent}', (context.agent || 'default').toLowerCase());
    const masterPath = path.join(getPromptSkillsDir(), `${skillId}.md`);
    let content = '';
    let usedSkillSource = skillId;

    if (context.workspace?.localPath) {
      const overridePath = path.join(context.workspace.localPath, '.devflow', 'prompt-overrides', `${skillId}.md`);
      if (fs.existsSync(overridePath)) {
        content = fs.readFileSync(overridePath, 'utf8');
        usedSkillSource = `${skillId} (override)`;
      }
    }

    if (!content && fs.existsSync(masterPath)) {
      content = fs.readFileSync(masterPath, 'utf8');
    }

    if (content) {
      const { text, hasDynamicTags, hasData } = interpolate(content, renderContext);
      const rendered = text.trim();
      const isEffectivelyEmpty = hasDynamicTags && !hasData;
      
      if (mode === 'preview') {
        previewSections.push({
          skillId,
          content: rendered,
          isEmpty: isEffectivelyEmpty || rendered === '' || rendered === '(none)'
        });
      }

      if (!isEffectivelyEmpty && rendered) {
        sections.push(rendered);
      }
      usedSkills.push(usedSkillSource);
    } else if (!rawSkillId.includes('agent-specific')) {
      throw new Error(`Required prompt skill missing: ${skillId}`);
    }
  }

  // Compose the final prompt body from the rendered sections only.
  // The internal usedSkills list is still returned in the API response for
  // logs/debugging, but we no longer emit it as an HTML comment at the top of
  // the rendered prompt.
  const finalContent = sections.join('\n\n');

  if (mode === 'preview') {
    return {
      content: finalContent,
      sections: previewSections,
      usedSkills
    };
  }

  return {
    content: finalContent,
    usedSkills
  };
}

export function getPromptPipelineStructure(pipelineId: string, agent: string, localPath?: string) {
  const pipeline = getPromptPipeline(pipelineId);
  return pipeline.map((rawSkillId, index) => {
    const skillId = rawSkillId.replace('{agent}', (agent || 'default').toLowerCase());
    const masterPath = path.join(getPromptSkillsDir(), `${skillId}.md`);
    let overridePath: string | null = null;
    let masterContent = '';
    let overrideContent = null;
    
    if (fs.existsSync(masterPath)) {
      masterContent = fs.readFileSync(masterPath, 'utf8');
    }
    
    if (localPath) {
      overridePath = path.join(localPath, '.devflow', 'prompt-overrides', `${skillId}.md`);
      if (fs.existsSync(overridePath)) {
        overrideContent = fs.readFileSync(overridePath, 'utf8');
      }
    }
    
    const isRequired = !rawSkillId.includes('agent-specific');
    
    return {
      id: skillId,
      title: skillId,
      order: index + 1,
      required: isRequired,
      sourcePath: masterPath,
      sourceType: overrideContent !== null ? 'override' : 'master',
      masterContent,
      overrideContent: overrideContent !== null ? overrideContent : undefined,
      effectiveContent: overrideContent !== null ? overrideContent : masterContent,
      rawId: rawSkillId, // keeping for backward compatibility if needed internally
      overridePath
    };
  });
}

const PROMPT_SKILL_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function resolvePromptSectionId(rawSkillId: string, agent: string): string {
  return rawSkillId.replace('{agent}', (agent || 'default').toLowerCase());
}

export function isAllowedPromptSkillId(skillId: unknown, agent: string, pipelineId: string = 'default'): boolean {
  if (typeof skillId !== 'string' || skillId.length === 0 || skillId.length > 128) return false;
  if (!PROMPT_SKILL_ID_PATTERN.test(skillId)) return false;
  if (skillId.includes('..')) return false;
  const resolved = getPromptPipeline(pipelineId).map((raw) => resolvePromptSectionId(raw, agent));
  if (resolved.includes(skillId)) return true;
  return skillId === `prompt.agent-specific.${(agent || 'default').toLowerCase()}`;
}

export function listPromptSectionsForWorkspace(opts: { pipelineId?: string; agent?: string; localPath?: string }) {
  const pipelineId = opts.pipelineId || 'default';
  const agent = opts.agent || 'default';
  const sections = getPromptPipelineStructure(pipelineId, agent, opts.localPath);
  return sections.map((s) => ({
    id: s.id,
    order: s.order,
    required: s.required,
    sourceType: s.sourceType,
    masterAvailable: Boolean(s.masterContent),
    overrideAvailable: Boolean(s.overrideContent),
    effectiveEmpty: !s.effectiveContent || String(s.effectiveContent).trim().length === 0,
    sourcePath: s.sourcePath,
    overridePath: s.overridePath,
  }));
}

export function readPromptSectionForWorkspace(sectionId: string, opts: { pipelineId?: string; agent?: string; localPath?: string }) {
  const pipelineId = opts.pipelineId || 'default';
  const agent = opts.agent || 'default';
  if (!isAllowedPromptSkillId(sectionId, agent, pipelineId)) {
    throw createApiError(400, 'INVALID_SECTION_ID', `Section id not in pipeline: ${sectionId}`, { affectedId: sectionId });
  }
  const all = getPromptPipelineStructure(pipelineId, agent, opts.localPath);
  return all.find((s) => s.id === sectionId) || null;
}

function ensureOverridePathIsSafe(localPath: string, sectionId: string, opts: { pipelineId?: string; agent?: string }) {
  const pipelineId = opts.pipelineId || 'default';
  const agent = opts.agent || 'default';
  if (!isAllowedPromptSkillId(sectionId, agent, pipelineId)) {
    throw createApiError(400, 'INVALID_SECTION_ID', `Section id not in pipeline: ${sectionId}`, { affectedId: sectionId });
  }
  const overrideDir = path.join(localPath, '.devflow', 'prompt-overrides');
  const overridePath = path.join(overrideDir, `${sectionId}.md`);
  const resolved = path.resolve(overridePath);
  const root = path.resolve(overrideDir);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw createApiError(403, 'FILE_ACCESS_DENIED', 'Path traversal detected', { affectedId: sectionId });
  }
  return { overrideDir, overridePath: resolved };
}

export function writePromptOverrideForWorkspace(localPath: string, sectionId: string, content: string, opts: { pipelineId?: string; agent?: string } = {}) {
  if (typeof content !== 'string') {
    throw createApiError(400, 'INVALID_CONTENT', 'content must be a string');
  }
  if (typeof localPath !== 'string' || !localPath) {
    throw createApiError(400, 'INVALID_LOCAL_PATH', 'localPath is required');
  }
  const { overrideDir, overridePath } = ensureOverridePathIsSafe(localPath, sectionId, opts);
  fs.mkdirSync(overrideDir, { recursive: true });
  fs.writeFileSync(overridePath, content, 'utf8');
  return { success: true, overridePath };
}

export function deletePromptOverrideForWorkspace(localPath: string, sectionId: string, opts: { pipelineId?: string; agent?: string } = {}) {
  if (typeof localPath !== 'string' || !localPath) {
    throw createApiError(400, 'INVALID_LOCAL_PATH', 'localPath is required');
  }
  const { overridePath } = ensureOverridePathIsSafe(localPath, sectionId, opts);
  if (!fs.existsSync(overridePath)) return { success: true, removed: false, overridePath };
  fs.unlinkSync(overridePath);
  return { success: true, removed: true, overridePath };
}

export function resolvePromptProjectLocalPath(state: any, identifier: { projectId?: string; projectName?: string; repo?: string; repoUrl?: string; localPath?: string }): string {
  const project = findProjectByIdentifier(state, identifier);
  if (project?.localPath) return project.localPath;
  if (typeof identifier.localPath === 'string' && identifier.localPath) return identifier.localPath;
  throw createApiError(400, 'INVALID_PROJECT', 'Could not resolve a workspace: provide projectId, projectName, repo, repoUrl, or localPath');
}
