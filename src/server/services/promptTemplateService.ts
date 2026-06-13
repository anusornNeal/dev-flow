import fs from 'fs';
import path from 'path';
import { getDevFlowAppRoot } from './agentRunService';
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
  if (val === null || val === undefined || val === '') return '(none)';
  if (Array.isArray(val)) {
    if (val.length === 0) return '(none)';
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

export function interpolate(template: string, context: PromptRenderContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const cleanKey = key.trim();
    const path = cleanKey.split('.');
    let current: any = context;
    for (const p of path) {
      if (current === undefined || current === null) {
        return '(none)';
      }
      current = current[p];
    }
    const isChecklistOrSubtasks = [
      'task.checklist',
      'task.subtasks',
      'requirements.checklist',
      'orchestration.subtasks',
    ].includes(cleanKey);
    return renderValue(current, isChecklistOrSubtasks);
  });
}

export function renderPromptTemplate(pipelineId: string, context: PromptRenderContext) {
  const pipeline = getPromptPipeline(pipelineId);
  const usedSkills: string[] = [];
  const sections: string[] = [];

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
      sections.push(interpolate(content, context));
      usedSkills.push(usedSkillSource);
    } else if (!rawSkillId.includes('agent-specific')) {
      throw new Error(`Required prompt skill missing: ${skillId}`);
    }
  }

  // Prepend used skills as requested
  const finalContent = `<!-- Rendered using skills: ${usedSkills.join(', ')} -->\n\n${sections.join('\n\n')}`;

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
