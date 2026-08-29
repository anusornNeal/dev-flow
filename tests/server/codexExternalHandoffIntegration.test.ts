import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-codex-handoff-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const localProjectRoot = path.join(tempRoot, 'project');
fs.mkdirSync(path.join(localProjectRoot, '.devflow', 'prompt-overrides'), { recursive: true });
fs.writeFileSync(path.join(localProjectRoot, '.devflow', 'agents.md'), 'PROJECT-AGENTS-INJECTION-SENTINEL\n', 'utf8');
fs.writeFileSync(
  path.join(localProjectRoot, '.devflow', 'prompt-overrides', 'prompt.codex-header.md'),
  'PROJECT-PROMPT-OVERRIDE-SENTINEL\n',
  'utf8',
);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { createAgentRun } = await import('../../src/server/repositories/agentRunRepository.js');
const { createExecutionSessionRecord, listExecutionSessionsForTask } = await import('../../src/server/repositories/executionSessionRepository.js');

const project = {
  id: 'project-codex-handoff',
  name: 'Codex Handoff',
  repoUrl: 'https://example.test/codex-handoff.git',
  localPath: localProjectRoot,
  taskIdPrefix: 'CDX',
  createdAt: new Date().toISOString(),
};
createProject(project as any);
const state: any = { countersCache: {}, projectsCache: [project], skillsRegistry: [] };

let sequence = 0;
function seedTask(status = 'backlog', patch: Record<string, any> = {}) {
  sequence += 1;
  const now = new Date().toISOString();
  const id = `codex-handoff-${sequence}`;
  const task = {
    id,
    displayId: `CDX-${String(sequence).padStart(4, '0')}`,
    projectId: project.id,
    title: `Codex handoff ${sequence}`,
    description: '',
    status,
    priority: 'high',
    category: 'backend',
    tags: [],
    targetFiles: [],
    checklist: [],
    verificationEvidence: [],
    logs: [],
    bugs: [],
    images: [],
    designImages: [],
    createdAt: now,
    updatedAt: now,
    ...patch,
  } as any;
  saveTask(task);
  return task;
}

function externalLogs(taskId: string) {
  return (getTask(taskId)?.logs || []).filter((entry: any) => String(entry.id || '').startsWith('external-task-status-op-'));
}

function seedManagedExecution(taskId: string) {
  const now = new Date().toISOString();
  return createExecutionSessionRecord({
    id: `exec-${taskId}`,
    projectId: project.id,
    taskId,
    workspaceId: `ws-${taskId}`,
    branch: `managed-${taskId}`,
    baseRevision: 'managed-base-revision',
    repoRevision: 'managed-repo-revision',
    status: 'active',
    contextHandle: 'MANAGED-CONTEXT-SENTINEL',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    endedAt: null,
  });
}

const app = express();
app.use(express.json({ limit: '1mb' }));
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server did not bind');
const base = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function getPrompt(taskId: string) {
  const response = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/prompt`);
  return { response, text: await response.text() };
}

async function postExternalStatus(taskId: string, body: any) {
  const response = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/external-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = await response.json(); } catch {}
  return { response, body: parsed };
}

test('real Copy Prompt route renders rich card data for autonomous Codex without managed/project injection', async () => {
  const unicodeDescription = `รองรับ Unicode ✅ — autonomous handoff\n${'bounded card context '.repeat(120)}`;
  const rich = seedTask('backlog', {
    title: 'Implement autonomous Codex handoff',
    description: unicodeDescription,
    reasoning: 'Keep repository execution native to Codex.',
    acceptanceCriteria: 'Copy Prompt contains task-authored implementation context only.',
    verification: 'Run focused integration tests and typecheck.',
    targetFiles: ['src/example.ts', 'tests/example.test.ts'],
    checklist: [{ id: 'c1', text: 'Preserve autonomous boundary', completed: false }],
    repoContext: 'Implementation map: src/example.ts owns the repository change.',
    sourceUrl: 'https://example.test/source',
    jiraKey: 'QCA-9999',
    agent: 'Codex',
    model: 'TASK-MODEL-INJECTION-SENTINEL',
    effort: 'TASK-EFFORT-INJECTION-SENTINEL',
  });
  const run = createAgentRun({
    taskId: rich.id,
    projectId: project.id,
    agent: 'Codex',
    model: 'ACTIVE-RUN-MODEL-SENTINEL',
    effort: 'high',
    promptPath: 'ACTIVE-RUN-PROMPT-PATH-SENTINEL',
    contextRef: 'ACTIVE-RUN-CONTEXT-SENTINEL',
  });
  assert.ok(run);

  const result = await getPrompt(rich.displayId);
  assert.equal(result.response.status, 200, result.text);
  assert.match(result.text, /# Codex Autonomous Task Handoff/);
  assert.match(result.text, /Implement autonomous Codex handoff/);
  assert.match(result.text, /รองรับ Unicode ✅/);
  assert.match(result.text, /Copy Prompt contains task-authored implementation context only/);
  assert.match(result.text, /Run focused integration tests and typecheck/);
  assert.match(result.text, /src\/example\.ts/);
  assert.match(result.text, /Preserve autonomous boundary/);
  assert.match(result.text, /Implementation map: src\/example\.ts owns the repository change/);
  assert.match(result.text, /Work autonomously/);
  assert.match(result.text, /best-effort board synchronization/);

  for (const forbidden of [
    'PROJECT-AGENTS-INJECTION-SENTINEL',
    'PROJECT-PROMPT-OVERRIDE-SENTINEL',
    'ACTIVE-RUN-MODEL-SENTINEL',
    'ACTIVE-RUN-PROMPT-PATH-SENTINEL',
    'ACTIVE-RUN-CONTEXT-SENTINEL',
    'TASK-MODEL-INJECTION-SENTINEL',
    'TASK-EFFORT-INJECTION-SENTINEL',
    'managed workspace',
    'ownership epoch',
  ]) {
    assert.equal(result.text.includes(forbidden), false, `copied prompt leaked forbidden execution context: ${forbidden}`);
  }
  assert.equal(getTask(rich.id)?.status, 'backlog', 'copying a prompt must not mutate board status');
  assert.equal(externalLogs(rich.id).length, 0, 'copying a prompt must not call external status synchronization');
});

test('sparse card prompt remains useful without placeholder garbage and missing task fails narrowly', async () => {
  const sparse = seedTask('todo', { title: 'Sparse but usable task' });
  const result = await getPrompt(sparse.id);
  assert.equal(result.response.status, 200, result.text);
  assert.match(result.text, /Sparse but usable task/);
  assert.match(result.text, /Codex Autonomous Task Handoff/);
  assert.doesNotMatch(result.text, /\bundefined\b|\bnull\b|\(none\)/i);

  const missing = await getPrompt('missing-codex-task');
  assert.equal(missing.response.status, 404);
});

test('external status route supports direct completion, reopen, replay, and conflict without execution prerequisites', async () => {
  const task = seedTask('backlog', {
    checklist: [{ id: 'unchecked', text: 'managed-only checklist', completed: false }],
    verificationEvidence: [],
  });

  const done = await postExternalStatus(task.id, {
    status: 'done',
    summary: 'repository work completed by Codex',
    commit: 'abc123',
    verification: 'native tests passed',
    idempotencyKey: 'codex-complete-1',
  });
  assert.equal(done.response.status, 200, JSON.stringify(done.body));
  assert.equal(getTask(task.id)?.status, 'done');
  assert.equal(done.body.externalMetadata.commit, 'abc123');
  assert.equal(done.body.externalMetadata.verification, 'native tests passed');
  assert.deepEqual(getTask(task.id)?.verificationEvidence, [], 'external verification text must stay informational');
  assert.equal(getTask(task.id)?.gitEvidence, undefined, 'external commit text must not become authoritative Git evidence');
  assert.equal(getTask(task.id)?.checklist?.[0]?.completed, false);

  const replay = await postExternalStatus(task.displayId, {
    status: 'done',
    summary: 'repository work completed by Codex',
    commit: 'abc123',
    verification: 'native tests passed',
    idempotencyKey: 'codex-complete-1',
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true);
  assert.equal(externalLogs(task.id).length, 1);

  const conflict = await postExternalStatus(task.id, { status: 'in-progress', idempotencyKey: 'codex-complete-1' });
  assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body?.error?.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(getTask(task.id)?.status, 'done');

  const reopened = await postExternalStatus(task.id, { status: 'in-progress', idempotencyKey: 'codex-reopen-1' });
  assert.equal(reopened.response.status, 200, JSON.stringify(reopened.body));
  assert.equal(getTask(task.id)?.status, 'in-progress');
});

test('status endpoint failure is isolated and wrong-task requests cannot mutate neighboring repository work', async () => {
  const neighbor = seedTask('backlog', { title: 'Neighbor must remain untouched' });
  const before = structuredClone(getTask(neighbor.id));

  const missing = await postExternalStatus('missing-neighbor-id', { status: 'done' });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body?.error?.code, 'TASK_NOT_FOUND');

  const invalid = await postExternalStatus(neighbor.id, { status: 'todo' });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body?.error?.code, 'EXTERNAL_STATUS_INVALID_TARGET');
  assert.deepEqual(getTask(neighbor.id), before);
});

test('managed authority overlap fails closed by default and explicit status-only override preserves authority/evidence', async () => {
  const now = new Date().toISOString();
  const managed = seedTask('in-progress', {
    claim: {
      sessionIdHash: 'managed-session-hash',
      ownershipEpochId: 'managed-epoch',
      workspaceId: 'managed-workspace',
      ownerKind: 'chat',
      ownerLabel: 'Managed Chat',
      claimedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      reservedPaths: ['src/managed.ts'],
    },
    checklist: [{ id: 'managed-check', text: 'managed checklist', completed: false }],
    verificationEvidence: [{ command: 'managed-verify', status: 'passed', recordedAt: now }],
    gitEvidence: {
      branch: 'managed-branch', commit: 'managed-commit', remote: 'origin', ahead: 1, behind: 0,
      diverged: false, pushed: false, workingTreeClean: false, recordedAt: now,
    },
    bugs: [{ id: 'managed-bug', taskId: 'placeholder', title: 'managed bug', status: 'open', source: 'user', severity: 'medium', versions: [], createdAt: now, updatedAt: now }],
  });
  const execution = seedManagedExecution(managed.id);
  assert.ok(execution);
  const beforeTask = structuredClone(getTask(managed.id));
  const beforeExecution = structuredClone(listExecutionSessionsForTask(managed.id));

  const blocked = await postExternalStatus(managed.id, { status: 'done' });
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body?.error?.code, 'EXTERNAL_STATUS_MANAGED_AUTHORITY_CONFLICT');
  assert.deepEqual(getTask(managed.id), beforeTask);
  assert.deepEqual(listExecutionSessionsForTask(managed.id), beforeExecution);

  const override = await postExternalStatus(managed.id, {
    status: 'done',
    summary: 'Codex repository work is done; board update only.',
    commit: 'external-commit-info',
    verification: 'external verification info',
    idempotencyKey: 'managed-overlap-integration',
    allowManagedAuthorityOverlap: true,
  });
  assert.equal(override.response.status, 200, JSON.stringify(override.body));
  assert.equal(override.body.warnings?.[0]?.code, 'MANAGED_AUTHORITY_PRESERVED');

  const afterTask = getTask(managed.id)!;
  assert.equal(afterTask.status, 'done');
  assert.deepEqual(afterTask.claim, beforeTask?.claim);
  assert.deepEqual(afterTask.gitEvidence, beforeTask?.gitEvidence);
  assert.deepEqual(afterTask.verificationEvidence, beforeTask?.verificationEvidence);
  assert.deepEqual(afterTask.checklist, beforeTask?.checklist);
  assert.deepEqual(afterTask.bugs, beforeTask?.bugs);
  assert.deepEqual(listExecutionSessionsForTask(managed.id), beforeExecution);
  assert.equal(externalLogs(managed.id).length, 1);
});

test('agent-neutral orchestration contract keeps workers replaceable without promoting result metadata to managed proof', async () => {
  const repository = await import('../../src/server/repositories/agentRunRepository.js');
  assert.deepEqual(repository.AGENT_NEUTRAL_ORCHESTRATION_ACTIONS, ['IMPLEMENT_TASK', 'RESOLVE_FAILURE', 'RESOLVE_CONFLICT', 'REVIEW_TASK', 'INVESTIGATE']);
  assert.deepEqual(repository.AGENT_NEUTRAL_RESULT_STATES, ['HANDOFF_READY', 'BLOCKED', 'NEEDS_CONTEXT', 'COMPLETE']);
  assert.deepEqual(repository.AGENT_EXECUTION_ADAPTERS, ['devflow-managed', 'worker-native', 'legacy-launcher']);

  const native = repository.createAgentNeutralOrchestrationEnvelope({
    projectId: project.id,
    taskId: 'task-replaceable',
    action: 'IMPLEMENT_TASK',
    adapter: 'worker-native',
    contextRef: 'ctx-durable',
  });
  assert.equal(native.canonicalStateOwner, 'devflow');
  assert.equal(native.repositoryExecutionOwner, 'worker');
  assert.equal(native.disposableWorker, true);
  assert.equal((native as any).prompt, undefined, 'contract must not assume a generic prompt runner');

  const result = repository.createAgentNeutralOrchestrationResult({
    projectId: project.id,
    taskId: 'task-replaceable',
    action: 'IMPLEMENT_TASK',
    state: 'HANDOFF_READY',
    summary: 'worker yielded at a safe boundary',
    runId: 'run-disposable',
  });
  assert.equal(result.evidenceAuthority, 'orchestration-only');
  assert.equal(result.workerReplaceable, true);
  assert.equal((result as any).verificationEvidence, undefined);
  assert.equal((result as any).gitEvidence, undefined);

});

test('authoritative docs keep Codex Copy Prompt autonomous and status synchronization non-blocking', () => {
  const docs = [
    'docs/agent-flow/fresh-session-orchestration.md',
    'docs/agent-flow/final-prompt-pipeline-flow.md',
    'skills/README.md',
    'skills/codex-workflow.md',
  ].map((file) => fs.readFileSync(file, 'utf8')).join('\n');

  assert.match(docs, /Copy for Codex/);
  assert.match(docs, /autonomous/i);
  assert.match(docs, /best-effort/i);
  assert.match(docs, /ChatGPT\/@devflowz/);
  assert.match(docs, /IMPLEMENT_TASK/);
  assert.match(docs, /HANDOFF_READY/);
  assert.match(docs, /worker-native/);
  assert.match(docs, /orchestration-only evidence/i);
  assert.match(docs, /agent\.run\(prompt\)/);
  assert.match(docs, /not.*repository execution layer/i);
  assert.match(docs, /must not.*stop|must not stop|do not.*stop/i);
  assert.doesNotMatch(docs, /current card workflow is manual:[\s\S]{0,500}engine-agnostic/i);
});
