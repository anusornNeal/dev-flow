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

createExecutionSessionRecord({
  id: 'exec-chat-title-other',
  projectId: project.id,
  taskId: task.id,
  workspaceId: 'ws-chat-title-other',
  branch: '0761-other',
  baseRevision: null,
  repoRevision: 'ghi789',
  status: 'active',
  contextHandle: null,
  createdAt: '2026-08-28T00:30:00.000Z',
  updatedAt: '2026-08-28T00:30:00.000Z',
  expiresAt: null,
  endedAt: null,
});

createExecutionSessionRecord({
  id: 'exec-chat-title-newer',
  projectId: project.id,
  taskId: task.id,
  workspaceId: 'ws-chat-title-newer',
  branch: '0761',
  baseRevision: null,
  repoRevision: 'def456',
  status: 'active',
  contextHandle: null,
  createdAt: '2026-08-28T01:00:00.000Z',
  updatedAt: '2026-08-28T01:00:00.000Z',
  expiresAt: null,
  endedAt: null,
});

createExecutionSessionRecord({
  id: 'exec-chat-title-rebind',
  projectId: project.id,
  taskId: task.id,
  workspaceId: 'ws-chat-title-rebind',
  branch: '0761-rebind',
  baseRevision: null,
  repoRevision: 'jkl012',
  status: 'active',
  contextHandle: null,
  createdAt: '2026-08-28T01:30:00.000Z',
  updatedAt: '2026-08-28T01:30:00.000Z',
  expiresAt: null,
  endedAt: null,
});

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

test('deterministic title association is idempotent, isolates conversations, and guards rebinds', async () => {
  const associate = async (executionSessionId: string, conversationId: string, previousExecutionSessionId?: string) => fetch(`${baseUrl}/api/chat-sessions/title-associations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      executionSessionId,
      conversationId,
      previousExecutionSessionId,
      source: 'chatgpt-structured-tool-metadata',
    }),
  });

  const first = await associate('exec-chat-title-other', 'conv_auto_a');
  assert.equal(first.status, 200);
  assert.equal((await first.json() as any).bound, true);

  const replay = await associate('exec-chat-title-other', 'conv_auto_a');
  assert.equal(replay.status, 200);

  const steal = await associate('exec-chat-title-other', 'conv_auto_b');
  assert.equal(steal.status, 409);

  const second = await associate('exec-chat-title-newer', 'conv_auto_b');
  assert.equal(second.status, 200);
  const resolvedB = await fetch(`${baseUrl}/api/chat-sessions/title?conversationId=conv_auto_b`).then(response => response.json()) as any;
  assert.equal(resolvedB.executionSessionId, 'exec-chat-title-newer');

  const guardedRebind = await associate('exec-chat-title-rebind', 'conv_auto_a', 'exec-chat-title-other');
  assert.equal(guardedRebind.status, 200);
  const resolvedA = await fetch(`${baseUrl}/api/chat-sessions/title?conversationId=conv_auto_a`).then(response => response.json()) as any;
  assert.equal(resolvedA.executionSessionId, 'exec-chat-title-rebind');
  const stillResolvedB = await fetch(`${baseUrl}/api/chat-sessions/title?conversationId=conv_auto_b`).then(response => response.json()) as any;
  assert.equal(stillResolvedB.resolved, true);
  assert.equal(stillResolvedB.executionSessionId, 'exec-chat-title-newer');
});

test('pairing candidates expose only bounded presentation metadata for explicit recovery', async () => {
  const response = await fetch(`${baseUrl}/api/chat-sessions/title-candidates`);
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.ok(Array.isArray(payload.candidates));
  const candidate = payload.candidates.find((entry: any) => entry.executionSessionId === 'exec-chat-title-rebind');
  assert.ok(candidate);
  assert.equal(candidate.taskId, 'DVF-0747');
  assert.equal(candidate.taskTitle, 'Sync ChatGPT conversation title');
  assert.equal(candidate.project, 'DevFlow');
  assert.equal('ownerLabel' in candidate, false);
  assert.equal('message' in candidate, false);
});

test('automatic association rejects unsupported evidence sources', async () => {
  const response = await fetch(`${baseUrl}/api/chat-sessions/title-associations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      executionSessionId: 'exec-chat-title',
      conversationId: 'conv_bad_source',
      source: 'latest-active-session',
    }),
  });
  assert.equal(response.status, 400);
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
