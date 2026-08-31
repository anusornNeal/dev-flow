import test from 'node:test';
import assert from 'node:assert/strict';

const { evaluatePerformanceSlo } = await import('../../src/server/services/performanceSloService.js');

test('performance SLO evaluation flags a sampled p95 regression and keeps sparse samples informational', () => {
  const result = evaluatePerformanceSlo([
    { toolName: 'get_repo_context_bundle', count: 5, p50DurationMs: 100, p95DurationMs: 900, dominantPhase: 'repoIndex', dominantPhaseP95Ms: 820, repoIndexCacheState: 'warm' },
    { toolName: 'search_local_files', count: 1, p50DurationMs: 10, p95DurationMs: 10 },
  ]);

  const context = result.tools.find((entry: any) => entry.toolName === 'get_repo_context_bundle');
  const search = result.tools.find((entry: any) => entry.toolName === 'search_local_files');
  assert.equal(context?.status, 'regressed');
  assert.equal(context?.dominantPhase, 'repoIndex');
  assert.equal(context?.dominantPhaseP95Ms, 820);
  assert.equal(context?.repoIndexCacheState, 'warm');
  assert.equal('bundleCacheState' in (context || {}), false);
  assert.equal(search?.status, 'insufficient_samples');
  assert.equal(result.regressions.length, 1);
  assert.equal(result.dominant?.toolName, 'get_repo_context_bundle');
});

test('inline local reads evaluate orchestration overhead when execution telemetry is available', () => {
  const result = evaluatePerformanceSlo([
    {
      toolName: 'read_local_file',
      count: 5,
      p50DurationMs: 450,
      p95DurationMs: 520,
      logicalOperationP50Ms: 450,
      logicalOperationP95Ms: 520,
      executionP50Ms: 45,
      executionP95Ms: 55,
    },
  ]);

  const read = result.tools[0] as any;
  assert.equal(read.status, 'regressed');
  assert.equal(read.executionP95Ms, 55);
  assert.equal(read.orchestrationOverheadP95Ms, 465);
  assert.equal(read.evaluatedP95Ms, 465);
  assert.equal(read.latencyBasis, 'orchestration-overhead');
});

test('run_project_command evaluates orchestration overhead instead of legitimate command execution time', () => {
  const result = evaluatePerformanceSlo([
    {
      toolName: 'run_project_command',
      count: 5,
      p50DurationMs: 15_500,
      p95DurationMs: 16_500,
      logicalOperationP50Ms: 15_500,
      logicalOperationP95Ms: 16_500,
      executionP50Ms: 14_500,
      executionP95Ms: 15_000,
      completionModes: { 'inline-json': 0, 'request-stream': 5, 'durable-handoff': 0 },
    },
  ]);

  const command = result.tools[0] as any;
  assert.equal(command.status, 'within_budget');
  assert.equal(command.p95DurationMs, 16_500);
  assert.equal(command.rawP95DurationMs, 16_500);
  assert.equal(command.logicalOperationP95Ms, 16_500);
  assert.equal(command.executionP95Ms, 15_000);
  assert.equal(command.orchestrationOverheadP95Ms, 1_500);
  assert.equal(command.evaluatedP95Ms, 1_500);
  assert.equal(command.latencyBasis, 'orchestration-overhead');
  assert.equal(result.regressions.length, 0);
});

test('run_project_command still flags genuine orchestration overhead and orders regressions by evaluated latency', () => {
  const result = evaluatePerformanceSlo([
    {
      toolName: 'run_project_command',
      count: 5,
      p95DurationMs: 26_000,
      logicalOperationP95Ms: 26_000,
      executionP95Ms: 15_000,
    },
    { toolName: 'get_repo_context_bundle', count: 5, p95DurationMs: 12_000 },
  ]);

  const command = result.tools.find((entry: any) => entry.toolName === 'run_project_command') as any;
  assert.equal(command.status, 'regressed');
  assert.equal(command.orchestrationOverheadP95Ms, 11_000);
  assert.equal(command.evaluatedP95Ms, 11_000);
  assert.equal(command.latencyBasis, 'orchestration-overhead');
  assert.equal(result.regressions[0]?.toolName, 'get_repo_context_bundle');
  assert.equal(result.regressions[1]?.toolName, 'run_project_command');
  assert.equal(result.dominant?.toolName, 'get_repo_context_bundle');
});

test('run_project_command fails closed to observable raw latency when execution telemetry is unavailable or incoherent', () => {
  const result = evaluatePerformanceSlo([
    {
      toolName: 'run_project_command',
      count: 5,
      p95DurationMs: 12_000,
      logicalOperationP95Ms: 12_100,
      executionP95Ms: 0,
      completionModes: { 'inline-json': 0, 'request-stream': 0, 'durable-handoff': 5 },
    },
    {
      toolName: 'run_project_command',
      count: 5,
      p95DurationMs: 13_000,
      logicalOperationP95Ms: 10_000,
      executionP95Ms: 11_000,
    },
  ]);

  for (const command of result.tools as any[]) {
    assert.equal(command.status, 'regressed');
    assert.equal(command.latencyBasis, 'raw-duration');
    assert.equal(command.orchestrationOverheadP95Ms, null);
    assert.equal(command.evaluatedP95Ms, command.rawP95DurationMs);
  }
});
