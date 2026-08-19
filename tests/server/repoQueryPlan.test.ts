import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepoQueryPlanExecutor } from '../../src/server/services/repoQueryPlanService.js';
import { getBuiltinToolRunnerNames } from '../../src/server/services/mcpToolJobRunnerRegistry.js';

type SearchMatch = { path: string; line: number; preview: string };

const state = {} as any;
const logger = { stdout: () => {}, stderr: () => {} };

function searchResult(matches: SearchMatch[], overrides: Record<string, any> = {}) {
  return {
    root: '/repo',
    path: '.',
    query: 'fixture',
    count: matches.length,
    scannedMatchCount: matches.length,
    truncated: false,
    matches,
    ...overrides,
  };
}

function basePlan(steps: any[], output: string, overrides: Record<string, any> = {}) {
  return { steps, output, ...overrides };
}

test('validates the complete plan before executing any repository operation', async () => {
  let searchCalls = 0;
  const execute = createRepoQueryPlanExecutor({
    search: async () => {
      searchCalls += 1;
      return searchResult([]);
    },
  });

  const invalidPlans = [
    basePlan([
      { id: 'a', op: 'search', query: 'x' },
      { id: 'a', op: 'select', from: 'a' },
    ], 'a'),
    basePlan([
      { id: 'a', op: 'search', query: 'x' },
      { id: 'out', op: 'select', from: 'missing' },
    ], 'out'),
    basePlan([
      { id: 'a', op: 'dedupe', from: 'b' },
      { id: 'b', op: 'dedupe', from: 'a' },
      { id: 'out', op: 'select', from: 'a' },
    ], 'out'),
    basePlan([
      { id: 'a', op: 'shell', command: 'echo unsafe' },
      { id: 'out', op: 'select', from: 'a' },
    ], 'out'),
    basePlan([
      { id: 'a', op: 'search', query: 'x', script: 'process.exit()' },
      { id: 'out', op: 'select', from: 'a' },
    ], 'out'),
    basePlan([
      { id: 'a', op: 'search', query: 'x', path: '../outside' },
      { id: 'out', op: 'select', from: 'a' },
    ], 'out'),
  ];

  for (const plan of invalidPlans) {
    await assert.rejects(() => execute(state, plan, logger, () => {}), /Repo Query Plan|step|Operation|repository-relative|workspace/i);
  }
  assert.equal(searchCalls, 0, 'structurally invalid plans must not partially execute');
});

test('enforces hard step, search, concurrency, and output limits', async () => {
  const execute = createRepoQueryPlanExecutor({ search: async () => searchResult([]) });
  const tooManySteps: Record<string, any>[] = Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, op: 'search', query: 'x' }));
  tooManySteps.push({ id: 'out', op: 'select', from: 's0' });
  await assert.rejects(() => execute(state, basePlan(tooManySteps, 'out'), logger, () => {}), /at most 12 steps/i);

  const tooManySearches: Record<string, any>[] = Array.from({ length: 7 }, (_, index) => ({ id: `s${index}`, op: 'search', query: 'x' }));
  tooManySearches.push({ id: 'out', op: 'select', from: 's0' });
  await assert.rejects(() => execute(state, basePlan(tooManySearches, 'out'), logger, () => {}), /at most 6 search steps/i);

  await assert.rejects(() => execute(state, basePlan([
    { id: 's', op: 'search', query: 'x' },
    { id: 'out', op: 'select', from: 's' },
  ], 'out', { maxConcurrency: 5 }), logger, () => {}), /maxConcurrency.*between 1 and 4/i);
});

test('runs independent searches concurrently under the bounded plan concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const execute = createRepoQueryPlanExecutor({
    search: async (_state, args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, args.query === 'slow' ? 25 : 10));
      active -= 1;
      return searchResult([{ path: `${args.query}.ts`, line: 1, preview: args.query }]);
    },
  });

  const result = await execute(state, basePlan([
    { id: 'slow', op: 'search', query: 'slow' },
    { id: 'fast', op: 'search', query: 'fast' },
    { id: 'merged', op: 'dedupe', from: ['slow', 'fast'], by: 'file' },
    { id: 'out', op: 'select', from: 'merged', fields: ['path'] },
  ], 'out', { maxConcurrency: 2 }), logger, () => {});

  assert.equal(maxActive, 2);
  assert.deepEqual(result.evidence, [{ path: 'fast.ts' }, { path: 'slow.ts' }]);
  assert.equal(result.diagnostics.counts.searchCount, 2);
  assert.equal(result.diagnostics.plan.maxConcurrency, 2);
});

test('filter, dedupe, limit, and select compact intermediate search evidence deterministically', async () => {
  const execute = createRepoQueryPlanExecutor({
    search: async (_state, args) => {
      if (args.query === 'one') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return searchResult([
          { path: 'tests/a.test.ts', line: 8, preview: 'ignore' },
          { path: 'src/z.ts', line: 4, preview: 'z' },
          { path: 'src/a.ts', line: 3, preview: 'a' },
        ]);
      }
      return searchResult([
        { path: 'src/a.ts', line: 3, preview: 'a' },
        { path: 'src/b.ts', line: 2, preview: 'b' },
      ]);
    },
  });

  const plan = basePlan([
    { id: 'one', op: 'search', query: 'one' },
    { id: 'two', op: 'search', query: 'two' },
    { id: 'filtered', op: 'filter_path', from: ['one', 'two'], include: ['src/**'] },
    { id: 'deduped', op: 'dedupe', from: 'filtered', by: 'match' },
    { id: 'limited', op: 'limit', from: 'deduped', count: 2 },
    { id: 'out', op: 'select', from: 'limited', fields: ['path', 'line'] },
  ], 'out');

  const first = await execute(state, plan, logger, () => {});
  const second = await execute(state, plan, logger, () => {});
  assert.deepEqual(first.evidence, [
    { path: 'src/a.ts', line: 3 },
    { path: 'src/b.ts', line: 2 },
  ]);
  assert.deepEqual(second.evidence, first.evidence);
  assert.equal(first.diagnostics.counts.filterCandidatesBefore, 5);
  assert.equal(first.diagnostics.counts.filterCandidatesAfter, 4);
  assert.equal(first.diagnostics.counts.dedupeCandidatesAfter, 3);
  assert.equal(first.diagnostics.counts.limitCandidatesAfter, 2);
  assert.equal(JSON.stringify(first).includes('tests/a.test.ts'), false, 'discarded intermediate matches must not leak into final output');
});

test('read_snippets reuses bounded batch-read semantics and returns only selected evidence fields', async () => {
  let readArgs: any = null;
  const execute = createRepoQueryPlanExecutor({
    search: async () => searchResult([
      { path: 'src/a.ts', line: 10, preview: 'needle' },
      { path: 'src/b.ts', line: 20, preview: 'needle' },
    ]),
    readSnippets: (_state, args) => {
      readArgs = args;
      return {
        root: 'repo-root',
        count: args.files.length,
        requestedCount: args.files.length,
        successCount: args.files.length,
        errorCount: 0,
        partial: false,
        totalReturnedBytes: 40,
        maxTotalBytes: args.maxTotalBytes,
        truncated: false,
        files: args.files.map((file: any) => ({
          path: file.filePath,
          startLine: file.startLine,
          endLine: file.endLine,
          content: `content:${file.filePath}`,
          returnedBytes: 20,
          truncated: false,
        })),
      };
    },
  });

  const result = await execute(state, basePlan([
    { id: 's', op: 'search', query: 'needle' },
    { id: 'r', op: 'read_snippets', from: 's', contextBefore: 3, contextAfter: 4, maxBytesPerSnippet: 3000, maxTotalBytes: 5000 },
    { id: 'out', op: 'select', from: 'r', fields: ['path', 'startLine', 'endLine', 'content'] },
  ], 'out'), logger, () => {});

  assert.equal(readArgs.maxFiles, 25);
  assert.equal(readArgs.maxTotalBytes, 5000);
  assert.equal(readArgs.responseMode, 'compact');
  assert.deepEqual(readArgs.files.map((file: any) => [file.filePath, file.startLine, file.endLine, file.maxBytes]), [
    ['src/a.ts', 7, 14, 3000],
    ['src/b.ts', 17, 24, 3000],
  ]);
  assert.deepEqual(result.evidence[0], {
    path: 'src/a.ts',
    startLine: 7,
    endLine: 14,
    content: 'content:src/a.ts',
  });
  assert.equal(result.diagnostics.counts.snippetReadCount, 2);
  assert.equal(result.diagnostics.counts.snippetReadBytes, 40);
});

test('partial execution preserves independent successful branches and reports bounded step errors', async () => {
  const execute = createRepoQueryPlanExecutor({
    search: async (_state, args) => {
      if (args.query === 'fail') throw new Error('simulated search failure');
      return searchResult([{ path: 'src/good.ts', line: 1, preview: 'good' }]);
    },
  });

  const result = await execute(state, basePlan([
    { id: 'bad', op: 'search', query: 'fail' },
    { id: 'good', op: 'search', query: 'good' },
    { id: 'merged', op: 'dedupe', from: ['bad', 'good'], by: 'file' },
    { id: 'out', op: 'select', from: 'merged', fields: ['path'] },
  ], 'out', { allowPartial: true }), logger, () => {});

  assert.deepEqual(result.evidence, [{ path: 'src/good.ts' }]);
  assert.equal(result.diagnostics.partial, true);
  assert.ok(result.diagnostics.stepErrors.some((entry: any) => entry.stepId === 'bad'));
  assert.ok(result.diagnostics.stepErrors.some((entry: any) => entry.code === 'REPO_QUERY_PLAN_DEPENDENCY_PARTIAL'));
  assert.ok(result.diagnostics.stepErrors.length <= 8);
});

test('output byte budget is enforced even when snippet content is much larger', async () => {
  const execute = createRepoQueryPlanExecutor({
    search: async () => searchResult([{ path: 'src/large.ts', line: 1, preview: 'large' }]),
    readSnippets: (_state, args) => ({
      root: 'repo-root',
      count: 1,
      requestedCount: 1,
      successCount: 1,
      errorCount: 0,
      partial: false,
      totalReturnedBytes: 5000,
      maxTotalBytes: args.maxTotalBytes,
      truncated: false,
      files: [{ path: args.files[0].filePath, content: 'x'.repeat(5000), returnedBytes: 5000, truncated: false }],
    }),
  });

  const result = await execute(state, basePlan([
    { id: 's', op: 'search', query: 'large' },
    { id: 'r', op: 'read_snippets', from: 's' },
    { id: 'out', op: 'select', from: 'r', fields: ['path', 'content'] },
  ], 'out', { maxReturnedBytes: 1024 }), logger, () => {});

  assert.ok(result.diagnostics.returnedBytes <= 1024);
  assert.equal(result.diagnostics.truncated, true);
  assert.deepEqual(result.evidence, []);
});

test('registers execute_repo_query_plan only as a built-in read job runner name', () => {
  assert.ok(getBuiltinToolRunnerNames().includes('execute_repo_query_plan' as any));
});
