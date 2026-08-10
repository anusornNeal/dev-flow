import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-verification-benchmark-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'benchmark.sqlite');
let closeDatabase: (() => void) | null = null;

const now = () => Date.now();
const compactCommandMetrics = (result: any, wallMs: number, queueWaitMs = 0) => ({
  ok: result?.ok === true,
  wallMs,
  queueWaitMs,
  executionMs: Number(result?.performance?.executionMs ?? result?.durationMs ?? 0),
  resolutionMs: Number(result?.performance?.resolutionMs ?? 0),
  cacheLookupMs: Number(result?.performance?.cacheLookupMs ?? 0),
  processStartupMs: result?.performance?.processStartupMs == null ? null : Number(result.performance.processStartupMs),
  resultNormalizationMs: Number(result?.performance?.resultNormalizationMs ?? 0),
  totalMs: Number(result?.performance?.totalMs ?? wallMs),
  processSpawns: Number(result?.processSpawns ?? 0),
  cacheHit: result?.cache?.hit === true,
});

const percentile = (values: number[], percentileValue: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
};

const summarizeLatency = (values: number[]) => ({
  count: values.length,
  p50Ms: percentile(values, 50),
  p95Ms: percentile(values, 95),
  maxMs: values.length > 0 ? Math.max(...values) : 0,
});

function git(repo: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

try {
  const { executeAllMigrations } = await import('../src/db/migrations/index.js');
  const { default: db } = await import('../src/db/index.js');
  closeDatabase = () => db.close();
  executeAllMigrations();
  const { createProject } = await import('../src/server/repositories/projectRepository.js');
  const { runProjectCommand } = await import('../src/server/services/projectCommandService.js');
  const { applyAndVerifyAsync } = await import('../src/server/services/applyAndVerifyService.js');
  const { enqueueToolJob, getQueueMetrics, getToolJobStatus, waitForToolJob } = await import('../src/server/services/mcpToolJobService.js');
  const { readJobResult } = await import('../src/server/repositories/mcpToolJobRepository.js');

  const state: any = {
    projectsCache: [{ id: 'benchmark-devflow', name: 'DevFlow Benchmark', repoUrl: 'https://example.com/devflow', localPath: root }],
  };
  createProject({ id: 'benchmark-devflow', name: 'DevFlow Benchmark', repoUrl: 'https://example.com/devflow', localPath: root });

  let startedAt = now();
  const coldTypecheckResult = runProjectCommand(state, {
    projectId: 'benchmark-devflow',
    command: 'typecheck',
    responseMode: 'compact',
    forceFresh: true,
  });
  const coldTypecheck = compactCommandMetrics(coldTypecheckResult, now() - startedAt);

  startedAt = now();
  const warmTypecheckResult = runProjectCommand(state, {
    projectId: 'benchmark-devflow',
    command: 'typecheck',
    responseMode: 'compact',
  });
  const warmTypecheck = compactCommandMetrics(warmTypecheckResult, now() - startedAt);

  startedAt = now();
  const semanticAliasResult = runProjectCommand(state, {
    projectId: 'benchmark-devflow',
    command: 'lint',
    responseMode: 'compact',
  });
  const semanticAlias = compactCommandMetrics(semanticAliasResult, now() - startedAt);

  startedAt = now();
  const coldSafeResult = runProjectCommand(state, {
    projectId: 'benchmark-devflow',
    command: 'test-project-command',
    responseMode: 'compact',
    forceFresh: true,
  });
  const coldSafe = compactCommandMetrics(coldSafeResult, now() - startedAt);

  startedAt = now();
  const warmSafeResult = runProjectCommand(state, {
    projectId: 'benchmark-devflow',
    command: 'test-project-command',
    responseMode: 'compact',
    forceFresh: true,
  });
  const warmSafe = compactCommandMetrics(warmSafeResult, now() - startedAt);

  const beforeSingleFlight = getQueueMetrics().metrics.singleFlightHits;
  startedAt = now();
  const firstJob = enqueueToolJob(state, 'run_project_command', {
    projectId: 'benchmark-devflow',
    command: 'typecheck',
    responseMode: 'compact',
    forceFresh: true,
  }, 'repo-command');
  const secondJob = enqueueToolJob(state, 'run_project_command', {
    projectId: 'benchmark-devflow',
    command: 'typecheck',
    responseMode: 'compact',
    forceFresh: true,
  }, 'repo-command');
  await Promise.all([
    waitForToolJob(firstJob.jobId, 30_000),
    waitForToolJob(secondJob.jobId, 30_000),
  ]);
  const concurrentWallMs = now() - startedAt;
  const firstJobResult = readJobResult(firstJob.jobId)?.result as any;
  const firstJobStatus = getToolJobStatus(firstJob.jobId);
  const afterSingleFlight = getQueueMetrics().metrics.singleFlightHits;
  const concurrentTypecheck = {
    ...compactCommandMetrics(firstJobResult, concurrentWallMs, Number(firstJobStatus?.waitMs || 0)),
    sharedWith: secondJob.sharedWith || null,
    singleFlightHits: afterSingleFlight - beforeSingleFlight,
    underlyingProcessSpawns: Number(firstJobResult?.processSpawns ?? 0),
  };

  const multiChatRoot = path.join(tempRoot, 'multi-chat-repo');
  fs.mkdirSync(path.join(multiChatRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(multiChatRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(multiChatRoot, 'src', 'a.ts'), 'export const needleAlpha = 1;\n', 'utf8');
  fs.writeFileSync(path.join(multiChatRoot, 'src', 'b.ts'), 'export const needleBeta = 2;\n', 'utf8');
  fs.writeFileSync(path.join(multiChatRoot, 'src', 'c.ts'), 'export const needleGamma = 3;\n', 'utf8');
  fs.writeFileSync(path.join(multiChatRoot, 'scripts', 'slow-verify.mjs'), "await new Promise((resolve) => setTimeout(resolve, 2000));\n", 'utf8');
  fs.writeFileSync(path.join(multiChatRoot, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { typecheck: 'node scripts/slow-verify.mjs' },
  }, null, 2), 'utf8');
  git(multiChatRoot, ['init']);
  git(multiChatRoot, ['config', 'user.name', 'DevFlow Benchmark']);
  git(multiChatRoot, ['config', 'user.email', 'devflow-benchmark@example.com']);
  git(multiChatRoot, ['add', '.']);
  git(multiChatRoot, ['commit', '-m', 'initial']);
  createProject({ id: 'benchmark-multi-chat', name: 'Multi Chat Benchmark', repoUrl: 'https://example.com/multi-chat', localPath: multiChatRoot });
  const multiChatState: any = {
    projectsCache: [{ id: 'benchmark-multi-chat', name: 'Multi Chat Benchmark', repoUrl: 'https://example.com/multi-chat', localPath: multiChatRoot }],
  };

  const multiChatStartedAt = now();
  const verifyJob = enqueueToolJob(multiChatState, 'run_project_command', {
    projectId: 'benchmark-multi-chat',
    command: 'typecheck',
    responseMode: 'compact',
    forceFresh: true,
  }, 'repo-command');
  const verifyRunningDeadline = now() + 3000;
  while (getToolJobStatus(verifyJob.jobId)?.status === 'queued' && now() < verifyRunningDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (getToolJobStatus(verifyJob.jobId)?.status !== 'running') {
    throw new Error('Multi-chat benchmark verification did not enter running state.');
  }

  const readStartedAt = now();
  const readJobs = [
    ['needleAlpha', 'alpha'],
    ['needleBeta', 'beta'],
    ['needleGamma', 'gamma'],
  ].map(([query, label]) => enqueueToolJob(multiChatState, 'search_local_files', {
    projectId: 'benchmark-multi-chat',
    path: 'src',
    query,
    label,
    singleFlight: false,
  }, 'repo-read'));
  await Promise.all(readJobs.map((job) => waitForToolJob(job.jobId, 30_000)));
  const readWallMs = now() - readStartedAt;
  const verifyStatusAfterReads = getToolJobStatus(verifyJob.jobId)?.status;
  const readStatuses = readJobs.map((job) => getToolJobStatus(job.jobId));
  await waitForToolJob(verifyJob.jobId, 30_000);
  const verifyStatus = getToolJobStatus(verifyJob.jobId);
  const multiChat = {
    ok: verifyStatus?.status === 'succeeded' && readStatuses.every((status) => status?.status === 'succeeded'),
    wallMs: now() - multiChatStartedAt,
    verifyRunMs: Number(verifyStatus?.durationMs || 0),
    verifyWaitMs: Number(verifyStatus?.waitMs || 0),
    readWallMs,
    readWaitMs: readStatuses.map((status) => Number(status?.waitMs || 0)),
    maxReadWaitMs: Math.max(...readStatuses.map((status) => Number(status?.waitMs || 0))),
    readsFinishedBeforeVerify: verifyStatusAfterReads === 'running',
  };
  if (!multiChat.ok || !multiChat.readsFinishedBeforeVerify) {
    throw new Error(`Multi-chat benchmark failed: ${JSON.stringify(multiChat)}`);
  }

  const targetedRoot = path.join(tempRoot, 'targeted-repo');
  fs.mkdirSync(path.join(targetedRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(targetedRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(targetedRoot, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(targetedRoot, 'src', 'value.ts'), 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(path.join(targetedRoot, 'scripts', 'a.mjs'), "await new Promise((resolve) => setTimeout(resolve, 500));\n", 'utf8');
  fs.writeFileSync(path.join(targetedRoot, 'scripts', 'b.mjs'), "await new Promise((resolve) => setTimeout(resolve, 500));\n", 'utf8');
  fs.writeFileSync(path.join(targetedRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2), 'utf8');
  fs.writeFileSync(path.join(targetedRoot, '.devflow', 'commands.yaml'), [
    'commands:',
    '  target-a:',
    '    executable: node',
    '    args:',
    '      - scripts/a.mjs',
    '    category: test',
    '  target-b:',
    '    executable: node',
    '    args:',
    '      - scripts/b.mjs',
    '    category: test',
    '',
  ].join('\n'), 'utf8');
  git(targetedRoot, ['init']);
  git(targetedRoot, ['config', 'user.name', 'DevFlow Benchmark']);
  git(targetedRoot, ['config', 'user.email', 'devflow-benchmark@example.com']);
  git(targetedRoot, ['add', '.']);
  git(targetedRoot, ['commit', '-m', 'initial']);
  createProject({ id: 'benchmark-targeted', name: 'Targeted Benchmark', repoUrl: 'https://example.com/targeted', localPath: targetedRoot });
  const targetedState: any = {
    projectsCache: [{ id: 'benchmark-targeted', name: 'Targeted Benchmark', repoUrl: 'https://example.com/targeted', localPath: targetedRoot }],
  };
  startedAt = now();
  const targetedResult = await applyAndVerifyAsync(targetedState, {
    projectId: 'benchmark-targeted',
    files: [{ filePath: 'src/value.ts', edits: [{ type: 'replace', find: 'value = 1', replaceWith: 'value = 2' }] }],
    requestedCommands: ['target-a', 'target-b'],
    cacheVerificationResults: false,
    forceFresh: true,
  });
  const targetedWallMs = now() - startedAt;
  const targeted = {
    ok: targetedResult.ok === true,
    wallMs: targetedWallMs,
    summedExecutionMs: Number(targetedResult.verificationPerformance?.summedExecutionMs ?? 0),
    processSpawns: Number(targetedResult.verificationPerformance?.processSpawns ?? 0),
    parallelVerification: targetedResult.parallelVerification === true,
  };

  const resourceMixRoot = path.join(tempRoot, 'resource-mix-repo');
  fs.mkdirSync(path.join(resourceMixRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(resourceMixRoot, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(resourceMixRoot, 'scripts', 'heavy.mjs'), "await new Promise((resolve) => setTimeout(resolve, 900));\n", 'utf8');
  fs.writeFileSync(path.join(resourceMixRoot, 'scripts', 'fast.mjs'), "await new Promise((resolve) => setTimeout(resolve, 250));\n", 'utf8');
  fs.writeFileSync(path.join(resourceMixRoot, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { verify: 'node scripts/heavy.mjs' },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(resourceMixRoot, '.devflow', 'commands.yaml'), [
    'commands:',
    '  fast-check:',
    '    executable: node',
    '    args:',
    '      - scripts/fast.mjs',
    '    category: test',
    '',
  ].join('\n'), 'utf8');
  git(resourceMixRoot, ['init']);
  git(resourceMixRoot, ['config', 'user.name', 'DevFlow Benchmark']);
  git(resourceMixRoot, ['config', 'user.email', 'devflow-benchmark@example.com']);
  git(resourceMixRoot, ['add', '.']);
  git(resourceMixRoot, ['commit', '-m', 'initial']);
  createProject({ id: 'benchmark-resource-mix', name: 'Resource Mix Benchmark', repoUrl: 'https://example.com/resource-mix', localPath: resourceMixRoot });
  const resourceMixState: any = {
    projectsCache: [{ id: 'benchmark-resource-mix', name: 'Resource Mix Benchmark', repoUrl: 'https://example.com/resource-mix', localPath: resourceMixRoot }],
  };

  const resourceMixStartedAt = now();
  const heavyJob = enqueueToolJob(resourceMixState, 'run_project_command', {
    projectId: 'benchmark-resource-mix',
    command: 'verify',
    responseMode: 'compact',
    forceFresh: true,
    singleFlight: false,
  }, 'repo-command');
  const heavyRunningDeadline = now() + 3000;
  while (getToolJobStatus(heavyJob.jobId)?.status === 'queued' && now() < heavyRunningDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (getToolJobStatus(heavyJob.jobId)?.status !== 'running') {
    throw new Error('Resource-mix heavy verification did not enter running state.');
  }

  const queuedJobs = [
    { kind: 'heavy' as const, jobId: heavyJob.jobId, queuedAt: resourceMixStartedAt },
    ...Array.from({ length: 3 }, () => {
      const queuedAt = now();
      const job = enqueueToolJob(resourceMixState, 'run_project_command', {
        projectId: 'benchmark-resource-mix',
        command: 'fast-check',
        responseMode: 'compact',
        forceFresh: true,
        singleFlight: false,
      }, 'repo-command');
      return { kind: 'fast' as const, jobId: job.jobId, queuedAt };
    }),
  ];

  const activeVerifySamples: number[] = [];
  let sampleResourceMix = true;
  const sampler = (async () => {
    while (sampleResourceMix) {
      activeVerifySamples.push(Number(getQueueMetrics().capacity?.verify?.active || 0));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  const completedJobs = await Promise.all(queuedJobs.map(async (entry) => {
    await waitForToolJob(entry.jobId, 30_000);
    return {
      ...entry,
      completedAt: now(),
      status: getToolJobStatus(entry.jobId),
    };
  }));
  sampleResourceMix = false;
  await sampler;

  const summarizeResourceJobs = (kind: 'fast' | 'heavy') => {
    const jobs = completedJobs.filter((entry) => entry.kind === kind);
    return {
      wall: summarizeLatency(jobs.map((entry) => Math.max(0, entry.completedAt - entry.queuedAt))),
      capacityWait: summarizeLatency(jobs.map((entry) => Number(entry.status?.phaseTimings?.capacityWaitMs || 0))),
      queueWait: summarizeLatency(jobs.map((entry) => Number(entry.status?.phaseTimings?.queueWaitMs ?? entry.status?.waitMs ?? 0))),
      execution: summarizeLatency(jobs.map((entry) => Number(entry.status?.phaseTimings?.executionMs ?? entry.status?.durationMs ?? 0))),
    };
  };
  const resourceMix = {
    ok: completedJobs.every((entry) => entry.status?.status === 'succeeded'),
    currentVerifyCapacity: Number(getQueueMetrics().capacity?.verify?.capacity || 0),
    maxConcurrentProcesses: activeVerifySamples.length > 0 ? Math.max(...activeVerifySamples) : 0,
    totalWallMs: now() - resourceMixStartedAt,
    fast: summarizeResourceJobs('fast'),
    heavy: summarizeResourceJobs('heavy'),
  };
  if (!resourceMix.ok) {
    throw new Error(`Resource-mix benchmark failed: ${JSON.stringify(resourceMix)}`);
  }

  let full: any = null;
  if (process.argv.includes('--full')) {
    startedAt = now();
    const coldFullResult = runProjectCommand(state, {
      projectId: 'benchmark-devflow',
      command: 'verify',
      responseMode: 'compact',
      forceFresh: true,
      timeoutMs: 300_000,
    });
    const coldFull = compactCommandMetrics(coldFullResult, now() - startedAt);

    startedAt = now();
    const warmFullResult = runProjectCommand(state, {
      projectId: 'benchmark-devflow',
      command: 'verify',
      responseMode: 'compact',
      forceFresh: true,
      timeoutMs: 300_000,
    });
    const warmFull = compactCommandMetrics(warmFullResult, now() - startedAt);
    full = { cold: coldFull, warm: warmFull };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseline: {
      recentRunProjectCommandP50Ms: 11_987,
      recentRunProjectCommandP95Ms: 20_130,
      preChangeObservedReadQueueWaitMs: 45_722,
      preChangeColdTypecheckMs: 7_336,
      preChangeColdLintMs: 7_391,
      preChangeIncompleteFullVerifyMs: 70_471,
    },
    after: {
      lanes: {
        fast: { command: 'typecheck', cold: coldTypecheck, warm: warmTypecheck },
        safe: { command: 'test-project-command', cold: coldSafe, warm: warmSafe },
        full: { command: 'verify', runs: full, enabled: process.argv.includes('--full') },
      },
      semanticAlias,
      concurrentTypecheck,
      multiChat,
      targeted,
      resourceMix,
      full,
    },
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    closeDatabase?.();
  } catch (error) {
    console.error(`[benchmark] database close warning: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    console.error(`[benchmark] cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
  }
}
