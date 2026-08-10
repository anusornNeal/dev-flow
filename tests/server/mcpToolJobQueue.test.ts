import { after, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const TEST_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-mcp-job-queue-'));
const TEST_DB_PATH = path.join(TEST_STATE_ROOT, 'devflow.sqlite');
const TEST_JOBS_DIR = path.join(TEST_STATE_ROOT, 'jobs');
const TEST_RUNTIME_DIR = path.join(TEST_STATE_ROOT, 'runtime');
const previousTestStateEnv = {
  dbPath: process.env.DEVFLOW_DB_PATH,
  jobsDir: process.env.DEVFLOW_JOBS_DIR,
  runtimeDir: process.env.DEVFLOW_RUNTIME_DIR,
};

process.env.DEVFLOW_DB_PATH = TEST_DB_PATH;
process.env.DEVFLOW_JOBS_DIR = TEST_JOBS_DIR;
process.env.DEVFLOW_RUNTIME_DIR = TEST_RUNTIME_DIR;

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
const { default: db } = await import('../../src/db/index.js');
executeAllMigrations();
const {
  __setToolJobTestRunner,
  enqueueToolJob,
  getToolJobStatus,
  cancelToolJob,
  waitForToolJob,
  getQueueMetrics,
  getToolJobWaitGuidance,
  __resetQueueWaitTelemetryForTests,
} = await import('../../src/server/services/mcpToolJobService');
const { heartbeatJob, readJobLog, readJobResult } = await import('../../src/server/repositories/mcpToolJobRepository');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { registerMcpToolJobRoutes } = await import('../../src/server/routes/mcpToolJobs.js');
const { createApiError } = await import('../../src/server/services/api.js');
const {
  getSchedulerCapacitySnapshot,
  resetSchedulerResourceStateForTests,
  setGlobalVerifyCapacityForTests,
} = await import('../../src/server/services/mcpToolJobScheduler.js');

function restoreTestEnv(name: 'DEVFLOW_DB_PATH' | 'DEVFLOW_JOBS_DIR' | 'DEVFLOW_RUNTIME_DIR', value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

after(() => {
  try { db.close(); } catch { /* best-effort isolated test cleanup */ }
  fs.rmSync(TEST_STATE_ROOT, { recursive: true, force: true });
  restoreTestEnv('DEVFLOW_DB_PATH', previousTestStateEnv.dbPath);
  restoreTestEnv('DEVFLOW_JOBS_DIR', previousTestStateEnv.jobsDir);
  restoreTestEnv('DEVFLOW_RUNTIME_DIR', previousTestStateEnv.runtimeDir);
});

try { createProject({ id: 'proj_1', name: 'dev-flow', localPath: process.cwd() }); } catch(e) {}
const MOCK_STATE: any = {
  projects: [{ id: 'proj_1', name: 'dev-flow', localPath: process.cwd() }],
};

test('mcpToolJobQueue - isolates database and runtime state before repository mutations', () => {
  assert.strictEqual(process.env.DEVFLOW_DB_PATH, TEST_DB_PATH);
  assert.strictEqual(process.env.DEVFLOW_JOBS_DIR, TEST_JOBS_DIR);
  assert.strictEqual(process.env.DEVFLOW_RUNTIME_DIR, TEST_RUNTIME_DIR);
  assert.ok(fs.existsSync(TEST_DB_PATH));
  assert.ok(path.resolve(TEST_DB_PATH).startsWith(path.resolve(TEST_STATE_ROOT)));
  assert.ok(path.resolve(TEST_JOBS_DIR).startsWith(path.resolve(TEST_STATE_ROOT)));
  assert.ok(path.resolve(TEST_RUNTIME_DIR).startsWith(path.resolve(TEST_STATE_ROOT)));
  if (previousTestStateEnv.dbPath) assert.notStrictEqual(path.resolve(TEST_DB_PATH), path.resolve(previousTestStateEnv.dbPath));
  if (previousTestStateEnv.jobsDir) assert.notStrictEqual(path.resolve(TEST_JOBS_DIR), path.resolve(previousTestStateEnv.jobsDir));
  if (previousTestStateEnv.runtimeDir) assert.notStrictEqual(path.resolve(TEST_RUNTIME_DIR), path.resolve(previousTestStateEnv.runtimeDir));

  const fixture = db.prepare('SELECT id, localPath FROM projects WHERE id = ?').get('proj_1') as { id: string; localPath: string } | undefined;
  assert.strictEqual(fixture?.id, 'proj_1');
  assert.strictEqual(fixture?.localPath, process.cwd());
});

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


test('mcpToolJobService - batches verbose durable output and flushes it before success', async () => {
  const root = makeTempRepo('verbose-log-batching');
  const state = makeState(root);
  const toolName = `test_verbose_log_${randomUUID()}`;
  const chunkCount = 200;
  const chunk = 'verbose-chunk-payload-0123456789\\n';
  const expectedBytes = Buffer.byteLength(chunk, 'utf8') * chunkCount;
  const originalAppendFileSync = fs.appendFileSync;
  let persistenceWrites = 0;

  fs.appendFileSync = ((file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
    if (String(data).includes('verbose-chunk-payload-')) persistenceWrites += 1;
    return originalAppendFileSync(file, data, options as any);
  }) as typeof fs.appendFileSync;

  __setToolJobTestRunner(toolName, async (_state, _args, logger) => {
    for (let index = 0; index < chunkCount; index += 1) logger.stdout(chunk);
    return { emitted: chunkCount };
  });

  try {
    const jobInfo = enqueueToolJob(state, toolName, { localPath: root }, 'repo-command');
    const status = await waitForStatus(jobInfo.jobId, 'succeeded');
    const logs = readJobLog(jobInfo.jobId, 'stdout');

    assert.equal(status?.stdoutBytes, expectedBytes);
    assert.equal(logs.bytes, expectedBytes);
    assert.equal(logs.log.includes('verbose-chunk-payload-'), true);
    assert.equal(persistenceWrites < chunkCount / 4, true, `expected batching, saw ${persistenceWrites} writes for ${chunkCount} chunks`);
  } finally {
    fs.appendFileSync = originalAppendFileSync;
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - batched durable logs redact credentials across adjacent chunks', async () => {
  const root = makeTempRepo('batched-log-redaction');
  const state = makeState(root);
  const toolName = `test_batched_redaction_${randomUUID()}`;
  const secret = `ghp_${randomUUID().replace(/-/g, '')}`;
  const previousToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = secret;

  __setToolJobTestRunner(toolName, async (_state, _args, logger) => {
    const split = Math.floor(secret.length / 2);
    logger.stdout(`credential=${secret.slice(0, split)}`);
    logger.stdout(`${secret.slice(split)}\\n`);
    return { ok: true };
  });

  try {
    const jobInfo = enqueueToolJob(state, toolName, { localPath: root }, 'repo-command');
    await waitForStatus(jobInfo.jobId, 'succeeded');
    const logs = readJobLog(jobInfo.jobId, 'stdout');
    assert.equal(logs.log.includes(secret), false);
    assert.equal(logs.log.includes('[REDACTED]'), true);
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    else process.env.GITHUB_PERSONAL_ACCESS_TOKEN = previousToken;
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - active cancellation flushes pending batched logs before terminal state', async () => {
  const root = makeTempRepo('cancel-log-flush');
  const state = makeState(root);
  const toolName = `test_cancel_log_flush_${randomUUID()}`;
  const emitted = deferred();
  const pendingLine = 'pending-before-cancel\\n';

  __setToolJobTestRunner(toolName, async (_state, _args, logger, setCancelFn) => {
    await new Promise((_resolve, reject) => {
      setCancelFn(() => reject(new Error('Job cancelled')));
      logger.stdout(pendingLine);
      emitted.resolve();
    });
    return { unreachable: true };
  });

  try {
    const jobInfo = enqueueToolJob(state, toolName, { localPath: root }, 'repo-command');
    await emitted.promise;
    assert.equal(cancelToolJob(jobInfo.jobId), true);
    const status = await waitForStatus(jobInfo.jobId, 'cancelled');
    const logs = readJobLog(jobInfo.jobId, 'stdout');
    assert.equal(status?.status, 'cancelled');
    assert.equal(logs.log.includes(pendingLine.trim()), true);
    assert.equal(logs.bytes >= Buffer.byteLength(pendingLine, 'utf8'), true);
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
    const staleBeforeFollower = getQueueMetrics().metrics.durable.staleRunning;
    const second = enqueueToolJob(state, toolName, args, 'repo-read');
    assert.notStrictEqual(first.jobId, second.jobId);
    assert.strictEqual(second.sharedWith, first.jobId);
    assert.strictEqual(getQueueMetrics().metrics.durable.staleRunning, staleBeforeFollower);

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

test('mcpToolJobService - live single-flight consumers protect an older verification candidate from supersession', async () => {
  const root = process.cwd();
  const state = makeState(root);
  const gateA = deferred();
  const gateB = deferred();
  const starts: string[] = [];
  __setToolJobTestRunner('run_project_command', async (_state, args) => {
    starts.push(args.verificationCandidateKey);
    if (args.verificationCandidateKey === 'A') await gateA.promise;
    if (args.verificationCandidateKey === 'B') await gateB.promise;
    return { ok: true, candidate: args.verificationCandidateKey };
  });

  try {
    const argsA = {
      localPath: root,
      command: 'typecheck',
      verificationSeriesKey: 'shared-series',
      verificationCandidateKey: 'A',
    };
    const leaderA = enqueueToolJob(state, 'run_project_command', argsA, 'repo-command');
    const followerA = enqueueToolJob(state, 'run_project_command', argsA, 'repo-command');
    assert.strictEqual(followerA.sharedWith, leaderA.jobId);
    await waitUntil(() => starts.includes('A'), 'Expected candidate A leader to start');

    const candidateB = enqueueToolJob(state, 'run_project_command', {
      ...argsA,
      verificationCandidateKey: 'B',
      singleFlight: false,
    }, 'repo-command');

    assert.notStrictEqual(getToolJobStatus(leaderA.jobId)?.status, 'cancelled');
    assert.equal((getToolJobStatus(leaderA.jobId) as any)?.superseded, undefined);
    assert.equal(getToolJobStatus(followerA.jobId)?.status, 'running');

    gateA.resolve();
    gateB.resolve();
    await waitForStatus(leaderA.jobId, 'succeeded');
    await waitForStatus(followerA.jobId, 'succeeded');
    await waitForStatus(candidateB.jobId, 'succeeded');
  } finally {
    gateA.resolve();
    gateB.resolve();
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
    await waitUntil(() => starts.includes('typecheck') && starts.includes('lint'), 'Expected two verification jobs to start');

    const third: any = enqueueToolJob(state, 'run_project_command', { localPath: root, command: 'test', forceFresh: true }, 'repo-command');
    assert.strictEqual(third.handoffImmediately, true);
    assert.strictEqual(third.waitType, 'capacity');
    assert.strictEqual(third.blockReason, 'capacity_saturated');
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
      const verificationLease = await transitionAccess('verify', { verificationClass: 'fast', sharedResources: ['test:downgrade'] });
      starts.push('downgraded');
      await primaryDone.promise;
      verificationLease?.dispose?.();
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

test('mcpToolJobService - write to verify transition waits for real process capacity while independent reads stay runnable', async () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(1);
  const verifyRoot = makeTempRepo('transition-capacity-verify');
  const writerRoot = makeTempRepo('transition-capacity-writer');
  const readRoot = makeTempRepo('transition-capacity-read');
  const state = makeState(verifyRoot, writerRoot, readRoot);
  const writeTool = `test_transition_capacity_${randomUUID()}`;
  const readTool = `test_transition_read_${randomUUID()}`;
  const starts: string[] = [];
  const verifyDone = deferred();
  const writerDone = deferred();
  const readDone = deferred();

  __setToolJobTestRunner('run_project_command', async () => {
    starts.push('verify-active');
    await verifyDone.promise;
    return { ok: true };
  });
  __setToolJobTestRunner(writeTool, async (_state, _args, _logger, _setCancelFn, transitionAccess: any) => {
    starts.push('writer-mutation');
    const lease = await transitionAccess('verify', { verificationClass: 'fast', sharedResources: ['typescript'] });
    starts.push('writer-downgraded');
    await lease.runWithPermit({ verificationClass: 'fast', sharedResources: ['typescript'] }, async () => {
      starts.push('writer-child');
      assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 1, 'child process must reuse the reserved transition permit');
      await writerDone.promise;
    });
    lease.dispose();
    return { ok: true };
  });
  __setToolJobTestRunner(readTool, async () => {
    starts.push('independent-read');
    await readDone.promise;
    return { ok: true };
  });

  try {
    const activeVerify = enqueueToolJob(state, 'run_project_command', {
      localPath: verifyRoot,
      command: 'typecheck',
      forceFresh: true,
      singleFlight: false,
    }, 'repo-command');
    await waitUntil(() => starts.includes('verify-active'), 'Expected verification capacity to be occupied');
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 1);

    const transitioningWriter = enqueueToolJob(state, writeTool, { localPath: writerRoot }, 'repo-command');
    await waitUntil(() => starts.includes('writer-mutation'), 'Expected writer mutation phase to start');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.strictEqual(starts.includes('writer-downgraded'), false, 'transition must wait while verification capacity is saturated');
    assert.strictEqual(getToolJobStatus(transitioningWriter.jobId)?.accessMode, 'write');
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 1);

    const independentRead = enqueueToolJob(state, readTool, { localPath: readRoot, singleFlight: false }, 'repo-read');
    await waitUntil(() => starts.includes('independent-read'), 'Expected independent read to run while transition waits for capacity');
    readDone.resolve();
    await waitForStatus(independentRead.jobId, 'succeeded');

    verifyDone.resolve();
    await waitForStatus(activeVerify.jobId, 'succeeded');
    await waitUntil(() => starts.includes('writer-downgraded') && starts.includes('writer-child'), 'Expected writer to reserve freed capacity then start verification');
    assert.strictEqual(getToolJobStatus(transitioningWriter.jobId)?.accessMode, 'verify');
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 1);

    writerDone.resolve();
    await waitForStatus(transitioningWriter.jobId, 'succeeded');
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 0, 'terminal writer must release the reserved verification permit');
  } finally {
    verifyDone.resolve();
    writerDone.resolve();
    readDone.resolve();
    __setToolJobTestRunner('run_project_command', null);
    __setToolJobTestRunner(writeTool, null);
    __setToolJobTestRunner(readTool, null);
    resetSchedulerResourceStateForTests();
  }
});

test('mcpToolJobService - cancelling a writer waiting for verification capacity releases its write lock without leaking a permit', async () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(1);
  const verifyRoot = makeTempRepo('transition-cancel-verify');
  const writerRoot = makeTempRepo('transition-cancel-writer');
  const state = makeState(verifyRoot, writerRoot);
  const writeTool = `test_transition_cancel_${randomUUID()}`;
  const readTool = `test_transition_cancel_read_${randomUUID()}`;
  const starts: string[] = [];
  const verifyDone = deferred();
  const readDone = deferred();

  __setToolJobTestRunner('run_project_command', async () => {
    starts.push('verify-active');
    await verifyDone.promise;
    return { ok: true };
  });
  __setToolJobTestRunner(writeTool, async (_state, _args, _logger, _setCancelFn, transitionAccess: any) => {
    starts.push('writer-mutation');
    await transitionAccess('verify', { verificationClass: 'fast', sharedResources: ['typescript'] });
    starts.push('writer-downgraded');
    return { ok: true };
  });
  __setToolJobTestRunner(readTool, async () => {
    starts.push('same-root-read');
    await readDone.promise;
    return { ok: true };
  });

  try {
    const activeVerify = enqueueToolJob(state, 'run_project_command', {
      localPath: verifyRoot,
      command: 'typecheck',
      forceFresh: true,
      singleFlight: false,
    }, 'repo-command');
    await waitUntil(() => starts.includes('verify-active'), 'Expected verification capacity to be occupied');

    const writer = enqueueToolJob(state, writeTool, { localPath: writerRoot }, 'repo-command');
    await waitUntil(() => starts.includes('writer-mutation'), 'Expected writer mutation phase to start');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.strictEqual(starts.includes('writer-downgraded'), false);
    assert.strictEqual(getToolJobStatus(writer.jobId)?.accessMode, 'write');
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 1);

    assert.strictEqual(cancelToolJob(writer.jobId), true);
    await waitForStatus(writer.jobId, 'cancelled');
    const sameRootRead = enqueueToolJob(state, readTool, { localPath: writerRoot, singleFlight: false }, 'repo-read');
    await waitUntil(() => starts.includes('same-root-read'), 'Expected cancelled transition to release the writer lock');
    assert.strictEqual(starts.includes('writer-downgraded'), false, 'cancelled writer must never enter verify phase');
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 1, 'cancelled writer must not leak or acquire a verification permit');

    readDone.resolve();
    await waitForStatus(sameRootRead.jobId, 'succeeded');
    verifyDone.resolve();
    await waitForStatus(activeVerify.jobId, 'succeeded');
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 0);
  } finally {
    verifyDone.resolve();
    readDone.resolve();
    __setToolJobTestRunner('run_project_command', null);
    __setToolJobTestRunner(writeTool, null);
    __setToolJobTestRunner(readTool, null);
    resetSchedulerResourceStateForTests();
  }
});

test('mcpToolJobService - verification failure after write downgrade releases the reserved process permit', async () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(1);
  const root = makeTempRepo('transition-failure-release');
  const state = makeState(root);
  const writeTool = `test_transition_failure_${randomUUID()}`;

  __setToolJobTestRunner(writeTool, async (_state, _args, _logger, _setCancelFn, transitionAccess: any) => {
    await transitionAccess('verify', { verificationClass: 'fast', sharedResources: ['typescript'] });
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 1);
    throw new Error('expected failure before the reserved permit is consumed');
  });

  try {
    const writer = enqueueToolJob(state, writeTool, { localPath: root }, 'repo-command');
    await waitForStatus(writer.jobId, 'failed');
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 0, 'failed child verification must release its process permit');
  } finally {
    __setToolJobTestRunner(writeTool, null);
    resetSchedulerResourceStateForTests();
  }
});

test('mcpToolJobService - timed out write-to-verify job releases an unconsumed reserved process permit', async () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(1);
  const root = makeTempRepo('transition-timeout-release');
  const state = makeState(root);
  const writeTool = `test_transition_timeout_${randomUUID()}`;

  __setToolJobTestRunner(writeTool, async (_state, _args, _logger, _setCancelFn, transitionAccess: any) => {
    await transitionAccess('verify', { verificationClass: 'fast', sharedResources: ['typescript'] });
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 1);
    return { ok: false, timedOut: true, status: 'timed_out' };
  });

  try {
    const writer = enqueueToolJob(state, writeTool, { localPath: root }, 'repo-command');
    await waitForStatus(writer.jobId, 'timed_out');
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 0, 'timed out transition must release its reserved verification permit');
  } finally {
    __setToolJobTestRunner(writeTool, null);
    resetSchedulerResourceStateForTests();
  }
});

test('mcpToolJobService - concurrent composite transitions share one global verification process budget', async () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(1);
  const rootA = makeTempRepo('composite-budget-a');
  const rootB = makeTempRepo('composite-budget-b');
  const state = makeState(rootA, rootB);
  const writeTool = `test_composite_budget_${randomUUID()}`;
  const starts: string[] = [];
  const childGates = { a: deferred(), b: deferred() };
  let activeChildren = 0;
  let maxActiveChildren = 0;

  __setToolJobTestRunner(writeTool, async (_state, args, _logger, _setCancelFn, transitionAccess: any) => {
    const label = args.label as keyof typeof childGates;
    starts.push(`${label}-mutation`);
    const lease = await transitionAccess('verify', { verificationClass: 'fast', sharedResources: ['typescript'] });
    starts.push(`${label}-verify`);
    await lease.runWithPermit({ verificationClass: 'fast', sharedResources: ['typescript'] }, async () => {
      activeChildren += 1;
      maxActiveChildren = Math.max(maxActiveChildren, activeChildren);
      starts.push(`${label}-child`);
      try {
        await childGates[label].promise;
      } finally {
        activeChildren -= 1;
      }
    });
    lease.dispose();
    return { ok: true, label };
  });

  try {
    const first = enqueueToolJob(state, writeTool, { localPath: rootA, label: 'a', singleFlight: false }, 'repo-command');
    const second = enqueueToolJob(state, writeTool, { localPath: rootB, label: 'b', singleFlight: false }, 'repo-command');
    await waitUntil(() => starts.includes('a-mutation') && starts.includes('b-mutation'), 'Expected both independent mutation phases to start');
    await waitUntil(() => starts.some((value) => value.endsWith('-child')), 'Expected one composite verification child to start');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.strictEqual(maxActiveChildren, 1);
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 1);

    const firstLabel = starts.includes('a-child') ? 'a' : 'b';
    const secondLabel = firstLabel === 'a' ? 'b' : 'a';
    childGates[firstLabel].resolve();
    await waitUntil(() => starts.includes(`${secondLabel}-child`), 'Expected waiting composite to consume the freed global permit');
    assert.strictEqual(maxActiveChildren, 1, 'two composite jobs must share the same global child-process budget');
    childGates[secondLabel].resolve();

    await waitForStatus(first.jobId, 'succeeded');
    await waitForStatus(second.jobId, 'succeeded');
    assert.strictEqual(getSchedulerCapacitySnapshot().verify.active, 0);
  } finally {
    childGates.a.resolve();
    childGates.b.resolve();
    __setToolJobTestRunner(writeTool, null);
    resetSchedulerResourceStateForTests();
  }
});

test('mcpToolJobService - queued heavy verification yields to newer fast verification when one slot is available', async () => {
  const root = makeTempRepo('resource-aware-fast-lane');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: {
      typecheck: 'tsc --noEmit',
      verify: 'node -e "0"',
    },
  }, null, 2));
  const state = makeState(root);
  const starts: string[] = [];
  const gates = {
    heavy1: deferred(),
    heavy2: deferred(),
    fast: deferred(),
  };

  __setToolJobTestRunner('run_project_command', async (_state, args) => {
    starts.push(args.label);
    const gate = gates[args.label as keyof typeof gates];
    if (gate) await gate.promise;
    return { ok: true, label: args.label };
  });

  try {
    const heavy1 = enqueueToolJob(state, 'run_project_command', {
      localPath: root,
      command: 'verify',
      label: 'heavy1',
      singleFlight: false,
    }, 'repo-command');
    await waitUntil(() => starts.includes('heavy1'), 'Expected first heavy verification to start');

    const heavy2 = enqueueToolJob(state, 'run_project_command', {
      localPath: root,
      command: 'verify',
      label: 'heavy2',
      singleFlight: false,
    }, 'repo-command');
    const fast = enqueueToolJob(state, 'run_project_command', {
      localPath: root,
      command: 'typecheck',
      label: 'fast',
      singleFlight: false,
    }, 'repo-command');

    await waitUntil(() => starts.includes('fast'), 'Expected fast verification to take the spare slot ahead of queued heavy work');
    assert.strictEqual(getToolJobStatus(fast.jobId)?.status, 'running');
    assert.strictEqual(getToolJobStatus(heavy2.jobId)?.status, 'queued');
    assert.strictEqual((getToolJobStatus(heavy2.jobId) as any)?.blockReason, 'capacity_saturated');

    gates.fast.resolve();
    await waitForStatus(fast.jobId, 'succeeded');
    await waitUntil(() => starts.includes('heavy2'), 'Expected heavy verification to start when the fast slot is released');

    gates.heavy1.resolve();
    gates.heavy2.resolve();
    await waitForStatus(heavy1.jobId, 'succeeded');
    await waitForStatus(heavy2.jobId, 'succeeded');
  } finally {
    Object.values(gates).forEach((gate) => gate.resolve());
    __setToolJobTestRunner('run_project_command', null);
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
    assert.equal(typeof running.phaseTimings.candidatePreparationMs, 'number');

    blockers.second.resolve();
    const terminal: any = await waitForStatus(second.jobId, 'succeeded');
    assert.equal(terminal.phaseTimings.queueWaitMs >= terminal.phaseTimings.workspaceLockWaitMs, true);
    assert.equal(terminal.phaseTimings.executionMs > 0, true);
    assert.equal(typeof terminal.phaseTimings.candidatePreparationMs, 'number');
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

test('mcpToolJobService - newer verification candidates supersede obsolete queued work', async () => {
  const roots = [makeTempRepo('supersede-block-a'), makeTempRepo('supersede-block-b'), makeTempRepo('supersede-target')];
  const state = makeState(...roots);
  const blockers = { blockA: deferred(), blockB: deferred(), candidateC: deferred() };
  const starts: string[] = [];
  __setToolJobTestRunner('run_project_command', async (_state, args) => {
    starts.push(args.label);
    const blocker = blockers[args.label as keyof typeof blockers];
    if (blocker) await blocker.promise;
    return { ok: true, label: args.label };
  });

  try {
    const blockA = enqueueToolJob(state, 'run_project_command', { localPath: roots[0], command: 'typecheck', label: 'blockA', singleFlight: false }, 'repo-command');
    const blockB = enqueueToolJob(state, 'run_project_command', { localPath: roots[1], command: 'typecheck', label: 'blockB', singleFlight: false }, 'repo-command');
    await waitUntil(() => starts.includes('blockA') && starts.includes('blockB'), 'Expected verification capacity blockers to start');

    const candidateA = enqueueToolJob(state, 'run_project_command', {
      localPath: roots[2], command: 'typecheck', label: 'candidateA', singleFlight: false,
      verificationSeriesKey: 'workspace-verify', verificationCandidateKey: 'A',
    }, 'repo-command');
    const candidateB = enqueueToolJob(state, 'run_project_command', {
      localPath: roots[2], command: 'typecheck', label: 'candidateB', singleFlight: false,
      verificationSeriesKey: 'workspace-verify', verificationCandidateKey: 'B',
    }, 'repo-command');
    const candidateC = enqueueToolJob(state, 'run_project_command', {
      localPath: roots[2], command: 'typecheck', label: 'candidateC', singleFlight: false,
      verificationSeriesKey: 'workspace-verify', verificationCandidateKey: 'C',
    }, 'repo-command');

    assert.equal(getToolJobStatus(candidateA.jobId)?.status, 'cancelled');
    assert.equal((getToolJobStatus(candidateA.jobId) as any)?.supersededByCandidateKey, 'B');
    assert.equal((readJobResult(candidateA.jobId) as any)?.result?.code, 'JOB_SUPERSEDED');
    assert.equal(getToolJobStatus(candidateB.jobId)?.status, 'cancelled');
    assert.equal((getToolJobStatus(candidateB.jobId) as any)?.supersededByCandidateKey, 'C');
    assert.equal(getToolJobStatus(candidateC.jobId)?.status, 'queued');
    assert.equal(getQueueMetrics().queue.filter((entry: any) => entry.resourceKey === getToolJobStatus(candidateC.jobId)?.resourceKey).length, 1);

    blockers.blockA.resolve();
    blockers.blockB.resolve();
    await waitForStatus(blockA.jobId, 'succeeded');
    await waitForStatus(blockB.jobId, 'succeeded');
    await waitUntil(() => starts.includes('candidateC'), 'Newest candidate should start after capacity frees');
    blockers.candidateC.resolve();
    await waitForStatus(candidateC.jobId, 'succeeded');
  } finally {
    blockers.blockA.resolve();
    blockers.blockB.resolve();
    blockers.candidateC.resolve();
    __setToolJobTestRunner('run_project_command', null);
  }
});

test('mcpToolJobService - required verification is not superseded by a newer candidate', async () => {
  const roots = [makeTempRepo('required-block-a'), makeTempRepo('required-block-b'), makeTempRepo('required-target')];
  const state = makeState(...roots);
  const gates = { blockA: deferred(), blockB: deferred(), requiredA: deferred(), candidateB: deferred() };
  const starts: string[] = [];
  __setToolJobTestRunner('run_project_command', async (_state, args) => {
    starts.push(args.label);
    const gate = gates[args.label as keyof typeof gates];
    if (gate) await gate.promise;
    return { ok: true, label: args.label };
  });

  try {
    const blockA = enqueueToolJob(state, 'run_project_command', { localPath: roots[0], command: 'typecheck', label: 'blockA', singleFlight: false }, 'repo-command');
    const blockB = enqueueToolJob(state, 'run_project_command', { localPath: roots[1], command: 'typecheck', label: 'blockB', singleFlight: false }, 'repo-command');
    await waitUntil(() => starts.includes('blockA') && starts.includes('blockB'), 'Expected verification capacity blockers to start');

    const requiredA = enqueueToolJob(state, 'run_project_command', {
      localPath: roots[2], command: 'typecheck', label: 'requiredA', singleFlight: false,
      verificationSeriesKey: 'review-gate', verificationCandidateKey: 'A', verificationRequired: true,
    }, 'repo-command');
    const candidateB = enqueueToolJob(state, 'run_project_command', {
      localPath: roots[2], command: 'typecheck', label: 'candidateB', singleFlight: false,
      verificationSeriesKey: 'review-gate', verificationCandidateKey: 'B',
    }, 'repo-command');

    assert.equal(getToolJobStatus(requiredA.jobId)?.status, 'queued');
    assert.equal((getToolJobStatus(requiredA.jobId) as any)?.supersededByCandidateKey, undefined);
    assert.equal(getToolJobStatus(candidateB.jobId)?.status, 'queued');

    gates.blockA.resolve();
    gates.blockB.resolve();
    await waitForStatus(blockA.jobId, 'succeeded');
    await waitForStatus(blockB.jobId, 'succeeded');
    gates.requiredA.resolve();
    gates.candidateB.resolve();
    await waitForStatus(requiredA.jobId, 'succeeded');
    await waitForStatus(candidateB.jobId, 'succeeded');
  } finally {
    Object.values(gates).forEach((gate) => gate.resolve());
    __setToolJobTestRunner('run_project_command', null);
  }
});

test('mcpToolJobService - verification backlog returns structured backpressure instead of growing unbounded', async () => {
  const roots = [makeTempRepo('backpressure-block-a'), makeTempRepo('backpressure-block-b'), makeTempRepo('backpressure-target')];
  const state = makeState(...roots);
  const gates = { blockA: deferred(), blockB: deferred() };
  const starts: string[] = [];
  __setToolJobTestRunner('run_project_command', async (_state, args) => {
    starts.push(args.label);
    const gate = gates[args.label as keyof typeof gates];
    if (gate) await gate.promise;
    return { ok: true };
  });

  try {
    const blockA = enqueueToolJob(state, 'run_project_command', { localPath: roots[0], command: 'typecheck', label: 'blockA', singleFlight: false }, 'repo-command');
    const blockB = enqueueToolJob(state, 'run_project_command', { localPath: roots[1], command: 'typecheck', label: 'blockB', singleFlight: false }, 'repo-command');
    await waitUntil(() => starts.includes('blockA') && starts.includes('blockB'), 'Expected verification capacity blockers to start');

    const queuedOne = enqueueToolJob(state, 'run_project_command', { localPath: roots[2], command: 'typecheck', singleFlight: false, verificationBacklogLimit: 2 }, 'repo-command');
    const queuedTwo = enqueueToolJob(state, 'run_project_command', { localPath: roots[2], command: 'typecheck', singleFlight: false, verificationBacklogLimit: 2 }, 'repo-command');
    const targetResourceKey = getToolJobStatus(queuedOne.jobId)?.resourceKey;
    assert.equal(targetResourceKey, getToolJobStatus(queuedTwo.jobId)?.resourceKey);
    assert.throws(
      () => enqueueToolJob(state, 'run_project_command', { localPath: roots[2], command: 'typecheck', singleFlight: false, verificationBacklogLimit: 2 }, 'repo-command'),
      (error: any) => error?.payload?.code === 'VERIFICATION_BACKPRESSURE' && error?.status === 429,
    );
    assert.equal(getQueueMetrics().metrics.backpressure.rejections >= 1, true);
    assert.equal(getQueueMetrics().queue.filter((entry: any) => entry.resourceKey === targetResourceKey).length, 2);

    gates.blockA.resolve();
    gates.blockB.resolve();
    await waitForStatus(blockA.jobId, 'succeeded');
    await waitForStatus(blockB.jobId, 'succeeded');
  } finally {
    gates.blockA.resolve();
    gates.blockB.resolve();
    __setToolJobTestRunner('run_project_command', null);
  }
});

test('mcpToolJobService - running obsolete verification uses cooperative cancellation and remains non-authoritative', async () => {
  const root = makeTempRepo('supersede-running');
  const state = makeState(root);
  const startedA = deferred();
  const finishB = deferred();
  let cancellationRequested = false;
  __setToolJobTestRunner('run_project_command', async (_state, args, _logger, setCancelFn) => {
    if (args.label === 'A') {
      await new Promise((_resolve, reject) => {
        setCancelFn(() => {
          cancellationRequested = true;
          const error = new Error('superseded');
          error.name = 'AbortError';
          reject(error);
        });
        startedA.resolve();
      });
    }
    if (args.label === 'B') await finishB.promise;
    return { ok: true, label: args.label };
  });

  try {
    const candidateA = enqueueToolJob(state, 'run_project_command', {
      localPath: root, command: 'typecheck', label: 'A', singleFlight: false,
      verificationSeriesKey: 'running-series', verificationCandidateKey: 'A',
    }, 'repo-command');
    await startedA.promise;
    const candidateB = enqueueToolJob(state, 'run_project_command', {
      localPath: root, command: 'typecheck', label: 'B', singleFlight: false,
      verificationSeriesKey: 'running-series', verificationCandidateKey: 'B',
    }, 'repo-command');

    await waitForStatus(candidateA.jobId, 'cancelled');
    assert.equal(cancellationRequested, true);
    assert.equal((getToolJobStatus(candidateA.jobId) as any)?.authoritative, false);
    assert.equal((getToolJobStatus(candidateA.jobId) as any)?.supersededByCandidateKey, 'B');
    assert.equal((readJobResult(candidateA.jobId) as any)?.result?.code, 'JOB_SUPERSEDED');
    finishB.resolve();
    await waitForStatus(candidateB.jobId, 'succeeded');
  } finally {
    finishB.resolve();
    __setToolJobTestRunner('run_project_command', null);
  }
});

test('mcpToolJobService - bounded waiter detaches without cancelling durable execution', async () => {
  const root = makeTempRepo('durable-detach');
  const state = makeState(root);
  const gate = deferred();
  const toolName = `test_durable_detach_${randomUUID()}`;
  __setToolJobTestRunner(toolName, async () => {
    await gate.promise;
    return { ok: true };
  });

  try {
    const job = enqueueToolJob(state, toolName, { localPath: root }, 'repo-read');
    await waitUntil(() => getToolJobStatus(job.jobId)?.status === 'running', 'Expected durable job to start');

    const observed = await waitForToolJob(job.jobId, 5);
    assert.equal(observed?.status, 'running');
    const detached: any = getToolJobStatus(job.jobId);
    assert.equal(detached?.status, 'running');
    assert.equal(typeof detached?.detachedAt, 'string');

    gate.resolve();
    await waitForStatus(job.jobId, 'succeeded');
  } finally {
    gate.resolve();
    __setToolJobTestRunner(toolName, null);
  }
});

test('mcpToolJobService - stale retry-safe lease recovery releases capacity and fences zombie completion', async () => {
  const root = process.cwd();
  const state = makeState(root);
  const firstStarted = deferred();
  const zombieFinish = deferred();
  let attempt = 0;

  __setToolJobTestRunner('search_local_files', async (_state, args) => {
    if (args?.query !== 'lease-fencing') return { ok: true, unrelatedRecovery: true };
    attempt += 1;
    if (attempt === 1) {
      firstStarted.resolve();
      await zombieFinish.promise;
      return { ok: true, attempt: 1 };
    }
    return { ok: true, attempt };
  });

  try {
    const job = enqueueToolJob(state, 'search_local_files', {
      localPath: root,
      query: 'lease-fencing',
    }, 'repo-read');
    await firstStarted.promise;
    const follower = enqueueToolJob(state, 'search_local_files', {
      localPath: root,
      query: 'lease-fencing',
    }, 'repo-read');
    assert.equal(follower.sharedWith, job.jobId);

    const firstLease: any = getToolJobStatus(job.jobId);
    assert.equal(firstLease?.status, 'running');
    assert.equal(firstLease?.leaseGeneration, 1);
    assert.equal(typeof firstLease?.leaseOwner, 'string');

    const expired = (heartbeatJob as any)(
      job.jobId,
      firstLease.leaseOwner,
      1_000,
      Date.now() - 5_000,
      firstLease.leaseGeneration,
    );
    assert.ok(expired);

    const serviceModule: any = await import('../../src/server/services/mcpToolJobService.js');
    assert.equal(typeof serviceModule.__runDurableJobRecoveryPassForTests, 'function');
    const recovery = serviceModule.__runDurableJobRecoveryPassForTests(state, Date.now());
    assert.equal(recovery.retryable >= 1, true);

    await waitForStatus(job.jobId, 'succeeded');
    await waitForStatus(follower.jobId, 'succeeded');
    assert.equal((readJobResult(job.jobId) as any)?.result?.attempt, 2);
    assert.equal((readJobResult(follower.jobId) as any)?.result?.attempt, 2);

    zombieFinish.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal((readJobResult(job.jobId) as any)?.result?.attempt, 2);
    assert.equal((getToolJobStatus(job.jobId) as any)?.leaseGeneration, 2);
    assert.equal((getQueueMetrics().metrics.durable as any).fencedLateWrites >= 1, true);
  } finally {
    zombieFinish.resolve();
    __setToolJobTestRunner('search_local_files', null);
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
