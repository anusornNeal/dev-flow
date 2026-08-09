import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-index-'));
process.env.DEVFLOW_DB_PATH = path.join(os.tmpdir(), `devflow-repo-index-db-${path.basename(tempDir)}.sqlite`);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
createProject({ id: 'project-index-1', name: 'Index Fixture', repoUrl: 'https://example.com/index', localPath: tempDir });

const { getRepoInspectionIndex, clearRepoInspectionIndexCache } = await import('../../src/server/services/repoInspectionIndexService.js');
const { mergeProjectFileRules } = await import('../../src/server/services/projectRulesService.js');
const { invalidateRepoReadCaches, invalidateRepoCacheDependencies } = await import('../../src/server/services/repoCacheInvalidationService.js');

const state: any = {
  projectsCache: [
    { id: 'project-index-1', name: 'Index Fixture', repoUrl: 'https://example.com/index', localPath: tempDir },
  ],
};

fs.mkdirSync(path.join(tempDir, 'app', 'src'), { recursive: true });
fs.writeFileSync(path.join(tempDir, 'app', 'src', 'JobDetailScreen.kt'), [
  'class JobDetailViewModel',
  '@Composable',
  'fun JobDetailContent() {}',
  'fun DetailsTabContent() {}',
].join('\n'), 'utf8');
fs.writeFileSync(path.join(tempDir, 'app', 'src', 'Other.kt'), 'fun OtherThing() {}', 'utf8');
fs.mkdirSync(path.join(tempDir, 'node_modules', 'generated'), { recursive: true });
fs.writeFileSync(path.join(tempDir, 'node_modules', 'generated', 'Generated.ts'), 'export const GeneratedSymbol = 1;', 'utf8');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: tempDir, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

test('getRepoInspectionIndex returns focused file and symbol matches from cacheable repo index', () => {
  clearRepoInspectionIndexCache();

  const first = getRepoInspectionIndex(state, {
    projectId: 'project-index-1',
    q: 'JobDetail DetailsTab',
  });
  const second = getRepoInspectionIndex(state, {
    projectId: 'project-index-1',
    q: 'JobDetail DetailsTab',
  });

  assert.equal(first.fileCount, 2);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(typeof first.repoRevision, 'string');
  assert.equal(first.repoRevision, second.repoRevision);
  assert.ok(first.matches.some((entry: any) => entry.path.endsWith('JobDetailScreen.kt')));
  assert.ok(first.matches.some((entry: any) => entry.symbols.includes('JobDetailContent')));
  assert.ok(first.matches.some((entry: any) => entry.symbols.includes('DetailsTabContent')));
});

test('getRepoInspectionIndex keeps explicit target files even when query terms do not match them', () => {
  clearRepoInspectionIndexCache();
  const result = getRepoInspectionIndex(state, {
    projectId: 'project-index-1',
    q: 'OtherThing',
    targetFiles: ['app/src/JobDetailScreen.kt'],
    limit: 2,
  });

  assert.equal(result.matches.length, 2);
  const target = result.matches.find((entry: any) => entry.path.replace(/\\/g, '/') === 'app/src/JobDetailScreen.kt');
  assert.ok(target);
  assert.equal(target.explicitTarget, true);
});

test('getRepoInspectionIndex incrementally refreshes a changed working-tree file inside the cache TTL', () => {
  clearRepoInspectionIndexCache();
  const first = getRepoInspectionIndex(state, {
    projectId: 'project-index-1',
    q: 'OtherThing',
  });
  assert.ok(first.matches.some((entry: any) => entry.symbols.includes('OtherThing')));

  fs.writeFileSync(path.join(tempDir, 'app', 'src', 'Other.kt'), 'fun UpdatedThing() {}', 'utf8');
  invalidateRepoReadCaches(tempDir, 'test-write', { paths: ['app/src/Other.kt'] });
  const second = getRepoInspectionIndex(state, {
    projectId: 'project-index-1',
    q: 'UpdatedThing',
  });

  assert.equal(second.cache.refresh, 'incremental');
  assert.equal(second.cache.changedEntries, 1);
  assert.ok(second.matches.some((entry: any) => entry.symbols.includes('UpdatedThing')));
});

test('project-rules dependency invalidation rebuilds the repo index even when the Git revision is unchanged', () => {
  clearRepoInspectionIndexCache();
  const first = getRepoInspectionIndex(state, {
    projectId: 'project-index-1',
    q: 'UpdatedThing',
  });
  const warm = getRepoInspectionIndex(state, {
    projectId: 'project-index-1',
    q: 'UpdatedThing',
  });
  assert.equal(first.cache.refresh, 'rebuild');
  assert.equal(warm.cache.refresh, 'hit');

  invalidateRepoCacheDependencies({
    root: tempDir,
    reason: 'project-rules-updated',
    dependencies: ['project-rules'],
    paths: ['config/project-rules.json'],
  });

  const afterRules = getRepoInspectionIndex(state, {
    projectId: 'project-index-1',
    q: 'UpdatedThing',
  });
  assert.equal(afterRules.cache.refresh, 'rebuild');
  assert.equal(typeof afterRules.cache.lineageToken, 'string');
  assert.ok(afterRules.cache.lineageToken.length > 0);
});

test('getRepoInspectionIndex skips heavy folders by default and can opt in with includeIgnored', () => {
  clearRepoInspectionIndexCache();

  const safeDefault = getRepoInspectionIndex(state, {
    projectId: 'project-index-1',
    q: 'GeneratedSymbol',
  });
  const withIgnored = getRepoInspectionIndex(state, {
    projectId: 'project-index-1',
    q: 'GeneratedSymbol',
    includeIgnored: true,
  });

  assert.equal(safeDefault.metadata.includeIgnored, false);
  assert.ok(safeDefault.metadata.skippedDirectories.some((entry: string) => entry.includes('node_modules')));
  assert.equal(safeDefault.matches.some((entry: any) => entry.path.includes('node_modules')), false);
  assert.equal(withIgnored.metadata.includeIgnored, true);
  assert.ok(withIgnored.matches.some((entry: any) => entry.path.replace(/\\/g, '/').includes('node_modules/generated/Generated.ts')));
  assert.equal(typeof withIgnored.cache.generatedAt, 'string');
});

test('mergeProjectFileRules keeps safe defaults and merges project file rules predictably', () => {
  const rules = mergeProjectFileRules({
    ignoreDirectories: ['custom-build', '.github', '../escape'],
    includeDirectories: ['.github'],
    maxFiles: 999_999,
    maxFileBytes: 2_000_000,
  });

  assert.ok(rules.ignoreDirectories.includes('node_modules'));
  assert.ok(rules.ignoreDirectories.includes('custom-build'));
  assert.equal(rules.ignoreDirectories.includes('.github'), false);
  assert.ok(rules.includeDirectories.includes('.github'));
  assert.equal(rules.maxFiles, 10_000);
  assert.equal(rules.maxFileBytes, 1_000_000);
});

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
