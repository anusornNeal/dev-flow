import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearToolCallRecords,
  getToolCallSummary,
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
  const summary = getToolCallSummary({ now: now + 4000, windowMs: 60_000 });

  assert.equal(summary.totalCalls, 5);
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
  assert.deepEqual(summary.recommendations, [
    'Replace repeated get_git_status/get_git_branch calls with get_project_start_context for startup context.',
  ]);
});
