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
const { getCapabilityCatalog, getMcpToolList, getToolDefinitionByName } = await import('../src/server/contracts/devflowContract.js');

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
  assert.ok(capabilitiesBody.tools.some((tool: any) => tool.name === 'import_tasks_from_file'));

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
  assert.ok(mcpTools.some((tool) => tool.name === 'import_tasks_from_file'));
  assert.ok(mcpTools.length > catalog.tools.length);

  const createTaskSchema = catalog.tools.find((tool) => tool.name === 'create_task')?.inputSchema;
  const updateTaskSchema = catalog.tools.find((tool) => tool.name === 'update_task')?.inputSchema;
  assert.ok(createTaskSchema?.properties?.title);
  assert.ok(createTaskSchema?.properties?.projectId);
  assert.ok(createTaskSchema?.properties?.repoUrl);
  assert.ok(updateTaskSchema?.properties?.taskId);

  console.log('[verify] Testing prompt override MCP tools...');
  const newToolNames = ['list_prompt_skills', 'get_prompt_skill', 'update_prompt_override', 'delete_prompt_override'];
  for (const toolName of newToolNames) {
    assert.ok(
      catalog.tools.some((tool) => tool.name === toolName),
      `Missing tool in catalog: ${toolName}`,
    );
    assert.ok(
      mcpTools.some((tool) => tool.name === toolName),
      `Missing tool in MCP list: ${toolName}`,
    );
  }
  const updateOverrideSchema = catalog.tools.find((tool) => tool.name === 'update_prompt_override')?.inputSchema as any;
  const getSkillSchema = catalog.tools.find((tool) => tool.name === 'get_prompt_skill')?.inputSchema as any;
  const deleteOverrideSchema = catalog.tools.find((tool) => tool.name === 'delete_prompt_override')?.inputSchema as any;
  assert.ok(Array.isArray(updateOverrideSchema?.required) && updateOverrideSchema.required.includes('sectionId') && updateOverrideSchema.required.includes('content'));
  assert.ok(Array.isArray(getSkillSchema?.required) && getSkillSchema.required.includes('sectionId'));
  assert.ok(Array.isArray(deleteOverrideSchema?.required) && deleteOverrideSchema.required.includes('sectionId'));
  assert.ok(updateOverrideSchema?.properties?.projectId);
  assert.ok(updateOverrideSchema?.properties?.localPath);

  // Verify the contract-level buildHttpRequest mapping actually produces the
  // right body shape (MCP tool path, not hand-written HTTP body).
  const updateOverrideTool = getToolDefinitionByName('update_prompt_override');
  assert.ok(updateOverrideTool, 'update_prompt_override must be resolvable by name');
  const contractReq = updateOverrideTool.buildHttpRequest({
    projectId: 'project-contract-1',
    sectionId: 'prompt.header',
    content: '# from contract',
    agent: 'codex',
    pipeline: 'default',
  });
  assert.equal(contractReq.method, 'PUT');
  assert.equal(contractReq.path, '/api/prompt-overrides/section');
  assert.ok(contractReq.body, 'PUT body must be present');
  assert.equal((contractReq.body as Record<string, unknown>)?.sectionId, 'prompt.header');
  assert.equal((contractReq.body as Record<string, unknown>)?.content, '# from contract');
  assert.equal((contractReq.body as Record<string, unknown>)?.projectId, 'project-contract-1');
  assert.equal((contractReq.body as Record<string, unknown>)?.agent, 'codex');
  assert.equal((contractReq.body as Record<string, unknown>)?.pipeline, 'default');

  // HTTP round-trip: write override, read it, delete it, read again.
  const overrideContent = '# test override\n\nfor prompt.header\n';
  const putResp = await fetch(`${baseUrl}/api/prompt-overrides/section`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', sectionId: 'prompt.header', content: overrideContent }),
  });
  assert.equal(putResp.status, 200);
  const putBody = await putResp.json();
  assert.equal(putBody.success, true);
  assert.ok(putBody.overridePath && putBody.overridePath.endsWith('prompt.header.md'));

  const getAfterPut = await fetch(`${baseUrl}/api/prompt-overrides/section?projectId=project-contract-1&sectionId=prompt.header`);
  assert.equal(getAfterPut.status, 200);
  const getAfterPutBody = await getAfterPut.json();
  assert.equal(getAfterPutBody.section.overrideContent, overrideContent);
  assert.equal(getAfterPutBody.section.effectiveContent, overrideContent);
  assert.equal(getAfterPutBody.section.sourceType, 'override');

  const sectionsResp = await fetch(`${baseUrl}/api/prompt-overrides/sections?projectId=project-contract-1`);
  assert.equal(sectionsResp.status, 200);
  const sectionsBody = await sectionsResp.json();
  assert.ok(Array.isArray(sectionsBody.sections));
  assert.ok(sectionsBody.sections.length > 0);
  const headerSection = sectionsBody.sections.find((s: any) => s.id === 'prompt.header');
  assert.ok(headerSection, 'list must include prompt.header section');
  assert.equal(headerSection.sourceType, 'override');
  assert.equal(headerSection.overrideAvailable, true);
  assert.equal(headerSection.masterAvailable, true);
  // Compactness: list response must NOT include large content fields.
  assert.equal(headerSection.masterContent, undefined);
  assert.equal(headerSection.overrideContent, undefined);
  assert.equal(headerSection.effectiveContent, undefined);

  const deleteResp = await fetch(`${baseUrl}/api/prompt-overrides/section?projectId=project-contract-1&sectionId=prompt.header`, { method: 'DELETE' });
  assert.equal(deleteResp.status, 200);
  const deleteBody = await deleteResp.json();
  assert.equal(deleteBody.success, true);
  assert.equal(deleteBody.removed, true);

  const getAfterDelete = await fetch(`${baseUrl}/api/prompt-overrides/section?projectId=project-contract-1&sectionId=prompt.header`);
  assert.equal(getAfterDelete.status, 200);
  const getAfterDeleteBody = await getAfterDelete.json();
  assert.equal(getAfterDeleteBody.section.sourceType, 'master');
  assert.equal(getAfterDeleteBody.section.overrideContent, undefined);

  // Path-traversal / invalid id rejection
  const traversalResp = await fetch(`${baseUrl}/api/prompt-overrides/section`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', sectionId: '../etc/passwd', content: 'x' }),
  });
  assert.equal(traversalResp.status, 400);
  const traversalBody = await traversalResp.json();
  assert.equal(traversalBody.error.code, 'INVALID_SECTION_ID');

  const unknownIdResp = await fetch(`${baseUrl}/api/prompt-overrides/section`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', sectionId: 'prompt.unknown.thing', content: 'x' }),
  });
  assert.equal(unknownIdResp.status, 400);
  const unknownIdBody = await unknownIdResp.json();
  assert.equal(unknownIdBody.error.code, 'INVALID_SECTION_ID');

  // Missing project / no localPath resolution
  const noProjectResp = await fetch(`${baseUrl}/api/prompt-overrides/section`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sectionId: 'prompt.header', content: 'x' }),
  });
  assert.equal(noProjectResp.status, 400);
  const noProjectBody = await noProjectResp.json();
  assert.equal(noProjectBody.error.code, 'INVALID_PROJECT');

  console.log('[verify-devflow-contract] all assertions passed');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
