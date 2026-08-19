import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-start-context-'));
process.env.DEVFLOW_DB_PATH = path.join(os.tmpdir(), `devflow-start-context-db-${path.basename(tempDir)}.sqlite`);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
createProject({ id: 'project-start-1', name: 'Start Fixture', repoUrl: 'https://example.com/start', localPath: tempDir });
const {
  clearRepoContextBundlePerformanceRecords,
  getProjectStartContext,
  getRepoContextBundle,
  getRepoContextBundlePerformanceSummary,
  getRepoReadSnapshot,
} = await import('../../src/server/services/projectStartContextService.js');
const { ADAPTIVE_SOURCE_DISCLOSURE_POLICY } = await import('../../src/server/services/contextBudgetPlannerService.js');
const { clearRepoInspectionIndexCache } = await import('../../src/server/services/repoInspectionIndexService.js');
const { stopAllRepoChangeWatchers } = await import('../../src/server/services/workspaceChangeWatcherService.js');

fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"fixture"}\n', 'utf8');
fs.writeFileSync(path.join(tempDir, 'README.md'), '# Fixture\n', 'utf8');
fs.mkdirSync(path.join(tempDir, 'src'));
fs.writeFileSync(path.join(tempDir, 'src', 'snapshotService.ts'), "export function snapshotExample() { return 'snapshot'; }\n", 'utf8');
const adaptiveFixture = (lineCount: number, payloadWidth: number) => Array.from(
  { length: lineCount },
  (_, index) => `// ${String(index).padStart(3, '0')} ${'x'.repeat(Math.max(1, payloadWidth))}`,
).join('\n');
fs.writeFileSync(path.join(tempDir, 'src', 'adaptive399.ts'), adaptiveFixture(399, 8), 'utf8');
fs.writeFileSync(path.join(tempDir, 'src', 'adaptive400.ts'), adaptiveFixture(400, 8), 'utf8');
fs.writeFileSync(path.join(tempDir, 'src', 'adaptive401.ts'), adaptiveFixture(401, 8), 'utf8');
fs.writeFileSync(path.join(tempDir, 'src', 'adaptiveByteUnder.ts'), adaptiveFixture(100, 180), 'utf8');
fs.writeFileSync(path.join(tempDir, 'src', 'adaptiveByteOver.ts'), adaptiveFixture(100, 210), 'utf8');
for (let index = 0; index < 10; index += 1) {
  fs.writeFileSync(
    path.join(tempDir, 'src', `sharedContext${index}.ts`),
    `export function SharedContext${index}() { return '${'x'.repeat(240)}'; }\n`,
    'utf8',
  );
}

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: tempDir, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const state: any = {
  projectsCache: [
    { id: 'project-start-1', name: 'Start Fixture', repoUrl: 'https://example.com/start', localPath: tempDir },
  ],
};
createProject(state.projectsCache[0]);

test('getProjectStartContext returns compact project and top-level file context', () => {
  const scheduled: Array<() => void> = [];
  const result = getProjectStartContext(state, {
    projectId: 'project-start-1',
    atlasScheduler: (run: () => void) => scheduled.push(run),
  });

  assert.equal(result.project.id, 'project-start-1');
  assert.equal(result.project.name, 'Start Fixture');
  assert.ok(result.files.count >= 3);
  assert.deepEqual(result.hints.present.sort(), ['README.md', 'package.json']);
  assert.ok(result.recommendedNextTools.includes('read_local_file'));
  assert.ok(result.git.available === false || typeof result.git.branch === 'string');
  assert.equal(result.projectAtlas.projectId, 'project-start-1');
  assert.equal(result.projectAtlas.lifecycleState, 'generating');
  assert.equal(result.projectAtlas.strategy, 'bootstrap');
  assert.equal(scheduled.length, 1);
});

test('project-local .devflow/agents.md is surfaced first without exposing sibling .devflow files', () => {
  const hintRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-start-hints-'));
  const devFlowDir = path.join(hintRoot, '.devflow');
  fs.mkdirSync(devFlowDir, { recursive: true });
  fs.writeFileSync(path.join(hintRoot, 'README.md'), '# Hints\n', 'utf8');
  fs.writeFileSync(path.join(hintRoot, 'package.json'), '{"name":"hints"}\n', 'utf8');
  fs.writeFileSync(path.join(hintRoot, 'AGENTS.md'), 'generic guidance\n', 'utf8');
  fs.writeFileSync(path.join(devFlowDir, 'agents.md'), 'devflow-local guidance\n', 'utf8');
  fs.writeFileSync(path.join(devFlowDir, 'commands.yaml'), 'commands: {}\n', 'utf8');
  fs.writeFileSync(path.join(devFlowDir, 'secret.txt'), 'must-not-surface\n', 'utf8');
  const hintProject = {
    id: 'project-start-hints',
    name: 'Hints Fixture',
    repoUrl: 'https://example.com/start-hints',
    localPath: hintRoot,
  };
  createProject(hintProject);
  state.projectsCache.push(hintProject);

  try {
    const both = getProjectStartContext(state, { projectId: hintProject.id, atlasScheduler: () => {} });
    assert.deepEqual(both.hints.recommendedReads.slice(0, 3), ['.devflow/agents.md', 'AGENTS.md', 'README.md']);
    assert.equal(both.hints.present.includes('.devflow/commands.yaml'), false);
    assert.equal(both.hints.present.includes('.devflow/secret.txt'), false);

    const bundle = getRepoContextBundle(state, {
      projectId: hintProject.id,
      q: 'devflow commands secret project guidance',
      limit: 20,
      atlasScheduler: () => {},
    });
    assert.equal(bundle.hints.recommendedReads[0], '.devflow/agents.md');
    assert.equal(bundle.index.matches.some((entry: any) => entry.path.replace(/\\/g, '/').startsWith('.devflow/')), false);

    fs.unlinkSync(path.join(hintRoot, 'AGENTS.md'));
    const devFlowOnly = getProjectStartContext(state, { projectId: hintProject.id, atlasScheduler: () => {} });
    assert.equal(devFlowOnly.hints.recommendedReads[0], '.devflow/agents.md');
    assert.equal(devFlowOnly.hints.present.includes('AGENTS.md'), false);

    fs.writeFileSync(path.join(hintRoot, 'AGENTS.md'), 'generic guidance\n', 'utf8');
    fs.unlinkSync(path.join(devFlowDir, 'agents.md'));
    const rootOnly = getProjectStartContext(state, { projectId: hintProject.id, atlasScheduler: () => {} });
    assert.equal(rootOnly.hints.recommendedReads[0], 'AGENTS.md');
    assert.equal(rootOnly.hints.present.includes('.devflow/agents.md'), false);

    fs.unlinkSync(path.join(hintRoot, 'AGENTS.md'));
    const neither = getProjectStartContext(state, { projectId: hintProject.id, atlasScheduler: () => {} });
    assert.equal(neither.hints.present.includes('.devflow/agents.md'), false);
    assert.equal(neither.hints.present.includes('AGENTS.md'), false);
  } finally {
    state.projectsCache = state.projectsCache.filter((project: any) => project.id !== hintProject.id);
    fs.rmSync(hintRoot, { recursive: true, force: true });
  }
});

test('getRepoReadSnapshot returns compact metadata without file contents', () => {
  const result = getRepoReadSnapshot(state, { projectId: 'project-start-1', q: 'snapshot', limit: 5 });

  assert.equal(result.project.id, 'project-start-1');
  assert.ok(result.summary.includes('read_file_snippets_batch'));
  assert.ok(result.recommendedNextTools.includes('read_file_snippets_batch'));
  assert.ok(result.likelyFiles.length >= 1);
  assert.equal('content' in result.likelyFiles[0], false);
  assert.equal(typeof result.likelyFiles[0].metadata.revision, 'string');
});

test('getRepoContextBundle applies intent-aware budgets and evidence reasons', () => {
  const simple = getRepoContextBundle(state, {
    projectId: 'project-start-1',
    q: 'update README wording documentation',
    targetFiles: ['README.md'],
  });

  assert.equal(simple.contextPlan.intent, 'authoring');
  assert.equal(simple.contextPlan.disclosureLevel, 'symbols');
  assert.ok(simple.contextPlan.budgets.snippetBytes < 60_000);
  assert.ok(simple.contextPlan.returnedSnippetBytes <= simple.contextPlan.budgets.snippetBytes);
  const readme = simple.snippets.find((snippet: any) => snippet.path.replace(/\\/g, '/') === 'README.md');
  assert.ok(readme);
  assert.equal(readme.rank, 'must');
  assert.ok(readme.reasons.some((reason: string) => reason.includes('target')));
  assert.equal(typeof readme.freshnessIdentity, 'string');

  const architecture = getRepoContextBundle(state, {
    projectId: 'project-start-1',
    q: 'analyze architecture and module boundaries for the whole system',
  });
  assert.equal(architecture.contextPlan.intent, 'architecture-analysis');
  assert.equal(architecture.contextPlan.disclosureLevel, 'callers-tests');
  assert.ok(architecture.contextPlan.budgets.snippetBytes > simple.contextPlan.budgets.snippetBytes);
  assert.notEqual(architecture.contextPlan.disclosureLevel, 'full-file');

  const explicitFull = getRepoContextBundle(state, {
    projectId: 'project-start-1',
    q: 'snapshot implementation',
    targetFiles: ['src/snapshotService.ts'],
    disclosureLevel: 'full-file',
  });
  assert.equal(explicitFull.contextPlan.disclosureLevel, 'full-file');
  assert.ok(explicitFull.contextPlan.budgets.snippetBytes >= 120_000);
});

test('getRepoContextBundle applies size-aware adaptive disclosure without overriding explicit smaller requests', () => {
  const readAdaptive = (filePath: string, overrides: Record<string, any> = {}) => getRepoContextBundle(state, {
    projectId: 'project-start-1',
    q: 'adaptive source disclosure threshold',
    contextIntent: 'cross-module-change',
    targetFiles: [filePath],
    snippetLimit: 1,
    maxContextBytes: 40_000,
    ...overrides,
  });

  for (const [filePath, expectedLines] of [['src/adaptive399.ts', 399], ['src/adaptive400.ts', 400]] as const) {
    const result = readAdaptive(filePath);
    assert.equal(result.snippets.length, 1);
    assert.equal(result.snippets[0].totalLines, expectedLines);
    assert.equal(result.snippets[0].endLine, expectedLines);
    assert.equal(result.snippets[0].truncated, false);
    assert.equal(result.snippets[0].adaptiveDisclosure.mode, 'whole-small-file');
    assert.equal(result.snippets[0].adaptiveDisclosure.wholeFileSelected, true);
  }

  const overLineLimit = readAdaptive('src/adaptive401.ts');
  assert.equal(overLineLimit.snippets.length, 1);
  assert.equal(overLineLimit.snippets[0].totalLines, 401);
  assert.equal(overLineLimit.snippets[0].adaptiveDisclosure.mode, 'bounded-large-file');
  assert.equal(overLineLimit.snippets[0].endLine, ADAPTIVE_SOURCE_DISCLOSURE_POLICY.largeFileWindowLines);
  assert.equal(overLineLimit.snippets[0].truncated, true);

  const byteUnderPath = path.join(tempDir, 'src', 'adaptiveByteUnder.ts');
  const byteOverPath = path.join(tempDir, 'src', 'adaptiveByteOver.ts');
  assert.equal(fs.statSync(byteUnderPath).size < ADAPTIVE_SOURCE_DISCLOSURE_POLICY.smallFileMaxBytes, true);
  assert.equal(fs.statSync(byteOverPath).size > ADAPTIVE_SOURCE_DISCLOSURE_POLICY.smallFileMaxBytes, true);

  const underByteLimit = readAdaptive('src/adaptiveByteUnder.ts');
  assert.equal(underByteLimit.snippets[0].adaptiveDisclosure.mode, 'whole-small-file');
  assert.equal(underByteLimit.snippets[0].truncated, false);

  const overByteLimit = readAdaptive('src/adaptiveByteOver.ts');
  assert.equal(overByteLimit.snippets[0].adaptiveDisclosure.mode, 'bounded-large-file');
  assert.equal(overByteLimit.snippets[0].returnedBytes <= ADAPTIVE_SOURCE_DISCLOSURE_POLICY.smallFileMaxBytes, true);
  assert.equal(overByteLimit.snippets[0].truncated, true);

  const explicitLines = readAdaptive('src/adaptive399.ts', { snippetLines: 25 });
  assert.equal(explicitLines.contextPlan.adaptiveDisclosure.automatic, false);
  assert.equal(explicitLines.snippets[0].endLine, 25);
  assert.equal(explicitLines.snippets[0].adaptiveDisclosure.mode, 'explicit-window');

  const explicitBytes = readAdaptive('src/adaptiveByteUnder.ts', { maxSnippetBytes: 512 });
  assert.equal(explicitBytes.contextPlan.adaptiveDisclosure.explicitMaxSnippetBytes, true);
  assert.equal(explicitBytes.snippets[0].returnedBytes <= 512, true);
  assert.equal(explicitBytes.snippets[0].adaptiveDisclosure.wholeFileSelected, false);

  const explicitDisclosure = readAdaptive('src/adaptive399.ts', { disclosureLevel: 'snippets' });
  assert.equal(explicitDisclosure.contextPlan.adaptiveDisclosure.automatic, false);
  assert.equal(explicitDisclosure.snippets[0].adaptiveDisclosure.mode, 'explicit-window');
  assert.equal(explicitDisclosure.snippets[0].endLine, explicitDisclosure.contextPlan.budgets.snippetLines);

  const constrainedAggregate = readAdaptive('src/adaptiveByteUnder.ts', { maxContextBytes: 12_000 });
  assert.equal(constrainedAggregate.contextPlan.responseBudget.returnedBytes <= 12_000, true);
  assert.equal(constrainedAggregate.contextPlan.maxContextBytes ?? constrainedAggregate.contextPlan.budgets.maxContextBytes, 12_000);
  assert.equal(constrainedAggregate.snippets[0]?.adaptiveDisclosure.wholeFileSelected === true, false);
});

test('getRepoContextBundle enforces an aggregate budget for metadata-heavy project summaries', () => {
  const heavyDir = path.join(tempDir, 'metadata-heavy');
  fs.mkdirSync(heavyDir, { recursive: true });
  try {
    for (let fileIndex = 0; fileIndex < 20; fileIndex += 1) {
      const imports = Array.from({ length: 24 }, (_, index) => `import value${index} from 'package-${fileIndex}-${index}';`).join('\n');
      const symbols = Array.from({ length: 60 }, (_, index) => `export function MetadataHeavy${fileIndex}_${index}() { return value${index % 24}; }`).join('\n');
      fs.writeFileSync(path.join(heavyDir, `metadataHeavy${fileIndex}.ts`), `${imports}\n${symbols}\n`, 'utf8');
    }
    clearRepoInspectionIndexCache(tempDir);

    const budgetBytes = 12_000;
    const compact = getRepoContextBundle(state, {
      projectId: 'project-start-1',
      q: 'metadata heavy implementation symbols imports',
      disclosureLevel: 'project-summary',
      targetFiles: ['metadata-heavy/metadataHeavy0.ts'],
      limit: 20,
      maxContextBytes: budgetBytes,
    });
    const compactBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');

    assert.equal(compactBytes <= budgetBytes, true, `aggregate bundle should fit ${budgetBytes} bytes, got ${compactBytes}`);
    assert.equal(compact.contextPlan.responseBudget.budgetBytes, budgetBytes);
    assert.equal(compact.contextPlan.responseBudget.returnedBytes, compactBytes);
    assert.equal(compact.contextPlan.responseBudget.budgetExhausted, true);
    assert.equal(compact.contextPlan.responseBudget.omitted.indexMatchDetails > 0, true);
    const target = compact.contextPlan.evidence.find((entry: any) => entry.path.replace(/\\/g, '/') === 'metadata-heavy/metadataHeavy0.ts');
    assert.ok(target);
    assert.equal(target.rank, 'must');
    assert.equal(target.explicitTarget, true);
    assert.equal(compact.index.matches.every((entry: any) => !('imports' in entry) && !('reasons' in entry)), true);

    const expanded = getRepoContextBundle(state, {
      projectId: 'project-start-1',
      q: 'metadata heavy implementation symbols imports',
      disclosureLevel: 'project-summary',
      targetFiles: ['metadata-heavy/metadataHeavy0.ts'],
      limit: 20,
      maxContextBytes: 40_000,
    });
    const expandedBytes = Buffer.byteLength(JSON.stringify(expanded), 'utf8');
    assert.equal(expandedBytes <= 40_000, true);
    assert.equal(expandedBytes > compactBytes, true);
  } finally {
    fs.rmSync(heavyDir, { recursive: true, force: true });
    clearRepoInspectionIndexCache(tempDir);
  }
});

test('getRepoContextBundle exposes repo and snippet revisions', () => {
  const first = getRepoContextBundle(state, { projectId: 'project-start-1', q: 'snapshot', limit: 5, snippetLimit: 2 });

  assert.equal(typeof first.repoRevision, 'string');
  assert.ok(first.repoRevision.length > 10);
  assert.ok(first.snippets.length >= 1);
  assert.equal(typeof first.snippets[0].revision, 'string');
  assert.equal(typeof first.snippets[0].fileRevision.token, 'string');

  fs.writeFileSync(path.join(tempDir, 'src', 'snapshotService.ts'), "export function snapshotExample() { return 'changed'; }\n", 'utf8');
  const second = getRepoContextBundle(state, { projectId: 'project-start-1', q: 'snapshot', limit: 5, snippetLimit: 2 });
  assert.notEqual(second.repoRevision, first.repoRevision);
  assert.notEqual(second.snippets[0].freshnessIdentity, first.snippets[0].freshnessIdentity);
});

test('getRepoContextBundle separates cold/warm phase timings and keeps representative warm p95 within SLO', () => {
  clearRepoContextBundlePerformanceRecords();
  clearRepoInspectionIndexCache(tempDir);
  const args = {
    projectId: 'project-start-1',
    q: 'shared context implementation callers tests',
    contextIntent: 'verification-debugging',
    targetFiles: ['src/snapshotService.ts', 'src/sharedContext0.ts', 'src/sharedContext1.ts'],
    snippetLimit: 6,
    snippetLines: 40,
    maxContextBytes: 24_000,
  };

  const cold = getRepoContextBundle(state, args);
  assert.equal(cold.performance.repoIndexCacheState, 'cold');
  assert.equal(cold.index.cache.revisionSource, 'post-build');
  assert.equal(typeof cold.performance.totalMs, 'number');
  assert.equal(typeof cold.performance.phases.startContextMs, 'number');
  assert.equal(typeof cold.performance.phases.repoIndexMs, 'number');
  assert.equal(typeof cold.performance.phases.snippetReadMs, 'number');
  assert.equal(typeof cold.performance.phases.snippetReadCount, 'number');
  assert.equal(typeof cold.performance.phases.diffMs, 'number');
  assert.equal(typeof cold.performance.phases.responseAssemblyMs, 'number');
  assert.equal(typeof cold.performance.dominantPhase, 'string');

  const warmDurations: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const warm = getRepoContextBundle(state, args);
    assert.equal(warm.performance.repoIndexCacheState, 'warm');
    assert.equal(warm.index.cache.revisionSource, 'trusted-request');
    warmDurations.push(warm.performance.totalMs);
  }
  const sortedWarm = [...warmDurations].sort((left, right) => left - right);
  const spoofed = getRepoContextBundle(state, { ...args, repoRevision: 'caller-supplied-not-trusted' });
  assert.equal(spoofed.index.cache.revisionSource, 'trusted-request');
  assert.notEqual(spoofed.repoRevision, 'caller-supplied-not-trusted');

  const warmP95 = sortedWarm[Math.ceil(sortedWarm.length * 0.95) - 1];
  assert.equal(warmP95 <= 750, true, `representative warm bundle p95 should stay <=750ms, got ${warmP95}ms`);

  const summary = getRepoContextBundlePerformanceSummary({ windowMs: 60_000 });
  assert.equal(summary.cold.count >= 1, true);
  assert.equal(summary.warm.count >= 5, true);
  assert.equal(summary.warm.repoIndexCacheState, 'warm');
  assert.equal(summary.cold.repoIndexCacheState, 'cold');

  assert.equal(typeof summary.warm.p95TotalMs, 'number');
  assert.equal(typeof summary.warm.dominantPhase, 'string');
  assert.equal(typeof summary.warm.phases.snippetRead.p95Ms, 'number');
  assert.doesNotMatch(JSON.stringify(summary), /snapshotExample|sharedContext0|\.ts/);
});

test.after(() => {
  stopAllRepoChangeWatchers();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
