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
const DVF_0443_INTERACTIVE_P95_BASELINE_MS = 99;
const DVF_0476_AGENT_SPLIT = { devflow: 3, sumora: 3 } as const;
const DVF_0476_MIN_IMPROVEMENT_PCT = 15;
const DVF_0476_TRIAL_MULTIPLIERS = [0.97, 1, 1.03, 0.99, 1.02] as const;


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

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index];
}

function p95(values: number[]) {
  return percentile(values, 0.95);
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
    getBlockerForQueueEntry,
    getSchedulerCapacitySnapshot,
    releaseVerificationProcessPermit,
    resetSchedulerResourceStateForTests,
    setGlobalVerifyCapacityForTests,
    setVerificationMachinePressureForTests,
    setVerificationResourceBudgetForTests,
    tryAcquireVerificationProcessPermit,
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
    __setToolJobTestRunner('benchmark_read', null);
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
  __setToolJobTestRunner('benchmark_read', async (_state, args) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, label: args.label };
  });
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

  const interactiveReadLatenciesMs: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    const startedAt = Date.now();
    const interactive = enqueueToolJob(state, 'benchmark_read', {
      projectId,
      workspaceId: workspaces[index % workspaces.length].workspaceId,
      label: `interactive-${index}`,
      singleFlight: false,
    }, 'repo-read');
    const status = await waitForToolJob(interactive.jobId, 5_000);
    assert.equal(status?.status, 'succeeded', 'interactive read should complete while verification capacity is saturated');
    interactiveReadLatenciesMs.push(Date.now() - startedAt);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  verifyBlocks.get('verify-0')!.resolve();
  verifyBlocks.get('verify-1')!.resolve();
  await waitUntil(() => verifyStarts.length === 4, 'remaining verifies should start after capacity frees');
  verifyBlocks.get('verify-2')!.resolve();
  verifyBlocks.get('verify-3')!.resolve();
  await waitForTerminal(waitForToolJob, verifyJobs.map((job) => job.jobId));
  const verifyWallMs = Date.now() - verifyStartedAt;
  const verificationThroughputPerSecond = Number((verifyJobs.length / (Math.max(1, verifyWallMs) / 1000)).toFixed(2));
  const verifyPhases = verifyJobs.map((job, index) => ({
    verification: index + 1,
    ...(getToolJobStatus(job.jobId) as any)?.phaseTimings,
  }));
  const waitDominatedCall = verifyPhases
    .filter((entry) => Number(entry.queueWaitMs || 0) > Number(entry.executionMs || 0))
    .sort((left, right) => (Number(right.queueWaitMs || 0) - Number(right.executionMs || 0)) - (Number(left.queueWaitMs || 0) - Number(left.executionMs || 0)))[0] || null;
  assert.ok(waitDominatedCall, 'mixed workload must include at least one verification call dominated by scheduler waiting');
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

  const queueMetrics = getQueueMetrics().metrics;
  const waitTelemetry = queueMetrics.waitTelemetry;
  const phaseTelemetry = queueMetrics.phaseTelemetry;
  const interactiveP50Ms = percentile(interactiveReadLatenciesMs, 0.5);
  const interactiveP95Ms = p95(interactiveReadLatenciesMs);
  const interactiveP95ImprovementPct = Number((((DVF_0443_INTERACTIVE_P95_BASELINE_MS - interactiveP95Ms) / DVF_0443_INTERACTIVE_P95_BASELINE_MS) * 100).toFixed(1));
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
  assert.equal(interactiveP95Ms <= DVF_0443_INTERACTIVE_P95_BASELINE_MS * 0.75, true, `interactive p95 ${interactiveP95Ms}ms should improve materially from DVF-0443 baseline ${DVF_0443_INTERACTIVE_P95_BASELINE_MS}ms`);

  const virtualWorkloads = [
    { id: 'devflow-heavy', repo: 'devflow', verificationClass: 'heavy' as const, sharedResource: 'project:devflow:repo', durationMs: 120, cpuRatio: 0.28, memoryMb: 400 },
    { id: 'sumora-heavy', repo: 'sumora', verificationClass: 'heavy' as const, sharedResource: 'project:sumora:gradle', durationMs: 140, cpuRatio: 0.34, memoryMb: 600 },
    { id: 'devflow-fast-a', repo: 'devflow', verificationClass: 'fast' as const, sharedResource: 'project:devflow:typescript', durationMs: 45, cpuRatio: 0.08, memoryMb: 128 },
    { id: 'sumora-fast-a', repo: 'sumora', verificationClass: 'fast' as const, sharedResource: 'project:sumora:gradle', durationMs: 50, cpuRatio: 0.09, memoryMb: 160 },
    { id: 'devflow-fast-b', repo: 'devflow', verificationClass: 'fast' as const, sharedResource: 'project:devflow:command:focused', durationMs: 35, cpuRatio: 0.07, memoryMb: 96 },
    { id: 'sumora-fast-b', repo: 'sumora', verificationClass: 'fast' as const, sharedResource: 'project:sumora:gradle', durationMs: 40, cpuRatio: 0.08, memoryMb: 128 },
  ];
  assert.equal(virtualWorkloads.filter((workload) => workload.repo === 'devflow').length, DVF_0476_AGENT_SPLIT.devflow);
  assert.equal(virtualWorkloads.filter((workload) => workload.repo === 'sumora').length, DVF_0476_AGENT_SPLIT.sumora);
  assert.equal(new Set(virtualWorkloads.filter((workload) => workload.repo === 'sumora').map((workload) => workload.sharedResource)).size, 1, 'all Sumora Gradle-like verification must share one repository-scoped Gradle resource');

  function runVirtualVerificationTrial(mode: 'fixed' | 'adaptive', durationMultiplier: number) {
    resetSchedulerResourceStateForTests();
    setGlobalVerifyCapacityForTests(2);
    setVerificationResourceBudgetForTests({
      targetCpuRatio: 0.8,
      hardCpuRatio: 0.9,
      targetMemoryPressure: 0.8,
      hardMemoryPressure: 0.9,
      maxAdaptiveProcesses: 6,
    });
    setVerificationMachinePressureForTests(mode === 'adaptive'
      ? { cpuRatio: 0.15, memoryPressureRatio: 0.30, totalMemoryBytes: 8 * 1024 ** 3 }
      : null);

    const queued = virtualWorkloads.map((workload) => ({
      ...workload,
      durationMs: Math.max(1, Math.round(workload.durationMs * durationMultiplier)),
    }));
    const running: Array<{ workload: typeof queued[number]; permit: any; finishAt: number }> = [];
    const startOrder: Array<{ id: string; repo: string; startedAtMs: number }> = [];
    let nowMs = 0;
    let blockedTimeMs = 0;
    let maxActive = 0;
    let maxWeightedCpuRatio = 0;
    let maxWeightedMemoryBytes = 0;
    let interactiveReadBlocked = false;

    while (queued.length > 0 || running.length > 0) {
      let admittedThisTick = false;
      for (let index = 0; index < queued.length;) {
        const workload = queued[index];
        const reservation = tryAcquireVerificationProcessPermit({
          jobId: `${mode}-${workload.id}`,
          verificationClass: workload.verificationClass,
          sharedResources: [workload.sharedResource],
          resourceDemand: {
            profileKey: `dvf0476:${workload.id}`,
            confidence: 'high',
            sampleCount: 6,
            cpuRatio: workload.cpuRatio,
            memoryBytes: workload.memoryMb * 1024 ** 2,
            durationMs: workload.durationMs,
            processCount: 1,
          },
        });
        if (!reservation.permit) {
          index += 1;
          continue;
        }
        queued.splice(index, 1);
        running.push({ workload, permit: reservation.permit, finishAt: nowMs + workload.durationMs });
        startOrder.push({ id: workload.id, repo: workload.repo, startedAtMs: nowMs });
        blockedTimeMs += nowMs;
        admittedThisTick = true;
        const snapshot: any = getSchedulerCapacitySnapshot().verify;
        maxActive = Math.max(maxActive, Number(snapshot.active || 0));
        maxWeightedCpuRatio = Math.max(maxWeightedCpuRatio, Number(snapshot.weighted?.activeCpuRatio || 0));
        maxWeightedMemoryBytes = Math.max(maxWeightedMemoryBytes, Number(snapshot.weighted?.activeMemoryBytes || 0));
      }

      if (running.length > 0) {
        const readEntry: any = {
          jobId: `${mode}-interactive-${nowMs}`,
          resourceKey: 'workspace:interactive',
          kind: 'repo-read',
          toolName: 'read_local_file',
          args: {},
          accessMode: 'read',
          costClass: 'light-read',
          enqueuedAt: nowMs,
        };
        interactiveReadBlocked ||= Boolean(getBlockerForQueueEntry(readEntry, 0, [readEntry], [], nowMs));
      }

      if (running.length === 0) {
        if (queued.length > 0) throw new Error(`${mode} verification simulation deadlocked with ${queued.length} queued jobs.`);
        break;
      }
      if (admittedThisTick && queued.length === 0) {
        // All remaining work is running; advance normally to its next completion.
      }
      const nextFinishAt = Math.min(...running.map((entry) => entry.finishAt));
      nowMs = nextFinishAt;
      for (let index = running.length - 1; index >= 0; index -= 1) {
        const entry = running[index];
        if (entry.finishAt !== nextFinishAt) continue;
        releaseVerificationProcessPermit(entry.permit, { actualDurationMs: entry.workload.durationMs });
        running.splice(index, 1);
      }
    }

    const firstThreeRepos = new Set(startOrder.slice(0, 3).map((entry) => entry.repo));
    const crossRepoFair = firstThreeRepos.has('devflow') && firstThreeRepos.has('sumora');
    return {
      mode,
      makespanMs: nowMs,
      blockedTimeMs,
      maxActive,
      maxWeightedCpuRatio: Number(maxWeightedCpuRatio.toFixed(3)),
      maxWeightedMemoryMb: Number((maxWeightedMemoryBytes / 1024 ** 2).toFixed(1)),
      interactiveReadBlocked,
      crossRepoFair,
      startOrder,
    };
  }

  const fixedTrials = DVF_0476_TRIAL_MULTIPLIERS.map((multiplier) => runVirtualVerificationTrial('fixed', multiplier));
  const adaptiveTrials = DVF_0476_TRIAL_MULTIPLIERS.map((multiplier) => runVirtualVerificationTrial('adaptive', multiplier));
  const fixedMakespans = fixedTrials.map((trial) => trial.makespanMs);
  const adaptiveMakespans = adaptiveTrials.map((trial) => trial.makespanMs);
  const fixedBlocked = fixedTrials.map((trial) => trial.blockedTimeMs);
  const adaptiveBlocked = adaptiveTrials.map((trial) => trial.blockedTimeMs);
  const fixedP50MakespanMs = percentile(fixedMakespans, 0.5);
  const adaptiveP50MakespanMs = percentile(adaptiveMakespans, 0.5);
  const fixedP50BlockedMs = percentile(fixedBlocked, 0.5);
  const adaptiveP50BlockedMs = percentile(adaptiveBlocked, 0.5);
  const makespanImprovementPct = Number((((fixedP50MakespanMs - adaptiveP50MakespanMs) / Math.max(1, fixedP50MakespanMs)) * 100).toFixed(1));
  const blockedTimeImprovementPct = Number((((fixedP50BlockedMs - adaptiveP50BlockedMs) / Math.max(1, fixedP50BlockedMs)) * 100).toFixed(1));
  const crossRepoFairness = {
    fixed: fixedTrials.every((trial) => trial.crossRepoFair),
    adaptive: adaptiveTrials.every((trial) => trial.crossRepoFair),
    noStarvation: adaptiveTrials.every((trial) => trial.startOrder.length === DVF_0476_AGENT_SPLIT.devflow + DVF_0476_AGENT_SPLIT.sumora),
    firstThreeAdaptiveStarts: adaptiveTrials[0].startOrder.slice(0, 3),
  };
  const hardBudgetRespected = adaptiveTrials.every((trial) => trial.maxWeightedCpuRatio <= 0.9 && trial.maxWeightedMemoryMb <= 8 * 1024 * 0.9);
  const interactiveResponsive = adaptiveTrials.every((trial) => !trial.interactiveReadBlocked);
  const fixedBaseline = {
    trials: fixedTrials.length,
    p50MakespanMs: fixedP50MakespanMs,
    p95MakespanMs: p95(fixedMakespans),
    p50BlockedTimeMs: fixedP50BlockedMs,
    p95BlockedTimeMs: p95(fixedBlocked),
    maxActive: Math.max(...fixedTrials.map((trial) => trial.maxActive)),
  };
  const adaptiveCandidate = {
    trials: adaptiveTrials.length,
    p50MakespanMs: adaptiveP50MakespanMs,
    p95MakespanMs: p95(adaptiveMakespans),
    p50BlockedTimeMs: adaptiveP50BlockedMs,
    p95BlockedTimeMs: p95(adaptiveBlocked),
    maxActive: Math.max(...adaptiveTrials.map((trial) => trial.maxActive)),
    maxWeightedCpuRatio: Math.max(...adaptiveTrials.map((trial) => trial.maxWeightedCpuRatio)),
    maxWeightedMemoryMb: Math.max(...adaptiveTrials.map((trial) => trial.maxWeightedMemoryMb)),
  };
  const adaptiveVerificationGate = {
    minimumImprovementPct: DVF_0476_MIN_IMPROVEMENT_PCT,
    makespanImprovementPct,
    blockedTimeImprovementPct,
    crossRepoFairness: crossRepoFairness.adaptive,
    interactiveResponsive,
    hardBudgetRespected,
    passed: (makespanImprovementPct >= DVF_0476_MIN_IMPROVEMENT_PCT
      || blockedTimeImprovementPct >= DVF_0476_MIN_IMPROVEMENT_PCT)
      && crossRepoFairness.adaptive
      && crossRepoFairness.noStarvation
      && interactiveResponsive
      && hardBudgetRespected,
  };
  assert.equal(adaptiveVerificationGate.passed, true, `adaptive 3+3 gate failed: ${JSON.stringify(adaptiveVerificationGate)}`);

  const result = {
    dvf0476: {
      agentSplit: DVF_0476_AGENT_SPLIT,
      minimumImprovementPct: DVF_0476_MIN_IMPROVEMENT_PCT,
      trials: DVF_0476_TRIAL_MULTIPLIERS.length,
      workloadMix: virtualWorkloads.map(({ id, repo, verificationClass, sharedResource, durationMs }) => ({ id, repo, verificationClass, sharedResource, durationMs })),
      machine: {
        platform: process.platform,
        node: process.version,
        logicalCpuCount: os.cpus().length,
        totalMemoryMb: Math.round(os.totalmem() / 1024 ** 2),
      },
    },
    fixedBaseline,
    adaptiveCandidate,
    adaptiveVerificationGate,
    crossRepoFairness,
    sessions: workspaces.length,
    sharedRoot: { wallMs: sharedWallMs, queueWaitP95Ms: sharedWaitP95Ms, workspaceLockWaitP95Ms: sharedLockWait.p95Ms, initialConcurrentStarts: sharedInitialStarts, maxActiveWrites: sharedMaxActive, workspaceLockBlocked: sharedQueuedBlockers.length },
    isolated: { wallMs: isolatedWallMs, queueWaitP95Ms: isolatedWaitP95Ms, workspaceLockWaitP95Ms: isolatedLockWait.p95Ms, initialConcurrentStarts: isolatedInitialStarts, maxActiveWrites: isolatedMaxActive, workspaceLockBlocked: 0, workflowWallMs: isolatedWorkflowWallMs, throughputSessionsPerSecond: isolatedThroughputSessionsPerSecond },
    sameWorkspace: { serialized: sameWorkspaceMaxActive === 1, blocker: sameWorkspaceQueued?.waitType || null },
    verifyCapacity: { limit: 2, maxActive: maxActiveVerify, capacityQueued: capacityQueued.length, processSpawns: verifyProcessSpawns, throughputPerSecond: verificationThroughputPerSecond },
    interactive: {
      samples: interactiveReadLatenciesMs.length,
      p50Ms: interactiveP50Ms,
      p95Ms: interactiveP95Ms,
      maxMs: Math.max(...interactiveReadLatenciesMs),
      dvf0443BaselineP95Ms: DVF_0443_INTERACTIVE_P95_BASELINE_MS,
      p95ImprovementPct: interactiveP95ImprovementPct,
    },
    waitDominatedCall,
    phases: phaseTelemetry,
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
