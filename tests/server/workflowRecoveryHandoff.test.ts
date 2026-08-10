import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workflow-recovery-handoff-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_JOBS_DIR = path.join(tempRoot, 'jobs');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

fs.mkdirSync(repoRoot, { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'base\n', 'utf8');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

git(repoRoot, ['init']);
git(repoRoot, ['config', 'user.name', 'DevFlow Test']);
git(repoRoot, ['config', 'user.email', 'devflow@example.test']);
git(repoRoot, ['add', '.']);
git(repoRoot, ['commit', '-m', 'base']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const jobs = await import('../../src/server/repositories/mcpToolJobRepository.js') as any;
const {
  createOrReuseSessionWorkspace,
  markSessionWorkspaceIntegrationRequired,
} = await import('../../src/server/services/sessionWorkspaceService.js');
const { registerDevFlowRoutes } = await import('../../src/server/routes/devflow.js');

const projectId = 'project-recovery-handoff';
createProject({
  id: projectId,
  name: 'Recovery Handoff',
  repoUrl: 'https://example.test/recovery-handoff.git',
  localPath: repoRoot,
  taskIdPrefix: 'RCH',
  createdAt: new Date().toISOString(),
});

function seedClaimedTask(label: string) {
  const workspace = createOrReuseSessionWorkspace({ id: projectId, localPath: repoRoot }, `session-${label}`);
  const now = new Date().toISOString();
  const taskId = `task-${label}`;
  saveTask({
    id: taskId,
    displayId: `RCH-${label.toUpperCase()}`,
    projectId,
    title: `Recovery ${label}`,
    description: '',
    status: 'in-progress',
    priority: 'high',
    category: 'backend',
    tags: [],
    targetFiles: ['tracked.txt'],
    checklist: [],
    createdAt: now,
    updatedAt: now,
    logs: [],
    claim: {
      sessionIdHash: workspace.sessionIdHash,
      workspaceId: workspace.workspaceId,
      ownerKind: 'chat',
      ownerLabel: `Chat ${label}`,
      claimedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  return { taskId, displayId: `RCH-${label.toUpperCase()}`, workspace };
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerDevFlowRoutes(app, {
    state: { countersCache: {} },
    writeAgentLog: () => {},
    restartProcess: () => {},
  } as any);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind recovery handoff test server.');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function json(baseUrl: string, query: URLSearchParams) {
  const response = await fetch(`${baseUrl}/api/recovery/handoff?${query.toString()}`);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() as any : { raw: await response.text() };
  return { response, body };
}

test('fresh client receives the accepted durable job and original managed workspace instead of replay guidance', async () => {
  const fixture = seedClaimedTask('job');
  const job = jobs.createJob(
    `job-handoff-${Date.now()}`,
    'run_project_command',
    {
      projectId,
      taskId: fixture.taskId,
      workspaceId: fixture.workspace.workspaceId,
      command: 'typecheck',
      prompt: 'raw chat text must never appear',
    },
    `workspace:${fixture.workspace.workspaceId}`,
  );

  await withServer(async (baseUrl) => {
    const capabilities = await (await fetch(`${baseUrl}/api/capabilities`)).json() as any;
    const query = new URLSearchParams({
      taskId: fixture.displayId,
      previousContractVersion: capabilities.contractVersion,
      previousRuntimeInstanceId: capabilities.runtimeInstanceId,
      previousToolSurfaceIdentity: capabilities.toolSurfaceIdentity,
      clientToolsVisible: 'false',
    });
    const { response, body } = await json(baseUrl, query);

    assert.equal(response.status, 200);
    assert.equal(body.diagnosis.code, 'client-registry-desync');
    assert.match(body.diagnosis.detail, /cannot repair/i);
    assert.equal(body.project.id, projectId);
    assert.equal(body.task.id, fixture.taskId);
    assert.equal(body.workspace.workspaceId, fixture.workspace.workspaceId);
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].jobId, job.jobId);
    assert.equal(body.jobs[0].status, 'queued');
    assert.equal(body.continuation.action, 'query-job');
    assert.equal(body.continuation.jobId, job.jobId);
    assert.equal(JSON.stringify(body).includes('raw chat text must never appear'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body.jobs[0], 'args'), false);
  });
});

test('succeeded durable job remains the first reusable recovery boundary by job id', async () => {
  const fixture = seedClaimedTask('succeeded');
  const job = jobs.createJob(
    `job-succeeded-${Date.now()}`,
    'run_project_command',
    { projectId, taskId: fixture.taskId, workspaceId: fixture.workspace.workspaceId, command: 'typecheck' },
    `workspace:${fixture.workspace.workspaceId}`,
  );
  jobs.updateJobStatus(job.jobId, { status: 'succeeded' });

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ jobId: job.jobId }));
    assert.equal(response.status, 200);
    assert.equal(body.jobs[0].jobId, job.jobId);
    assert.equal(body.jobs[0].status, 'succeeded');
    assert.equal(body.continuation.action, 'query-job');
    assert.equal(body.continuation.jobId, job.jobId);
  });
});

test('dirty workspace is resumed by opaque workspace id and committed integration-required work is finalized, never duplicated', async () => {
  const dirty = seedClaimedTask('dirty');
  fs.writeFileSync(path.join(dirty.workspace.root, 'tracked.txt'), 'dirty work\n', 'utf8');

  const integration = seedClaimedTask('integration');
  fs.writeFileSync(path.join(integration.workspace.root, 'tracked.txt'), 'committed work\n', 'utf8');
  git(integration.workspace.root, ['add', 'tracked.txt']);
  git(integration.workspace.root, ['commit', '-m', 'committed recovery work']);
  markSessionWorkspaceIntegrationRequired(integration.workspace.workspaceId, true);

  await withServer(async (baseUrl) => {
    const dirtyResult = await json(baseUrl, new URLSearchParams({ taskId: dirty.displayId }));
    assert.equal(dirtyResult.response.status, 200);
    assert.equal(dirtyResult.body.workspace.workspaceId, dirty.workspace.workspaceId);
    assert.equal(dirtyResult.body.workspace.disposition, 'needs-recovery');
    assert.deepEqual(dirtyResult.body.workspace.dirtyFiles, ['tracked.txt']);
    assert.equal(dirtyResult.body.continuation.action, 'continue-workspace');
    assert.equal(dirtyResult.body.continuation.workspaceId, dirty.workspace.workspaceId);

    const integrationResult = await json(baseUrl, new URLSearchParams({ taskId: integration.displayId }));
    assert.equal(integrationResult.response.status, 200);
    assert.equal(integrationResult.body.workspace.workspaceId, integration.workspace.workspaceId);
    assert.equal(integrationResult.body.workspace.state, 'integration-required');
    assert.equal(integrationResult.body.workspace.disposition, 'committed-not-integrated');
    assert.equal(integrationResult.body.continuation.action, 'finish-integration');
    assert.equal(integrationResult.body.continuation.workspaceId, integration.workspace.workspaceId);
  });
});

test('interrupted unsafe mutation is surfaced as blocked manual continuation and is not replayed', async () => {
  const fixture = seedClaimedTask('unsafe');
  const job = jobs.createJob(
    `job-unsafe-${Date.now()}`,
    'commit_git_changes',
    { projectId, taskId: fixture.taskId, workspaceId: fixture.workspace.workspaceId, message: 'unsafe mutation' },
    `workspace:${fixture.workspace.workspaceId}`,
  );
  jobs.updateJobStatus(job.jobId, {
    status: 'failed',
    failureSummary: 'Server restarted before this mutation completed.',
    recoveryClassification: 'interrupted',
  });

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: fixture.displayId }));
    assert.equal(response.status, 200);
    assert.equal(body.jobs[0].jobId, job.jobId);
    assert.equal(body.jobs[0].recoveryClassification, 'interrupted');
    assert.equal(body.continuation.action, 'blocked');
    assert.match(body.continuation.reason, /manual|interrupted|unsafe/i);
  });

  assert.equal(jobs.getJob(job.jobId)?.status, 'failed');
});

test('conflicting task and job recovery selectors fail closed instead of composing different workflow state', async () => {
  const left = seedClaimedTask('selector-left');
  const right = seedClaimedTask('selector-right');
  const job = jobs.createJob(
    `job-selector-mismatch-${Date.now()}`,
    'run_project_command',
    { projectId, taskId: right.taskId, workspaceId: right.workspace.workspaceId, command: 'typecheck' },
    `workspace:${right.workspace.workspaceId}`,
  );

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: left.displayId, jobId: job.jobId }));
    assert.equal(response.status, 200);
    assert.equal(body.status, 'blocked');
    assert.equal(body.continuation.action, 'blocked');
    assert.match(body.continuation.reason, /conflict|mismatch|different|unsafe/i);
    assert.notEqual(body.continuation.action, 'query-job');
  });
});

test('project-only recovery stops as ambiguous when more than one active claimed workspace exists', async () => {
  const first = seedClaimedTask('ambiguous-a');
  const second = seedClaimedTask('ambiguous-b');

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ projectId }));
    assert.equal(response.status, 200);
    assert.equal(body.status, 'blocked');
    assert.equal(body.continuation.action, 'blocked');
    assert.match(body.continuation.reason, /ambiguous|multiple/i);
    assert.equal(body.candidates.tasks.includes(first.taskId), true);
    assert.equal(body.candidates.tasks.includes(second.taskId), true);
  });
});
