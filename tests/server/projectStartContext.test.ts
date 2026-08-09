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
const { getProjectStartContext, getRepoContextBundle, getRepoReadSnapshot } = await import('../../src/server/services/projectStartContextService.js');
const { stopAllRepoChangeWatchers } = await import('../../src/server/services/workspaceChangeWatcherService.js');

fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"fixture"}\n', 'utf8');
fs.writeFileSync(path.join(tempDir, 'README.md'), '# Fixture\n', 'utf8');
fs.mkdirSync(path.join(tempDir, 'src'));
fs.writeFileSync(path.join(tempDir, 'src', 'snapshotService.ts'), "export function snapshotExample() { return 'snapshot'; }\n", 'utf8');
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
  const result = getProjectStartContext(state, { projectId: 'project-start-1' });

  assert.equal(result.project.id, 'project-start-1');
  assert.equal(result.project.name, 'Start Fixture');
  assert.equal(result.files.count, 3);
  assert.deepEqual(result.hints.present.sort(), ['README.md', 'package.json']);
  assert.ok(result.recommendedNextTools.includes('read_local_file'));
  assert.ok(result.git.available === false || typeof result.git.branch === 'string');
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
});

test('getRepoContextBundle applies smaller intent defaults and exposes ranked evidence', () => {
  const simple = getRepoContextBundle(state, {
    projectId: 'project-start-1',
    q: 'update config SharedContext',
    targetFiles: ['src/sharedContext0.ts'],
  });
  const broadBaseline = getRepoContextBundle(state, {
    projectId: 'project-start-1',
    q: 'update config SharedContext',
    limit: 8,
    snippetLimit: 5,
    snippetLines: 80,
    maxSnippetBytes: 12000,
  });
  const architecture = getRepoContextBundle(state, {
    projectId: 'project-start-1',
    q: 'architecture SharedContext dependency flow',
  });

  assert.equal(simple.contextPlan.intent, 'authoring');
  assert.equal(simple.contextPlan.disclosureLevel, 'symbols');
  assert.equal(simple.contextPlan.budget.indexLimit, 5);
  assert.equal(simple.contextPlan.budget.snippetLimit, 2);
  assert.ok(simple.index.matches.length <= 5);
  assert.ok(simple.snippets.length <= 2);
  assert.equal(simple.contextPlan.evidence[0].path, 'src/sharedContext0.ts');
  assert.equal(simple.contextPlan.evidence[0].rank, 'Must');
  assert.ok(simple.contextPlan.evidence[0].reasons.includes('explicit-target'));
  const targetSnippet = simple.snippets.find((entry: any) => entry.path === 'src/sharedContext0.ts');
  assert.equal(targetSnippet?.evidenceRank, 'Must');
  assert.ok(targetSnippet?.evidenceReasons.includes('explicit-target'));
  assert.equal(typeof targetSnippet?.revision, 'string');

  assert.equal(architecture.contextPlan.intent, 'architecture');
  assert.ok(architecture.contextPlan.budget.snippetLimit > simple.contextPlan.budget.snippetLimit);
  assert.ok(architecture.snippets.length > simple.snippets.length);
  assert.ok(JSON.stringify(simple).length < JSON.stringify(broadBaseline).length);
});

test('getRepoContextBundle preserves explicit caller budgets over planner defaults', () => {
  const result = getRepoContextBundle(state, {
    projectId: 'project-start-1',
    q: 'architecture SharedContext',
    limit: 2,
    snippetLimit: 1,
    snippetLines: 20,
    maxSnippetBytes: 1000,
  });

  assert.equal(result.contextPlan.intent, 'architecture');
  assert.equal(result.contextPlan.budget.indexLimit, 2);
  assert.equal(result.contextPlan.budget.snippetLimit, 1);
  assert.equal(result.contextPlan.budget.snippetLines, 20);
  assert.equal(result.contextPlan.budget.maxSnippetBytes, 1000);
  assert.equal(result.index.matches.length, 2);
  assert.equal(result.snippets.length, 1);
});

test.after(() => {
  stopAllRepoChangeWatchers();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
