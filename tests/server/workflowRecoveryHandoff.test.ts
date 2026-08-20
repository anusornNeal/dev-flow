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
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');const executionSessions = await import('../../src/server/services/executionSessionService.js');
const { listExecutionSessionsForTask, listExecutionSessionEvidence } = await import('../../src/server/repositories/executionSessionRepository.js');
const jobs = await import('../../src/server/repositories/mcpToolJobRepository.js') as any;
const finalizationOps = await import('../../src/server/repositories/taskFinalizationOperationRepository.js');
const emergencyOps = await import('../../src/server/repositories/lifecycleEmergencyOperationRepository.js');
const {
  createOrReuseSessionWorkspace,
  markSessionWorkspaceIntegrationRequired,
  resetSessionWorkspaceRuntimeForTests,
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

let isolatedProjectCounter = 0;
function seedIsolatedProject(label: string) {
  isolatedProjectCounter += 1;
  const id = `project-recovery-${label}-${isolatedProjectCounter}`;
  createProject({
    id,
    name: `Recovery Handoff ${label}`,
    repoUrl: `https://example.test/${id}.git`,
    localPath: repoRoot,
    taskIdPrefix: 'RCI',
    createdAt: new Date().toISOString(),
  });
  return id;
}

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

let unclaimedTaskCounter = 7000;

function workspaceRegistryPath(workspaceId: string) {
  return path.join(process.env.DEVFLOW_RUNTIME_DIR!, 'workspaces', 'registry', `${workspaceId}.json`);
}

function rewriteWorkspaceMetadata(workspaceId: string, mutate: (metadata: any) => void) {
  const target = workspaceRegistryPath(workspaceId);
  const metadata = JSON.parse(fs.readFileSync(target, 'utf8')) as any;
  mutate(metadata);
  fs.writeFileSync(target, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  resetSessionWorkspaceRuntimeForTests();
}

function seedUnclaimedTaskWorkspace(label: string, status: 'todo' | 'in-progress' | 'done' = 'in-progress') {
  unclaimedTaskCounter += 1;
  const isolatedProjectId = seedIsolatedProject(label);
  const displayId = `RCI-${unclaimedTaskCounter}`;
  const workspace = createOrReuseSessionWorkspace(
    { id: isolatedProjectId, localPath: repoRoot },
    `session-${label}-${unclaimedTaskCounter}`,
    { taskDisplayId: displayId },
  );
  const now = new Date().toISOString();
  const taskId = `task-${label}-${unclaimedTaskCounter}`;
  saveTask({
    id: taskId,
    displayId,
    projectId: isolatedProjectId,
    title: `Unclaimed recovery ${label}`,
    description: '',
    status,
    priority: 'high',
    category: 'backend',
    tags: [],
    targetFiles: ['tracked.txt'],
    checklist: [],
    createdAt: now,
    updatedAt: now,
    logs: [],
  });
  return { taskId, displayId, projectId: isolatedProjectId, workspace };
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

test('recovery handoff observes pre-fix orphan execution without mutating lifecycle state', async () => {
  const fixture = seedUnclaimedTaskWorkspace('orphan-readonly');
  fs.writeFileSync(path.join(fixture.workspace.root, 'tracked.txt'), 'orphan dirty work\n', 'utf8');
  const orphan = executionSessions.createExecutionSession({
    projectId: fixture.projectId,
    taskId: fixture.taskId,
    workspaceId: fixture.workspace.workspaceId,
    repoRoot: fixture.workspace.root,
    branch: fixture.workspace.branch,
  });
  executionSessions.recordExecutionLifecycleTransition(orphan.id, {
    toStage: 'context-ready', reasonCode: 'orphan-readonly-context', evidence: { id: 'orphan-readonly-context', kind: 'context', status: 'completed' },
  });
  executionSessions.recordExecutionLifecycleTransition(orphan.id, {
    toStage: 'implementing', reasonCode: 'orphan-readonly-implementing', evidence: { id: 'orphan-readonly-implementing', kind: 'mutation', status: 'completed' },
  });
  executionSessions.recordExecutionLifecycleTransition(orphan.id, {
    toStage: 'verifying', reasonCode: 'orphan-readonly-verifying', evidence: { id: 'orphan-readonly-verifying', kind: 'verification', status: 'completed' },
  });
  const beforeSession = listExecutionSessionsForTask(fixture.taskId).find((entry: any) => entry.id === orphan.id);
  const beforeEvidence = listExecutionSessionEvidence(orphan.id).map((entry: any) => entry.id);

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: fixture.displayId }));
    assert.equal(response.status, 200);
    assert.equal(body.task.id, fixture.taskId);
    assert.equal(body.workspace.workspaceId, fixture.workspace.workspaceId);
  });

  const afterSession = listExecutionSessionsForTask(fixture.taskId).find((entry: any) => entry.id === orphan.id);
  const afterEvidence = listExecutionSessionEvidence(orphan.id).map((entry: any) => entry.id);
  assert.equal(beforeSession?.status, 'active');
  assert.equal(beforeSession?.lifecycle.stage, 'verifying');
  assert.equal(afterSession?.status, 'active');
  assert.equal(afterSession?.lifecycle.stage, 'verifying');
  assert.deepEqual(afterEvidence, beforeEvidence);
  assert.equal(fs.readFileSync(path.join(fixture.workspace.root, 'tracked.txt'), 'utf8'), 'orphan dirty work\n');
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

test('project-only recovery discovers a sole integration-required workspace even without an active task claim', async () => {
  const isolatedProjectId = seedIsolatedProject('unclaimed-integration');
  const workspace = createOrReuseSessionWorkspace({ id: isolatedProjectId, localPath: repoRoot }, 'session-unclaimed-integration');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'unclaimed committed work\n', 'utf8');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', 'unclaimed recovery work']);
  markSessionWorkspaceIntegrationRequired(workspace.workspaceId, true);

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ projectId: isolatedProjectId }));
    assert.equal(response.status, 200);
    assert.equal(body.workspace.workspaceId, workspace.workspaceId);
    assert.equal(body.workspace.state, 'integration-required');
    assert.equal(body.continuation.action, 'finish-integration');
    assert.equal(body.continuation.workspaceId, workspace.workspaceId);
  });
});

test('project-only recovery discovers a sole dirty workspace without an active task claim', async () => {
  const isolatedProjectId = seedIsolatedProject('unclaimed-dirty');
  const workspace = createOrReuseSessionWorkspace({ id: isolatedProjectId, localPath: repoRoot }, 'session-unclaimed-dirty');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'unclaimed dirty work\n', 'utf8');

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ projectId: isolatedProjectId }));
    assert.equal(response.status, 200);
    assert.equal(body.workspace.workspaceId, workspace.workspaceId);
    assert.equal(body.workspace.disposition, 'needs-recovery');
    assert.equal(body.continuation.action, 'continue-workspace');
    assert.equal(body.continuation.workspaceId, workspace.workspaceId);
  });
});

test('recovery handoff exposes a durable finalization cursor instead of reconstructing from task status', async () => {
  const fixture = seedUnclaimedTaskWorkspace('durable-finalization-cursor');
  const sourceHead = git(fixture.workspace.root, ['rev-parse', 'HEAD']);
  const now = new Date().toISOString();
  const operation = finalizationOps.createTaskFinalizationOperation({
    id: `finalize-recovery-${Date.now()}`,
    projectId: fixture.projectId,
    taskId: fixture.taskId,
    workspaceId: fixture.workspace.workspaceId,
    executionSessionId: null,
    ownershipEpochId: null,
    sourceHead,
    baseRevision: fixture.workspace.baseRevision,
    baseBranch: fixture.workspace.baseBranch,
    candidateId: null,
    candidateRepoRevision: null,
    ownedFingerprint: null,
    phase: 'evidence-recorded',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: fixture.displayId }));
    assert.equal(response.status, 200);
    assert.equal(body.finalizationOperation.id, operation.id);
    assert.equal(body.finalizationOperation.phase, 'evidence-recorded');
    assert.equal(body.continuation.action, 'continue-workspace');
    assert.equal(body.continuation.operationId, operation.id);
    assert.equal(body.continuation.tool, 'finalize_task_workspace');
    assert.match(body.continuation.reason, /durable task finalization|retry the same operation/i);
  });
});

test('recovery handoff surfaces an unresolved audited break-glass operation as the exact continuation boundary', async () => {
  const fixture = seedUnclaimedTaskWorkspace('durable-break-glass-cursor');
  const now = new Date().toISOString();
  const operation = emergencyOps.createLifecycleEmergencyOperation({
    id: `break-glass-recovery-${Date.now()}`,
    requestDigest: 'break-glass-recovery-digest',
    action: 'release-ownership-preserve-wip',
    projectId: fixture.projectId,
    taskId: fixture.taskId,
    workspaceId: fixture.workspace.workspaceId,
    executionSessionId: null,
    ownershipEpochId: null,
    actorLabel: 'Recovery Operator',
    reason: 'resume exact audited operation',
    status: 'partial',
    request: { operationId: 'break-glass-recovery' },
    beforeSnapshot: { classification: 'recoverable' },
    afterSnapshot: { classification: 'recoverable' },
    bypassedGates: [],
    hardChecks: [],
    evidence: { preserved: true },
    wipDisposition: 'preserved',
    result: { pending: true },
    failure: { code: 'RECOVERY_PENDING', message: 'synthetic continuation' },
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: fixture.displayId }));
    assert.equal(response.status, 200);
    assert.equal(body.continuation.action, 'continue-workspace');
    assert.equal(body.continuation.operationId, operation.id);
    assert.equal(body.continuation.tool, 'break_glass_lifecycle');
    assert.equal(body.breakGlassOperations.some((entry: any) => entry.id === operation.id && entry.status === 'partial'), true);
    assert.equal(emergencyOps.getLifecycleEmergencyOperation(operation.id)?.status, 'partial', 'recovery handoff must remain read-only');
  });
  emergencyOps.updateLifecycleEmergencyOperation(operation.id, { status: 'completed', completedAt: new Date().toISOString() });
});

test('project-only recovery keeps no-action when the project has no actionable managed workspace', async () => {
  const isolatedProjectId = seedIsolatedProject('no-action');
  createOrReuseSessionWorkspace({ id: isolatedProjectId, localPath: repoRoot }, 'session-no-action');

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ projectId: isolatedProjectId }));
    assert.equal(response.status, 200);
    assert.equal(body.status, 'current');
    assert.equal(body.continuation.action, 'no-action');
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'workspace'), false);
  });
});

test('project-only recovery blocks when multiple unclaimed managed workspaces are actionable', async () => {
  const isolatedProjectId = seedIsolatedProject('multiple-actionable');
  const dirty = createOrReuseSessionWorkspace({ id: isolatedProjectId, localPath: repoRoot }, 'session-multiple-dirty');
  fs.writeFileSync(path.join(dirty.root, 'tracked.txt'), 'multiple dirty work\n', 'utf8');
  const integration = createOrReuseSessionWorkspace({ id: isolatedProjectId, localPath: repoRoot }, 'session-multiple-integration');
  fs.writeFileSync(path.join(integration.root, 'tracked.txt'), 'multiple committed work\n', 'utf8');
  git(integration.root, ['add', 'tracked.txt']);
  git(integration.root, ['commit', '-m', 'multiple integration work']);
  markSessionWorkspaceIntegrationRequired(integration.workspaceId, true);

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ projectId: isolatedProjectId }));
    assert.equal(response.status, 200);
    assert.equal(body.status, 'blocked');
    assert.equal(body.continuation.action, 'blocked');
    assert.match(body.continuation.reason, /ambiguous|multiple/i);
    assert.equal(body.candidates.workspaces.includes(dirty.workspaceId), true);
    assert.equal(body.candidates.workspaces.includes(integration.workspaceId), true);
  });
});

test('explicit workspace selector keeps precedence over project-only actionable workspace discovery', async () => {
  const isolatedProjectId = seedIsolatedProject('explicit-workspace');
  const selected = createOrReuseSessionWorkspace({ id: isolatedProjectId, localPath: repoRoot }, 'session-explicit-selected');
  fs.writeFileSync(path.join(selected.root, 'tracked.txt'), 'selected dirty work\n', 'utf8');
  const other = createOrReuseSessionWorkspace({ id: isolatedProjectId, localPath: repoRoot }, 'session-explicit-other');
  fs.writeFileSync(path.join(other.root, 'tracked.txt'), 'other dirty work\n', 'utf8');

  await withServer(async (baseUrl) => {
    const query = new URLSearchParams({ projectId: isolatedProjectId, workspaceId: selected.workspaceId });
    const { response, body } = await json(baseUrl, query);
    assert.equal(response.status, 200);
    assert.equal(body.workspace.workspaceId, selected.workspaceId);
    assert.notEqual(body.workspace.workspaceId, other.workspaceId);
    assert.equal(body.continuation.action, 'continue-workspace');
    assert.equal(body.continuation.workspaceId, selected.workspaceId);
  });
});

test('project-only recovery keeps an active claim visible when task presentation status drifted to todo', async () => {
  const isolatedProjectId = seedIsolatedProject('status-drift-claim');
  const displayId = `RCI-${++unclaimedTaskCounter}`;
  const workspace = createOrReuseSessionWorkspace(
    { id: isolatedProjectId, localPath: repoRoot },
    `session-status-drift-${unclaimedTaskCounter}`,
    { taskDisplayId: displayId },
  );
  const now = new Date().toISOString();
  const taskId = `task-status-drift-${unclaimedTaskCounter}`;
  saveTask({
    id: taskId,
    displayId,
    projectId: isolatedProjectId,
    title: 'Status drift active claim',
    description: '',
    status: 'todo',
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
      ownershipEpochId: 'claim-epoch-recovery-status-drift',
      workspaceId: workspace.workspaceId,
      ownerKind: 'chat',
      ownerLabel: 'Chat Drift',
      claimedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  } as any);

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ projectId: isolatedProjectId }));
    assert.equal(response.status, 200);
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.status, 'todo');
    assert.equal(body.workspace.workspaceId, workspace.workspaceId);
    assert.equal(body.continuation.action, 'continue-workspace');
    assert.match(body.continuation.reason, /lifecycle authority|existing managed workspace/i);
  });
  assert.equal(getTask(taskId)?.status, 'todo');
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

test('task-only recovery rediscovers exact dirty workspace after claim loss without mutating registry metadata', async () => {
  const fixture = seedUnclaimedTaskWorkspace('task-only-dirty');
  fs.writeFileSync(path.join(fixture.workspace.root, 'tracked.txt'), 'task-only dirty work\n', 'utf8');
  const metadataBefore = fs.readFileSync(workspaceRegistryPath(fixture.workspace.workspaceId), 'utf8');

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: fixture.displayId }));
    assert.equal(response.status, 200);
    assert.equal(body.workspace.workspaceId, fixture.workspace.workspaceId);
    assert.equal(body.workspace.disposition, 'needs-recovery');
    assert.deepEqual(body.workspace.dirtyFiles, ['tracked.txt']);
    assert.equal(body.continuation.action, 'continue-workspace');
    assert.equal(body.continuation.workspaceId, fixture.workspace.workspaceId);
  });

  assert.equal(fs.readFileSync(workspaceRegistryPath(fixture.workspace.workspaceId), 'utf8'), metadataBefore);
});

test('task-only recovery rediscovers exact committed integration-required workspace after claim loss', async () => {
  const fixture = seedUnclaimedTaskWorkspace('task-only-integration');
  fs.writeFileSync(path.join(fixture.workspace.root, 'tracked.txt'), 'task-only committed work\n', 'utf8');
  git(fixture.workspace.root, ['add', 'tracked.txt']);
  git(fixture.workspace.root, ['commit', '-m', 'task-only recovery commit']);
  markSessionWorkspaceIntegrationRequired(fixture.workspace.workspaceId, true);

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: fixture.displayId }));
    assert.equal(response.status, 200);
    assert.equal(body.workspace.workspaceId, fixture.workspace.workspaceId);
    assert.equal(body.workspace.state, 'integration-required');
    assert.equal(body.continuation.action, 'finish-integration');
    assert.equal(body.continuation.workspaceId, fixture.workspace.workspaceId);
  });
});

test('task-only recovery exposes a unique clean exact historical workspace without inventing actionable work', async () => {
  const fixture = seedUnclaimedTaskWorkspace('task-only-clean', 'done');

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: fixture.displayId }));
    assert.equal(response.status, 200);
    assert.equal(body.workspace.workspaceId, fixture.workspace.workspaceId);
    assert.equal(body.status, 'current');
    assert.equal(body.continuation.action, 'no-action');
  });
});

test('task-only recovery fails closed when only legacy numeric task compatibility remains', async () => {
  const fixture = seedUnclaimedTaskWorkspace('task-only-legacy');
  const rootLeaf = fixture.displayId.match(/(\d+)$/)?.[1];
  rewriteWorkspaceMetadata(fixture.workspace.workspaceId, (metadata) => {
    delete metadata.taskDisplayId;
    metadata.taskRootLeaf = rootLeaf;
  });

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: fixture.displayId }));
    assert.equal(response.status, 200);
    assert.equal(body.status, 'blocked');
    assert.equal(body.continuation.action, 'blocked');
    assert.match(body.continuation.reason, /legacy|exact persisted task identity/i);
    assert.equal(body.candidates.workspaces.includes(fixture.workspace.workspaceId), true);
  });
});

test('task-only recovery blocks when multiple actionable workspaces carry the same exact task identity', async () => {
  const fixture = seedUnclaimedTaskWorkspace('task-only-ambiguous');
  fs.writeFileSync(path.join(fixture.workspace.root, 'tracked.txt'), 'primary dirty work\n', 'utf8');
  const duplicate = createOrReuseSessionWorkspace(
    { id: fixture.projectId, localPath: repoRoot },
    `session-task-only-duplicate-${unclaimedTaskCounter}`,
  );
  fs.writeFileSync(path.join(duplicate.root, 'tracked.txt'), 'duplicate dirty work\n', 'utf8');
  rewriteWorkspaceMetadata(duplicate.workspaceId, (metadata) => {
    metadata.taskDisplayId = fixture.displayId;
    metadata.taskRootLeaf = fixture.displayId.match(/(\d+)$/)?.[1];
  });

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: fixture.displayId }));
    assert.equal(response.status, 200);
    assert.equal(body.status, 'blocked');
    assert.equal(body.continuation.action, 'blocked');
    assert.match(body.continuation.reason, /multiple|ambiguous/i);
    assert.equal(body.candidates.workspaces.includes(fixture.workspace.workspaceId), true);
    assert.equal(body.candidates.workspaces.includes(duplicate.workspaceId), true);
  });
});

test('task-only recovery blocks when bounded registry truncation prevents uniqueness proof', async () => {
  const fixture = seedUnclaimedTaskWorkspace('task-only-truncated');
  const source = JSON.parse(fs.readFileSync(workspaceRegistryPath(fixture.workspace.workspaceId), 'utf8')) as any;
  for (let index = 0; index < 51; index += 1) {
    const workspaceId = `ws_truncated_${String(index).padStart(3, '0')}`;
    fs.writeFileSync(workspaceRegistryPath(workspaceId), `${JSON.stringify({
      ...source,
      workspaceId,
      taskDisplayId: undefined,
      taskRootLeaf: undefined,
    }, null, 2)}\n`, 'utf8');
  }

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({ taskId: fixture.displayId }));
    assert.equal(response.status, 200);
    assert.equal(body.status, 'blocked');
    assert.equal(body.continuation.action, 'blocked');
    assert.match(body.continuation.reason, /bounded|uniqueness|registry/i);
  });
});

test('explicit task and workspace selectors must agree by exact persisted task identity after claim loss', async () => {
  const fixture = seedUnclaimedTaskWorkspace('task-workspace-selector-left');
  const other = seedUnclaimedTaskWorkspace('task-workspace-selector-right');

  await withServer(async (baseUrl) => {
    const { response, body } = await json(baseUrl, new URLSearchParams({
      taskId: fixture.displayId,
      workspaceId: other.workspace.workspaceId,
    }));
    assert.equal(response.status, 200);
    assert.equal(body.status, 'blocked');
    assert.equal(body.continuation.action, 'blocked');
    assert.match(body.continuation.reason, /exact persisted|identifiers|bind/i);
  });
});
