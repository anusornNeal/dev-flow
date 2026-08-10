import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-project-git-policy-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const express = (await import('express')).default;
const { registerProjectRoutes } = await import('../../src/server/routes/projects.js');
const { getProject } = await import('../../src/server/repositories/projectRepository.js');

const app = express();
app.use(express.json());
registerProjectRoutes(app, { state: {} as any, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(method: string, route: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}

test('project CRUD persists optional structured git workflow policy without breaking legacy projects', async () => {
  const legacy = await request('POST', '/api/projects', {
    name: 'Legacy Project',
    repoUrl: 'https://example.com/legacy.git',
  });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.body.gitWorkflowPolicy, undefined);
  assert.equal(getProject(legacy.body.id)?.gitWorkflowPolicy, undefined);

  const configured = await request('POST', '/api/projects', {
    name: 'Kanban Project',
    repoUrl: 'https://example.com/kanban.git',
    taskIdPrefix: 'QCA',
    gitWorkflowPolicy: {
      integrationStrategy: 'merge',
      commitMessageTemplate: '[{ticket}] {type}: {title}',
      mergeMessageTemplate: 'Merge {ticket}',
    },
  });
  assert.equal(configured.status, 201);
  assert.deepEqual(configured.body.gitWorkflowPolicy, {
    integrationStrategy: 'merge',
    commitMessageTemplate: '[{ticket}] {type}: {title}',
    mergeMessageTemplate: 'Merge {ticket}',
  });
  assert.deepEqual(getProject(configured.body.id)?.gitWorkflowPolicy, configured.body.gitWorkflowPolicy);

  const updated = await request('PUT', `/api/projects/${configured.body.id}`, {
    gitWorkflowPolicy: {
      integrationStrategy: 'rebase-ff',
      commitMessageTemplate: '[{ticket}] {title}',
    },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.gitWorkflowPolicy.integrationStrategy, 'rebase-ff');
  assert.equal(updated.body.gitWorkflowPolicy.mergeMessageTemplate, undefined);
});

test('project routes reject invalid workflow policy with actionable error payload', async () => {
  const invalid = await request('POST', '/api/projects', {
    name: 'Invalid Policy',
    repoUrl: 'https://example.com/invalid.git',
    gitWorkflowPolicy: { integrationStrategy: 'squash' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error?.code, 'PROJECT_GIT_POLICY_INVALID');
  assert.match(invalid.body.error?.message || '', /integrationStrategy/);
});

test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
