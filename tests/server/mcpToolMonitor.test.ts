import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearToolCallRecords,
  getDevFlowDiagnostics,
  getToolCallSummary,
  buildIsolationDiagnostics,
  recordToolCall,
} from '../../src/server/services/mcpToolMonitor.js';

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
      },
      capacity: { verify: { active: 2, limit: 2, saturated: true } },
    } as any,
    { knownWorkspaces: 4, activeWorkspaces: 2, integrationRequired: 1, created: 5, reused: 3, cleaned: 1, cleanupBlocked: 2 } as any,
    { attempts: 4, successes: 2, conflicts: 1, aborts: 1, retries: 1, pendingConflicts: 1 } as any,
  );

  assert.equal(isolation.waits.workspaceLockWait.p95Ms, 20);
  assert.equal(isolation.waits.capacityWait.p95Ms, 40);
  assert.equal(isolation.capacity.saturated, true);
  assert.equal(isolation.workspaces.known, 4);
  assert.equal(isolation.integrations.conflicts, 1);
  assert.deepEqual(isolation.activeResources, { workspaces: 1, sharedRepos: 1, other: 0 });
  assert.doesNotMatch(JSON.stringify(isolation), /private|secret-repo|C:\\\\Users/);
});
