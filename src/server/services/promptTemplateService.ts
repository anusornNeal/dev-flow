import fs from 'fs';
import path from 'path';

export interface PromptRenderContext {
  run: { id: string };
  task: any;
  project: any;
  agent: string;
  model: string;
  effort: string;
}

export function getPromptPipeline(pipelineId: string = 'default'): string[] {
  const configPath = path.join(process.cwd(), 'config', 'prompt-pipeline.json');
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
        if (item.title) {
           return `- ${item.title} (${item.status || 'todo'})`;
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
    const path = key.trim().split('.');
    let current: any = context;
    for (const p of path) {
      if (current === undefined || current === null) {
        return '(none)';
      }
      current = current[p];
    }
    const isChecklistOrSubtasks = key.trim() === 'task.checklist' || key.trim() === 'task.subtasks';
    return renderValue(current, isChecklistOrSubtasks);
  });
}

export function renderPromptTemplate(pipelineId: string, context: PromptRenderContext) {
  const pipeline = getPromptPipeline(pipelineId);
  const usedSkills: string[] = [];
  const sections: string[] = [];

  for (const rawSkillId of pipeline) {
    const skillId = rawSkillId.replace('{agent}', (context.agent || 'default').toLowerCase());
    const skillPath = path.join(process.cwd(), 'skills', `${skillId}.md`);
    if (fs.existsSync(skillPath)) {
      const content = fs.readFileSync(skillPath, 'utf8');
      sections.push(interpolate(content, context));
      usedSkills.push(skillId);
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
