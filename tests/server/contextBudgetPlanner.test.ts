import test from 'node:test';
import assert from 'node:assert/strict';

const { planContextBudget, rankContextEvidence } = await import('../../src/server/services/contextBudgetPlannerService.js');

const candidates = [
  { path: 'src/server/services/configService.ts', score: 4, symbols: ['parseConfig', 'saveConfig'] },
  { path: 'tests/server/configService.test.ts', score: 3, symbols: ['parseConfig'] },
  { path: 'src/server/routes/settings.ts', score: 2, symbols: ['registerSettingsRoutes'] },
  { path: 'README.md', score: 1, symbols: [] },
  { path: 'src/server/repositories/settingsRepository.ts', score: 2, symbols: ['getSettings'] },
  { path: 'src/server/services/unrelatedService.ts', score: 1, symbols: ['unrelated'] },
];

test('small copy/config authoring gets a narrow deterministic budget below the old broad default', () => {
  const input = {
    query: 'update config wording in README and package config',
    candidates,
    targetFiles: ['README.md'],
  };
  const first = planContextBudget(input);
  const second = planContextBudget(input);

  assert.deepEqual(first, second);
  assert.equal(first.intent, 'authoring');
  assert.ok(['symbols', 'snippets'].includes(first.disclosureLevel));
  assert.ok(first.budgets.snippetBytes < 60_000);
  assert.ok(first.budgets.snippetLimit <= 3);
  assert.equal(first.evidence[0].rank, 'must');
  assert.equal(first.evidence[0].path, 'README.md');
  assert.ok(first.evidence[0].reasons.some((reason: string) => reason.includes('target')));
});

test('one-function bug ranks implementation and related test evidence with reasons', () => {
  const result = planContextBudget({
    query: 'fix parseConfig crash when config is empty',
    candidates,
    targetFiles: ['src/server/services/configService.ts'],
  });

  assert.equal(result.intent, 'small-bug-fix');
  assert.equal(result.evidence.find((entry: any) => entry.path.endsWith('configService.ts') && !entry.path.includes('tests/'))?.rank, 'must');
  const relatedTest = result.evidence.find((entry: any) => entry.path.includes('configService.test.ts'));
  assert.ok(relatedTest);
  assert.ok(['must', 'should'].includes(relatedTest.rank));
  assert.ok(relatedTest.reasons.some((reason: string) => reason.includes('test')));
});

test('cross-module requests deliberately expand callers/tests budget without escalating to full files', () => {
  const result = planContextBudget({
    query: 'change settings workflow across route service repository and tests',
    candidates,
  });

  assert.equal(result.intent, 'cross-module-change');
  assert.equal(result.disclosureLevel, 'callers-tests');
  assert.ok(result.budgets.snippetLimit >= 5);
  assert.ok(result.budgets.snippetBytes >= 36_000);
  assert.notEqual(result.disclosureLevel, 'full-file');
});

test('architecture analysis receives the largest automatic profile but full-file requires explicit escalation', () => {
  const automatic = planContextBudget({
    query: 'analyze architecture and module boundaries for the whole system',
    candidates,
  });
  const explicit = planContextBudget({
    query: 'analyze architecture and module boundaries for the whole system',
    candidates,
    requestedDisclosureLevel: 'full-file',
  });

  assert.equal(automatic.intent, 'architecture-analysis');
  assert.equal(automatic.disclosureLevel, 'callers-tests');
  assert.ok(automatic.budgets.snippetBytes >= 60_000);
  assert.equal(explicit.disclosureLevel, 'full-file');
  assert.ok(explicit.budgets.snippetBytes > automatic.budgets.snippetBytes);
});

test('verification/debugging prioritizes changed files and tests', () => {
  const ranked = rankContextEvidence(candidates, {
    query: 'debug failing config regression test',
    intent: 'verification-debugging',
    changedFiles: ['src/server/services/configService.ts'],
  });

  assert.equal(ranked[0].path, 'src/server/services/configService.ts');
  assert.equal(ranked[0].rank, 'must');
  const testEvidence = ranked.find((entry: any) => entry.path.includes('configService.test.ts'));
  assert.ok(testEvidence);
  assert.ok(['must', 'should'].includes(testEvidence.rank));
});
