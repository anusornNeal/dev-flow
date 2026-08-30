import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-mcp-job-recovery-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.sqlite');
process.env.DEVFLOW_JOBS_DIR = path.join(tempRoot, 'jobs');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const repo = await import('../../src/server/repositories/mcpToolJobRepository.js') as any;
const runnerRegistry = await import('../../src/server/services/mcpToolJobRunnerRegistry.js') as any;
const jobService = await import('../../src/server/services/mcpToolJobService.js') as any;
const projectCommandService = await import('../../src/server/services/projectCommandService.js') as any;
const resourceProfiles = await import('../../src/server/services/verificationResourceProfileService.js') as any;

function createJob(label: string) {
  return repo.createJob(`job-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`, 'search_local_files', { query: label }, `repo:${label}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

test('mcp tool jobs persist lifecycle state in SQLite and survive repository cache reset', () => {
  const job = createJob('durable');
  const row = db.prepare('SELECT job_id, status, tool_name, resource_key FROM mcp_tool_jobs WHERE job_id = ?').get(job.jobId) as any;

  assert.equal(row.job_id, job.jobId);
  assert.equal(row.status, 'queued');
  assert.equal(row.tool_name, 'search_local_files');
  assert.equal(row.resource_key, 'repo:durable');

  repo.clearRecentJobCache();
  const reloaded = repo.getJob(job.jobId);
  assert.equal(reloaded?.jobId, job.jobId);
  assert.equal(reloaded?.status, 'queued');
});

test('claim and heartbeat are atomic and reject competing workers', () => {
  const job = createJob('claim');
  const firstClaim = repo.claimJob(job.jobId, 'worker-a', 30_000, 1_000);
  const competingClaim = repo.claimJob(job.jobId, 'worker-b', 30_000, 1_001);

  assert.equal(firstClaim?.status, 'running');
  assert.equal(firstClaim?.leaseOwner, 'worker-a');
  assert.equal(competingClaim, null);

  const heartbeat = repo.heartbeatJob(job.jobId, 'worker-a', 30_000, 2_000);
  assert.equal(heartbeat?.leaseOwner, 'worker-a');
  assert.equal(Date.parse(heartbeat?.leaseExpiresAt || ''), 32_000);
  assert.equal(repo.heartbeatJob(job.jobId, 'worker-b', 30_000, 2_001), null);
});

test('durable watchdog consumes adaptive verification budget above the legacy 300s cap', () => {
  resourceProfiles.clearVerificationResourceProfilesForTests();
  const root = fs.mkdtempSync(path.join(tempRoot, 'adaptive-deadline-repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node -e \"process.exit(0)\"' },
  }));
  const state = { projectsCache: [{ id: 'adaptive-deadline-project', name: 'Adaptive Deadline', repoUrl: 'https://example.com/adaptive-deadline', localPath: root }] } as any;
  const described = projectCommandService.describeProjectCommandResourceProfile(state, { localPath: root, command: 'test' });
  for (const durationMs of [330_000, 360_000, 390_000]) {
    resourceProfiles.recordVerificationResourceSample(described.resourceDescriptor, { status: 'succeeded', durationMs });
  }
  const deadline = jobService.__getDurableExecutionDeadlineDelayMsForTests({
    toolName: 'run_project_command',
    state,
    args: { localPath: root, command: 'test', infrastructureRetryPolicy: 'none' },
  });
  assert.ok(deadline?.executionBudgetMs > 300_000, `expected adaptive watchdog budget above 300s, got ${deadline?.executionBudgetMs}`);
  assert.equal(deadline?.delayMs, deadline.executionBudgetMs + deadline.reconciliationGraceMs);
  resourceProfiles.clearVerificationResourceProfilesForTests();
});

test('recovery deadline wins over a fresh heartbeat once run_project_command exceeds its execution budget', () => {
  db.prepare('DELETE FROM mcp_tool_jobs').run();
  repo.clearRecentJobCache();
  const root = fs.mkdtempSync(path.join(tempRoot, 'deadline-recovery-repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { typecheck: 'node -e "process.exit(0)"' },
  }));
  const state = { projectsCache: [{ id: 'deadline-project', name: 'Deadline', repoUrl: 'https://example.com/deadline', localPath: root }] } as any;
  const nowMs = Date.now();
  const job = repo.createJob(
    `job-deadline-${nowMs}`,
    'run_project_command',
    { localPath: root, command: 'typecheck', timeoutMs: 20, infrastructureRetryPolicy: 'none', singleFlight: false },
    `repo:${root}`,
  );
  const claimed = repo.claimJob(job.jobId, 'worker-live', 30_000, nowMs);
  assert.ok(claimed?.leaseGeneration);
  const heartbeat = repo.heartbeatJob(job.jobId, 'worker-live', 30_000, nowMs + 10, claimed.leaseGeneration);
  assert.ok(heartbeat?.leaseExpiresAt);
  assert.equal(Date.parse(heartbeat.leaseExpiresAt) > nowMs + 20_000, true, 'fixture heartbeat must remain fresh');
  repo.appendJobLog(job.jobId, 'stdout', '[Verify Step] project command service\n', { workerId: 'worker-live', leaseGeneration: claimed.leaseGeneration });

  db.prepare('UPDATE mcp_tool_jobs SET started_at = ? WHERE job_id = ?').run(new Date(nowMs - 5_000).toISOString(), job.jobId);
  repo.clearRecentJobCache();
  const summary = jobService.__runDurableJobRecoveryPassForTests(state, nowMs + 20);
  const terminal = repo.getJob(job.jobId);

  assert.equal(summary.interrupted >= 1, true);
  assert.equal(terminal?.status, 'timed_out');
  assert.equal(terminal?.recoveryClassification, 'interrupted');
  assert.match(String(terminal?.failureSummary || ''), /execution deadline/i);
  const deadlineResult = repo.readJobResult(job.jobId)?.result as any;
  assert.equal(deadlineResult?.code, 'JOB_EXECUTION_DEADLINE_EXCEEDED');
  assert.equal(deadlineResult?.executionDeadline?.executionBudgetMs, 20);
  assert.equal(deadlineResult?.executionDeadline?.reconciliationGraceMs, 100);
  assert.equal(deadlineResult?.executionDeadline?.totalDeadlineMs, 120);
  assert.equal(deadlineResult?.executionDeadline?.lastActivePhase, 'execution');
  assert.match(String(deadlineResult?.executionDeadline?.lastLog || ''), /project command service/);
  assert.equal(deadlineResult?.executionDeadline?.childTermination?.status, 'unavailable');
  assert.equal(deadlineResult?.executionDeadline?.childTermination?.attempted, false);
  assert.deepEqual(deadlineResult?.executionDeadline?.attempt, {
    retryAttempt: 0,
    infrastructureRetryPolicy: 'none',
    recoveryProfile: false,
  });
});

test('live run_project_command watchdog captures cooperative child termination before fencing a wedged runner', async () => {
  db.prepare('DELETE FROM mcp_tool_jobs').run();
  repo.clearRecentJobCache();
  const root = fs.mkdtempSync(path.join(tempRoot, 'live-deadline-repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { typecheck: 'node -e "process.exit(0)"' },
  }));
  fs.writeFileSync(path.join(root, 'README.md'), '# live deadline fixture\n');
  git(root, ['init', '-b', 'develop']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);

  const state = { projectsCache: [{ id: 'live-deadline-project', name: 'Live Deadline', repoUrl: 'https://example.com/live-deadline', localPath: root }] } as any;
  const blocker = deferred();
  jobService.__setToolJobTestRunner('run_project_command', async (_state: any, _args: any, _logger: any, setCancelFn: (fn: () => unknown) => void) => {
    setCancelFn(() => {
      blocker.resolve();
      return {
        mode: 'test-stuck-child',
        attempted: true,
        treeTermination: true,
        terminated: false,
        terminationError: 'child did not acknowledge termination',
      };
    });
    await blocker.promise;
    return { ok: true, status: 'succeeded' };
  });

  const job = jobService.enqueueToolJob(state, 'run_project_command', {
    localPath: root,
    command: 'typecheck',
    timeoutMs: 20,
    infrastructureRetryPolicy: 'none',
    singleFlight: false,
  }, 'repo-command');

  try {
    await waitUntil(() => repo.getJob(job.jobId)?.status === 'timed_out', 'Expected live watchdog to fence the wedged runner');
    const result = repo.readJobResult(job.jobId)?.result as any;
    assert.equal(result?.code, 'JOB_EXECUTION_DEADLINE_EXCEEDED');
    assert.equal(result?.executionDeadline?.childTermination?.status, 'reported');
    assert.equal(result?.executionDeadline?.childTermination?.attempted, true);
    assert.equal(result?.executionDeadline?.childTermination?.terminated, false);
    assert.equal(result?.executionDeadline?.childTermination?.mode, 'test-stuck-child');
    assert.match(String(result?.executionDeadline?.childTermination?.terminationError || ''), /did not acknowledge/);
  } finally {
    blocker.resolve();
    jobService.__setToolJobTestRunner('run_project_command', null);
  }
});

test('expired lease loses heartbeat and fenced-write authority before reaping', () => {
  const job = createJob('expired-authority');
  const claimed = repo.claimJob(job.jobId, 'worker-a', 1_000, 1_000);
  assert.equal(claimed?.leaseGeneration, 1);
  const guard = { workerId: 'worker-a', leaseGeneration: claimed.leaseGeneration };

  assert.equal(repo.heartbeatJob(job.jobId, 'worker-a', 30_000, 2_500, claimed.leaseGeneration), null);
  assert.equal(repo.appendJobLog(job.jobId, 'stdout', 'late progress\n', guard), false);
  assert.equal(repo.writeJobResult(job.jobId, { ok: true, stale: true }, guard), false);
  assert.equal(repo.readJobResult(job.jobId), null);
  assert.equal(repo.getDurableJobMetrics(2_500).fencedLateWrites >= 2, true);
});

test('terminal transitions are compare-and-set and cannot be overwritten', () => {
  const job = createJob('terminal');
  assert.ok(repo.claimJob(job.jobId, 'worker-a', 30_000, 1_000));

  const completed = repo.transitionJobStatus(job.jobId, ['running'], { status: 'succeeded' }, { workerId: 'worker-a', nowMs: 2_000 });
  assert.equal(completed?.status, 'succeeded');

  const lateFailure = repo.transitionJobStatus(job.jobId, ['running'], { status: 'failed', failureSummary: 'late worker' }, { workerId: 'worker-a', nowMs: 2_001 });
  assert.equal(lateFailure, null);
  assert.equal(repo.getJob(job.jobId)?.status, 'succeeded');
});

test('cancellation persists immediately and prevents future claims', () => {
  const job = createJob('cancel');
  const cancelled = repo.requestJobCancellation(job.jobId, 'user requested');

  assert.equal(cancelled?.status, 'cancelled');
  assert.ok(cancelled?.cancelRequestedAt);
  assert.equal(cancelled?.cancelReason, 'user requested');
  assert.equal(repo.claimJob(job.jobId, 'worker-a', 30_000, 5_000), null);

  repo.clearRecentJobCache();
  const reloaded = repo.getJob(job.jobId);
  assert.equal(reloaded?.status, 'cancelled');
  assert.equal(reloaded?.cancelReason, 'user requested');
});

test('expired running leases are listed for deterministic recovery while terminal jobs are excluded', () => {
  const stale = createJob('stale');
  assert.ok(repo.claimJob(stale.jobId, 'worker-a', 500, 1_000));

  const succeeded = createJob('done');
  assert.ok(repo.claimJob(succeeded.jobId, 'worker-a', 30_000, 1_000));
  assert.ok(repo.transitionJobStatus(succeeded.jobId, ['running'], { status: 'succeeded' }, { workerId: 'worker-a', nowMs: 1_100 }));

  const recoverable = repo.listRecoverableJobs(2_000);
  assert.ok(recoverable.some((entry: any) => entry.jobId === stale.jobId));
  assert.equal(recoverable.some((entry: any) => entry.jobId === succeeded.jobId), false);
});

test('builtin recovery policy retries only explicitly safe read jobs', () => {
  assert.equal(runnerRegistry.getBuiltinToolJobRecoveryPolicy('search_local_files'), 'retryable');
  assert.equal(runnerRegistry.getBuiltinToolJobRecoveryPolicy('apply_prepared_edit'), 'interrupted');
  assert.equal(runnerRegistry.getBuiltinToolJobRecoveryPolicy('commit_git_changes'), 'interrupted');
  assert.equal(runnerRegistry.getBuiltinToolJobRecoveryPolicy('run_project_command'), 'interrupted');
  assert.equal(runnerRegistry.getBuiltinToolJobRecoveryPolicy('continue_task_execution_tail'), 'retryable');
});

test('service execution owns a durable lease and persisted cancellation wins over late completion', async () => {
  db.prepare('DELETE FROM mcp_tool_jobs').run();
  repo.clearRecentJobCache();
  const root = fs.mkdtempSync(path.join(tempRoot, 'lease-repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'lease-fixture' }));
  const state = { projects: [{ id: 'lease-project', name: 'Lease', localPath: root }] } as any;
  const blocker = deferred();
  const toolName = `test_lease_${Date.now()}`;

  jobService.__setToolJobTestRunner(toolName, async (_state: any, _args: any, _logger: any, setCancelFn: (fn: () => void) => void) => {
    setCancelFn(() => blocker.resolve());
    await blocker.promise;
    return { ok: true, late: true };
  });

  const job = jobService.enqueueToolJob(state, toolName, { localPath: root, singleFlight: false }, 'repo-read');
  try {
    await waitUntil(() => repo.getJob(job.jobId)?.status === 'running', 'Expected service-owned job to run');
    const running = repo.getJob(job.jobId);
    assert.ok(running?.leaseOwner);
    assert.ok(running?.leaseExpiresAt);
    assert.ok(Date.parse(running.leaseExpiresAt) > Date.now());

    assert.equal(jobService.cancelToolJob(job.jobId), true);
    const cancelled = repo.getJob(job.jobId);
    assert.equal(cancelled?.status, 'cancelled');
    assert.ok(cancelled?.cancelRequestedAt);
    assert.equal(cancelled?.leaseOwner, undefined);

    blocker.resolve();
    await waitUntil(() => !jobService.getJobMetrics().activeJobs.some((entry: any) => entry.jobId === job.jobId), 'Expected cancelled worker to finish');
    assert.equal(repo.getJob(job.jobId)?.status, 'cancelled');
  } finally {
    blocker.resolve();
    jobService.__setToolJobTestRunner(toolName, null);
  }
});

test('artifact metadata remains durable and result/log artifacts stay readable after cache reset', () => {
  db.prepare('DELETE FROM mcp_tool_jobs').run();
  repo.clearRecentJobCache();
  const job = createJob('artifacts');

  repo.appendJobLog(job.jobId, 'stdout', 'hello durable log\n');
  repo.writeJobResult(job.jobId, { ok: true, patch: 'diff --git a/a b/a\n' });
  repo.clearRecentJobCache();

  const reloaded = repo.getJob(job.jobId);
  assert.ok((reloaded?.stdoutBytes || 0) > 0);
  assert.ok((reloaded?.resultBytes || 0) > 0);
  assert.ok(reloaded?.resultSha256);
  assert.ok((reloaded?.patchBytes || 0) > 0);
  assert.ok(reloaded?.patchSha256);
  assert.match(repo.readJobLog(job.jobId, 'stdout').log, /hello durable log/);
  assert.equal(repo.readJobResult(job.jobId)?.result?.ok, true);
});

test('queue diagnostics derive queued and running counts from durable rows without in-memory queue entries', () => {
  db.prepare('DELETE FROM mcp_tool_jobs').run();
  repo.clearRecentJobCache();
  const queued = createJob('durable-queued');
  const running = createJob('durable-running');
  assert.ok(repo.claimJob(running.jobId, 'external-worker', 30_000));

  const queueMetrics = jobService.getQueueMetrics();
  const jobMetrics = jobService.getJobMetrics();
  assert.equal(queueMetrics.metrics.durable.queued, 1);
  assert.equal(queueMetrics.metrics.durable.running, 1);
  assert.equal(jobMetrics.queueDepth, 1);
  assert.equal(jobMetrics.metrics.durable.running, 1);
  assert.equal(repo.getJob(queued.jobId)?.status, 'queued');
});

test('recovery classification survives terminal completion and recovered metrics exclude normal terminal jobs', () => {
  db.prepare('DELETE FROM mcp_tool_jobs').run();
  repo.clearRecentJobCache();

  const recovered = createJob('classification-recovered');
  repo.setJobRecoveryClassification(recovered.jobId, 'retryable');
  assert.ok(repo.claimJob(recovered.jobId, 'worker-a', 30_000));
  assert.ok(repo.transitionJobStatus(recovered.jobId, ['running'], { status: 'succeeded' }, { workerId: 'worker-a' }));

  const normal = createJob('classification-normal');
  repo.updateJobStatus(normal.jobId, { status: 'succeeded' });

  assert.equal(repo.getJob(recovered.jobId)?.recoveryClassification, 'retryable');
  assert.equal(repo.getJob(normal.jobId)?.recoveryClassification, 'terminal');
  assert.equal(repo.getDurableJobMetrics().recovered, 1);
});

test('startup recovery resumes queued jobs, retries stale safe reads, and interrupts stale mutations exactly once', async () => {
  db.prepare('DELETE FROM mcp_tool_jobs').run();
  repo.clearRecentJobCache();
  fs.rmSync(process.env.DEVFLOW_JOBS_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.DEVFLOW_JOBS_DIR!, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'recovery-fixture' }));
  const state = { projects: [{ id: 'recovery-project', name: 'Recovery', localPath: root }] } as any;
  const blocker = deferred();
  const starts: string[] = [];

  jobService.__setToolJobTestRunner('search_local_files', async (_state: any, args: any) => {
    starts.push(args.query);
    await blocker.promise;
    return { ok: true, query: args.query };
  });

  const queued = repo.createJob(`job-queued-${Date.now()}`, 'search_local_files', { localPath: root, query: 'queued', singleFlight: false }, `repo:${root}`);
  const retryable = repo.createJob(`job-retry-${Date.now()}`, 'search_local_files', { localPath: root, query: 'retry', singleFlight: false }, `repo:${root}`);
  assert.ok(repo.claimJob(retryable.jobId, 'dead-worker', 1_000, Date.now() - 10_000));

  const interrupted = repo.createJob(`job-interrupted-${Date.now()}`, 'commit_git_changes', { localPath: root, message: 'unsafe retry' }, `repo:${root}`);
  assert.ok(repo.claimJob(interrupted.jobId, 'dead-worker', 1_000, Date.now() - 10_000));

  const terminal = repo.createJob(`job-terminal-${Date.now()}`, 'search_local_files', { localPath: root, query: 'done' }, `repo:${root}`);
  repo.updateJobStatus(terminal.jobId, { status: 'succeeded' });

  const failed = repo.createJob(`job-failed-${Date.now()}`, 'search_local_files', { localPath: root, query: 'failed' }, `repo:${root}`);
  repo.updateJobStatus(failed.jobId, { status: 'failed', failureSummary: 'previous failure' });

  const timedOut = repo.createJob(`job-timeout-${Date.now()}`, 'search_local_files', { localPath: root, query: 'timed-out' }, `repo:${root}`);
  repo.updateJobStatus(timedOut.jobId, { status: 'timed_out', failureSummary: 'previous timeout' });

  const cancelled = repo.createJob(`job-cancelled-${Date.now()}`, 'search_local_files', { localPath: root, query: 'cancelled' }, `repo:${root}`);
  repo.requestJobCancellation(cancelled.jobId, 'cancel before restart');

  try {
    const first = jobService.initMcpToolJobs(state);
    await waitUntil(() => starts.includes('queued') && starts.includes('retry'), 'Expected recovered queued/retryable jobs to resume');

    assert.equal(repo.getJob(queued.jobId)?.recoveryClassification, 'resumable');
    assert.equal(repo.getJob(retryable.jobId)?.recoveryClassification, 'retryable');
    assert.equal(repo.getJob(interrupted.jobId)?.status, 'failed');
    assert.equal(repo.getJob(interrupted.jobId)?.recoveryClassification, 'interrupted');
    assert.equal(repo.getJob(terminal.jobId)?.status, 'succeeded');
    assert.equal(repo.getJob(failed.jobId)?.status, 'failed');
    assert.equal(repo.getJob(timedOut.jobId)?.status, 'timed_out');
    assert.equal(repo.getJob(cancelled.jobId)?.status, 'cancelled');
    assert.equal(first.interrupted, 1);

    const second = jobService.initMcpToolJobs(state);
    assert.equal(second.interrupted, 0);
    assert.equal(repo.getJob(terminal.jobId)?.status, 'succeeded');
    assert.equal(repo.getJob(failed.jobId)?.status, 'failed');
    assert.equal(repo.getJob(timedOut.jobId)?.status, 'timed_out');
    assert.equal(repo.getJob(cancelled.jobId)?.status, 'cancelled');
    assert.equal(starts.filter((value) => value === 'queued').length, 1);
    assert.equal(starts.filter((value) => value === 'retry').length, 1);
  } finally {
    blocker.resolve();
    jobService.__setToolJobTestRunner('search_local_files', null);
  }
});
