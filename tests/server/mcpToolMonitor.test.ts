import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-mcp-monitor-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.sqlite');
process.env.DEVFLOW_APP_REVISION = 'app-test';
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const {
  clearToolCallRecords,
  getDevFlowDiagnostics,
  getToolCallSummary,
  buildIsolationDiagnostics,
  recordToolCall,
  flushPerformanceTelemetry,
  getPerformanceHistoryComparison,
} = await import('../../src/server/services/mcpToolMonitor.js');

test('tool monitor summarizes repeated tool calls and duplicate bursts', () => {
  clearToolCallRecords();
  const now = Date.now();

  recordToolCall({ toolName: 'get_git_status', args: { projectName: 'buddy2' }, status: 200, durationMs: 4, timestamp: now });
  recordToolCall({ toolName: 'get_git_status', args: { projectName: 'buddy2' }, status: 200, durationMs: 5, timestamp: now + 1000 });
  recordToolCall({ toolName: 'get_git_status', args: { projectName: 'buddy2' }, status: 200, durationMs: 6, timestamp: now + 2000 });
  recordToolCall({ toolName: 'get_project_start_context', args: { projectName: 'buddy2' }, status: 200, durationMs: 8, timestamp: now + 3000 });

  recordToolCall({ toolName: 'get_project_start_context', args: { projectName: 'buddy2', warm: true }, status: 200, durationMs: 20, timestamp: now + 3500, responseBytes: 1200, cacheHit: true, phase: 'context', processSpawns: 2 });
  const sensitiveArgs = { text: 'สวัสดี', secret: 'do-not-retain-raw-payload' };
  const expectedInputBytes = Buffer.byteLength(JSON.stringify(sensitiveArgs), 'utf8');
  const secondInputBytes = Buffer.byteLength(JSON.stringify({ text: 'x' }), 'utf8');
  recordToolCall({ toolName: 'prepare_compact_edit', args: sensitiveArgs, status: 200, durationMs: 2, timestamp: now + 3600 });
  recordToolCall({ toolName: 'prepare_compact_edit', args: { text: 'x' }, status: 200, durationMs: 3, timestamp: now + 3700 });

  const summary = getToolCallSummary({ now: now + 4000, windowMs: 60_000 });

  assert.equal(summary.totalCalls, 7);
  assert.equal(summary.topTools[0].toolName, 'get_git_status');
  assert.equal(summary.topTools[0].count, 3);
  assert.equal(summary.duplicateBursts[0].toolName, 'get_git_status');
  assert.equal(summary.duplicateBursts[0].count, 3);
  const gitStats = summary.topTools.find((entry) => entry.toolName === 'get_git_status');
  assert.equal(gitStats?.p50DurationMs, 5);
  assert.equal(gitStats?.p95DurationMs, 6);
  const contextStats = summary.topTools.find((entry) => entry.toolName === 'get_project_start_context');
  assert.equal(contextStats?.cacheHitCount, 1);
  assert.equal(contextStats?.responseBytes, 1200);
  assert.equal(contextStats?.processSpawns, 2);
  const compactStats = summary.topTools.find((entry) => entry.toolName === 'prepare_compact_edit');
  assert.equal(compactStats?.totalInputBytes, expectedInputBytes + secondInputBytes);
  assert.equal(compactStats?.avgInputBytes, Math.round((expectedInputBytes + secondInputBytes) / 2));
  assert.equal(compactStats?.maxInputBytes, Math.max(expectedInputBytes, secondInputBytes));
  assert.equal(summary.latestCalls.some((entry) => entry.inputBytes === expectedInputBytes), true);
  assert.doesNotMatch(JSON.stringify(summary), /do-not-retain-raw-payload/);
  assert.deepEqual(summary.recommendations, [
    'Replace repeated get_git_status/get_git_branch calls with get_project_start_context for startup context.',
  ]);
});

test('tool monitor separates logical request completion from execution and keeps handoff telemetry bounded', () => {
  clearToolCallRecords();
  const now = Date.now();
  recordToolCall({
    toolName: 'run_project_command',
    args: { projectId: 'project-streaming', secret: 'do-not-retain' },
    status: 200,
    durationMs: 2_950,
    logicalOperationDurationMs: 3_000,
    completionMode: 'request-stream',
    handoffCount: 0,
    pollCount: 1,
    jobId: 'job-stream-1',
    executionDurationMs: 2_700,
    timestamp: now,
  });
  recordToolCall({
    toolName: 'run_project_command',
    args: { projectId: 'project-streaming', secret: 'do-not-retain' },
    status: 200,
    durationMs: 1_000,
    logicalOperationDurationMs: 1_005,
    completionMode: 'durable-handoff',
    handoffCount: 1,
    pollCount: 1,
    jobId: 'job-stream-2',
    executionDurationMs: 0,
    timestamp: now + 1,
  });

  const summary = getToolCallSummary({ now: now + 10, windowMs: 1_000 });
  const tool = summary.topTools.find((entry) => entry.toolName === 'run_project_command');
  assert.deepEqual(tool?.completionModes, { 'inline-json': 0, 'request-stream': 1, 'durable-handoff': 1 });
  assert.equal(tool?.handoffCount, 1);
  assert.equal(tool?.pollCount, 2);
  assert.equal(tool?.logicalOperationP50Ms, 1_005);
  assert.equal(tool?.logicalOperationP95Ms, 3_000);
  assert.equal(tool?.executionP50Ms, 0);
  assert.equal(tool?.executionP95Ms, 2_700);
  assert.equal(summary.latestCalls[0].completionMode, 'durable-handoff');
  assert.equal(summary.latestCalls[0].logicalOperationDurationMs, 1_005);
  assert.equal(summary.latestCalls[0].jobId, 'job-stream-2');
  assert.equal(summary.latestCalls[0].executionDurationMs, 0);
  assert.doesNotMatch(JSON.stringify(summary), /do-not-retain/);
});

test('tool monitor attaches aggregate repo-context dominant phase without payload data', async () => {
  const {
    clearRepoContextBundlePerformanceRecords,
    recordRepoContextBundlePerformance,
  } = await import('../../src/server/services/projectStartContextService.js');
  clearToolCallRecords();
  clearRepoContextBundlePerformanceRecords();
  const now = Date.now();
  for (let index = 0; index < 3; index += 1) {
    recordToolCall({
      toolName: 'get_repo_context_bundle',
      args: { projectId: 'project-monitor' },
      status: 200,
      durationMs: 900 + index,
      timestamp: now + index,
    });
    recordRepoContextBundlePerformance({
      cacheState: 'warm',
      totalMs: 900 + index,
      phases: {
        startContextMs: 10,
        repoIndexMs: 700 + index,
        snippetReadMs: 100,
        snippetReadCount: 3,
        diffMs: 0,
        responseAssemblyMs: 90,
      },
      timestamp: now + index,
    });
  }

  const summary = getToolCallSummary({ now: now + 10, windowMs: 1000 });
  const context = summary.topTools.find((entry) => entry.toolName === 'get_repo_context_bundle');
  assert.equal(context?.dominantPhase, 'repoIndex');
  assert.equal(context?.dominantPhaseP95Ms, 702);
  assert.equal(context?.bundleCacheState, 'warm');
  assert.doesNotMatch(JSON.stringify(context), /project-monitor|\.ts|content/);
});

test('tool monitor groups response bytes by mode and tracks truncation', () => {
  clearToolCallRecords();
  const now = Date.now();
  recordToolCall({ toolName: 'get_git_show', args: { responseMode: 'compact' }, status: 200, durationMs: 5, responseBytes: 4000, responseMode: 'compact', responseTruncated: true, timestamp: now });
  recordToolCall({ toolName: 'get_git_show', args: { responseMode: 'standard' }, status: 200, durationMs: 6, responseBytes: 42000, responseMode: 'standard', responseTruncated: false, timestamp: now + 1 });

  const summary = getToolCallSummary({ now: now + 10, windowMs: 1000 });
  const gitShow = summary.topTools.find((entry) => entry.toolName === 'get_git_show');
  assert.deepEqual(gitShow?.responseModes, { compact: 1, standard: 1 });
  assert.equal(gitShow?.truncatedCount, 1);
  assert.equal(gitShow?.maxResponseBytes, 42000);
  assert.equal(gitShow?.p50ResponseBytes, 4000);
  assert.equal(gitShow?.p95ResponseBytes, 42000);
  assert.equal(summary.latestCalls[0].responseMode, 'standard');
  assert.equal(summary.latestCalls[1].responseTruncated, true);
});

test('diagnostics expose local search backend fallback counters', () => {
  const diagnostics = getDevFlowDiagnostics();
  assert.ok(diagnostics.search);
  assert.equal(typeof diagnostics.search.fallbackCount, 'number');
  assert.equal(typeof diagnostics.search.infrastructureFailureCount, 'number');
});


test('isolation diagnostics separate correctness and capacity waits without leaking resource paths', () => {
  const isolation = buildIsolationDiagnostics(
    {
      queueDepth: 2,
      activeJobs: [
        { resourceKey: 'workspace:ws_alpha', accessMode: 'write', costClass: 'write' },
        { resourceKey: 'repo:C:\\Users\\private\\secret-repo', accessMode: 'verify', costClass: 'verify' },
      ],
      queuedJobs: [
        { resourceKey: 'workspace:ws_beta', waitType: 'capacity', blockReason: 'capacity_saturated' },
      ],
      metrics: {
        waitTelemetry: {
          workspaceLockWait: { count: 3, totalMs: 42, p50Ms: 12, p95Ms: 20 },
          capacityWait: { count: 2, totalMs: 70, p50Ms: 30, p95Ms: 40 },
          blockerReasons: { writer_barrier: 2, capacity_saturated: 2 },
        },
        phaseTelemetry: {
          admissionWait: { count: 3, totalMs: 6, p50Ms: 2, p95Ms: 3 },
          queueWait: { count: 3, totalMs: 150, p50Ms: 50, p95Ms: 80 },
          workspaceLockWait: { count: 3, totalMs: 42, p50Ms: 12, p95Ms: 20 },
          capacityWait: { count: 2, totalMs: 70, p50Ms: 30, p95Ms: 40 },
          candidatePreparation: { count: 2, totalMs: 50, p50Ms: 20, p95Ms: 30 },
          execution: { count: 3, totalMs: 270, p50Ms: 90, p95Ms: 120 },
          responseHandoff: { count: 3, totalMs: 7, p50Ms: 2, p95Ms: 4 },
        },
      },
      capacity: { verify: { active: 2, limit: 2, saturated: true } },
    } as any,
    { knownWorkspaces: 4, activeWorkspaces: 2, integrationRequired: 1, created: 5, reused: 3, cleaned: 1, cleanupBlocked: 2 } as any,
    { attempts: 4, successes: 2, conflicts: 1, aborts: 1, retries: 1, pendingConflicts: 1 } as any,
  );

  assert.equal(isolation.waits.workspaceLockWait.p95Ms, 20);
  assert.equal(isolation.waits.capacityWait.p95Ms, 40);
  assert.equal(isolation.phases.queueWait.p95Ms, 80);
  assert.equal(isolation.phases.candidatePreparation.p95Ms, 30);
  assert.equal(isolation.phases.execution.p95Ms, 120);
  assert.equal(isolation.phases.responseHandoff.p95Ms, 4);
  assert.equal(isolation.capacity.saturated, true);
  assert.equal(isolation.workspaces.known, 4);
  assert.equal(isolation.integrations.conflicts, 1);
  assert.deepEqual(isolation.activeResources, { workspaces: 1, sharedRepos: 1, other: 0 });
  assert.doesNotMatch(JSON.stringify(isolation), /private|secret-repo|C:\\\\Users/);
});

test('monitor flush persists aggregate telemetry without raw args or machine paths', () => {
  assert.equal(typeof flushPerformanceTelemetry, 'function');
  clearToolCallRecords();
  db.prepare('DELETE FROM performance_telemetry_snapshots').run();
  const now = 10_000;
  const secretPath = 'C:\\Users\\private\\repo';
  for (const [index, durationMs] of [10, 20, 30, 40, 50].entries()) {
    recordToolCall({
      toolName: 'read_local_file',
      args: { projectId: 'project-history', localPath: secretPath, secret: 'do-not-store' },
      status: index === 4 ? 500 : 200,
      durationMs,
      responseBytes: 100 + index,
      cacheHit: index < 2,
      processSpawns: index === 0 ? 1 : 0,
      responseTruncated: index === 4,
      jobId: `job-history-${index}`,
      executionDurationMs: 100 + index,
      logicalOperationDurationMs: 200 + index,
      completionMode: index === 4 ? 'durable-handoff' : 'request-stream',
      handoffCount: index === 4 ? 1 : 0,
      pollCount: 1,
      timestamp: now + index,
    });
  }

  const flushed = flushPerformanceTelemetry({ now: now + 100, force: true });
  assert.equal(flushed.inserted, 1);
  const row = db.prepare('SELECT * FROM performance_telemetry_snapshots WHERE toolName = ?').get('read_local_file') as any;
  assert.equal(row.projectScope, 'project:project-history');
  assert.equal(row.appRevision, 'app-test');
  assert.equal(row.count, 5);
  assert.equal(row.errorCount, 1);
  assert.equal(row.p50DurationMs, 30);
  assert.equal(row.p95DurationMs, 50);
  assert.equal(row.cacheHitCount, 2);
  assert.equal(row.processSpawns, 1);
  assert.equal(row.truncatedCount, 1);
  assert.equal(row.truncationRate, 0.2);
  assert.equal(row.executionP50Ms, 102);
  assert.equal(row.executionP95Ms, 104);
  assert.equal(row.logicalOperationP50Ms, 202);
  assert.equal(row.logicalOperationP95Ms, 204);
  assert.equal(row.handoffCount, 1);
  assert.equal(row.pollCount, 5);
  assert.equal(row.requestStreamCount, 4);
  assert.equal(row.durableHandoffCount, 1);
  assert.doesNotMatch(JSON.stringify(row), /do-not-store|private|localPath|inputHash/);
  assert.equal(flushPerformanceTelemetry({ now: now + 200, force: true }).inserted, 0);
});

test('history comparison distinguishes regression from insufficient samples', () => {
  assert.equal(typeof getPerformanceHistoryComparison, 'function');
  clearToolCallRecords();
  db.prepare('DELETE FROM performance_telemetry_snapshots').run();
  const baselineStart = 20_000;
  for (let index = 0; index < 5; index += 1) {
    recordToolCall({ toolName: 'search_local_files', args: { projectId: 'project-history' }, status: 200, durationMs: 100, timestamp: baselineStart + index });
    recordToolCall({ toolName: 'get_git_status', args: { projectId: 'project-history' }, status: 200, durationMs: 100, timestamp: baselineStart + 10 + index });
  }
  flushPerformanceTelemetry({ now: baselineStart + 100, force: true });

  clearToolCallRecords();
  const currentStart = 40_000;
  for (let index = 0; index < 5; index += 1) {
    recordToolCall({ toolName: 'search_local_files', args: { projectId: 'project-history' }, status: 200, durationMs: 130, timestamp: currentStart + index });
    recordToolCall({ toolName: 'get_git_status', args: { projectId: 'project-history' }, status: 200, durationMs: 70, timestamp: currentStart + 10 + index });
  }
  recordToolCall({ toolName: 'read_local_file', args: { projectId: 'project-history' }, status: 200, durationMs: 5, timestamp: currentStart + 20 });

  const comparison = getPerformanceHistoryComparison({ now: currentStart + 100, windowMs: 1_000, minSamples: 5, regressionThreshold: 0.15 });
  const search = comparison.comparisons.find((entry: any) => entry.toolName === 'search_local_files');
  const read = comparison.comparisons.find((entry: any) => entry.toolName === 'read_local_file');
  const gitStatus = comparison.comparisons.find((entry: any) => entry.toolName === 'get_git_status');
  assert.equal(search?.status, 'regression');
  assert.equal(search?.current.p95DurationMs, 130);
  assert.equal(search?.baseline.p95DurationMs, 100);
  assert.equal(search?.deltaPercent, 30);
  assert.equal(search?.current.truncationRate, 0);
  assert.equal(search?.baseline.truncationRate, 0);
  assert.equal(gitStatus?.status, 'improvement');
  assert.equal(gitStatus?.deltaPercent, -30);
  assert.equal(read?.status, 'insufficient-samples');
  assert.equal(comparison.regressions.length, 1);
  assert.equal(comparison.improvements.length, 1);
  assert.equal(comparison.insufficientSamples.length, 1);
});

test('diagnostics opportunistically flush aggregate telemetry and expose history summary', () => {
  clearToolCallRecords();
  db.prepare('DELETE FROM performance_telemetry_snapshots').run();
  const now = 60_000;
  for (let index = 0; index < 5; index += 1) {
    recordToolCall({
      toolName: 'get_repo_context_bundle',
      args: { projectId: 'project-diagnostics' },
      status: 200,
      durationMs: 25,
      timestamp: now + index,
    });
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM performance_telemetry_snapshots').get() as any).count, 0);

  const diagnostics = getDevFlowDiagnostics({ now: now + 100, windowMs: 1_000 }) as any;
  assert.equal(diagnostics.telemetryPersistence.inserted, 1);
  assert.equal(diagnostics.performanceHistory.comparisons[0].toolName, 'get_repo_context_bundle');
  assert.equal(diagnostics.performanceHistory.comparisons[0].status, 'insufficient-samples');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM performance_telemetry_snapshots').get() as any).count, 1);

  recordToolCall({
    toolName: 'get_repo_context_bundle',
    args: { projectId: 'project-diagnostics' },
    status: 200,
    durationMs: 30,
    timestamp: now + 30_000,
  });
  const early = getDevFlowDiagnostics({ now: now + 30_100, windowMs: 60_000 }) as any;
  assert.equal(early.telemetryPersistence.skipped, true);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM performance_telemetry_snapshots').get() as any).count, 1);
});
