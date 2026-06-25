import { executeAllMigrations } from '../../src/db/migrations/index.js';
executeAllMigrations();
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  __setToolJobTestRunner,
  enqueueToolJob,
  getToolJobStatus,
  cancelToolJob,
} from '../../src/server/services/mcpToolJobService';
import { readJobLog, readJobResult } from '../../src/server/repositories/mcpToolJobRepository';
import { createProject } from '../../src/server/repositories/projectRepository.js';

try { createProject({ id: 'proj_1', name: 'dev-flow', localPath: process.cwd() }); } catch(e) {}
const MOCK_STATE: any = {
  projects: [{ id: 'proj_1', name: 'dev-flow', localPath: process.cwd() }],
};

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTempRepo(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `devflow-${name}-`));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "0"' } }));
  return root;
}

function makeState(...roots: string[]) {
  return {
    projects: roots.map((root, index) => ({
      id: `proj_${index}_${randomUUID()}`,
      name: `repo_${index}`,
      localPath: root,
    })),
  } as any;
}

async function waitUntil(predicate: () => boolean, message: string, retries = 80) {
  for (let i = 0; i < retries; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function waitForStatus(jobId: string, terminalStatus: string) {
  await waitUntil(() => getToolJobStatus(jobId)?.status === terminalStatus, `Expected ${jobId} to become ${terminalStatus}`);
  return getToolJobStatus(jobId);
}

function installControlledRunner(toolName: string, starts: string[], blockers: Record<string, Deferred>) {
  __setToolJobTestRunner(toolName, async (_state, args) => {
    starts.push(args.label);
    await blockers[args.label].promise;
    return { label: args.label };
  });
}

test('mcpToolJobService - enqueue and cancel', async () => {
  const jobInfo = enqueueToolJob(MOCK_STATE, 'search_local_files', { query: 'test' }, 'repo-read');
  
  assert.ok(jobInfo.jobId);
  assert.strictEqual(jobInfo.status, 'queued');

  const cancelled = cancelToolJob(jobInfo.jobId);
  assert.strictEqual(cancelled, true);

  const status = getToolJobStatus(jobInfo.jobId);
  assert.strictEqual(status?.status, 'cancelled');
});

test('mcpToolJobService - job execution and result', async () => {
  const jobInfo = enqueueToolJob(MOCK_STATE, 'search_local_files', { query: 'mcpToolJobService' }, 'repo-read');
  
  // Wait for job to finish
  let status = getToolJobStatus(jobInfo.jobId);
  let retries = 0;
  while (status && (status.status === 'queued' || status.status === 'running') && retries < 40) {
    await new Promise(r => setTimeout(r, 100));
    status = getToolJobStatus(jobInfo.jobId);
    retries++;
  }

  assert.strictEqual(status?.status, 'succeeded');
  
  const result = readJobResult(jobInfo.jobId);
  assert.ok(result);
  assert.ok(result.result.count >= 0);
});

test('mcpToolJobService - completed job has persisted result', async () => {
  const root = makeTempRepo('completed-result');
  const state = makeState(root);
  const toolName = `test_completed_result_${randomUUID()}`;
  const payload = { ok: true, label: 'done' };

  __setToolJobTestRunner(toolName, async () => payload);

  try {
    const jobInfo = enqueueToolJob(state, toolName, { localPath: root, label: 'done' }, 'repo-command');
    await waitForStatus(jobInfo.jobId, 'succeeded');

    const result = readJobResult(jobInfo.jobId);
    assert.ok(result, 'completed jobs should have a result payload');
    assert.deepStrictEqual(result.result, payload);
  } finally {
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - log tailing', async () => {
  const jobInfo = enqueueToolJob(MOCK_STATE, 'search_local_files', { query: 'mcpToolJobService' }, 'repo-read');
  
  let status = getToolJobStatus(jobInfo.jobId);
  let retries = 0;
  while (status && (status.status === 'queued' || status.status === 'running') && retries < 40) {
    await new Promise(r => setTimeout(r, 100));
    status = getToolJobStatus(jobInfo.jobId);
    retries++;
  }

  const logs = readJobLog(jobInfo.jobId, 'stdout');
  // rg doesn't output to stdout unless matches are found or we're streaming the json, but we just check logs doesn't crash
  assert.strictEqual(typeof logs.log, 'string');
});

test('mcpToolJobService - repo-read jobs for one repo can run concurrently', async () => {
  const root = makeTempRepo('read-read');
  const state = makeState(root);
  const toolName = `test_read_${randomUUID()}`;
  const starts: string[] = [];
  const blockers = { read1: deferred(), read2: deferred() };
  installControlledRunner(toolName, starts, blockers);

  try {
    const first = enqueueToolJob(state, toolName, { localPath: root, label: 'read1' }, 'repo-read');
    const second = enqueueToolJob(state, toolName, { localPath: root, label: 'read2' }, 'repo-read');

    await waitUntil(() => starts.includes('read1') && starts.includes('read2'), 'Expected both repo-read jobs to start concurrently');
    assert.strictEqual(getToolJobStatus(first.jobId)?.status, 'running');
    assert.strictEqual(getToolJobStatus(second.jobId)?.status, 'running');

    blockers.read1.resolve();
    blockers.read2.resolve();
    await waitForStatus(first.jobId, 'succeeded');
    await waitForStatus(second.jobId, 'succeeded');
  } finally {
    blockers.read1.resolve();
    blockers.read2.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - repo-write waits while a same-repo read is active', async () => {
  const root = makeTempRepo('read-write');
  const state = makeState(root);
  const toolName = `test_rw_${randomUUID()}`;
  const starts: string[] = [];
  const blockers = { read: deferred(), write: deferred() };
  installControlledRunner(toolName, starts, blockers);

  try {
    const read = enqueueToolJob(state, toolName, { localPath: root, label: 'read' }, 'repo-read');
    const write = enqueueToolJob(state, toolName, { localPath: root, label: 'write' }, 'repo-write');

    await waitUntil(() => starts.includes('read'), 'Expected read job to start');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.deepStrictEqual(starts, ['read']);
    assert.strictEqual(getToolJobStatus(write.jobId)?.status, 'queued');

    blockers.read.resolve();
    await waitForStatus(read.jobId, 'succeeded');
    await waitUntil(() => starts.includes('write'), 'Expected write job to start after read finished');
    assert.strictEqual(getToolJobStatus(write.jobId)?.status, 'running');

    blockers.write.resolve();
    await waitForStatus(write.jobId, 'succeeded');
  } finally {
    blockers.read.resolve();
    blockers.write.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - repo-read waits while a same-repo write is active', async () => {
  const root = makeTempRepo('write-read');
  const state = makeState(root);
  const toolName = `test_wr_${randomUUID()}`;
  const starts: string[] = [];
  const blockers = { write: deferred(), read: deferred() };
  installControlledRunner(toolName, starts, blockers);

  try {
    const write = enqueueToolJob(state, toolName, { localPath: root, label: 'write' }, 'repo-write');
    const read = enqueueToolJob(state, toolName, { localPath: root, label: 'read' }, 'repo-read');

    await waitUntil(() => starts.includes('write'), 'Expected write job to start');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.deepStrictEqual(starts, ['write']);
    assert.strictEqual(getToolJobStatus(read.jobId)?.status, 'queued');

    blockers.write.resolve();
    await waitForStatus(write.jobId, 'succeeded');
    await waitUntil(() => starts.includes('read'), 'Expected read job to start after write finished');
    assert.strictEqual(getToolJobStatus(read.jobId)?.status, 'running');

    blockers.read.resolve();
    await waitForStatus(read.jobId, 'succeeded');
  } finally {
    blockers.write.resolve();
    blockers.read.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - write jobs for different repos do not block each other', async () => {
  const firstRoot = makeTempRepo('repo-a');
  const secondRoot = makeTempRepo('repo-b');
  const state = makeState(firstRoot, secondRoot);
  const toolName = `test_different_repo_${randomUUID()}`;
  const starts: string[] = [];
  const blockers = { write1: deferred(), write2: deferred() };
  installControlledRunner(toolName, starts, blockers);

  try {
    const first = enqueueToolJob(state, toolName, { localPath: firstRoot, label: 'write1' }, 'repo-write');
    const second = enqueueToolJob(state, toolName, { localPath: secondRoot, label: 'write2' }, 'repo-write');

    await waitUntil(() => starts.includes('write1') && starts.includes('write2'), 'Expected different-repo writes to start concurrently');
    assert.strictEqual(getToolJobStatus(first.jobId)?.status, 'running');
    assert.strictEqual(getToolJobStatus(second.jobId)?.status, 'running');

    blockers.write1.resolve();
    blockers.write2.resolve();
    await waitForStatus(first.jobId, 'succeeded');
    await waitForStatus(second.jobId, 'succeeded');
  } finally {
    blockers.write1.resolve();
    blockers.write2.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - stress read/write/command queue ordering on one repo', async () => {
  const root = makeTempRepo('stress-same-repo');
  const state = makeState(root);
  const toolName = `test_stress_${randomUUID()}`;
  const starts: string[] = [];
  const blockers = {
    read1: deferred(),
    read2: deferred(),
    write: deferred(),
    command: deferred(),
  };
  installControlledRunner(toolName, starts, blockers);

  try {
    const read1 = enqueueToolJob(state, toolName, { localPath: root, label: 'read1' }, 'repo-read');
    const read2 = enqueueToolJob(state, toolName, { localPath: root, label: 'read2' }, 'repo-read');
    const write = enqueueToolJob(state, toolName, { localPath: root, label: 'write' }, 'repo-write');
    const command = enqueueToolJob(state, toolName, { localPath: root, label: 'command' }, 'repo-command');

    await waitUntil(() => starts.includes('read1') && starts.includes('read2'), 'Expected both read jobs to start');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.deepStrictEqual(starts, ['read1', 'read2']);
    assert.strictEqual(getToolJobStatus(read1.jobId)?.status, 'running');
    assert.strictEqual(getToolJobStatus(read2.jobId)?.status, 'running');
    assert.strictEqual(getToolJobStatus(write.jobId)?.status, 'queued');
    assert.strictEqual(getToolJobStatus(command.jobId)?.status, 'queued');

    blockers.read1.resolve();
    blockers.read2.resolve();
    await waitForStatus(read1.jobId, 'succeeded');
    await waitForStatus(read2.jobId, 'succeeded');
    await waitUntil(() => starts.includes('write'), 'Expected write job to start after both reads finished');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.deepStrictEqual(starts, ['read1', 'read2', 'write']);
    assert.strictEqual(getToolJobStatus(write.jobId)?.status, 'running');
    assert.strictEqual(getToolJobStatus(command.jobId)?.status, 'queued');

    blockers.write.resolve();
    await waitForStatus(write.jobId, 'succeeded');
    await waitUntil(() => starts.includes('command'), 'Expected command job to start after write finished');
    assert.deepStrictEqual(starts, ['read1', 'read2', 'write', 'command']);
    assert.strictEqual(getToolJobStatus(command.jobId)?.status, 'running');

    blockers.command.resolve();
    await waitForStatus(command.jobId, 'succeeded');
  } finally {
    blockers.read1.resolve();
    blockers.read2.resolve();
    blockers.write.resolve();
    blockers.command.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});
