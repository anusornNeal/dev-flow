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

let seq = 0;
function insertLegacyRun(patch: Record<string, unknown> = {}) {
  seq += 1;
  const run = {
    id: `legacy-run-${seq}`,
    taskId: 'task-agent-run-repository',
    projectId: 'project-agent-run-repository',
    agent: 'Codex',
    model: 'GPT-5.6 Sol',
    effort: 'medium',
    status: 'succeeded',
    createdAt: `2026-08-29T00:00:0${seq}.000Z`,
    startedAt: null,
    endedAt: null,
    promptPath: 'prompt.md',
    contextRef: 'context-ref',
    logPath: 'agent.log',
    errorMessage: null,
    retryOfRunId: 'prior-run',
    triggerSource: 'legacy-fixture',
    ...patch,
  } as any;
  db.prepare(`INSERT INTO agent_runs (id, taskId, projectId, agent, model, effort, status, createdAt, startedAt, endedAt, promptPath, contextRef, logPath, errorMessage, retryOfRunId, triggerSource) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(run.id, run.taskId, run.projectId, run.agent, run.model, run.effort, run.status, run.createdAt, run.startedAt, run.endedAt, run.promptPath, run.contextRef, run.logPath, run.errorMessage, run.retryOfRunId, run.triggerSource);
  return run;
}

test('legacy agent run rows remain readable as cold history', () => {
  const created = insertLegacyRun();
  const read = repository.getAgentRun(created.id)!;
  assert.equal(read.id, created.id);
  assert.equal(read.status, 'succeeded');
  assert.equal(repository.listAgentRunsForTask(created.taskId)[0]?.id, created.id);
  assert.equal(repository.getLatestAgentRunForTask(created.taskId)?.id, created.id);
});

test('nullable persisted fields normalize SQL null shapes to null', () => {
  const created = insertLegacyRun({ model: null, effort: null, promptPath: null, contextRef: null, logPath: null, retryOfRunId: null, triggerSource: null });
  const read = repository.getAgentRun(created.id)!;
  assert.equal(read.model, null);
  assert.equal(read.promptPath, null);
  assert.equal(read.contextRef, null);
  assert.equal(read.logPath, null);
});

test('invalid persisted legacy status fails closed at read boundary', () => {
  const created = insertLegacyRun();
  db.prepare('UPDATE agent_runs SET status = ? WHERE id = ?').run('mystery-state', created.id);
  assert.throws(() => repository.getAgentRun(created.id), /INVALID_AGENT_RUN_STATUS:mystery-state/);
});
