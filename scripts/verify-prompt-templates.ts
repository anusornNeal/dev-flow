import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { interpolate, isPromptValuePresent, renderPromptTemplate, type PromptRenderContext } from '../src/server/services/promptTemplateService';
import { getProjectRulesContext } from '../src/server/services/projectRulesService';
import { renderTaskPrompt } from '../src/server/services/taskService';

console.log('[verify] Testing prompt template interpolation with production-shaped context...');
const fixtureLocalPath = path.join('fixtures', 'dev-flow');

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
    localPath: fixtureLocalPath,
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
  projectRules: getProjectRulesContext(),
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
assert.equal(oldShapeResult.text, ' /  / ');

assert.equal(isPromptValuePresent(null), false);
assert.equal(isPromptValuePresent(undefined), false);
assert.equal(isPromptValuePresent(''), false);
assert.equal(isPromptValuePresent('   '), false);
assert.equal(isPromptValuePresent('none'), false);
assert.equal(isPromptValuePresent('(none)'), false);
assert.equal(isPromptValuePresent('undefined'), false);
assert.equal(isPromptValuePresent([]), false);
assert.equal(isPromptValuePresent(['value']), true);
assert.equal(isPromptValuePresent('low'), true);

const checklistResult = interpolate('{{requirements.checklist}}', mockContext).text;
assert.ok(checklistResult.includes('- [ ] Wire renderer to real context'));

const subtasksResult = interpolate('{{orchestration.subtasks}}', mockContext).text;
assert.ok(subtasksResult.includes('DVF-0081: Use production task context'));
assert.ok(subtasksResult.includes('agent=Codex'));
assert.ok(subtasksResult.includes('model=GPT-5.5'));

const simpleResult = interpolate('Task {{task.displayId}} uses {{assignment.agent}}', mockContext).text;
assert.equal(simpleResult, 'Task DVF-0080 uses Codex');

console.log('[verify] Testing rendered prompt sections...');
const renderResult = renderPromptTemplate('default', mockContext);
assert.ok(renderResult.usedSkills.includes('prompt.header'));
assert.ok(renderResult.usedSkills.includes('prompt.task-context'));
assert.ok(renderResult.content.includes('Render prompts from the real agent task context.'));
assert.ok(renderResult.content.includes('Prompt contains the real task fields.'));
assert.ok(renderResult.content.includes('Run prompt template and orchestration checks.'));
assert.ok(renderResult.content.includes('https://github.com/anusornNeal/dev-flow'));
assert.ok(renderResult.content.includes(fixtureLocalPath));
assert.ok(renderResult.content.includes('Agent: Codex, Model: GPT-5.5, Effort: xhigh'));
assert.ok(renderResult.content.includes('DVF-0081: Use production task context'));
assert.ok(renderResult.usedSkills.includes('prompt.project-rules'));
assert.ok(renderResult.content.includes('## DevFlow Workflow Rules'));
assert.ok(renderResult.content.includes('Move todo cards to in-progress before implementation starts.'));
assert.ok(renderResult.content.includes('Use the card branch. If the card has no branch, default to develop.'));
assert.ok(renderResult.content.includes('Handle every checklist item or mini task.'));
assert.ok(renderResult.content.includes('Push the work to the active branch before moving the card to ready-for-review.'));
assert.ok(!renderResult.content.includes('Prefer clean architecture and modular design.'));
assert.ok(!renderResult.content.includes('Avoid god classes, god files, and monolithic implementation.'));

const agentsInstructions = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf8');
assert.ok(agentsInstructions.includes('Prefer clean architecture.'));
assert.ok(agentsInstructions.includes('Prefer modular design.'));
assert.ok(agentsInstructions.includes('Avoid god classes.'));
assert.ok(agentsInstructions.includes('Avoid god files.'));
assert.ok(agentsInstructions.includes('Avoid monolithic implementation.'));

console.log('[verify] Testing prompt skills resolve from stable app root...');
const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-prompt-root-'));
const originalCwd = process.cwd();
process.chdir(outsideCwd);
try {
  const stableRootRender = renderPromptTemplate('default', mockContext);
  assert.ok(stableRootRender.content.includes('Render prompts from the real agent task context.'));
  assert.ok(stableRootRender.usedSkills.includes('prompt.header'));
} finally {
  process.chdir(originalCwd);
}

const missingAgentContext = { ...mockContext, agent: 'non-existent' };
const missingRender = renderPromptTemplate('default', missingAgentContext);
assert.ok(!missingRender.usedSkills.includes('prompt.agent-specific.non-existent'));

assert.ok(renderResult.content.includes('Work only from this prompt'));
assert.ok(!renderResult.content.includes("repeat this loop until no 'todo' tasks remain"));

console.log('[verify] Testing sparse prompt rendering omits none-like values...');
const sparseContext: PromptRenderContext = {
  run: { id: 'run-sparse' },
  task: {
    id: 'task-sparse',
    title: 'Sparse Prompt Task',
    status: 'todo',
  },
  assignment: {
    agent: 'none',
    model: '',
    effort: undefined,
  },
  workspace: {
    repo: 'https://github.com/anusornNeal/dev-flow',
    localPath: fixtureLocalPath,
  },
  instruction: {
    description: 'Keep only real fields in sparse prompt output.',
    reasoning: '(none)',
  },
  requirements: {
    acceptanceCriteria: '',
    verification: null,
    checklist: [],
    targetFiles: [],
  },
  projectRules: getProjectRulesContext(),
  repoContext: undefined,
  orchestration: {
    role: 'standalone',
    hasSubtasks: false,
    subtasks: [],
  },
  agent: 'Codex',
  model: '',
  effort: '',
};

const sparseRender = renderPromptTemplate('default', sparseContext);
assert.ok(!sparseRender.content.includes('(none)'));
assert.ok(!sparseRender.content.includes('(none)'));
assert.ok(sparseRender.content.includes('**Task:**  - Sparse Prompt Task'));
assert.ok(sparseRender.content.includes('**Status:** todo'));
assert.ok(sparseRender.content.includes('Keep only real fields in sparse prompt output.'));

console.log('[verify] Testing real task prompt shares omission logic...');
const sparseState = {
  tasksCache: [{
    id: 'task-sparse',
    displayId: 'DVF-0121',
    projectId: 'project-1',
    title: 'Sparse Prompt Task',
    status: 'todo',
    priority: '',
    description: 'Keep only real fields in sparse prompt output.',
    reasoning: '(none)',
    acceptanceCriteria: '',
    verification: '',
    checklist: [],
    targetFiles: [],
    repoContext: '',
    branch: '',
    agent: '',
    model: '',
    effort: '',
    logs: [],
  }],
  projectsCache: [{
    id: 'project-1',
    repoUrl: 'https://github.com/anusornNeal/dev-flow',
    localPath: fixtureLocalPath,
  }],
} as any;
const taskPrompt = renderTaskPrompt(sparseState, 'task-sparse').renderResult.content;
assert.ok(!taskPrompt.includes('(none)'));
assert.ok(taskPrompt.includes('Keep only real fields in sparse prompt output.'));

console.log('[verify] Prompt template coverage passed!');
