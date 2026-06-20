import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { interpolate, isAllowedPromptSkillId, isPromptValuePresent, listPromptSectionsForWorkspace, readPromptSectionForWorkspace, renderPromptTemplate, resolvePromptSectionId, writePromptOverrideForWorkspace, deletePromptOverrideForWorkspace, type PromptRenderContext } from '../src/server/services/promptTemplateService';
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
    images: [{ id: 'img-1', url: '/api/static/images/example.png' }],
    imagesApi: '**Attached Images API:** GET /api/tasks/DVF-0080/images',
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
assert.ok(renderResult.content.includes('Fetch checklist details from DevFlow before reporting completion.'));
assert.ok(renderResult.content.includes('Load full task details from the local DevFlow HTTP API when needed.'));
assert.ok(renderResult.content.includes('GET /api/tasks/DVF-0080/agent-context?mode=agent-context'));
assert.ok(renderResult.content.includes('**Attached Images API:** GET /api/tasks/DVF-0080/images'));
assert.ok(renderResult.content.includes('https://github.com/anusornNeal/dev-flow'));
assert.ok(renderResult.content.includes(fixtureLocalPath));
assert.ok(renderResult.content.includes('# DevFlow Agent Task'));
assert.ok(renderResult.usedSkills.includes('prompt.project-rules'));
assert.ok(renderResult.content.includes('## DevFlow Usage'));
assert.ok(renderResult.content.includes('Prefer local repo access for code, git, and tests.'));
assert.ok(renderResult.content.includes('## Execution Rules'));
assert.ok(renderResult.content.includes('Fetch DevFlow context only when needed, but do not guess task requirements.'));
assert.ok(renderResult.content.includes('## Completion'));
assert.ok(renderResult.content.includes('Report changed behavior/files, verification run, and remaining risk. Then stop.'));
assert.ok(renderResult.content.includes('Work only on this current task and stop when it is complete.'));
assert.ok(!renderResult.content.includes('DVF-0081: Use production task context'));
assert.ok(!renderResult.content.includes('Prefer clean architecture and modular design.'));
assert.ok(!renderResult.content.includes('Avoid god classes, god files, and monolithic implementation.'));
assert.ok(!renderResult.content.includes('## Checklist'));
assert.ok(!renderResult.content.includes('## Subtasks'));
assert.ok(!renderResult.content.includes('## End'));
assert.ok(!renderResult.content.includes('Current card only'));

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
  assert.ok(stableRootRender.content.includes('Load full task details from the local DevFlow HTTP API when needed.'));
  assert.ok(stableRootRender.usedSkills.includes('prompt.header'));
} finally {
  process.chdir(originalCwd);
}

console.log('[verify] Testing non-override workspaces fall back to the current master template...');
const noOverrideRender = renderPromptTemplate('default', {
  ...mockContext,
  workspace: {
    ...mockContext.workspace,
    localPath: path.join(outsideCwd, 'some-other-project'),
  },
});
assert.ok(noOverrideRender.content.includes('# DevFlow Agent Task'));
assert.ok(noOverrideRender.content.includes('Load full task details from the local DevFlow HTTP API when needed.'));
assert.ok(noOverrideRender.content.includes('## Completion'));
assert.ok(!noOverrideRender.content.includes('This prompt is the sole source of truth for your DevFlow task context.'));

console.log('[verify] Testing project-local overrides change rendered prompts...');
const legacyOverrideWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-legacy-override-'));
try {
  const legacyOverrideDir = path.join(legacyOverrideWorkspace, '.devflow', 'prompt-overrides');
  fs.mkdirSync(legacyOverrideDir, { recursive: true });
  fs.writeFileSync(path.join(legacyOverrideDir, 'prompt.header.md'), '# Legacy Override Header', 'utf8');
  const legacyOverrideRender = renderPromptTemplate('default', {
    ...mockContext,
    workspace: {
      ...mockContext.workspace,
      localPath: legacyOverrideWorkspace,
    },
  });
  assert.ok(legacyOverrideRender.content.includes('# Legacy Override Header'));
  assert.ok(!legacyOverrideRender.content.includes('# DevFlow Agent Task'));
} finally {
  fs.rmSync(legacyOverrideWorkspace, { recursive: true, force: true });
}

const missingAgentContext = { ...mockContext, agent: 'non-existent' };
const missingRender = renderPromptTemplate('default', missingAgentContext);
assert.ok(!missingRender.usedSkills.includes('prompt.agent-specific.non-existent'));

assert.ok(!renderResult.content.includes('Work only from this prompt'));
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
assert.ok(sparseRender.content.includes('- Task: `` - Sparse Prompt Task'));
assert.ok(!sparseRender.content.includes('Attached Images API'));
assert.ok(!sparseRender.content.includes('Attached Images API'));

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
    images: [],
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
assert.ok(!taskPrompt.includes('Attached Images API'));

const imageState = {
  tasksCache: [{
    id: 'task-image',
    displayId: 'DVF-0122',
    projectId: 'project-1',
    title: 'Image Prompt Task',
    status: 'todo',
    priority: '',
    description: 'Include the image endpoint only when images exist.',
    reasoning: '',
    acceptanceCriteria: '',
    verification: '',
    checklist: [],
    targetFiles: [],
    repoContext: '',
    branch: '',
    agent: '',
    model: '',
    effort: '',
    images: [{ id: 'img-2', url: '/api/static/images/example-2.png' }],
    logs: [],
  }],
  projectsCache: [{
    id: 'project-1',
    repoUrl: 'https://github.com/anusornNeal/dev-flow',
    localPath: fixtureLocalPath,
  }],
} as any;
const imageTaskPrompt = renderTaskPrompt(imageState, 'task-image').renderResult.content;
assert.ok(imageTaskPrompt.includes('**Attached Images API:** GET /api/tasks/DVF-0122/images'));

console.log('[verify] Prompt template coverage passed!');

console.log('[verify] Testing prompt override helpers (skill id validation, compactness, write/read/delete)...');
assert.equal(resolvePromptSectionId('prompt.agent-specific.{agent}', 'Codex'), 'prompt.agent-specific.codex');
assert.equal(resolvePromptSectionId('prompt.header', 'Codex'), 'prompt.header');

// Allowed ids (in the default pipeline)
assert.equal(isAllowedPromptSkillId('prompt.header', 'codex'), true);
assert.equal(isAllowedPromptSkillId('prompt.task-context', 'codex'), true);
assert.equal(isAllowedPromptSkillId('prompt.repo-context', 'codex'), true);
assert.equal(isAllowedPromptSkillId('prompt.project-rules', 'codex'), true);
assert.equal(isAllowedPromptSkillId('prompt.checklist', 'codex'), false);
assert.equal(isAllowedPromptSkillId('prompt.subtasks', 'codex'), false);
assert.equal(isAllowedPromptSkillId('prompt.execution-rules', 'codex'), true);
assert.equal(isAllowedPromptSkillId('prompt.completion-contract', 'codex'), true);
assert.equal(isAllowedPromptSkillId('prompt.footer', 'codex'), false);
assert.equal(isAllowedPromptSkillId('prompt.agent-specific.codex', 'codex'), true);

// Disallowed ids
assert.equal(isAllowedPromptSkillId('../etc/passwd', 'codex'), false);
assert.equal(isAllowedPromptSkillId('..', 'codex'), false);
assert.equal(isAllowedPromptSkillId('a/../b', 'codex'), false);
assert.equal(isAllowedPromptSkillId('a/b', 'codex'), false);
assert.equal(isAllowedPromptSkillId('/etc/passwd', 'codex'), false);
assert.equal(isAllowedPromptSkillId('prompt.unknown.thing', 'codex'), false);
assert.equal(isAllowedPromptSkillId('', 'codex'), false);
assert.equal(isAllowedPromptSkillId(undefined as any, 'codex'), false);
assert.equal(isAllowedPromptSkillId(null as any, 'codex'), false);
assert.equal(isAllowedPromptSkillId('a'.repeat(129), 'codex'), false);

// Compact list omits large content fields
const sections = listPromptSectionsForWorkspace({ agent: 'codex' });
assert.ok(sections.length >= 7, 'pipeline should have at least 7 sections');
for (const section of sections) {
  assert.equal((section as any).masterContent, undefined, `section ${section.id} should not include masterContent`);
  assert.equal((section as any).overrideContent, undefined, `section ${section.id} should not include overrideContent`);
  assert.equal((section as any).effectiveContent, undefined, `section ${section.id} should not include effectiveContent`);
  assert.ok(typeof section.id === 'string');
  assert.equal(section.sourceType, 'master');
}

const defaultAgentSections = listPromptSectionsForWorkspace({ agent: 'default' });
assert.ok(!defaultAgentSections.some((section) => section.id === 'prompt.agent-specific.default'));

// Legacy override files can still be created/removed, but no longer affect effective prompt content.
const overrideWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-override-'));
try {
  writePromptOverrideForWorkspace(overrideWorkspace, 'prompt.header', '# override\nbody', { agent: 'codex' });
  const after = readPromptSectionForWorkspace('prompt.header', { agent: 'codex', localPath: overrideWorkspace });
  assert.ok(after, 'section must be returned');
  assert.equal(after!.sourceType, 'override');
  assert.equal(after!.overrideContent, '# override\nbody');
  assert.equal(after!.effectiveContent, '# override\nbody');

  const removed = deletePromptOverrideForWorkspace(overrideWorkspace, 'prompt.header', { agent: 'codex' });
  assert.equal(removed.success, true);
  assert.equal(removed.removed, true);

  const afterDelete = readPromptSectionForWorkspace('prompt.header', { agent: 'codex', localPath: overrideWorkspace });
  assert.equal(afterDelete!.sourceType, 'master');
  assert.equal(afterDelete!.overrideContent, undefined);

  // Service-layer validation rejects bad ids before touching the filesystem
  assert.throws(() => writePromptOverrideForWorkspace(overrideWorkspace, '../etc/passwd', 'x', { agent: 'codex' }));
  assert.throws(() => writePromptOverrideForWorkspace(overrideWorkspace, 'prompt.unknown.thing', 'x', { agent: 'codex' }));
  assert.throws(() => readPromptSectionForWorkspace('../etc/passwd', { agent: 'codex', localPath: overrideWorkspace }));
  assert.throws(() => deletePromptOverrideForWorkspace(overrideWorkspace, 'prompt.unknown.thing', { agent: 'codex' }));
} finally {
  fs.rmSync(overrideWorkspace, { recursive: true, force: true });
}

console.log('[verify] Prompt override helper coverage passed!');
