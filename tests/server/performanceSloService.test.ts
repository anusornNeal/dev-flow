import test from 'node:test';
import assert from 'node:assert/strict';

const { evaluatePerformanceSlo } = await import('../../src/server/services/performanceSloService.js');

test('performance SLO evaluation flags a sampled p95 regression and keeps sparse samples informational', () => {
  const result = evaluatePerformanceSlo([
    { toolName: 'get_repo_context_bundle', count: 5, p50DurationMs: 100, p95DurationMs: 900, dominantPhase: 'repoIndex', dominantPhaseP95Ms: 820 },
    { toolName: 'search_local_files', count: 1, p50DurationMs: 10, p95DurationMs: 10 },
  ]);

  const context = result.tools.find((entry: any) => entry.toolName === 'get_repo_context_bundle');
  const search = result.tools.find((entry: any) => entry.toolName === 'search_local_files');
  assert.equal(context?.status, 'regressed');
  assert.equal(context?.dominantPhase, 'repoIndex');
  assert.equal(context?.dominantPhaseP95Ms, 820);
  assert.equal(search?.status, 'insufficient_samples');
  assert.equal(result.regressions.length, 1);
  assert.equal(result.dominant?.toolName, 'get_repo_context_bundle');
});
