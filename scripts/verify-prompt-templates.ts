import assert from 'node:assert/strict';
import { interpolate, renderPromptTemplate, type PromptRenderContext } from '../src/server/services/promptTemplateService';

console.log('[verify] Testing prompt template interpolation with production-shaped context...');

const mockContext: PromptRenderContext = {
  run: { id: 'run-123' },
  task: {
    id: 'task-1',
    displayId: 'DVF-0080',
    title: 'Fix prompt rendering',
    status: 'todo',
    priority: 'high',
    branch: 'fix/dvf-0080-prompt-template-fresh-session',
  },
  assignment: {
    agent: 'Codex',
    model: 'GPT-5.5',
    effort: 'xhigh',
  },
  workspace: {
    repo: 'https://github.com/anusornNeal/dev-flow',
    localPath: 'C:\\Users\\tatar\\Projects\\dev-flow',
  },
  instruction: {
    description: 'Render prompts from the real agent task context.',
    reasoning: 'Review blockers showed the prompt was wired to an outdated task shape.',
  },
  requirements: {
    acceptanceCriteria: 'Prompt contains the real task fields.',
    verification: 'Run prompt template and orchestration checks.',
    checklist: [{ text: 'Wire renderer to real context', completed: false }],
    targetFiles: ['src/server/routes/tasks.ts', 'src/server/services/promptTemplateService.ts'],
  },
  repoContext: 'Keep prompt changes scoped to the fresh-session flow.',
  orchestration: {
    role: 'parent',
    hasSubtasks: true,
    subtasks: [{
      id: 'task-2',
      displayId: 'DVF-0081',
      title: 'Use production task context',
      status: 'backlog',
      branch: 'fix/dvf-0081',
      spawnAgent: 'Codex',
      spawnModel: 'GPT-5.5',
      spawnEffort: 'high',
    }],
  },
  agent: 'Codex',
  model: 'GPT-5.5',
  effort: 'xhigh',
};

const oldShapeResult = interpolate('{{task.description}} / {{project.localPath}} / {{task.checklist}}', mockContext as any);
assert.equal(oldShapeResult, '(none) / (none) / (none)');

const checklistResult = interpolate('{{requirements.checklist}}', mockContext);
assert.ok(checklistResult.includes('- [ ] Wire renderer to real context'));

const subtasksResult = interpolate('{{orchestration.subtasks}}', mockContext);
assert.ok(subtasksResult.includes('DVF-0081: Use production task context'));
assert.ok(subtasksResult.includes('agent=Codex'));
assert.ok(subtasksResult.includes('model=GPT-5.5'));

const simpleResult = interpolate('Task {{task.displayId}} uses {{assignment.agent}}', mockContext);
assert.equal(simpleResult, 'Task DVF-0080 uses Codex');

console.log('[verify] Testing rendered prompt sections...');
const renderResult = renderPromptTemplate('default', mockContext);
assert.ok(renderResult.usedSkills.includes('prompt.header'));
assert.ok(renderResult.usedSkills.includes('prompt.task-context'));
assert.ok(renderResult.content.includes('Render prompts from the real agent task context.'));
assert.ok(renderResult.content.includes('Prompt contains the real task fields.'));
assert.ok(renderResult.content.includes('Run prompt template and orchestration checks.'));
assert.ok(renderResult.content.includes('https://github.com/anusornNeal/dev-flow'));
assert.ok(renderResult.content.includes('C:\\Users\\tatar\\Projects\\dev-flow'));
assert.ok(renderResult.content.includes('Agent: Codex, Model: GPT-5.5, Effort: xhigh'));
assert.ok(renderResult.content.includes('DVF-0081: Use production task context'));

const missingAgentContext = { ...mockContext, agent: 'non-existent' };
const missingRender = renderPromptTemplate('default', missingAgentContext);
assert.ok(!missingRender.usedSkills.includes('prompt.agent-specific.non-existent'));

assert.ok(renderResult.content.includes('Work only from this prompt'));
assert.ok(!renderResult.content.includes("repeat this loop until no 'todo' tasks remain"));

console.log('[verify] Prompt template coverage passed!');
