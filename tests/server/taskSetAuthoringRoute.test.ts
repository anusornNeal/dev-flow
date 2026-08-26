import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-set-authoring-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTasks, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const express = (await import('express')).default;
const { registerTaskSetAuthoringRoute } = await import('../../src/server/routes/taskSetAuthoringRoute.js');
const { getToolDefinitionByName } = await import('../../src/server/contracts/devflowContract.js');
const { buildWorkDecomposition } = await import('../../src/server/services/workDecompositionService.js');
const { buildDecompositionCardPlan } = await import('../../src/server/services/workDecompositionCardService.js');

const projectId = 'project-task-set-authoring';
createProject({ id: projectId, name: 'Task Set Authoring', repoUrl: 'https://example.invalid/task-set', localPath: tempDir, taskIdPrefix: 'TSA' });

const state: any = {
  projectsCache: [{ id: projectId, name: 'Task Set Authoring', repoUrl: 'https://example.invalid/task-set', localPath: tempDir, taskIdPrefix: 'TSA' }],
  countersCache: {},
};

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  registerTaskSetAuthoringRoute(app, { state, writeAgentLog: () => {} } as any);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const parent = {
  title: 'Author parent set',
  category: 'backend',
  status: 'backlog',
  description: 'Parent orchestration.',
};

const validChild = (title: string) => ({
  title,
  category: 'backend',
  status: 'backlog',
  description: 'Focused child implementation.',
});

test('create_task contract exposes atomic parent/children authoring in one call', () => {
  const tool = getToolDefinitionByName('create_task');
  assert.ok(tool);
  assert.ok(tool.inputSchema.properties.parent);
  assert.ok(tool.inputSchema.properties.children);
  assert.equal(Array.isArray(tool.inputSchema.anyOf), true);
  const request = tool.buildHttpRequest({ projectId, parent, children: [validChild('Contract child')], responseMode: 'summary' });
  assert.equal(request.method, 'POST');
  assert.match(request.path, /^\/api\/tasks\/task-set/);
  assert.equal((request.body as any).children.length, 1);
});

test('task-set authoring creates parent and children atomically with deterministic linkage', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-set?responseMode=standard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, parent, children: [validChild('Child A'), validChild('Child B')] }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.createdCount, 3);
    assert.equal(body.children.length, 2);
    assert.equal(body.children.every((child: any) => child.parentId === body.parent.id), true);
    assert.equal(getTasks().filter((task: any) => task.projectId === projectId).length, 3);
  });
});

test('task-set authoring reports invalid child quality and writes nothing', async () => {
  const before = getTasks().length;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        parent,
        children: [{
          title: 'Invalid implementation-ready child',
          category: 'backend',
          status: 'in-progress',
          description: 'Implementation-ready but missing repo evidence.',
          targetFiles: [],
        }],
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'TASK_SET_VALIDATION_FAILED');
    assert.equal(body.error.details.failures[0].role, 'child');
    assert.equal(body.error.details.failures[0].index, 0);
    assert.equal(body.error.details.failures[0].stage, 'quality');
    assert.equal(body.error.details.failures[0].fields.includes('repoContext'), true);
    assert.equal(body.error.details.failures[0].fields.includes('targetFiles'), true);
  });
  assert.equal(getTasks().length, before);
});

test('task-set authoring rejects child linkage conflicts before mutation', async () => {
  const before = getTasks().length;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, parent, children: [{ ...validChild('Conflicting child'), parentId: 'another-parent' }] }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'TASK_SET_VALIDATION_FAILED');
    assert.equal(body.error.details.failures[0].code, 'TASK_SET_CHILD_PARENT_CONFLICT');
  });
  assert.equal(getTasks().length, before);
});

test('decomposition card plan can be explicitly created through atomic task-set authoring with preserved linkage', async () => {
  const before = getTasks().length;
  const decomposition = buildWorkDecomposition({
    title: 'Add task audit contract and backend support',
    description: 'Define an audit contract, implement backend support, and run focused regression coverage.',
    repoEvidence: {
      repoRevision: 'rev-task-set-integration',
      matches: [
        { path: 'src/server/contracts/taskAuditContract.ts', symbols: ['TaskAuditEntry'], score: 9 },
        { path: 'src/server/services/taskAuditService.ts', symbols: ['getTaskAudit'], score: 8 },
        { path: 'tests/server/taskAuditService.test.ts', score: 6 },
      ],
    },
  });
  const plan = buildDecompositionCardPlan({
    projectId,
    parentTitle: 'Task audit delivery',
    decomposition,
    createRequested: true,
  });
  assert.equal(plan.evaluation.ok, true);
  assert.ok(plan.creationPayload);

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-set?responseMode=standard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plan.creationPayload),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.children.length, plan.children.length);
    assert.equal(body.children.every((child: any) => child.parentId === body.parent.id), true);
    assert.equal(body.parent.verification, plan.parent.verification);
    assert.equal(body.children.some((child: any) => child.repoContext.includes('Prerequisites: contract')), true);
  });

  const created = getTasks().slice(before);
  assert.equal(created.length, 1 + plan.children.length);
  const createdParent = created.find((task: any) => !task.parentId);
  assert.ok(createdParent);
  assert.equal(created.filter((task: any) => task.parentId === createdParent.id).length, plan.children.length);
});

test('task-set authoring resolves sibling prerequisite keys to canonical ids and persists the DAG atomically', async () => {
  const before = getTasks().length;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-set?responseMode=standard`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        parent: { ...parent, title: 'Dependency parent' },
        children: [
          { ...validChild('Foundation child'), taskSetKey: 'foundation' },
          { ...validChild('Dependent child'), taskSetKey: 'dependent', prerequisiteTaskIds: ['foundation'] },
          { ...validChild('Independent child'), taskSetKey: 'parallel' },
        ],
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 201, JSON.stringify(body));
    const foundation = body.children.find((child: any) => child.title === 'Foundation child');
    const dependent = body.children.find((child: any) => child.title === 'Dependent child');
    const parallel = body.children.find((child: any) => child.title === 'Independent child');
    assert.ok(foundation && dependent && parallel);
    assert.deepEqual(dependent.prerequisiteTaskIds, [foundation.id]);
    assert.deepEqual(parallel.prerequisiteTaskIds, []);
    assert.equal('taskSetKey' in dependent, false);
    const persisted = getTasks().find((task: any) => task.id === dependent.id);
    assert.deepEqual(persisted?.prerequisiteTaskIds, [foundation.id]);
  });
  assert.equal(getTasks().length, before + 4);
});

test('task-set prerequisite cycles and self references rollback the whole request', async () => {
  const before = getTasks().length;
  await withServer(async (baseUrl) => {
    const cyclic = await fetch(`${baseUrl}/api/tasks/task-set`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, parent: { ...parent, title: 'Cycle parent' }, children: [
        { ...validChild('Cycle A'), taskSetKey: 'a', prerequisiteTaskIds: ['b'] },
        { ...validChild('Cycle B'), taskSetKey: 'b', prerequisiteTaskIds: ['a'] },
      ] }),
    });
    const cyclicBody = await cyclic.json() as any;
    assert.equal(cyclic.status, 400);
    assert.equal(cyclicBody.error.code, 'TASK_SET_VALIDATION_FAILED');
    assert.match(JSON.stringify(cyclicBody), /TASK_PREREQUISITE_CYCLE/);

    const self = await fetch(`${baseUrl}/api/tasks/task-set`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, parent: { ...parent, title: 'Self parent' }, children: [
        { ...validChild('Self child'), taskSetKey: 'self', prerequisiteTaskIds: ['self'] },
      ] }),
    });
    const selfBody = await self.json() as any;
    assert.equal(self.status, 400);
    assert.match(JSON.stringify(selfBody), /TASK_PREREQUISITE_SELF/);
  });
  assert.equal(getTasks().length, before);
});

test('task-set prerequisites reject duplicate and cross-project references without partial writes', async () => {
  const foreignProjectId = 'project-task-set-foreign';
  createProject({ id: foreignProjectId, name: 'Foreign Task Set', repoUrl: 'https://example.invalid/foreign', localPath: tempDir, taskIdPrefix: 'FRN' });
  saveTask({ id: 'foreign-prerequisite', displayId: 'FRN-0001', projectId: foreignProjectId, title: 'Foreign prerequisite', description: '', status: 'done', priority: 'medium', category: 'backend', tags: [], targetFiles: [], checklist: [], logs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const before = getTasks().length;
  await withServer(async (baseUrl) => {
    const duplicate = await fetch(`${baseUrl}/api/tasks/task-set`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, parent: { ...parent, title: 'Duplicate parent' }, children: [
        { ...validChild('Base'), taskSetKey: 'base' },
        { ...validChild('Duplicate dependent'), taskSetKey: 'dup', prerequisiteTaskIds: ['base', 'BASE'] },
      ] }),
    });
    assert.equal(duplicate.status, 400);
    assert.match(JSON.stringify(await duplicate.json()), /TASK_PREREQUISITES_DUPLICATE/);

    const crossProject = await fetch(`${baseUrl}/api/tasks/task-set`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, parent: { ...parent, title: 'Cross project parent' }, children: [
        { ...validChild('Cross dependent'), taskSetKey: 'cross', prerequisiteTaskIds: ['FRN-0001'] },
      ] }),
    });
    assert.equal(crossProject.status, 400);
    assert.match(JSON.stringify(await crossProject.json()), /TASK_PREREQUISITE_CROSS_PROJECT/);
  });
  assert.equal(getTasks().length, before);
});

test.after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
