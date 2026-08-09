import test from 'node:test';
import assert from 'node:assert/strict';

async function loadPlanner() {
  try {
    return await import('../../src/server/services/contextBudgetPlanner.js');
  } catch {
    return null;
  }
}

const fixtures = [
  { query: 'update package config label copy', expectedIntent: 'authoring', expectedDisclosure: 'symbols' },
  { query: 'fix snapshotExample function bug', expectedIntent: 'small-bug', expectedDisclosure: 'snippets' },
  { query: 'debug failing unit test verification', expectedIntent: 'verification', expectedDisclosure: 'related' },
  { query: 'refactor integration across frontend backend services', expectedIntent: 'cross-module', expectedDisclosure: 'related' },
  { query: 'explain architecture dependency flow across the system', expectedIntent: 'architecture', expectedDisclosure: 'related' },
] as const;

test('planner infers deterministic intent and progressive disclosure budgets', async () => {
  const planner = await loadPlanner();
  assert.equal(typeof planner?.createContextBudgetPlan, 'function');
  const plans = fixtures.map((fixture) => planner!.createContextBudgetPlan({ query: fixture.query }));
  fixtures.forEach((fixture, index) => {
    assert.equal(plans[index].intent, fixture.expectedIntent, fixture.query);
    assert.equal(plans[index].disclosureLevel, fixture.expectedDisclosure, fixture.query);
    assert.ok(plans[index].budget.indexLimit > 0);
    assert.ok(plans[index].budget.snippetLimit >= 0);
    assert.equal(plans[index].budget.estimatedTokenBudget, Math.ceil(plans[index].budget.maxTotalSnippetBytes / 4));
  });
  assert.ok(plans[0].budget.maxTotalSnippetBytes < plans[1].budget.maxTotalSnippetBytes);
  assert.ok(plans[1].budget.maxTotalSnippetBytes < plans[3].budget.maxTotalSnippetBytes);
  assert.ok(plans[3].budget.maxTotalSnippetBytes <= plans[4].budget.maxTotalSnippetBytes);
});

test('explicit intent/deep overrides inference and only deep architecture allows full-file escalation', async () => {
  const planner = await loadPlanner();
  const normal = planner!.createContextBudgetPlan({ query: 'architecture overview', intent: 'small-bug' });
  assert.equal(normal.intent, 'small-bug');
  assert.equal(normal.allowFullFile, false);

  const deep = planner!.createContextBudgetPlan({ query: 'architecture overview', intent: 'architecture', deep: true });
  assert.equal(deep.intent, 'architecture');
  assert.equal(deep.disclosureLevel, 'full-file');
  assert.equal(deep.allowFullFile, true);
  assert.ok(deep.budget.maxTotalSnippetBytes > normal.budget.maxTotalSnippetBytes);
  assert.match(deep.escalation.guidance, /read_local_file/i);
});

test('planner ranks explicit targets and query/test evidence with reasons', async () => {
  const planner = await loadPlanner();
  assert.equal(typeof planner?.rankContextEvidence, 'function');
  const ranked = planner!.rankContextEvidence([
    { path: 'src/fooService.ts', score: 3, symbols: ['fooHandler'], imports: [] },
    { path: 'tests/fooService.test.ts', score: 2, symbols: ['fooHandler test'], imports: [] },
    { path: 'src/other.ts', score: 1, symbols: ['other'], imports: [] },
  ], {
    query: 'debug fooHandler failing test',
    intent: 'verification',
    targetFiles: ['src/fooService.ts'],
  });

  assert.equal(ranked[0].path, 'src/fooService.ts');
  assert.equal(ranked[0].rank, 'Must');
  assert.ok(ranked[0].reasons.includes('explicit-target'));
  const testEvidence = ranked.find((entry: any) => entry.path === 'tests/fooService.test.ts');
  assert.ok(testEvidence);
  assert.notEqual(testEvidence.rank, 'Optional');
  assert.ok(testEvidence.reasons.includes('verification-test'));
  assert.equal(ranked.at(-1)?.path, 'src/other.ts');
  assert.equal(ranked.at(-1)?.rank, 'Optional');
});

test('planner honors explicit disclosure request without silently enabling full files', async () => {
  const planner = await loadPlanner();
  const related = planner!.createContextBudgetPlan({ query: 'small fix', disclosureLevel: 'related' });
  assert.equal(related.disclosureLevel, 'related');
  assert.equal(related.allowFullFile, false);
  const full = planner!.createContextBudgetPlan({ query: 'small fix', disclosureLevel: 'full-file' });
  assert.equal(full.disclosureLevel, 'full-file');
  assert.equal(full.allowFullFile, true);
});

test('get_repo_context_bundle contract exposes planner inputs', async () => {
  const { devFlowToolDefinitions } = await import('../../src/server/contracts/devflowContract.js');
  const tool = devFlowToolDefinitions.find((entry: any) => entry.name === 'get_repo_context_bundle');
  assert.ok(tool);
  const properties = tool.inputSchema?.properties || {};
  assert.ok(properties.intent);
  assert.ok(properties.complexity);
  assert.ok(properties.targetFiles);
  assert.ok(properties.deep);
  assert.ok(properties.disclosureLevel);
  assert.deepEqual(properties.intent.enum, ['authoring', 'small-bug', 'verification', 'cross-module', 'architecture']);

  const { buildMcpTransportInputSchema } = await import('../../src/server/contracts/mcpSchemaTransport.js');
  const transport = buildMcpTransportInputSchema(tool.inputSchema);
  for (const name of ['intent', 'complexity', 'targetFiles', 'deep', 'disclosureLevel']) {
    assert.ok(transport.properties?.[name], `transport schema dropped ${name}`);
  }
});
