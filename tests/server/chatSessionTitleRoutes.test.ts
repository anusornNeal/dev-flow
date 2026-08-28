import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-chat-title-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { createExecutionSessionRecord } = await import('../../src/server/repositories/executionSessionRepository.js');

const project = {
  id: 'project-chat-title',
  name: 'DevFlow',
  repoUrl: 'https://example.test/devflow.git',
  localPath: tempDir,
  taskIdPrefix: 'DVF',
  createdAt: '2026-08-28T00:00:00.000Z',
};
createProject(project as any);

const task = {
  id: 'task-chat-title',
  displayId: 'DVF-0747',
  projectId: project.id,
  title: 'Sync ChatGPT conversation title',
  description: 'fixture',
  status: 'in-progress',
  priority: 'medium',
  category: 'frontend',
  tags: [],
  checklist: [],
  targetFiles: [],
  logs: [],
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};
saveTask(task as any);

createExecutionSessionRecord({
  id: 'exec-chat-title',
  projectId: project.id,
  taskId: task.id,
  workspaceId: 'ws-chat-title',
  branch: '0747',
  baseRevision: null,
  repoRevision: 'abc123',
  status: 'active',
  contextHandle: null,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  expiresAt: null,
  endedAt: null,
});

const state: any = { projectsCache: [project], countersCache: {}, skillsRegistry: [] };
const app = express();
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('chat session title route binds presentation metadata to an execution session and resolves by conversation id', async () => {
  const bindResponse = await fetch(`${baseUrl}/api/chat-sessions/title-bindings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      executionSessionId: 'exec-chat-title',
      conversationId: 'conv_chat_0747',
      chatAlias: 'Title sync chat',
      preferredTitle: 'DVF-0747 · Title sync chat',
    }),
  });
  assert.equal(bindResponse.status, 200);
  const bound = await bindResponse.json() as any;
  assert.equal(bound.bound, true);
  assert.equal(bound.executionSessionId, 'exec-chat-title');

  const resolveResponse = await fetch(`${baseUrl}/api/chat-sessions/title?conversationId=conv_chat_0747`);
  assert.equal(resolveResponse.status, 200);
  const resolved = await resolveResponse.json() as any;
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.executionSessionId, 'exec-chat-title');
  assert.equal(resolved.project, 'DevFlow');
  assert.equal(resolved.taskId, 'DVF-0747');
  assert.equal(resolved.taskTitle, 'Sync ChatGPT conversation title');
  assert.equal(resolved.chatAlias, 'Title sync chat');
  assert.equal(resolved.preferredTitle, 'DVF-0747 · Title sync chat');
  assert.equal('ownerLabel' in resolved, false);
});

test('unresolved or invalid chat title lookups fail closed without selecting an arbitrary session', async () => {
  const unresolvedResponse = await fetch(`${baseUrl}/api/chat-sessions/title?conversationId=unknown_conv`);
  assert.equal(unresolvedResponse.status, 200);
  assert.deepEqual(await unresolvedResponse.json(), { resolved: false, reason: 'unresolved-session' });

  const invalidBind = await fetch(`${baseUrl}/api/chat-sessions/title-bindings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ executionSessionId: 'missing-exec', conversationId: 'conv_missing' }),
  });
  assert.equal(invalidBind.status, 404);
});
