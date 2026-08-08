import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-manual-move-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTask } = await import('../../src/server/repositories/taskRepository.js');
const { createAgentRun } = await import('../../src/server/repositories/agentRunRepository.js');

const project = { id: 'project-manual-move', name: 'Manual Move', repoUrl: 'https://example.com/manual', localPath: tempDir };
createProject(project as any);
const state: any = { projectsCache: [project], countersCache: {}, skillsRegistry: [] };

function task(id: string) {
  return {
    id,
    displayId: id.toUpperCase(),
    title: id,
    description: 'Manual status move fixture',
    projectId: project.id,
    status: 'in-progress',
    priority: 'medium',
    branch: null,
    tags: [],
    targetFiles: [],
    checklist: [{ id: 'c1', text: 'unfinished', completed: false }],
    verificationEvidence: [],
    logs: [],
    bugs: [],
    images: [],
    designImages: [],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  } as any;
}

for (const id of ['manual-soft', 'manual-hard', 'strict-default', 'manual-path']) saveTask(task(id));
createAgentRun({ taskId: 'manual-hard', projectId: project.id, agent: 'Codex', model: 'GPT-5.5', effort: 'medium' });

const app = express();
app.use(express.json());
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server did not bind');
const base = `http://127.0.0.1:${address.port}`;

test.after(() => server.close());

async function post(id: string, body: any, route: 'move' | 'move-to' = 'move') {
  const response = await fetch(`${base}/api/tasks/${id}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('manual move returns structured confirmation without mutation', async () => {
  const result = await post('manual-soft', { status: 'ready-for-review', intent: 'manual' });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'MOVE_CONFIRMATION_REQUIRED');
  assert.equal(result.body.confirmationRequired, true);
  assert.equal(result.body.retry.manualOverride, true);
  assert.ok(result.body.blockers.some((item: any) => item.code === 'CHECKLIST_INCOMPLETE'));
  assert.equal(getTask('manual-soft')?.status, 'in-progress');
});

test('manual override moves, audits bypassed blockers, and does not launch Auto Work', async () => {
  const result = await post('manual-soft', { status: 'ready-for-review', intent: 'manual', manualOverride: true });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.task.status, 'ready-for-review');
  assert.equal(result.body.autoWorkTrigger, null);
  assert.ok(result.body.bypassedBlockers.some((item: any) => item.code === 'CHECKLIST_INCOMPLETE'));
  assert.ok((getTask('manual-soft')?.logs || []).some((entry: any) => /Manual override move/.test(entry.message) && /CHECKLIST_INCOMPLETE/.test(entry.message)));
});

test('active agent ownership stays a hard blocker even with manualOverride', async () => {
  const result = await post('manual-hard', { status: 'ready-for-review', intent: 'manual', manualOverride: true });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, 'MOVE_HARD_BLOCKED');
  assert.equal(result.body.blockers[0].code, 'ACTIVE_AGENT_LOCK');
  assert.equal(getTask('manual-hard')?.status, 'in-progress');
});

test('strict/default API move remains blocked rather than silently overriding', async () => {
  const result = await post('strict-default', { status: 'ready-for-review' });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'MOVE_WORKFLOW_BLOCKED');
  assert.equal(result.body.confirmationRequired, false);
  assert.equal(getTask('strict-default')?.status, 'in-progress');
});
test('move-to applies the same confirmation and explicit override semantics across a transition path', async () => {
  const first = await post('manual-path', { status: 'done', intent: 'manual' }, 'move-to');
  assert.equal(first.response.status, 409);
  assert.equal(first.body.code, 'MOVE_CONFIRMATION_REQUIRED');
  assert.equal(getTask('manual-path')?.status, 'in-progress');

  const override = await post('manual-path', { status: 'done', intent: 'manual', manualOverride: true }, 'move-to');
  assert.equal(override.response.status, 200);
  assert.equal(override.body.task.status, 'done');
  assert.equal(override.body.autoWorkTrigger, null);
  assert.ok(Array.isArray(override.body.path));
  assert.ok((getTask('manual-path')?.logs || []).some((entry: any) => /Manual override move in-progress -> done/.test(entry.message)));
});
