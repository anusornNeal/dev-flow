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

function createSection(title: string, blocks: Array<string | null | undefined>) {
  const content = blocks.filter((block): block is string => isPromptValuePresent(block)).join('\n\n').trim();
  if (!content) return '';
  return `## ${title}\n${content}`;
}

function createLabeledBlock(label: string, value: any) {
  if (!isPromptValuePresent(value)) return '';
  return `**${label}:**\n${renderValue(value, label === 'Checklist' || label === 'Subtasks')}`;
}

function createLabeledLine(label: string, value: any) {
  if (!isPromptValuePresent(value)) return '';
  return `**${label}:** ${renderValue(value)}`;
}

function createTaskLine(task: any) {
  const parts = [task?.displayId, task?.title].filter((part) => isPromptValuePresent(part));
  if (parts.length === 0) return '';
  return `**Task:** ${parts.join(' - ')}`;
}

function createConfigurationLine(context: PromptRenderContext) {
  const parts = [
    isPromptValuePresent(context.assignment?.agent) ? `Agent: ${context.assignment.agent}` : null,
    isPromptValuePresent(context.assignment?.model) ? `Model: ${context.assignment.model}` : null,
    isPromptValuePresent(context.assignment?.effort) ? `Effort: ${context.assignment.effort}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return '';
  return `**Configuration:** ${parts.join(', ')}`;
}

function buildDerivedSections(context: PromptRenderContext) {
  const headerLines = [
    '# DevFlow Task Prompt',
    createLabeledLine('Run ID', context.run?.id),
    createTaskLine(context.task),
    createLabeledLine('Status', context.task?.status),
    createLabeledLine('Priority', context.task?.priority),
    createConfigurationLine(context),
    '',
    'This prompt is the sole source of truth for your DevFlow task context.',
  ].filter((line, index, arr) => {
    if (line !== '') return true;
    return index > 0 && arr[index - 1] !== '';
  });

  const taskContext = createSection('Task Context', [
    createLabeledBlock('Description', context.instruction?.description),
    createLabeledBlock('Acceptance Criteria', context.requirements?.acceptanceCriteria),
    createLabeledBlock('Verification', context.requirements?.verification),
    createLabeledBlock('Reasoning', context.instruction?.reasoning),
    createLabeledBlock('Target Files', context.requirements?.targetFiles),
    createLabeledBlock('Repository Notes', context.repoContext),
  ]);

  const repoBlocks: string[] = [
    createLabeledLine('Repository URL', context.workspace?.repo),
    createLabeledLine('Local Path', context.workspace?.localPath),
    createLabeledLine('Branch', context.task?.branch),
  ].filter((line) => isPromptValuePresent(line));
  if (isPromptValuePresent(context.workspace?.localPath)) {
    repoBlocks.push(`**CRITICAL RULE:** The process you are running in should already be launched inside the correct repository folder (\`${context.workspace.localPath}\`). If your current folder is NOT the expected repository, you MUST stop and report a clear error.`);
  }
  const repoContext = createSection('Repository Context', repoBlocks);

  const projectRulesBlocks = [
    isPromptValuePresent(context.projectRules?.workflow) ? renderValue(context.projectRules.workflow) : '',
  ];
  const projectRules = isPromptValuePresent(context.projectRules?.title)
    ? createSection(context.projectRules.title, projectRulesBlocks)
    : '';

  const checklistBlocks = [
    renderValue(context.requirements?.checklist, true),
    isPromptValuePresent(context.requirements?.checklist)
      ? '**Rule:** Checklist items are explicit work and verification hints. Completing them does NOT authorize you to pick another card.'
      : '',
  ];
  const checklist = createSection('Checklist', checklistBlocks);

  const subtasksBlocks = [
    createLabeledLine('Role', context.orchestration?.role),
    createLabeledLine('Has Subtasks', context.orchestration?.hasSubtasks),
    isPromptValuePresent(context.orchestration?.subtasks) ? renderValue(context.orchestration.subtasks, true) : '',
    createLabeledBlock('Parent Boundary', context.orchestration?.parentBoundary),
    '**Rule:** Subtasks are provided for context only, unless your current card explicitly tells you to implement them. DO NOT spawn subagents automatically just because subtasks exist.',
  ];
  const subtasks = createSection('Subtasks', subtasksBlocks);

  return {
    header: headerLines.join('\n').trim(),
    taskContext,
    repoContext,
    projectRules,
    checklist,
    subtasks,
  };
}

export function interpolate(template: string, context: PromptRenderContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const cleanKey = key.trim();
    const allowEmpty = cleanKey.startsWith('sections.');
    const path = cleanKey.split('.');
    let current: any = context;
    for (const p of path) {
      if (current === undefined || current === null) {
        return '';
      }
      current = current[p];
    }
    if (allowEmpty && !isPromptValuePresent(current)) {
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
}

export function renderPromptTemplate(pipelineId: string, context: PromptRenderContext, mode: 'agent' | 'preview' = 'agent') {
  const pipeline = getPromptPipeline(pipelineId);
  const usedSkills: string[] = [];
  const sections: string[] = [];
  const previewSections: { skillId: string; content: string; isEmpty: boolean }[] = [];
  const renderContext = {
    ...context,
    sections: buildDerivedSections(context),
  };

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
      const rendered = interpolate(content, renderContext).trim();
      
      if (mode === 'preview') {
        previewSections.push({
          skillId,
          content: rendered,
          isEmpty: rendered === '' || rendered === '(none)'
        });
      }

      if (rendered) sections.push(rendered);
      usedSkills.push(usedSkillSource);
    } else if (!rawSkillId.includes('agent-specific')) {
      throw new Error(`Required prompt skill missing: ${skillId}`);
    }
  }

  // Prepend used skills as requested
  const finalContent = `<!-- Rendered using skills: ${usedSkills.join(', ')} -->\n\n${sections.join('\n\n')}`;

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
