import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppState, ApiRouteDeps } from '../src/server/types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-orchestration-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const repoPathWithSpaces = path.join(tempDir, 'repo with spaces');
fs.mkdirSync(repoPathWithSpaces, { recursive: true });

const triggerScriptPath = path.join(tempDir, 'trigger script with spaces.bat');
fs.writeFileSync(triggerScriptPath, [
  '@echo off',
  'setlocal',
  'echo trigger invoked> "%TEMP%\\devflow-trigger-args.txt"',
  'exit /b 0',
  '',
].join('\r\n'), 'utf8');
process.env.DEVFLOW_AGENT_TRIGGER_SCRIPT = triggerScriptPath;

const {
  completeAgentRunForTask,
  continueTaskQueueForProject,
  triggerTaskAgent,
} = await import('../src/server/routes/tasks.js');

const {
  getActiveRunForTask,
  getLatestAgentRunForTask,
} = await import('../src/server/repositories/agentRunRepository.js');

const { saveProjects } = await import('../src/server/repositories/projectRepository.js');

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const state: AppState = {
  tasksCache: [
    {
      id: 'task-1',
      displayId: 'DVF-0080',
      projectId: 'project-1',
      status: 'todo',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'xhigh',
      title: 'Fix fresh-session prompt flow',
      description: 'Generate the prompt from the real production agent context.',
      acceptanceCriteria: 'Prompt includes description, acceptance criteria, verification, checklist, subtasks, repo, localPath, agent, model, and effort.',
      verification: 'Run prompt template and orchestration verification scripts.',
      checklist: [{ id: 'chk-1', text: 'Use real agent task context', completed: false }],
      reasoning: 'Review blockers found the old flat task shape still in use.',
      targetFiles: ['src/server/routes/tasks.ts'],
      repoContext: 'Keep changes scoped to the fresh-session orchestration flow.',
      logs: [],
      createdAt: '2026-06-13T00:00:00.000Z',
      updatedAt: '2026-06-13T00:00:00.000Z',
    },
    {
      id: 'task-1-sub',
      displayId: 'DVF-0081',
      projectId: 'project-1',
      parentId: 'task-1',
      status: 'backlog',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Pass production context shape to prompt rendering',
      description: 'Use instruction, requirements, workspace, and orchestration fields.',
      checklist: [{ id: 'chk-sub', text: 'Update templates', completed: false }],
      logs: [],
      createdAt: '2026-06-13T00:01:00.000Z',
      updatedAt: '2026-06-13T00:01:00.000Z',
    },
    {
      id: 'task-2',
      displayId: 'DVF-0082',
      projectId: 'project-1',
      status: 'todo',
      agent: 'Bad@Agent',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Invalid card for skip logging',
      description: 'This should be skipped visibly.',
      logs: [],
      createdAt: '2026-06-13T00:02:00.000Z',
      updatedAt: '2026-06-13T00:02:00.000Z',
    },
    {
      id: 'task-3',
      displayId: 'DVF-0083',
      projectId: 'project-1',
      status: 'todo',
      agent: 'Codex',
      model: 'GPT-5.5',
      effort: 'high',
      title: 'Next valid card',
      description: 'This should start after skips are recorded.',
      logs: [],
      createdAt: '2026-06-13T00:03:00.000Z',
      updatedAt: '2026-06-13T00:03:00.000Z',
    },
  ],
  projectsCache: [
    { id: 'project-1', name: 'p1', repoUrl: 'https://github.com/anusornNeal/dev-flow', localPath: repoPathWithSpaces },
  ],
  countersCache: {},
  settingsCache: { autoWork: false, ngrokUrl: '', githubToken: '', jiraToken: '', jiraBaseUrl: '', jiraEmail: '' },
  skillsRegistry: [],
};

saveProjects(state);

const loggedMessages: string[] = [];
const deps: ApiRouteDeps = {
  state,
  writeAgentLog: (level, msg) => { loggedMessages.push(`[${level}] ${msg}`); },
};

console.log('[verify] Testing missing project.localPath blocks setup...');
state.projectsCache[0].localPath = '';
const noPathResult = triggerTaskAgent(state.tasksCache[0], deps, 'test');
assert.equal(noPathResult.triggered, false);
assert.equal(noPathResult.reason, 'Project localPath is missing. Task cannot be run.');
assert.equal(state.tasksCache[0].status, 'todo');

console.log('[verify] Testing real prompt rendering and startup handoff...');
state.projectsCache[0].localPath = repoPathWithSpaces;
const triggerResult = triggerTaskAgent(state.tasksCache[0], deps, 'test');
assert.equal(triggerResult.triggered, true);
assert.equal(state.tasksCache[0].status, 'in-progress');

await new Promise((resolve) => setTimeout(resolve, 250));
await waitFor(() => getLatestAgentRunForTask('task-1')?.status === 'running');

const run1 = getLatestAgentRunForTask('task-1');
assert.ok(run1);
assert.equal(run1?.status, 'running');
const promptPath = path.join(process.cwd(), '.devflow', 'runs', run1!.id, 'prompt.md');
const prompt = fs.readFileSync(promptPath, 'utf8');
assert.ok(prompt.includes('Generate the prompt from the real production agent context.'));
assert.ok(prompt.includes('Prompt includes description, acceptance criteria, verification, checklist, subtasks, repo, localPath, agent, model, and effort.'));
assert.ok(prompt.includes('Run prompt template and orchestration verification scripts.'));
assert.ok(prompt.includes('- [ ] Use real agent task context'));
assert.ok(prompt.includes('DVF-0081: Pass production context shape to prompt rendering'));
assert.ok(prompt.includes(repoPathWithSpaces));
assert.ok(prompt.includes('Agent: Codex, Model: GPT-5.5, Effort: xhigh'));

console.log('[verify] Testing failed completion leaves the card retryable...');
completeAgentRunForTask(state.tasksCache[0], run1!, deps, {
  success: false,
  errorMessage: 'agent exited 1',
});
assert.equal(state.tasksCache[0].status, 'todo');
assert.equal(getActiveRunForTask('task-1'), null);
assert.equal(getLatestAgentRunForTask('task-1')?.status, 'failed');
assert.match(state.tasksCache[0].logs.at(-1)?.message || '', /agent exited 1/);

console.log('[verify] Testing queue continuation records visible skip reasons...');
const queueResult = continueTaskQueueForProject('project-1', deps);
assert.equal(queueResult.triggered, true);

await new Promise((resolve) => setTimeout(resolve, 250));
await waitFor(() => getLatestAgentRunForTask('task-3')?.status === 'running');

assert.equal(state.tasksCache[1].status, 'backlog');
assert.equal(state.tasksCache[2].status, 'todo');
assert.equal(state.tasksCache[3].status, 'in-progress');
assert.match(state.tasksCache[0].logs.at(-1)?.message || '', /Manual retry is required/);
assert.match(state.tasksCache[2].logs.at(-1)?.message || '', /Invalid agent or task id characters/);
assert.equal(getLatestAgentRunForTask('task-3')?.status, 'running');

console.log('[verify-orchestration] all assertions passed');
