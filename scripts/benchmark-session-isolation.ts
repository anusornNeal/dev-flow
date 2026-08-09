import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-session-isolation-benchmark-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.sqlite');
process.env.DEVFLOW_JOBS_DIR = path.join(tempRoot, 'jobs');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
let closeDatabase: (() => void) | null = null;
let cleanupBenchmark: (() => void) | null = null;

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function waitForTerminal(waitForToolJob: any, jobIds: string[]) {
  await Promise.all(jobIds.map((jobId) => waitForToolJob(jobId, 10_000)));
}

function p95(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

try {
  const { executeAllMigrations } = await import('../src/db/migrations/index.js');
  const { default: db } = await import('../src/db/index.js');
  closeDatabase = () => db.close();
  executeAllMigrations();
  const { createProject } = await import('../src/server/repositories/projectRepository.js');
  const {
    createOrReuseSessionWorkspace,
    cleanupSessionWorkspace,
  } = await import('../src/server/services/sessionWorkspaceService.js');
  const {
    __setToolJobTestRunner,
    __resetQueueWaitTelemetryForTests,
    enqueueToolJob,
    getQueueMetrics,
    getToolJobStatus,
    waitForToolJob,
  } = await import('../src/server/services/mcpToolJobService.js');
  const {
    resetSchedulerResourceStateForTests,
    setGlobalVerifyCapacityForTests,
  } = await import('../src/server/services/mcpToolJobScheduler.js');

  const repo = path.join(tempRoot, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }, null, 2));
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'DevFlow Benchmark']);
  git(repo, ['config', 'user.email', 'devflow-benchmark@example.test']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);

  const projectId = 'benchmark-session-isolation';
  createProject({ id: projectId, name: 'Session Isolation Benchmark', repoUrl: 'https://example.invalid/session-isolation', localPath: repo });
  const state: any = { projectsCache: [{ id: projectId, name: 'Session Isolation Benchmark', repoUrl: 'https://example.invalid/session-isolation', localPath: repo }] };
  const workspaces = ['alpha', 'beta', 'gamma', 'delta'].map((sessionId) => createOrReuseSessionWorkspace(state.projectsCache[0], sessionId));
  const workspaceRoots = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.root]));
  cleanupBenchmark = () => {
    __setToolJobTestRunner('benchmark_write', null);
    __setToolJobTestRunner('run_project_command', null);
    for (const workspace of workspaces) {
      try { cleanupSessionWorkspace(workspace.workspaceId, { force: true }); } catch { /* best-effort benchmark cleanup */ }
    }
  };

  let writeBlocks = new Map<string, ReturnType<typeof deferred>>();
  let writeStarts: string[] = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  __setToolJobTestRunner('benchmark_write', async (_state, args) => {
    writeStarts.push(args.label);
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    await writeBlocks.get(args.label)!.promise;
    const root = args.workspaceId ? workspaceRoots.get(args.workspaceId) || repo : repo;
    const target = path.join(root, `.devflow-benchmark-${args.label}.txt`);
    fs.writeFileSync(target, `${args.label}\n`);
    fs.rmSync(target, { force: true });
    activeWrites -= 1;
    return { ok: true, label: args.label };
  });

  resetSchedulerResourceStateForTests();
  writeStarts = [];
  __resetQueueWaitTelemetryForTests();
  activeWrites = 0;
  maxActiveWrites = 0;
  writeBlocks = new Map(workspaces.map((_, index) => [`shared-${index}`, deferred()]));
  const sharedStartedAt = Date.now();
  const sharedJobs = workspaces.map((_, index) => enqueueToolJob(state, 'benchmark_write', { projectId, label: `shared-${index}`, singleFlight: false }, 'repo-write'));
  await waitUntil(() => writeStarts.length === 1, 'shared-root writes should start one at a time');
  const sharedInitialStarts = writeStarts.length;
  const sharedQueuedBlockers = sharedJobs.slice(1).map((job) => getToolJobStatus(job.jobId)?.waitType).filter(Boolean);
  for (let index = 0; index < sharedJobs.length; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeBlocks.get(`shared-${index}`)!.resolve();
    if (index + 1 < sharedJobs.length) await waitUntil(() => writeStarts.length === index + 2, `shared-root write ${index + 1} should start after predecessor`);
  }
  await waitForTerminal(waitForToolJob, sharedJobs.map((job) => job.jobId));
  const sharedWallMs = Date.now() - sharedStartedAt;
  const sharedMaxActive = maxActiveWrites;
  const sharedWaitP95Ms = p95(sharedJobs.map((job) => Number(getToolJobStatus(job.jobId)?.waitMs || 0)));
  const sharedLockWait = getQueueMetrics().metrics.waitTelemetry.workspaceLockWait;

  resetSchedulerResourceStateForTests();
  writeStarts = [];
  __resetQueueWaitTelemetryForTests();
  activeWrites = 0;
  maxActiveWrites = 0;
  writeBlocks = new Map(workspaces.map((_, index) => [`isolated-${index}`, deferred()]));
  const isolatedStartedAt = Date.now();
  const isolatedJobs = workspaces.map((workspace, index) => enqueueToolJob(state, 'benchmark_write', { projectId, workspaceId: workspace.workspaceId, label: `isolated-${index}`, singleFlight: false }, 'repo-write'));
  await waitUntil(() => writeStarts.length === workspaces.length, 'isolated workspace writes should all start independently');
  const isolatedInitialStarts = writeStarts.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let index = 0; index < workspaces.length; index += 1) writeBlocks.get(`isolated-${index}`)!.resolve();
  await waitForTerminal(waitForToolJob, isolatedJobs.map((job) => job.jobId));
  const isolatedWallMs = Date.now() - isolatedStartedAt;
  const isolatedMaxActive = maxActiveWrites;
  const isolatedWaitP95Ms = p95(isolatedJobs.map((job) => Number(getToolJobStatus(job.jobId)?.waitMs || 0)));
  const isolatedLockWait = getQueueMetrics().metrics.waitTelemetry.workspaceLockWait;

  resetSchedulerResourceStateForTests();
  writeStarts = [];
  activeWrites = 0;
  maxActiveWrites = 0;
  writeBlocks = new Map([['same-a', deferred()], ['same-b', deferred()]]);
  const sameWorkspaceJobs = [
    enqueueToolJob(state, 'benchmark_write', { projectId, workspaceId: workspaces[0].workspaceId, label: 'same-a', singleFlight: false }, 'repo-write'),
    enqueueToolJob(state, 'benchmark_write', { projectId, workspaceId: workspaces[0].workspaceId, label: 'same-b', singleFlight: false }, 'repo-write'),
  ];
  await waitUntil(() => writeStarts.length === 1, 'same-workspace writes should serialize');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sameWorkspaceQueued = getToolJobStatus(sameWorkspaceJobs[1].jobId);
  assert.equal(sameWorkspaceQueued?.waitType, 'workspace_lock');
  writeBlocks.get('same-a')!.resolve();
  await waitUntil(() => writeStarts.length === 2, 'second same-workspace write should start after first finishes');
  writeBlocks.get('same-b')!.resolve();
  await waitForTerminal(waitForToolJob, sameWorkspaceJobs.map((job) => job.jobId));
  const sameWorkspaceMaxActive = maxActiveWrites;

  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  let verifyBlocks = new Map(workspaces.map((_, index) => [`verify-${index}`, deferred()]));
  let verifyStarts: string[] = [];
  let activeVerify = 0;
  let maxActiveVerify = 0;
  let verifyProcessSpawns = 0;
  __setToolJobTestRunner('run_project_command', async (_state, args) => {
    verifyStarts.push(args.label);
    activeVerify += 1;
    maxActiveVerify = Math.max(maxActiveVerify, activeVerify);
    await verifyBlocks.get(args.label)!.promise;
    verifyProcessSpawns += 1;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { shell: false, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`verify child exited ${code}`)));
    });
    activeVerify -= 1;
    return { ok: true, label: args.label, processSpawns: 1 };
  });
  const verifyStartedAt = Date.now();
  const verifyJobs = workspaces.map((workspace, index) => enqueueToolJob(state, 'run_project_command', {
    projectId,
    workspaceId: workspace.workspaceId,
    command: 'typecheck',
    label: `verify-${index}`,
    singleFlight: false,
  }, 'repo-command'));
  await waitUntil(() => verifyStarts.length === 2, 'global verify capacity should start exactly two verifies');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const capacityQueued = verifyJobs.map((job) => getToolJobStatus(job.jobId)).filter((status) => status?.status === 'queued' && status?.waitType === 'capacity');
  assert.equal(capacityQueued.length, 2);
  verifyBlocks.get('verify-0')!.resolve();
  verifyBlocks.get('verify-1')!.resolve();
  await waitUntil(() => verifyStarts.length === 4, 'remaining verifies should start after capacity frees');
  verifyBlocks.get('verify-2')!.resolve();
  verifyBlocks.get('verify-3')!.resolve();
  await waitForTerminal(waitForToolJob, verifyJobs.map((job) => job.jobId));
  const verifyWallMs = Date.now() - verifyStartedAt;
  const perSession = workspaces.map((_, index) => {
    const editStatus = getToolJobStatus(isolatedJobs[index].jobId);
    const verifyStatus = getToolJobStatus(verifyJobs[index].jobId);
    const editWaitMs = Number(editStatus?.waitMs || 0);
    const editRunMs = Number(editStatus?.durationMs || 0);
    const verifyWaitMs = Number(verifyStatus?.waitMs || 0);
    const verifyRunMs = Number(verifyStatus?.durationMs || 0);
    return {
      session: index + 1,
      edit: { waitMs: editWaitMs, runMs: editRunMs, wallMs: editWaitMs + editRunMs },
      verify: { waitMs: verifyWaitMs, runMs: verifyRunMs, wallMs: verifyWaitMs + verifyRunMs },
      codingLoopWallMs: editWaitMs + editRunMs + verifyWaitMs + verifyRunMs,
    };
  });
  const isolatedWorkflowWallMs = isolatedWallMs + verifyWallMs;
  const isolatedThroughputSessionsPerSecond = Number((workspaces.length / (Math.max(1, isolatedWorkflowWallMs) / 1000)).toFixed(2));

  const waitTelemetry = getQueueMetrics().metrics.waitTelemetry;
  assert.equal(sharedInitialStarts, 1);
  assert.equal(sharedMaxActive, 1);
  assert.equal(sharedQueuedBlockers.every((waitType) => waitType === 'workspace_lock'), true);
  assert.equal(isolatedInitialStarts, 4);
  assert.equal(isolatedMaxActive, 4);
  assert.equal(isolatedMaxActive, 4);
  assert.equal(sharedLockWait.count > 0, true, 'shared-root baseline should record workspace correctness-lock wait');
  assert.equal(sharedLockWait.p95Ms > 0, true, 'shared-root workspace-lock p95 should be greater than zero');
  assert.equal(isolatedLockWait.count, 0, 'independent isolated workspaces should not record correctness-lock wait');
  assert.equal(isolatedLockWait.p95Ms, 0, 'isolated workspace correctness-lock p95 should remain zero');
  assert.equal(sameWorkspaceMaxActive, 1);
  assert.equal(maxActiveVerify, 2);
  assert.equal(verifyProcessSpawns, 4);
  assert.equal(waitTelemetry.workspaceLockWait.count >= 1, true);
  assert.equal(waitTelemetry.capacityWait.count >= 2, true);

  const result = {
    sessions: workspaces.length,
    sharedRoot: { wallMs: sharedWallMs, queueWaitP95Ms: sharedWaitP95Ms, workspaceLockWaitP95Ms: sharedLockWait.p95Ms, initialConcurrentStarts: sharedInitialStarts, maxActiveWrites: sharedMaxActive, workspaceLockBlocked: sharedQueuedBlockers.length },
    isolated: { wallMs: isolatedWallMs, queueWaitP95Ms: isolatedWaitP95Ms, workspaceLockWaitP95Ms: isolatedLockWait.p95Ms, initialConcurrentStarts: isolatedInitialStarts, maxActiveWrites: isolatedMaxActive, workspaceLockBlocked: 0, workflowWallMs: isolatedWorkflowWallMs, throughputSessionsPerSecond: isolatedThroughputSessionsPerSecond },
    sameWorkspace: { serialized: sameWorkspaceMaxActive === 1, blocker: sameWorkspaceQueued?.waitType || null },
    verifyCapacity: { limit: 2, maxActive: maxActiveVerify, capacityQueued: capacityQueued.length, processSpawns: verifyProcessSpawns },
    perSession,
    waits: waitTelemetry,
    structuralImprovement: { sharedInitialConcurrency: sharedInitialStarts, isolatedInitialConcurrency: isolatedInitialStarts },
  };
  console.log(JSON.stringify(result, null, 2));

} finally {
  cleanupBenchmark?.();
  closeDatabase?.();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
