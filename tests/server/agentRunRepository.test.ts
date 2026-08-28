import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-agent-run-repository-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const db = (await import('../../src/db/index.js')).default;
const repository = await import('../../src/server/repositories/agentRunRepository.js');

function createRun(patch: Record<string, unknown> = {}) {
  return repository.createAgentRun({
    taskId: 'task-agent-run-repository',
    projectId: 'project-agent-run-repository',
    agent: 'Codex',
    model: 'GPT-5.6 Sol',
    effort: 'medium',
    promptPath: 'prompt.md',
    contextRef: 'context-ref',
    logPath: 'agent.log',
    retryOfRunId: 'prior-run',
    triggerSource: 'test',
    ...patch,
  });
}

test('valid persisted agent run round-trips through explicit normalization', () => {
  const created = createRun();
  const read = repository.getAgentRun(created.id);

  assert.deepEqual(read, created);
  assert.deepEqual(repository.listAgentRunsForTask(created.taskId), [created]);
  assert.deepEqual(repository.listActiveRunsForProject(created.projectId), [created]);
});

test('nullable persisted fields normalize undefined/SQL null shapes to null', () => {
  const created = createRun({
    model: null,
    effort: null,
    promptPath: null,
    contextRef: null,
    logPath: null,
    retryOfRunId: null,
    triggerSource: null,
  });

  const read = repository.getAgentRun(created.id)!;
  assert.equal(read.model, null);
  assert.equal(read.effort, null);
  assert.equal(read.startedAt, null);
  assert.equal(read.endedAt, null);
  assert.equal(read.promptPath, null);
  assert.equal(read.contextRef, null);
  assert.equal(read.logPath, null);
  assert.equal(read.errorMessage, null);
  assert.equal(read.retryOfRunId, null);
  assert.equal(read.triggerSource, null);
});

test('invalid persisted status fails closed at the repository boundary', () => {
  const created = createRun();
  db.prepare('UPDATE agent_runs SET status = ? WHERE id = ?').run('mystery-state', created.id);

  assert.throws(
    () => repository.getAgentRun(created.id),
    /INVALID_AGENT_RUN_STATUS:mystery-state/,
  );
  assert.throws(
    () => repository.listAgentRunsForTask(created.taskId),
    /INVALID_AGENT_RUN_STATUS:mystery-state/,
  );
});

test('status transitions retain existing policy after normalization', () => {
  const created = createRun();
  const running = repository.updateAgentRunStatus(created.id, 'running', { startedAt: '2026-08-29T00:00:00.000Z' })!;
  assert.equal(running.status, 'running');
  assert.equal(running.startedAt, '2026-08-29T00:00:00.000Z');

  const succeeded = repository.updateAgentRunStatus(created.id, 'succeeded', { endedAt: '2026-08-29T00:01:00.000Z' })!;
  assert.equal(succeeded.status, 'succeeded');

  const rejected = repository.updateAgentRunStatus(created.id, 'running');
  assert.equal(rejected?.status, 'succeeded');
});
