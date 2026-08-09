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
  waitForToolJob,
  getQueueMetrics,
  getToolJobWaitGuidance,
  __resetQueueWaitTelemetryForTests,
} from '../../src/server/services/mcpToolJobService';
import { readJobLog, readJobResult } from '../../src/server/repositories/mcpToolJobRepository';
import { createProject } from '../../src/server/repositories/projectRepository.js';
import { registerMcpToolJobRoutes } from '../../src/server/routes/mcpToolJobs.js';
import { createApiError } from '../../src/server/services/api.js';

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

test('mcpToolJobService - pending jobs expose bounded completion guidance', async () => {
  const root = makeTempRepo('wait-guidance');
  const state = makeState(root);
  const toolName = `test_guidance_${randomUUID()}`;
  const blocker = deferred();
  __setToolJobTestRunner(toolName, async () => {
    await blocker.promise;
    return { ok: true };
  });

  try {
    const job = enqueueToolJob(state, toolName, { localPath: root }, 'repo-read');
    await waitUntil(() => getToolJobStatus(job.jobId)?.status === 'running', 'Expected guidance job to run');
    const timedWait = await waitForToolJob(job.jobId, 10);
    const guidance = getToolJobWaitGuidance(timedWait);
    assert.equal(timedWait?.status, 'running');
    assert.equal(guidance.ready, false);
    assert.equal(guidance.nextPollAfterMs >= 500, true);
    assert.equal(guidance.recommendedWaitMs, 30_000);
    assert.match(guidance.nextAction, /get_tool_job_result/i);
  } finally {
    blocker.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcp tool result route returns compact pending guidance without job metadata or logs', async () => {
  const root = makeTempRepo('result-route-guidance');
  const state = makeState(root);
  const toolName = `test_route_guidance_${randomUUID()}`;
  const blocker = deferred();
  __setToolJobTestRunner(toolName, async () => {
    await blocker.promise;
    return { ok: true };
  });

  try {
    const job = enqueueToolJob(state, toolName, { localPath: root, secretPayload: 'do-not-repeat' }, 'repo-read');
    await waitUntil(() => getToolJobStatus(job.jobId)?.status === 'running', 'Expected route guidance job to run');
    const handlers = new Map<string, Function>();
    const app = {
      get: (route: string, handler: Function) => handlers.set(`GET ${route}`, handler),
      post: (route: string, handler: Function) => handlers.set(`POST ${route}`, handler),
    } as any;
    registerMcpToolJobRoutes(app, { state, writeAgentLog: () => {} } as any);
    const handler = handlers.get('GET /api/tool-jobs/:jobId/result');
    assert.ok(handler);
    let packet: any;
    await handler!(
      { params: { jobId: job.jobId }, query: { waitMs: '10' } },
      { json: (value: any) => { packet = value; return value; } },
      (error: unknown) => { if (error) throw error; },
    );

    assert.equal(packet.ready, false);
    assert.equal(packet.result, null);
    assert.equal(packet.code, 'JOB_STILL_RUNNING');
    assert.equal(packet.recommendedWaitMs, 30_000);
    assert.match(packet.nextAction, /get_tool_job_result/i);
    assert.equal('args' in packet, false);
    assert.equal('lastLog' in packet, false);
    assert.equal(Buffer.byteLength(JSON.stringify(packet), 'utf8') < 600, true);
  } finally {
    blocker.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - waitForToolJob resolves when terminal state changes without caller polling', async () => {
  const root = process.cwd();
  const state = makeState(root);
  const toolName = `test_wait_${randomUUID()}`;
  const blocker = deferred();
  let starts = 0;
  __setToolJobTestRunner(toolName, async () => {
    starts += 1;
    await blocker.promise;
    return { ok: true, waited: true };
  });

  try {
    const job = enqueueToolJob(state, toolName, { localPath: root, label: 'wait' }, 'repo-read');
    const waiting = waitForToolJob(job.jobId, 1500);
    await waitUntil(() => starts === 1, 'Expected wait test runner to start');
    blocker.resolve();
    const status = await waiting;
    assert.strictEqual(status?.status, 'succeeded');
  } finally {
    blocker.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - identical safe in-flight reads use leader/follower single-flight', async () => {
  const root = process.cwd();
  const state = makeState(root);
  const toolName = `test_singleflight_${randomUUID()}`;
  const blocker = deferred();
  let starts = 0;
  __setToolJobTestRunner(toolName, async () => {
    starts += 1;
    await blocker.promise;
    return { ok: true, shared: 'result' };
  });

  try {
    const args = { localPath: root, query: 'same-query', singleFlight: true };
    const first = enqueueToolJob(state, toolName, args, 'repo-read');
    const second = enqueueToolJob(state, toolName, args, 'repo-read');
    assert.notStrictEqual(first.jobId, second.jobId);
    assert.strictEqual(second.sharedWith, first.jobId);

    await waitUntil(() => starts === 1, 'Expected only the single-flight leader to execute');
    blocker.resolve();
    await waitForStatus(first.jobId, 'succeeded');
    await waitForStatus(second.jobId, 'succeeded');
    assert.strictEqual(starts, 1);
    assert.deepStrictEqual(readJobResult(second.jobId)?.result, { ok: true, shared: 'result' });
  } finally {
    blocker.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - equivalent repo-command verification uses single-flight by default', async () => {
  const root = process.cwd();
  const state = makeState(root);
  const blocker = deferred();
  let starts = 0;
  __setToolJobTestRunner('run_project_command', async () => {
    starts += 1;
    await blocker.promise;
    return { ok: true, shared: 'verification' };
  });

  try {
    const args = { localPath: root, command: 'typecheck' };
    const first = enqueueToolJob(state, 'run_project_command', args, 'repo-command');
    const second = enqueueToolJob(state, 'run_project_command', args, 'repo-command');
    assert.notStrictEqual(first.jobId, second.jobId);
    assert.strictEqual(second.sharedWith, first.jobId);

    await waitUntil(() => starts === 1, 'Expected one repo-command leader execution');
    blocker.resolve();
    await waitForStatus(first.jobId, 'succeeded');
    await waitForStatus(second.jobId, 'succeeded');
    assert.strictEqual(starts, 1);
    assert.deepStrictEqual(readJobResult(second.jobId)?.result, { ok: true, shared: 'verification' });
  } finally {
    blocker.resolve();
    __setToolJobTestRunner('run_project_command', null);
  }
});

test('mcpToolJobService - safe verification runs concurrently with same-repo reads', async () => {
  const root = makeTempRepo('verify-read');
  const state = makeState(root);
  const readTool = `test_verify_read_${randomUUID()}`;
  const starts: string[] = [];
  const verifyBlocker = deferred();
  const readBlocker = deferred();

  __setToolJobTestRunner('run_project_command', async () => {
    starts.push('verify');
    await verifyBlocker.promise;
    return { ok: true, label: 'verify' };
  });
  __setToolJobTestRunner(readTool, async () => {
    starts.push('read');
    await readBlocker.promise;
    return { ok: true, label: 'read' };
  });

  try {
    const verify = enqueueToolJob(state, 'run_project_command', { localPath: root, command: 'typecheck', forceFresh: true }, 'repo-command');
    await waitUntil(() => starts.includes('verify'), 'Expected verification to start');
    const read = enqueueToolJob(state, readTool, { localPath: root, label: 'read', singleFlight: false }, 'repo-read');

    await waitUntil(() => starts.includes('read'), 'Expected same-repo read to start while verification is running');
    assert.strictEqual(getToolJobStatus(verify.jobId)?.status, 'running');
    assert.strictEqual(getToolJobStatus(verify.jobId)?.accessMode, 'verify');
    assert.strictEqual(getToolJobStatus(read.jobId)?.status, 'running');

    readBlocker.resolve();
    verifyBlocker.resolve();
    await waitForStatus(read.jobId, 'succeeded');
    await waitForStatus(verify.jobId, 'succeeded');
  } finally {
    readBlocker.resolve();
    verifyBlocker.resolve();
    __setToolJobTestRunner(readTool, null);
    __setToolJobTestRunner('run_project_command', null);
  }
});

test('mcpToolJobService - verification pool allows two jobs and queues the third', async () => {
  const root = makeTempRepo('verify-pool');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: {
    typecheck: 'node -e "0"',
    lint: 'node -e "1"',
    test: 'node -e "2"',
  } }));
  const state = makeState(root);
  const starts: string[] = [];
  const blockers = { typecheck: deferred(), lint: deferred(), test: deferred() };

  __setToolJobTestRunner('run_project_command', async (_state, args) => {
    const command = args.command as keyof typeof blockers;
    starts.push(command);
    await blockers[command].promise;
    return { ok: true, command };
  });

  try {
    const first = enqueueToolJob(state, 'run_project_command', { localPath: root, command: 'typecheck', forceFresh: true }, 'repo-command');
    const second = enqueueToolJob(state, 'run_project_command', { localPath: root, command: 'lint', forceFresh: true }, 'repo-command');
    const third = enqueueToolJob(state, 'run_project_command', { localPath: root, command: 'test', forceFresh: true }, 'repo-command');

    await waitUntil(() => starts.includes('typecheck') && starts.includes('lint'), 'Expected two verification jobs to start');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.strictEqual(starts.includes('test'), false);
    assert.strictEqual(getToolJobStatus(third.jobId)?.status, 'queued');
    assert.strictEqual(getToolJobStatus(third.jobId)?.costClass, 'verify');

    blockers.typecheck.resolve();
    await waitForStatus(first.jobId, 'succeeded');
    await waitUntil(() => starts.includes('test'), 'Expected third verification to start after one slot frees');

    blockers.lint.resolve();
    blockers.test.resolve();
    await waitForStatus(second.jobId, 'succeeded');
    await waitForStatus(third.jobId, 'succeeded');
  } finally {
    blockers.typecheck.resolve();
    blockers.lint.resolve();
    blockers.test.resolve();
    __setToolJobTestRunner('run_project_command', null);
  }
});

test('mcpToolJobService - queued writer is a barrier for newer reads and reports blocker metadata', async () => {
  const root = makeTempRepo('writer-barrier');
  const state = makeState(root);
  const toolName = `test_writer_barrier_${randomUUID()}`;
  const starts: string[] = [];
  const blockers = { read1: deferred(), write: deferred(), read2: deferred() };
  installControlledRunner(toolName, starts, blockers);

  try {
    const read1 = enqueueToolJob(state, toolName, { localPath: root, label: 'read1', singleFlight: false }, 'repo-read');
    await waitUntil(() => starts.includes('read1'), 'Expected first read to start');
    const write = enqueueToolJob(state, toolName, { localPath: root, label: 'write' }, 'repo-write');
    const read2 = enqueueToolJob(state, toolName, { localPath: root, label: 'read2', singleFlight: false }, 'repo-read');

    await new Promise(resolve => setTimeout(resolve, 75));
    assert.deepStrictEqual(starts, ['read1']);
    const queuedRead = getToolJobStatus(read2.jobId);
    assert.strictEqual(queuedRead?.status, 'queued');
    assert.strictEqual(queuedRead?.accessMode, 'read');
    assert.strictEqual(queuedRead?.costClass, 'light-read');
    assert.strictEqual(queuedRead?.blockedByJobId, write.jobId);
    assert.strictEqual(queuedRead?.blockedByAccessMode, 'write');
    assert.strictEqual(queuedRead?.blockReason, 'writer_barrier');
    assert.equal(typeof queuedRead?.queueAgeMs, 'number');

    const metrics = getQueueMetrics();
    const queuedMetric = metrics.queue.find((entry: any) => entry.jobId === read2.jobId);
    assert.strictEqual(queuedMetric?.blockedByJobId, write.jobId);

    blockers.read1.resolve();
    await waitForStatus(read1.jobId, 'succeeded');
    await waitUntil(() => starts.includes('write'), 'Expected writer to start after earlier read finishes');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(starts.includes('read2'), false);

    blockers.write.resolve();
    await waitForStatus(write.jobId, 'succeeded');
    await waitUntil(() => starts.includes('read2'), 'Expected newer read to start after writer completes');
    blockers.read2.resolve();
    await waitForStatus(read2.jobId, 'succeeded');
  } finally {
    blockers.read1.resolve();
    blockers.write.resolve();
    blockers.read2.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - saturated search pool does not head-of-line block a light read', async () => {
  const root = makeTempRepo('cost-pools');
  const state = makeState(root);
  const lightTool = `test_light_read_${randomUUID()}`;
  const starts: string[] = [];
  const searchBlockers: Record<string, Deferred> = {
    search1: deferred(), search2: deferred(), search3: deferred(), search4: deferred(), search5: deferred(),
  };
  const lightBlocker = deferred();

  __setToolJobTestRunner('search_local_files', async (_state, args) => {
    starts.push(args.label);
    await searchBlockers[args.label].promise;
    return { ok: true, label: args.label };
  });
  __setToolJobTestRunner(lightTool, async () => {
    starts.push('light');
    await lightBlocker.promise;
    return { ok: true, label: 'light' };
  });

  try {
    const activeSearches = ['search1', 'search2', 'search3', 'search4'].map((label) =>
      enqueueToolJob(state, 'search_local_files', { localPath: root, query: label, label, singleFlight: false }, 'repo-read'));
    await waitUntil(() => ['search1', 'search2', 'search3', 'search4'].every(label => starts.includes(label)), 'Expected four search jobs to fill the search pool');

    const blockedSearch = enqueueToolJob(state, 'search_local_files', { localPath: root, query: 'search5', label: 'search5', singleFlight: false }, 'repo-read');
    const light = enqueueToolJob(state, lightTool, { localPath: root, label: 'light', singleFlight: false }, 'repo-read');

    await waitUntil(() => starts.includes('light'), 'Expected light read to bypass a saturated search cost pool');
    assert.strictEqual(getToolJobStatus(blockedSearch.jobId)?.status, 'queued');
    assert.strictEqual(getToolJobStatus(blockedSearch.jobId)?.blockReason, 'cost_pool_saturated');
    assert.strictEqual(getToolJobStatus(light.jobId)?.status, 'running');

    lightBlocker.resolve();
    searchBlockers.search1.resolve();
    await waitForStatus(light.jobId, 'succeeded');
    await waitUntil(() => starts.includes('search5'), 'Expected fifth search to start after a search slot frees');

    for (const blocker of Object.values(searchBlockers)) blocker.resolve();
    await Promise.all(activeSearches.map(job => waitForStatus(job.jobId, 'succeeded')));
    await waitForStatus(blockedSearch.jobId, 'succeeded');
  } finally {
    lightBlocker.resolve();
    for (const blocker of Object.values(searchBlockers)) blocker.resolve();
    __setToolJobTestRunner('search_local_files', null);
    __setToolJobTestRunner(lightTool, null);
  }
});

test('mcpToolJobService - write job atomically downgrades to verify and unblocks reads but not writers', async () => {
  const root = makeTempRepo('write-verify-downgrade');
  const state = makeState(root);
  const toolName = `test_downgrade_${randomUUID()}`;
  const starts: string[] = [];
  const downgradeGate = deferred();
  const primaryDone = deferred();
  const readDone = deferred();
  const writerDone = deferred();

  __setToolJobTestRunner(toolName, async (_state, args, _logger, _setCancelFn, transitionAccess: any) => {
    starts.push(args.label);
    if (args.label === 'primary') {
      await downgradeGate.promise;
      transitionAccess('verify');
      starts.push('downgraded');
      await primaryDone.promise;
    } else if (args.label === 'read') {
      await readDone.promise;
    } else if (args.label === 'writer') {
      await writerDone.promise;
    }
    return { ok: true, label: args.label };
  });

  try {
    const primary = enqueueToolJob(state, toolName, { localPath: root, label: 'primary' }, 'repo-command');
    await waitUntil(() => starts.includes('primary'), 'Expected primary write phase to start');
    assert.strictEqual(getToolJobStatus(primary.jobId)?.accessMode, 'write');

    const read = enqueueToolJob(state, toolName, { localPath: root, label: 'read', singleFlight: false }, 'repo-read');
    const writer = enqueueToolJob(state, toolName, { localPath: root, label: 'writer' }, 'repo-write');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.strictEqual(getToolJobStatus(read.jobId)?.status, 'queued');
    assert.strictEqual(getToolJobStatus(writer.jobId)?.status, 'queued');

    downgradeGate.resolve();
    await waitUntil(() => starts.includes('downgraded') && starts.includes('read'), 'Expected downgrade to let the earlier read start');
    assert.strictEqual(getToolJobStatus(primary.jobId)?.accessMode, 'verify');
    assert.strictEqual(getToolJobStatus(read.jobId)?.status, 'running');
    assert.strictEqual(getToolJobStatus(writer.jobId)?.status, 'queued');

    primaryDone.resolve();
    await waitForStatus(primary.jobId, 'succeeded');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(getToolJobStatus(writer.jobId)?.status, 'queued', 'writer must still wait for the active read');

    readDone.resolve();
    await waitForStatus(read.jobId, 'succeeded');
    await waitUntil(() => starts.includes('writer'), 'Expected writer to start only after verify/read activity finishes');
    writerDone.resolve();
    await waitForStatus(writer.jobId, 'succeeded');
  } finally {
    downgradeGate.resolve();
    primaryDone.resolve();
    readDone.resolve();
    writerDone.resolve();
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

test('mcpToolJobService - pending jobs expose wait-result recovery instead of duplicate retry guidance', async () => {
  const root = makeTempRepo('recovery-pending');
  const state = makeState(root);
  const toolName = `test_recovery_pending_${randomUUID()}`;
  const gate = deferred();
  __setToolJobTestRunner(toolName, async () => {
    await gate.promise;
    return { ok: true };
  });

  try {
    const job = enqueueToolJob(state, toolName, { localPath: root }, 'repo-read');
    await waitUntil(() => getToolJobStatus(job.jobId)?.status === 'running', 'Expected recovery job to start');
    const status: any = getToolJobStatus(job.jobId);
    assert.strictEqual(status.recovery?.category, 'automatic');
    assert.strictEqual(status.recovery?.strategy, 'wait-result');
    assert.strictEqual(status.recovery?.retrySamePayload, false);
    assert.match(status.nextAction, /Wait for the running job result/i);
    gate.resolve();
    await waitForStatus(job.jobId, 'succeeded');
  } finally {
    gate.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - phase telemetry separates queue blockers from execution without overlap', async () => {
  const root = makeTempRepo('phase-telemetry');
  const state = makeState(root);
  const toolName = `test_phase_telemetry_${randomUUID()}`;
  const starts: string[] = [];
  const blockers = { first: deferred(), second: deferred() };
  installControlledRunner(toolName, starts, blockers);
  __resetQueueWaitTelemetryForTests();

  try {
    const first = enqueueToolJob(state, toolName, { localPath: root, label: 'first', singleFlight: false }, 'repo-write');
    await waitUntil(() => starts.includes('first'), 'Expected first job to start');
    const second = enqueueToolJob(state, toolName, { localPath: root, label: 'second', singleFlight: false }, 'repo-write');
    await new Promise(resolve => setTimeout(resolve, 60));

    const queued: any = getToolJobStatus(second.jobId);
    assert.equal(queued.status, 'queued');
    assert.equal(typeof queued.phaseTimings.admissionWaitMs, 'number');
    assert.equal(queued.phaseTimings.queueWaitMs > 0, true);
    assert.equal(queued.phaseTimings.workspaceLockWaitMs > 0, true);
    assert.equal(queued.phaseTimings.capacityWaitMs, 0);
    assert.equal(queued.phaseTimings.executionMs, 0);
    assert.equal(queued.phaseTimings.responseHandoffMs, 0);
    assert.equal(
      queued.phaseTimings.workspaceLockWaitMs + queued.phaseTimings.capacityWaitMs <= queued.phaseTimings.queueWaitMs,
      true,
      'queue blocker phases must not double-count queue wall time',
    );

    blockers.first.resolve();
    await waitForStatus(first.jobId, 'succeeded');
    await waitUntil(() => starts.includes('second'), 'Expected second job to start');
    await new Promise(resolve => setTimeout(resolve, 25));
    const running: any = getToolJobStatus(second.jobId);
    assert.equal(running.phaseTimings.executionMs > 0, true);

    blockers.second.resolve();
    const terminal: any = await waitForStatus(second.jobId, 'succeeded');
    assert.equal(terminal.phaseTimings.queueWaitMs >= terminal.phaseTimings.workspaceLockWaitMs, true);
    assert.equal(terminal.phaseTimings.executionMs > 0, true);
    assert.equal(typeof terminal.phaseTimings.responseHandoffMs, 'number');

    const metrics: any = getQueueMetrics();
    assert.equal(metrics.metrics.phaseTelemetry.queueWait.count >= 1, true);
    assert.equal(metrics.metrics.phaseTelemetry.workspaceLockWait.p95Ms > 0, true);
    assert.equal(metrics.metrics.phaseTelemetry.execution.p95Ms > 0, true);
    assert.doesNotMatch(JSON.stringify(metrics.metrics.phaseTelemetry), /phase-telemetry|localPath|Users|\\\\/);
  } finally {
    blockers.first.resolve();
    blockers.second.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - failed jobs expose decision-required recovery from persisted error code', async () => {
  const root = makeTempRepo('recovery-failed');
  const state = makeState(root);
  const toolName = `test_recovery_failed_${randomUUID()}`;
  __setToolJobTestRunner(toolName, async () => {
    throw createApiError(409, 'AMBIGUOUS_MATCH', 'multiple anchors');
  });

  try {
    const job = enqueueToolJob(state, toolName, { localPath: root }, 'repo-write');
    const status: any = await waitForStatus(job.jobId, 'failed');
    assert.strictEqual(status.recovery?.category, 'decision-required');
    assert.strictEqual(status.recovery?.strategy, 'request-decision');
    assert.strictEqual(status.recovery?.autoApply, false);
    assert.match(status.nextAction, /require an explicit target decision/i);
  } finally {
    __setToolJobTestRunner(toolName, null);
  }
});
