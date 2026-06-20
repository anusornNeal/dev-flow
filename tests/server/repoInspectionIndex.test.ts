import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-index-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { getRepoInspectionIndex, clearRepoInspectionIndexCache } = await import('../../src/server/services/repoInspectionIndexService.js');

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

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
