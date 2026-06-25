import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-index-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { getRepoInspectionIndex, clearRepoInspectionIndexCache } = await import('../../src/server/services/repoInspectionIndexService.js');
const { mergeProjectFileRules } = await import('../../src/server/services/projectRulesService.js');

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
  assert.ok(first.matches.some((entry: any) => entry.path.endsWith('JobDetailScreen.kt')));
  assert.ok(first.matches.some((entry: any) => entry.symbols.includes('JobDetailContent')));
  assert.ok(first.matches.some((entry: any) => entry.symbols.includes('DetailsTabContent')));
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
  assert.ok(withIgnored.matches.some((entry: any) => entry.path.includes('node_modules/generated/Generated.ts')));
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
