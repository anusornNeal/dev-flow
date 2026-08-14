import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-health-'));
process.env.DEVFLOW_DB_PATH = path.join(os.tmpdir(), `devflow-health-db-${path.basename(tempRoot)}.sqlite`);
process.env.DEVFLOW_JOBS_DIR = path.join(os.tmpdir(), `devflow-health-jobs-${path.basename(tempRoot)}`);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');

const { getWorkflowHealth } = await import('../../src/server/services/workflowHealthService.js');
const { getToolDefinitionByName } = await import('../../src/server/contracts/devflowContract.js');
const serverEvents = await import('../../src/server/services/serverEventService.js');
const { clearToolCallRecords, recordToolCall, flushPerformanceTelemetry } = await import('../../src/server/services/mcpToolMonitor.js');
const { default: db } = await import('../../src/db/index.js');
const {
  createJob,
  updateJobStatus,
  clearRecentJobCache,
  getRecentJobCacheStats,
  claimJob,
  requeueJobForRecovery,
  requestJobCancellation,
} = await import('../../src/server/repositories/mcpToolJobRepository.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function createRepo(name: string) {
  const repo = path.join(tempRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'DevFlow Test']);
  git(repo, ['config', 'user.email', 'devflow@example.com']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'initial']);
  createProject({ id: 'project-health', name: 'Health Fixture', repoUrl: 'https://example.com/health', localPath: repo });
  return repo;
}

function stateFor(repo: string): any {
  return {
    projectsCache: [{ id: 'project-health', name: 'Health Fixture', repoUrl: 'https://example.com/health', localPath: repo }],
  };
}

test('getWorkflowHealth returns ok for a clean repo', () => {
  const repo = createRepo('clean');
  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.git.clean, true);
  assert.equal(result.capabilities.keyToolsPresent.get_repo_context_bundle, true);
  assert.equal(result.capabilities.asyncToolCount > 0, true);
  assert.equal(typeof result.diagnostics.isolation.waits.workspaceLockWait.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.waits.capacityWait.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.phases.admissionWait.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.phases.queueWait.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.phases.execution.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.phases.responseHandoff.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.workspaces.known, 'number');
  assert.equal(typeof result.diagnostics.isolation.integrations.conflicts, 'number');
});

test('compact health preserves operational warnings while cutting response bytes by at least half', () => {
  const repo = createRepo('compact-shape');
  const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
  const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
  const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');

  assert.equal(compact.ok, true);
  assert.equal(compact.status, 'ok');
  assert.equal(compact.git.clean, true);
  assert.equal(compact.git.operation.blocked, false);
  assert.equal(typeof compact.queue.depth, 'number');
  assert.equal(typeof compact.queue.capacity.saturated, 'boolean');
  assert.equal(typeof compact.runtime.search.backend, 'string');
  assert.equal(compact.runtime.capabilities.keyToolsPresent.get_repo_context_bundle, true);
  assert.equal(Array.isArray(compact.regressions), true);
  assert.equal(typeof compact.recovery.hasVerifiedGoodBackup, 'boolean');
  assert.equal(Array.isArray(compact.recommendations), true);
  assert.equal(compact.diagnostics, undefined, 'compact mode must omit deep diagnostics');
  assert.equal(compact.capabilities, undefined, 'compact mode must omit the full capability packet');
  assert.equal(compactBytes <= fullBytes * 0.5, true, `expected compact <=50% of full (${compactBytes} vs ${fullBytes})`);
  assert.equal(compactBytes <= 3_000, true, `expected ordinary compact health <=3KB, got ${compactBytes} bytes`);
  console.log(`[health-bytes] full=${fullBytes} compact=${compactBytes} reduction=${Math.round((1 - compactBytes / fullBytes) * 100)}%`);
});

test('compact health keeps grouped failure and recovery warning context without verbose examples', () => {
  const repo = createRepo('compact-warning');
  createJob('job-health-compact-failed', 'run_project_command', { command: 'verify' }, `repo:${repo}`);
  updateJobStatus('job-health-compact-failed', { status: 'failed', failureSummary: 'synthetic compact failure' });

  const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
  const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'summary' }) as any;
  const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');
  assert.equal(compact.status, 'warning');
  assert.equal(compact.failures.total > 0, true);
  assert.equal(compact.failures.groups.some((group: any) => group.toolName === 'run_project_command'), true);
  assert.equal(compact.failures.groups.some((group: any) => 'examples' in group), false);
  assert.equal(compact.recovery.hasVerifiedGoodBackup, false);
  assert.match(compact.recommendations.join('\n'), /run_project_command/);
  assert.equal(compactBytes <= fullBytes * 0.5, true, `expected warning compact <=50% of full (${compactBytes} vs ${fullBytes})`);
  db.prepare('DELETE FROM mcp_tool_jobs WHERE job_id = ?').run('job-health-compact-failed');
  clearRecentJobCache();
});

test('compact health surfaces active current SLO regressions without historical payloads', () => {
  const repo = createRepo('compact-current-regression');
  clearToolCallRecords();
  const now = Date.now();
  for (let index = 0; index < 3; index += 1) {
    recordToolCall({
      toolName: 'search_local_files',
      args: { projectId: 'project-health' },
      status: 200,
      durationMs: 1_500 + index,
      timestamp: now - 10 + index,
    });
  }
  const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact', windowMs: 1_000 }) as any;
  assert.equal(compact.status, 'warning');
  assert.equal(compact.regressions.some((entry: any) => entry.toolName === 'search_local_files' && entry.status === 'regressed'), true);
  assert.equal(compact.diagnostics, undefined);
  assert.match(compact.recommendations.join('\n'), /Performance SLO regression/);
  clearToolCallRecords();
});

test('full and debug health modes preserve the detailed diagnostic shape', () => {
  const repo = createRepo('full-debug-shape');
  for (const responseMode of ['full', 'debug']) {
    const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode }) as any;
    assert.equal(typeof result.capabilities.toolCount, 'number');
    assert.equal(typeof result.diagnostics.isolation.phases.queueWait.p95Ms, 'number');
    assert.equal(Array.isArray(result.diagnostics.performance.history.comparisons), true);
    assert.equal(Array.isArray(result.diagnostics.failedJobSummaries), true);
  }
});

test('devflow_health_check contract defaults MCP requests to compact and permits explicit full diagnostics', () => {
  const tool = getToolDefinitionByName('devflow_health_check');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema?.properties?.responseMode?.enum, ['compact', 'summary', 'full', 'debug']);
  assert.equal(tool.buildHttpRequest({ projectId: 'project-health' }).path.includes('responseMode=compact'), true);
  assert.equal(tool.buildHttpRequest({ projectId: 'project-health', responseMode: 'full' }).path.includes('responseMode=full'), true);
});


test('workflow health exposes bounded sanitized tunnel failure timeline in full and compact modes', () => {
  const repo = createRepo('tunnel-evidence');
  const previousAppRoot = process.env.DEVFLOW_APP_ROOT;
  const runtimeRoot = path.join(tempRoot, 'tunnel-evidence-runtime');
  const runtimeDir = path.join(runtimeRoot, '.devflow');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'supervisor-state.json'), JSON.stringify({
    version: 1,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:02:00.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      ngrok: { label: 'ngrok', status: 'running', pid: 200, restartAttempt: 0 },
    },
    tunnelHealth: { status: 'degraded', generation: 'B', consecutiveProbeFailures: 2 },
  }), 'utf8');
  const evidence = [
    { at: '2026-08-13T00:01:00.000Z', kind: 'public-probe-failure', failureClass: 'timeout', latencyMs: 5000, generation: 'B', consecutiveProbeFailures: 1, recoveryDecision: 'threshold-not-reached', url: 'https://secret.ngrok-free.app' },
    { at: '2026-08-13T00:01:01.000Z', kind: 'public-probe-failure', failureClass: 'rate-limit', statusCode: 429, latencyMs: 80, generation: 'B', consecutiveProbeFailures: 2, recoveryDecision: 'threshold-not-reached', retryAfter: '120', token: 'secret-token' },
    { at: '2026-08-13T00:01:02.000Z', kind: 'public-probe-failure', failureClass: 'http-5xx', statusCode: 503, latencyMs: 90, generation: 'B', consecutiveProbeFailures: 3, recoveryDecision: 'restart-ngrok', body: 'raw-secret-body' },
    { at: '2026-08-13T00:01:03.000Z', kind: 'ngrok-pressure', generation: 'B', pressure: { connectionCount: 12, activeConnections: 2, connectionRate1: 1.5, requestCount: 30, requestRate1: 4.5 }, rawRequestHistory: 'request-secret' },
  ];
  fs.writeFileSync(path.join(runtimeDir, 'ngrok-diagnostics.jsonl'), `${evidence.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  process.env.DEVFLOW_APP_ROOT = runtimeRoot;
  try {
    const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
    const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
    const failures = full.diagnostics.runtimeSupervisor.tunnel.recentFailures;
    assert.equal(failures.length, 3);
    assert.deepEqual(failures.map((entry: any) => entry.failureClass), ['http-5xx', 'rate-limit', 'timeout']);
    assert.equal(full.diagnostics.runtimeSupervisor.tunnel.pressure.requestRate1, 4.5);
    assert.equal(compact.runtime.supervisor.recentTunnelFailures.length, 3);
    assert.equal(compact.runtime.supervisor.recentTunnelFailures[1].retryAfter, '120');
    assert.equal(compact.runtime.supervisor.pressure.activeConnections, 2);
    const rendered = JSON.stringify({ full: full.diagnostics.runtimeSupervisor.tunnel, compact: compact.runtime.supervisor });
    assert.doesNotMatch(rendered, /secret\.ngrok|secret-token|raw-secret-body|request-secret/i);
  } finally {
    if (previousAppRoot === undefined) delete process.env.DEVFLOW_APP_ROOT;
    else process.env.DEVFLOW_APP_ROOT = previousAppRoot;
  }
});

test('getWorkflowHealth reports fallback search backend when ripgrep is unavailable', () => {
  const repo = createRepo('search-backend');
  const previous = {
    path: process.env.PATH,
    appRoot: process.env.DEVFLOW_APP_ROOT,
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env.ProgramFiles,
  };
  process.env.PATH = '';
  process.env.DEVFLOW_APP_ROOT = path.join(repo, 'missing-app-root');
  process.env.LOCALAPPDATA = path.join(repo, 'missing-local-app-data');
  process.env.ProgramFiles = path.join(repo, 'missing-program-files');
  try {
    const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
    assert.equal(result.capabilities.search.backend, 'fallback');
    assert.equal(result.capabilities.search.fallbackAvailable, true);
  } finally {
    process.env.PATH = previous.path;
    if (previous.appRoot === undefined) delete process.env.DEVFLOW_APP_ROOT; else process.env.DEVFLOW_APP_ROOT = previous.appRoot;
    if (previous.localAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous.localAppData;
    if (previous.programFiles === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = previous.programFiles;
  }
});

test('getWorkflowHealth warns for a dirty repo', () => {
  const repo = createRepo('dirty');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');
  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'warning');
  assert.equal(result.git.clean, false);
  assert.match(result.recommendations.join('\n'), /Working tree/);
});

test('getWorkflowHealth blocks a real unresolved merge and recovers after abort', () => {
  const repo = createRepo('merge-conflict');
  const baseBranch = git(repo, ['branch', '--show-current']);

  git(repo, ['checkout', '-b', 'conflicting-side']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'side\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'side change']);

  git(repo, ['checkout', baseBranch]);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base branch\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'base change']);

  const merge = spawnSync('git', ['merge', 'conflicting-side'], { cwd: repo, encoding: 'utf8', shell: false });
  assert.notEqual(merge.status, 0, 'fixture must create a real merge conflict');

  const blocked = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'error');
  assert.equal(blocked.git.operation.blocked, true);
  assert.equal(blocked.git.operation.code, 'GIT_OPERATION_IN_PROGRESS');
  assert.equal(blocked.git.operation.kind, 'merge');
  assert.equal(blocked.git.operation.unmergedPathCount, 1);
  assert.deepEqual(blocked.git.operation.unmergedPaths, ['base.txt']);
  assert.match(blocked.recommendations.join('\n'), /do not start unrelated write\/integration work/i);

  git(repo, ['merge', '--abort']);
  const recovered = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.git.operation.blocked, false);
  assert.equal(recovered.git.operation.unmergedPathCount, 0);
});

test('getWorkflowHealth detects rebase, cherry-pick, and revert operation markers', () => {
  const cases = [
    { kind: 'rebase', marker: 'rebase-merge', directory: true },
    { kind: 'cherry-pick', marker: 'CHERRY_PICK_HEAD', directory: false },
    { kind: 'revert', marker: 'REVERT_HEAD', directory: false },
  ];

  for (const fixture of cases) {
    const repo = createRepo(`operation-${fixture.kind}`);
    const markerPath = path.resolve(repo, git(repo, ['rev-parse', '--git-path', fixture.marker]));
    if (fixture.directory) fs.mkdirSync(markerPath, { recursive: true });
    else fs.writeFileSync(markerPath, `${git(repo, ['rev-parse', 'HEAD'])}\n`);

    const blocked = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
    assert.equal(blocked.status, 'error', fixture.kind);
    assert.equal(blocked.git.operation.blocked, true, fixture.kind);
    assert.equal(blocked.git.operation.kind, fixture.kind, fixture.kind);
    assert.equal(blocked.git.operation.unmergedPathCount, 0, fixture.kind);

    fs.rmSync(markerPath, { recursive: true, force: true });
  }
});


test('getWorkflowHealth exposes phase timings without caching project git state', () => {
  const repo = createRepo('phase-freshness');
  const clean = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(typeof clean.performance.totalMs, 'number');
  assert.equal(typeof clean.performance.phases.diagnosticsMs, 'number');
  assert.equal(typeof clean.performance.phases.gitMs, 'number');

  fs.writeFileSync(path.join(repo, 'fresh-dirty.txt'), 'dirty now\n');
  const dirty = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(dirty.git.clean, false);
  assert.match(dirty.recommendations.join('\n'), /Working tree/);
});

test('getWorkflowHealth groups failed tool jobs by tool name', () => {
  const repo = createRepo('failed-tool-jobs');
  createJob('job-health-failed-1', 'run_project_command', { command: 'verify' }, `repo:${repo}`);
  updateJobStatus('job-health-failed-1', {
    status: 'failed',
    failureSummary: 'verify failed: lint error',
  });

  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'warning');
  assert.equal(result.diagnostics.failedJobs > 0, true);
  assert.equal(result.diagnostics.failedJobGroups[0].toolName, 'run_project_command');
  assert.equal(result.diagnostics.failedJobGroups[0].count >= 1, true);
  assert.match(result.recommendations.join('\n'), /run_project_command/);
});

test('workflow health exposes durable stale job state even when no in-memory runner owns it', () => {
  const repo = createRepo('durable-job-health');
  const jobId = 'job-health-stale-durable';
  createJob(jobId, 'search_local_files', { query: 'stale' }, `repo:${repo}`);
  assert.ok(claimJob(jobId, 'dead-worker', 1_000, Date.now() - 10_000));

  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.diagnostics.durableJobs.staleRunning >= 1, true);
  assert.equal(result.diagnostics.durableJobs.running >= 1, true);
  assert.match(result.recommendations.join('\n'), /stale MCP tool job lease/i);
});

test('workflow health publishes one regression event for a changed warning signature without refetch loops', () => {
  const repo = createRepo('health-event-dedup');
  const jobId = `job-health-event-${Date.now()}`;
  createJob(jobId, 'search_local_files', { query: 'event-dedup' }, `repo:${repo}`);
  assert.ok(claimJob(jobId, 'dead-worker-health-event', 1_000, Date.now() - 10_000));

  const observed: any[] = [];
  const subscription = serverEvents.subscribeServerEvents((event: any) => {
    if (event.type === 'health.regression') observed.push(event);
  });
  try {
    const before = observed.length;
    const first = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
    const afterFirst = observed.length;
    const second = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

    assert.equal(first.status, 'warning');
    assert.equal(second.status, 'warning');
    assert.equal(afterFirst, before + 1);
    assert.equal(observed.length, afterFirst, 'identical health refetch must not emit another regression event');
    assert.equal(observed[afterFirst - 1].status, 'warning');
  } finally {
    subscription.unsubscribe();
  }
});

test('workflow health reuses the recent-job index while reflecting incremental job status changes', () => {
  const repo = createRepo('recent-job-index');
  clearRecentJobCache();
  for (let index = 0; index < 120; index += 1) {
    const jobId = `job-health-cache-${index}`;
    createJob(jobId, 'read_local_file', { index }, `repo:${repo}`);
    updateJobStatus(jobId, { status: 'succeeded' });
  }

  const cold = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(cold.ok, true);
  assert.equal(getRecentJobCacheStats().diskScanCount, 1);
  for (let index = 0; index < 20; index += 1) getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(getRecentJobCacheStats().diskScanCount, 1);

  createJob('job-health-cache-failed', 'run_project_command', { command: 'test' }, `repo:${repo}`);
  updateJobStatus('job-health-cache-failed', { status: 'failed', failureSummary: 'synthetic failure' });
  const refreshed = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(refreshed.diagnostics.failedJobGroups.some((group: any) => group.toolName === 'run_project_command'), true);
  assert.equal(getRecentJobCacheStats().diskScanCount, 1);
});

test('workflow health warm p95 remains below the 750ms SLO with a populated job history', () => {
  const repo = createRepo('warm-benchmark');
  getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  const samples: number[] = [];
  for (let index = 0; index < 24; index += 1) {
    const startedAt = performance.now();
    getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const p50 = samples[Math.ceil(samples.length * 0.5) - 1];
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  console.log(`[health-benchmark] warm samples=${samples.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms scanCount=${getRecentJobCacheStats().diskScanCount}`);
  assert.equal(p95 <= 750, true, `expected warm p95 <= 750ms, got ${p95.toFixed(1)}ms`);
});

test('workflow health distinguishes durable lease, recovery, cancellation, and fencing states', () => {
  const repo = createRepo('durable-lease-health');
  const now = Date.now();
  const suffix = path.basename(repo);

  const healthy = createJob(`job-health-healthy-${suffix}`, 'run_project_command', { command: 'typecheck' }, `repo:${repo}`);
  claimJob(healthy.jobId, 'health-worker', 60_000, now);

  const stale = createJob(`job-health-stale-${suffix}`, 'run_project_command', { command: 'typecheck' }, `repo:${repo}`);
  claimJob(stale.jobId, 'stale-worker', 1_000, now - 5_000);

  const recovered = createJob(`job-health-recovered-${suffix}`, 'run_project_command', { command: 'typecheck' }, `repo:${repo}`);
  claimJob(recovered.jobId, 'recovered-worker', 1_000, now - 5_000);
  requeueJobForRecovery(recovered.jobId, now);

  const cancelled = createJob(`job-health-cancelled-${suffix}`, 'read_local_file', {}, `repo:${repo}`);
  requestJobCancellation(cancelled.jobId, 'synthetic cancel', now);

  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  const durable = result.diagnostics.durableJobs as any;
  assert.equal(durable.healthyRunning >= 1, true);
  assert.equal(durable.staleRunning >= 1, true);
  assert.equal(durable.recovered >= 1, true);
  assert.equal(durable.cancelled >= 1, true);
  assert.equal(typeof durable.detached, 'number');
  assert.equal(typeof durable.fencedLateWrites, 'number');
});

test('workflow health reports historical regressions separately from insufficient samples', () => {
  const repo = createRepo('historical-regression');
  db.prepare('DELETE FROM performance_telemetry_snapshots').run();
  clearToolCallRecords();
  const now = Date.now();
  for (let index = 0; index < 5; index += 1) {
    recordToolCall({
      toolName: 'search_local_files',
      args: { projectId: 'project-health' },
      status: 200,
      durationMs: 100,
      timestamp: now - 5_000 + index,
    });
  }
  flushPerformanceTelemetry({ now: now - 4_900, force: true });

  clearToolCallRecords();
  for (let index = 0; index < 5; index += 1) {
    recordToolCall({
      toolName: 'search_local_files',
      args: { projectId: 'project-health' },
      status: 200,
      durationMs: 130,
      timestamp: now - 100 + index,
    });
  }
  recordToolCall({
    toolName: 'read_local_file',
    args: { projectId: 'project-health' },
    status: 200,
    durationMs: 10,
    timestamp: now - 50,
  });

  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', windowMs: 1_000 });
  const history = (result.diagnostics.performance as any).history;
  assert.equal(history.regressions.length, 1);
  assert.equal(history.regressions[0].toolName, 'search_local_files');
  assert.equal(history.regressions[0].deltaPercent, 30);
  assert.equal(history.insufficientSamples.some((entry: any) => entry.toolName === 'read_local_file'), true);
  assert.match(result.recommendations.join('\n'), /Historical performance regression/);
});
