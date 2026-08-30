import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-worker-log-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const {
  appendWorkerDiagnosticLog,
  listWorkerDiagnosticLogs,
  readWorkerDiagnosticLog,
} = await import('../../src/server/services/workerDiagnosticLogService.js');
const { getTaskMutationOwnershipStrategy } = await import('../../src/server/services/executionSessionService.js');
const { getHarnessExecutionEffects } = await import('../../src/server/services/harnessExecutionGuardService.js');

const state: any = {
  projectsCache: [
    { id: 'project-worker-log-1', name: 'Worker Log Fixture', repoUrl: 'https://example.com/worker-log', localPath: tempDir },
  ],
};

test('worker diagnostics append without truncating prior entries', () => {
  appendWorkerDiagnosticLog(state, { projectId: 'project-worker-log-1', workerId: 'worker-c', entry: 'first entry' });
  appendWorkerDiagnosticLog(state, { projectId: 'project-worker-log-1', workerId: 'worker-c', entry: 'second entry' });

  const result = readWorkerDiagnosticLog(state, { projectId: 'project-worker-log-1', workerId: 'worker-c' });
  assert.equal(result.exists, true);
  assert.match(result.content, /first entry/);
  assert.match(result.content, /second entry/);
  assert.ok(result.content.indexOf('first entry') < result.content.indexOf('second entry'));
  assert.equal(fs.readFileSync(path.join(tempDir, '.devflow', 'worker-logs', 'worker-c.md'), 'utf8'), 'first entry\n\nsecond entry\n');
});

test('worker diagnostic reads are bounded and logs are listable', () => {
  appendWorkerDiagnosticLog(state, { projectId: 'project-worker-log-1', workerId: 'worker-b', entry: 'other worker' });
  const read = readWorkerDiagnosticLog(state, { projectId: 'project-worker-log-1', workerId: 'worker-c', maxBytes: 8 });
  assert.equal(read.truncated, true);
  assert.ok(read.returnedBytes <= 12, 'UTF-8 boundary conversion stays close to requested byte tail');

  const listed = listWorkerDiagnosticLogs(state, { projectId: 'project-worker-log-1' });
  assert.equal(listed.total, 2);
  assert.deepEqual(new Set(listed.logs.map((entry: any) => entry.workerId)), new Set(['worker-b', 'worker-c']));
});

test('worker log identity rejects traversal and arbitrary path-shaped ids', () => {
  for (const workerId of ['../escape', 'worker/c', 'C:\\escape', '.hidden']) {
    assert.throws(
      () => appendWorkerDiagnosticLog(state, { projectId: 'project-worker-log-1', workerId, entry: 'nope' }),
      (error: any) => error?.payload?.code === 'WORKER_LOG_INVALID_WORKER_ID',
    );
  }
  assert.equal(fs.existsSync(path.join(tempDir, 'escape.md')), false);
});

test('worker log tools remain outside task mutation ownership and harness mutation classification', () => {
  for (const toolName of ['append_worker_log', 'read_worker_log', 'list_worker_logs']) {
    assert.equal(getTaskMutationOwnershipStrategy(toolName), null);
    assert.deepEqual(getHarnessExecutionEffects(toolName), []);
  }
  assert.equal(getTaskMutationOwnershipStrategy('write_local_file'), 'transactional-owned');
  assert.deepEqual(getHarnessExecutionEffects('write_local_file'), ['mutation']);
});

test.after(() => {
  fs.rmSync(path.join(tempDir, '.devflow'), { recursive: true, force: true });
});
