import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-execution-contract-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 1;\n', 'utf8');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const sessions = await import('../../src/server/services/executionSessionService.js');
const { getToolDefinitionByName, getMcpToolList } = await import('../../src/server/contracts/devflowContract.js');

const project = {
  id: 'project-execution-contract',
  name: 'Execution Contract Fixture',
  repoUrl: 'https://example.com/execution-contract',
  localPath: repoRoot,
};
createProject(project as any);
const now = new Date().toISOString();
saveTask({
  id: 'task-execution-contract',
  displayId: 'DVF-EXEC',
  title: 'Execution contract fixture',
  description: 'fixture',
  projectId: project.id,
  status: 'in-progress',
  priority: 'medium',
  branch: 'develop',
  category: 'backend',
  tags: [],
  targetFiles: ['src/A.ts'],
  checklist: [
    { id: 'impl', text: 'Implement handoff service', completed: true },
    { id: 'review', text: 'Review resumed work', completed: false },
  ],
  createdAt: now,
  updatedAt: now,
  logs: [],
});

const session = sessions.createExecutionSession({
  projectId: project.id,
  taskId: 'task-execution-contract',
  branch: 'develop',
  repoRoot,
});
sessions.recordExecutionSessionEvidence(session.id, [
  { kind: 'file', path: 'src/A.ts', metadata: { symbols: ['A'] } },
], { repoRoot });
sessions.updateExecutionSessionProgress(session.id, {
  changedFiles: ['src/A.ts'],
  verification: [{ name: 'focused', status: 'passed' }],
});

const state: any = { projectsCache: [project], countersCache: {}, skillsRegistry: [] };
const app = express();
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
const baseUrl = `http://127.0.0.1:${address.port}`;

async function json(response: Response) {
  return response.json() as Promise<any>;
}

test('contract exposes one lightweight read-only execution continuation intent', () => {
  const continuation = getToolDefinitionByName('get_execution_continuation');

  assert.ok(continuation);
  assert.equal(continuation.lightweight, true);
  assert.deepEqual(continuation.inputSchema.required, ['executionSessionId']);

  const request = continuation.buildHttpRequest({
    executionSessionId: 'exec-1',
    workspaceId: 'ws-1',
    boardLoopRequested: true,
  });
  assert.equal(request.method, 'GET');
  assert.match(request.path, /^\/api\/execution-sessions\/exec-1\/continuation\?/);
  assert.match(request.path, /workspaceId=ws-1/);
  assert.match(request.path, /boardLoopRequested=true/);
  assert.equal(getMcpToolList('full').some((entry: any) => entry.name === 'get_execution_continuation'), true);
  assert.equal(getMcpToolList('review').some((entry: any) => entry.name === 'get_execution_continuation'), true);
  assert.equal(getMcpToolList('coding').some((entry: any) => entry.name === 'get_execution_continuation'), false);
});

test('REST handoff persists a compact snapshot and resume refreshes stale evidence', async () => {
  const handoffResponse = await fetch(`${baseUrl}/api/execution-sessions/${encodeURIComponent(session.id)}/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromAgent: 'ChatGPT',
      toAgent: 'Codex',
      lastCompletedStage: 'implementation',
      decisions: ['Keep handoff payload compact.'],
    }),
  });
  assert.equal(handoffResponse.status, 200);
  const snapshot = await json(handoffResponse);
  assert.equal(snapshot.executionSessionId, session.id);
  assert.equal(snapshot.toAgent, 'Codex');
  assert.deepEqual(snapshot.pendingNextWork, ['Review resumed work']);
  assert.equal(JSON.stringify(snapshot).includes(repoRoot), false);
  assert.equal(JSON.stringify(snapshot).includes('export const A = 1'), false);

  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  const resumeResponse = await fetch(`${baseUrl}/api/execution-sessions/${encodeURIComponent(session.id)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receivingAgent: 'Codex' }),
  });
  assert.equal(resumeResponse.status, 200);
  const resumed = await json(resumeResponse);
  assert.equal(resumed.executionSessionId, session.id);
  assert.equal(resumed.validity, 'stale');
  assert.deepEqual(resumed.requiresFreshRead, ['src/A.ts']);
  assert.equal(resumed.handoff?.toAgent, 'Codex');
  assert.equal(resumed.executionContinuation?.terminal, false);
  assert.equal(resumed.executionContinuation?.continuationRequired, true);
  assert.ok(resumed.executionContinuation?.reasonCodes.includes('EXECUTION_EVIDENCE_REVALIDATION_REQUIRED'));

  const continuationResponse = await fetch(`${baseUrl}/api/execution-sessions/${encodeURIComponent(session.id)}/continuation`);
  assert.equal(continuationResponse.status, 200);
  const continuation = await json(continuationResponse);
  assert.equal(continuation.executionSessionId, session.id);
  assert.equal(continuation.terminal, false);
  assert.equal(continuation.continuationRequired, true);
  assert.deepEqual(continuation.reasonCodes, resumed.executionContinuation.reasonCodes);
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
