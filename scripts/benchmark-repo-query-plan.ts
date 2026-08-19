import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-query-plan-bench-'));
process.env.DEVFLOW_DB_PATH = path.join(root, 'devflow.db');

const { executeAllMigrations } = await import('../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../src/server/repositories/projectRepository.js');
const {
  clearLocalFileSearchCache,
  readFileSnippetsBatch,
  searchLocalFilesAsync,
} = await import('../src/server/services/localFileService.js');
const { createRepoQueryPlanExecutor } = await import('../src/server/services/repoQueryPlanService.js');

const projectId = 'project-repo-query-plan-benchmark';
createProject({ id: projectId, name: 'Repo Query Plan Benchmark', repoUrl: 'https://example.com/repo-query-plan-benchmark', localPath: root });
const state: any = {
  projectsCache: [{ id: projectId, name: 'Repo Query Plan Benchmark', repoUrl: 'https://example.com/repo-query-plan-benchmark', localPath: root }],
};
const logger = { stdout: () => {}, stderr: () => {} };
const noCancel = () => {};

fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'a.ts'), ['alpha one', 'common', 'beta one'].join('\n'), 'utf8');
fs.writeFileSync(path.join(root, 'src', 'b.ts'), ['alpha two', 'common'].join('\n'), 'utf8');
fs.writeFileSync(path.join(root, 'src', 'c.ts'), ['beta two', 'common'].join('\n'), 'utf8');
fs.writeFileSync(path.join(root, 'tests', 'a.test.ts'), ['beta test', 'alpha test'].join('\n'), 'utf8');

const normalizeMatches = (results: any[]) => results
  .flatMap((result) => result.matches || [])
  .filter((match) => String(match.path).replace(/\\/g, '/').startsWith('src/'))
  .map((match) => ({ path: String(match.path).replace(/\\/g, '/'), line: Number(match.line), preview: String(match.preview) }))
  .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.preview.localeCompare(right.preview));

const dedupeByFile = (matches: Array<{ path: string; line: number; preview: string }>) => {
  const seen = new Set<string>();
  return matches.filter((match) => {
    if (seen.has(match.path)) return false;
    seen.add(match.path);
    return true;
  });
};

const selectEvidence = (batch: any, source: Array<{ path: string; line: number; preview: string }>) => (batch.files || []).flatMap((entry: any, index: number) => {
  if (entry?.ok === false) return [];
  return [{
    path: String(entry.path).replace(/\\/g, '/'),
    startLine: entry.startLine,
    endLine: entry.endLine,
    content: entry.content,
  }];
}).sort((left: any, right: any) => left.path.localeCompare(right.path));

async function runLegacy() {
  clearLocalFileSearchCache();
  const startedAt = performance.now();
  let primitiveMs = 0;
  const responses: any[] = [];
  for (const query of ['alpha', 'beta']) {
    const primitiveStartedAt = performance.now();
    const result = await searchLocalFilesAsync(state, { projectId, query, path: '.', limit: 50 }, logger, noCancel);
    primitiveMs += performance.now() - primitiveStartedAt;
    responses.push(result);
  }
  const candidates = dedupeByFile(normalizeMatches(responses)).slice(0, 3);
  const readStartedAt = performance.now();
  const batch = readFileSnippetsBatch(state, {
    projectId,
    files: candidates.map((candidate) => ({
      filePath: candidate.path,
      startLine: Math.max(1, candidate.line - 1),
      endLine: candidate.line + 1,
      maxBytes: 4000,
      responseMode: 'compact',
    })),
    maxFiles: 25,
    maxTotalBytes: 60000,
    responseMode: 'compact',
  });
  primitiveMs += performance.now() - readStartedAt;
  responses.push(batch);
  return {
    evidence: selectEvidence(batch, candidates),
    metrics: {
      modelVisibleCalls: 3,
      primitiveSearches: 2,
      snippetsRead: Number(batch.successCount || 0),
      returnedBytes: responses.reduce((sum, response) => sum + Buffer.byteLength(JSON.stringify(response), 'utf8'), 0),
      wallMs: performance.now() - startedAt,
      primitiveExecutionMs: primitiveMs,
      truncation: responses.some((response) => response?.truncated === true),
      cacheState: responses.slice(0, 2).map((response) => response?.cache?.hit ?? null),
    },
  };
}

async function runPlan() {
  clearLocalFileSearchCache();
  const observed = { searches: 0, searchMs: 0, readMs: 0, cacheState: [] as Array<boolean | null> };
  const execute = createRepoQueryPlanExecutor({
    search: async (...args: any[]) => {
      const startedAt = performance.now();
      const result = await (searchLocalFilesAsync as any)(...args);
      observed.searches += 1;
      observed.searchMs += performance.now() - startedAt;
      observed.cacheState.push(result?.cache?.hit ?? null);
      return result;
    },
    readSnippets: (...args: any[]) => {
      const startedAt = performance.now();
      const result = (readFileSnippetsBatch as any)(...args);
      observed.readMs += performance.now() - startedAt;
      return result;
    },
  });
  const startedAt = performance.now();
  const result = await execute(state, {
    projectId,
    steps: [
      { id: 'alpha', op: 'search', query: 'alpha', path: '.', limit: 50 },
      { id: 'beta', op: 'search', query: 'beta', path: '.', limit: 50 },
      { id: 'srcOnly', op: 'filter_path', from: ['alpha', 'beta'], include: ['src/**'] },
      { id: 'files', op: 'dedupe', from: 'srcOnly', by: 'file' },
      { id: 'bounded', op: 'limit', from: 'files', count: 3 },
      { id: 'snippets', op: 'read_snippets', from: 'bounded', contextBefore: 1, contextAfter: 1, maxBytesPerSnippet: 4000, maxTotalBytes: 60000 },
      { id: 'out', op: 'select', from: 'snippets', fields: ['path', 'startLine', 'endLine', 'content'] },
    ],
    output: 'out',
    maxConcurrency: 2,
    maxReturnedBytes: 60000,
  }, logger, noCancel);
  return {
    evidence: result.evidence,
    metrics: {
      modelVisibleCalls: 1,
      primitiveSearches: observed.searches,
      snippetsRead: result.diagnostics.counts.snippetReadCount,
      returnedBytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
      wallMs: performance.now() - startedAt,
      primitiveExecutionMs: observed.searchMs + observed.readMs,
      phaseTimings: result.diagnostics.phaseTimingsMs,
      truncation: result.diagnostics.truncated,
      cacheState: observed.cacheState,
    },
  };
}

try {
  const legacy = await runLegacy();
  const plan = await runPlan();
  assert.deepEqual(plan.evidence, legacy.evidence, 'Repo Query Plan must return evidence equivalent to the legacy primitive workflow');
  assert.equal(plan.metrics.modelVisibleCalls, 1);
  assert.equal(legacy.metrics.modelVisibleCalls, 3);
  assert.equal(plan.metrics.primitiveSearches, legacy.metrics.primitiveSearches);
  assert.equal(plan.metrics.snippetsRead, legacy.metrics.snippetsRead);

  console.log(JSON.stringify({
    benchmark: 'repo-query-plan-v1',
    evidenceEquivalent: true,
    legacy: legacy.metrics,
    repoQueryPlan: plan.metrics,
    measured: {
      modelVisibleCallReduction: legacy.metrics.modelVisibleCalls - plan.metrics.modelVisibleCalls,
      returnedBytesDelta: plan.metrics.returnedBytes - legacy.metrics.returnedBytes,
      wallMsDelta: plan.metrics.wallMs - legacy.metrics.wallMs,
    },
    note: 'Measured on a deterministic local fixture. No fixed token or wall-time percentage claim is assumed from external Search-as-Code results.',
  }, null, 2));
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // better-sqlite3 may keep a Windows handle alive until process exit; cleanup is best-effort only.
  }
}
