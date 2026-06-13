import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-contract-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const scratchDir = path.join(tempDir, 'scratch');
fs.mkdirSync(scratchDir, { recursive: true });
fs.writeFileSync(path.join(scratchDir, 'note.txt'), 'needle line\nsecond line\n', 'utf8');

const express = (await import('express')).default;
const { registerApiRoutes } = await import('../src/server/routes/registerApiRoutes.js');
const { saveProjects } = await import('../src/server/repositories/projectRepository.js');
const { saveTasks } = await import('../src/server/repositories/taskRepository.js');
const { getCapabilityCatalog, getMcpToolList } = await import('../src/server/contracts/devflowContract.js');

const state = {
  tasksCache: [
    {
      id: 'task-contract-1',
      displayId: 'DVF-0120',
      title: 'Contract refactor task',
      description: 'Use one shared contract for REST and MCP.',
      projectId: 'project-contract-1',
      status: 'backlog',
      priority: 'high',
      checklist: [{ id: 'chk-1', text: 'ship contract layer', completed: false }],
      logs: [],
      createdAt: '2026-06-13T00:00:00.000Z',
      updatedAt: '2026-06-13T00:00:00.000Z',
    },
  ],
  projectsCache: [
    {
      id: 'project-contract-1',
      name: 'Dev Flow',
      repoUrl: 'https://github.com/anusornNeal/dev-flow',
      localPath: tempDir,
      taskIdPrefix: 'DVF',
      createdAt: '2026-06-13T00:00:00.000Z',
    },
  ],
  countersCache: {},
  settingsCache: {
    ngrokUrl: '',
    githubToken: '',
    jiraToken: '',
    jiraBaseUrl: '',
    jiraEmail: '',
    autoWork: false,
    agentExecutionMode: 'safe',
  },
  skillsRegistry: [],
};

saveProjects(state as any);
saveTasks(state as any);

const app = express();
registerApiRoutes(app, {
  state: state as any,
  writeAgentLog: () => {},
});

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Failed to bind verification server.');
}

const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  console.log('[verify] Testing capabilities endpoint...');
  const capabilitiesResponse = await fetch(`${baseUrl}/api/capabilities`);
  assert.equal(capabilitiesResponse.status, 200);
  const capabilitiesBody = await capabilitiesResponse.json();
  const catalog = getCapabilityCatalog();
  assert.equal(capabilitiesBody.contractVersion, catalog.contractVersion);
  assert.equal(capabilitiesBody.counts.tools, catalog.tools.length);
  assert.ok(capabilitiesBody.tools.some((tool: any) => tool.name === 'get_capabilities'));

  console.log('[verify] Testing task summary/query modes...');
  const listResponse = await fetch(`${baseUrl}/api/tasks?mode=summary&q=contract`);
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  assert.equal(listBody.total, 1);
  assert.equal(listBody.items[0].displayId, 'DVF-0120');
  assert.equal(listBody.items[0].description, undefined);

  const getTaskResponse = await fetch(`${baseUrl}/api/tasks/DVF-0120?mode=minimal`);
  assert.equal(getTaskResponse.status, 200);
  const getTaskBody = await getTaskResponse.json();
  assert.equal(getTaskBody.id, 'task-contract-1');
  assert.equal(getTaskBody.title, 'Contract refactor task');

  console.log('[verify] Testing batch move/assign/checklist endpoints...');
  const moveResponse = await fetch(`${baseUrl}/api/tasks/batch/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ moves: [{ taskId: 'DVF-0120', status: 'todo' }] }),
  });
  assert.equal(moveResponse.status, 200);
  const moveBody = await moveResponse.json();
  assert.equal(moveBody.successCount, 1);
  assert.equal(state.tasksCache[0].status, 'todo');

  const assignResponse = await fetch(`${baseUrl}/api/tasks/batch/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: [{ taskId: 'DVF-0120', agent: 'Codex', model: 'GPT-5.4', effort: 'medium' }] }),
  });
  assert.equal(assignResponse.status, 200);
  const assignBody = await assignResponse.json();
  assert.equal(assignBody.successCount, 1);
  assert.equal((state.tasksCache[0] as any).agent, 'Codex');

  const toggleResponse = await fetch(`${baseUrl}/api/tasks/batch/checklist/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toggles: [{ taskId: 'DVF-0120', checklistId: 'chk-1' }] }),
  });
  assert.equal(toggleResponse.status, 200);
  const toggleBody = await toggleResponse.json();
  assert.equal(toggleBody.successCount, 1);
  assert.equal(state.tasksCache[0].checklist[0].completed, true);

  console.log('[verify] Testing local file tools...');
  const listFilesResponse = await fetch(`${baseUrl}/api/local-files?projectId=project-contract-1&path=scratch`);
  assert.equal(listFilesResponse.status, 200);
  const listFilesBody = await listFilesResponse.json();
  assert.ok(listFilesBody.files.some((entry: any) => entry.path.endsWith('note.txt')));

  const readFileResponse = await fetch(`${baseUrl}/api/local-files/read?projectId=project-contract-1&filePath=scratch/note.txt`);
  assert.equal(readFileResponse.status, 200);
  const readFileBody = await readFileResponse.json();
  assert.match(readFileBody.content, /needle line/);

  const searchFilesResponse = await fetch(`${baseUrl}/api/local-files/search?projectId=project-contract-1&query=needle&path=scratch`);
  assert.equal(searchFilesResponse.status, 200);
  const searchFilesBody = await searchFilesResponse.json();
  assert.equal(searchFilesBody.count, 1);
  assert.equal(searchFilesBody.matches[0].line, 1);

  console.log('[verify] Testing structured error normalization...');
  const missingProjectFileResponse = await fetch(`${baseUrl}/api/local-files?projectName=missing-project&path=scratch`);
  assert.equal(missingProjectFileResponse.status, 404);
  const missingProjectFileBody = await missingProjectFileResponse.json();
  assert.equal(missingProjectFileBody.error.code, 'PROJECT_NOT_FOUND');
  assert.equal(typeof missingProjectFileBody.error.message, 'string');
  assert.equal(typeof missingProjectFileBody.error.retryable, 'boolean');
  assert.equal(typeof missingProjectFileBody.error.correlationId, 'string');

  console.log('[verify] Testing MCP tool catalog parity and aliases...');
  const mcpTools = getMcpToolList();
  assert.ok(mcpTools.some((tool) => tool.name === 'get_agent_context'));
  assert.ok(mcpTools.some((tool) => tool.name === 'get_agent_task_context'));
  assert.ok(mcpTools.length > catalog.tools.length);

  const createTaskSchema = catalog.tools.find((tool) => tool.name === 'create_task')?.inputSchema;
  const updateTaskSchema = catalog.tools.find((tool) => tool.name === 'update_task')?.inputSchema;
  assert.ok(createTaskSchema?.properties?.title);
  assert.ok(createTaskSchema?.properties?.projectId);
  assert.ok(createTaskSchema?.properties?.repoUrl);
  assert.ok(updateTaskSchema?.properties?.taskId);

  console.log('[verify-devflow-contract] all assertions passed');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
