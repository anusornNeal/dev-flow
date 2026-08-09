import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { runMcpTransportBenchmark } from '../../scripts/benchmark-mcp-transport.js';

function assertLatencyStats(value: any, path: string, expectedSamples: number) {
  assert.equal(value?.samples, expectedSamples, `${path}.samples`);
  for (const key of ['p50Ms', 'p95Ms', 'minMs', 'maxMs']) {
    assert.equal(typeof value?.[key], 'number', `${path}.${key} should be numeric`);
    assert.ok(value[key] >= 0, `${path}.${key} should be non-negative`);
  }
  assert.ok(value.p95Ms >= value.p50Ms, `${path}.p95Ms should be >= p50Ms`);
  assert.ok(value.maxMs >= value.minMs, `${path}.maxMs should be >= minMs`);
}

test('transport benchmark returns machine-readable cold/warm MCP and SSE metrics', async () => {
  const result = await runMcpTransportBenchmark({ coldSamples: 2, warmSamples: 20 });

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.benchmark, 'devflow-mcp-transport-local');
  assert.deepEqual(result.config, {
    coldSamples: 2,
    warmSamples: 20,
    toolName: 'get_tool_schema',
  });

  for (const protocolName of ['streamableHttpBaseline', 'streamableHttp', 'legacySse'] as const) {
    const protocol = result.protocols[protocolName];
    assertLatencyStats(protocol.cold.initialize, `${protocolName}.cold.initialize`, 2);
    assertLatencyStats(protocol.cold.listTools, `${protocolName}.cold.listTools`, 2);
    assertLatencyStats(protocol.cold.callTool, `${protocolName}.cold.callTool`, 2);
    assertLatencyStats(protocol.warm.listTools, `${protocolName}.warm.listTools`, 20);
    assertLatencyStats(protocol.warm.callTool, `${protocolName}.warm.callTool`, 20);

    assert.ok(protocol.payload.toolCount > 0, `${protocolName}.payload.toolCount`);
    assert.ok(protocol.payload.toolListJsonBytes > 0, `${protocolName}.payload.toolListJsonBytes`);
    assert.ok(protocol.payload.toolSchemasJsonBytes > 0, `${protocolName}.payload.toolSchemasJsonBytes`);
    assert.ok(protocol.payload.callResultJsonBytes > 0, `${protocolName}.payload.callResultJsonBytes`);
  }

  assert.equal(result.comparison.baseline, 'streamableHttpBaseline');
  assert.equal(result.comparison.candidate, 'streamableHttp');
  assert.equal(typeof result.comparison.warm.callTool.p50DeltaMs, 'number');
  assert.equal(typeof result.comparison.warm.callTool.p95DeltaMs, 'number');
  assert.equal(result.fallbackComparison.baseline, 'legacySse');
  assert.equal(result.fallbackComparison.candidate, 'streamableHttp');
  assert.equal(result.regressionBudget.thresholdSource, 'same-run-stateless-baseline');
  assert.equal(result.regressionBudget.warmP50BaselineRatioMax, 0.95);
  assert.equal(result.regressionBudget.warmP95BaselineDeltaMaxMs, 2);
  assert.equal(typeof result.regressionBudget.warm.listTools.actualP50Ratio, 'number');
  assert.equal(typeof result.regressionBudget.warm.listTools.actualP95DeltaMs, 'number');
  assert.equal(typeof result.regressionBudget.warm.callTool.actualP50Ratio, 'number');
  assert.equal(typeof result.regressionBudget.warm.callTool.actualP95DeltaMs, 'number');
  assert.equal(result.regressionBudget.passed, true, JSON.stringify(result.regressionBudget));
  assert.ok(result.limitations.some((item: string) => /localhost|loopback/i.test(item)));
  assert.ok(result.limitations.some((item: string) => /ChatGPT|tunnel|model/i.test(item)));
});

test('package exposes repeatable transport benchmark and focused test commands', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['benchmark:mcp-transport'], 'tsx scripts/benchmark-mcp-transport.ts');
  assert.equal(pkg.scripts['test:mcp-transport-benchmark'], 'tsx --test tests/server/mcpTransportBenchmark.test.ts');
});
