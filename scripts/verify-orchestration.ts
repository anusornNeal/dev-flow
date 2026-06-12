import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppState, ApiRouteDeps } from '../src/server/types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-orchestration-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { triggerTaskAgent } = await import('../src/server/routes/tasks.js');

const {
  createAgentRun,
  getActiveRunForTask,
  listAgentRunsForTask,
  updateAgentRunStatus,
} = await import('../src/server/repositories/agentRunRepository.js');

const { saveProjects } = await import('../src/server/repositories/projectRepository.js');

const state: AppState = {
  tasksCache: [
    { id: 'task-1', displayId: 'DVF-001', projectId: 'project-1', status: 'todo', agent: 'Codex', model: 'GPT-5.5', effort: 'high', title: 't1', description: 'd1', logs: [] },
    { id: 'task-2', displayId: 'DVF-002', projectId: 'project-1', status: 'todo', agent: 'Antigravity', model: 'Gemini 3.1 Pro', effort: 'high', title: 't2', description: 'd2', logs: [] }
  ],
  projectsCache: [
    { id: 'project-1', name: 'p1', repoUrl: 'repo', localPath: tempDir }
  ],
  countersCache: {},
  settingsCache: { autoWork: false, ngrokUrl: '', githubToken: '', jiraToken: '', jiraBaseUrl: '', jiraEmail: '' },
  skillsRegistry: []
};

// Seed project first
saveProjects(state);

let loggedMessages: string[] = [];
const deps: ApiRouteDeps = {
  state,
  writeAgentLog: (level, msg) => { loggedMessages.push(`[${level}] ${msg}`); }
};

console.log('[verify] Testing missing project.localPath blocks setup...');
state.projectsCache[0].localPath = '';
const resultNoPath = triggerTaskAgent(state.tasksCache[0], deps, 'test');
assert.equal(resultNoPath?.triggered, false);
assert.equal(resultNoPath?.reason, 'Project localPath is missing. Task cannot be run.');
assert.equal(state.tasksCache[0].status, 'todo');

console.log('[verify] Testing todo trigger sets task to in-progress before prompt generation...');
state.projectsCache[0].localPath = tempDir;
const resultTrigger = triggerTaskAgent(state.tasksCache[0], deps, 'test');
console.log('Result Trigger:', resultTrigger);
assert.equal(state.tasksCache[0].status, 'in-progress');

console.log('[verify] Testing two sequential cards create separate run ids and use own model/effort...');
const run1 = getActiveRunForTask('task-1');
assert.ok(run1);
assert.equal(run1.model, 'GPT-5.5');
assert.equal(run1.effort, 'high');
const files1 = fs.readdirSync(path.join(process.cwd(), '.devflow', 'runs', run1.id));
assert.ok(files1.includes('prompt.md'));

// Mark task-1 done manually to allow next trigger
state.tasksCache[0].status = 'ready-for-review';
updateAgentRunStatus(run1.id, 'succeeded');

const resultTrigger2 = triggerTaskAgent(state.tasksCache[1], deps, 'test');
assert.equal(state.tasksCache[1].status, 'in-progress');

const run2 = getActiveRunForTask('task-2');
assert.ok(run2);
assert.notEqual(run1.id, run2.id); // distinct runs
assert.equal(run2.model, 'Gemini 3.1 Pro'); // distinct models
assert.equal(run2.effort, 'high'); // distinct effort

console.log('[verify] Duplicate next-card starts are prevented...');
const resultDup = triggerTaskAgent(state.tasksCache[1], deps, 'test');
assert.equal(resultDup?.triggered, false);
assert.ok(resultDup?.reason.includes('Task already has active run'));

console.log('[verify-orchestration] all assertions passed');
