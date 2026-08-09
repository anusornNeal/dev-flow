import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-atlas-api-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;

const {
  getProjectAtlasForApi,
  getProjectAtlasStatus,
  getTaskFocusedAtlasContext,
  maybeRefreshAtlasOnProjectOpen,
  rescanProjectAtlasSafely,
  saveLatestAtlas,
  shouldIncludeAtlasForTask,
} = await import('../../src/server/services/projectAtlasService.js');

const project: any = {
  id: 'project-api',
  name: 'Atlas API Project',
  repoUrl: 'https://example.test/repo',
  localPath: tempRoot,
};

const atlas: any = {
  schemaVersion: 1,
  projectId: project.id,
  nodes: Array.from({ length: 12 }, (_, index) => ({
    id: `file:src/${index}.ts`,
    label: `${index}.ts`,
    kind: 'file',
    path: `src/${index}.ts`,
    verified: { source: 'verified', description: `File ${index}` },
    metadata: { domainId: index % 2 === 0 ? 'domain:core' : 'domain:tools' },
  })),
  edges: Array.from({ length: 12 }, (_, index) => ({
    id: `edge:${index}`,
    source: `file:src/${index}.ts`,
    target: `file:src/${(index + 1) % 12}.ts`,
    kind: 'imports',
    fact: { source: 'verified', description: `edge ${index}` },
  })),
  domains: [
    { id: 'domain:core', name: 'Core', nodeIds: ['file:src/0.ts', 'file:src/2.ts'], origin: 'verified' },
    { id: 'domain:tools', name: 'Tools', nodeIds: ['file:src/1.ts', 'file:src/3.ts'], origin: 'inferred' },
  ],
  flows: [],
  summary: {
    inferred: { source: 'inferred', summary: 'ChatGPT-authored API atlas' },
  },
  freshness: { status: 'fresh', generatedAt: new Date().toISOString(), scanMode: 'task-focused' },
  authoring: {
    updatedAt: new Date().toISOString(),
    provenance: { provider: 'ChatGPT', model: 'GPT-5.5' },
    coverage: { notes: ['Authored from staged repo reads.'], skippedAreas: [{ path: 'dist', reason: 'Generated output.' }] },
    groupingRationale: { summary: 'ChatGPT grouped related project areas.' },
    evidence: [{ path: 'src/0.ts', nodeId: 'file:src/0.ts' }],
    readOrder: [{ nodeId: 'file:src/3.ts', path: 'src/3.ts', reason: 'Relevant to the request.' }],
    warnings: [{ message: 'Generated output skipped.', severity: 'info' }],
  },
};

saveLatestAtlas(atlas);

test('getProjectAtlasForApi returns compact status and capped standard output', () => {
  const compact = getProjectAtlasForApi(project, { mode: 'compact' }) as any;
  const standard = getProjectAtlasForApi(project, { mode: 'standard', limit: 5 }) as any;

  assert.equal(compact.mode, 'compact');
  assert.equal(compact.stale, false);
  assert.equal(compact.nodeCount, 12);
  assert.equal(standard.nodes.length, 5);
  assert.equal(standard.edges.length, 5);
  assert.equal(standard.truncated, true);
});

test('getProjectAtlasForApi returns markdown context and task-focused search', () => {
  const chatgpt = getProjectAtlasForApi(project, { mode: 'chatgpt-context' }) as any;
  const focused = getProjectAtlasForApi(project, { mode: 'task-focused', query: 'src/3.ts', limit: 4 }) as any;

  assert.equal(chatgpt.format, 'markdown');
  assert.match(chatgpt.markdown, /ChatGPT-authored API atlas/);
  assert.ok(focused.matchedNodeIds.includes('file:src/3.ts'));
  assert.match(focused.selectedContext, /src\/3.ts/);
});

test('getProjectAtlasStatus includes freshness and counts', () => {
  const status = getProjectAtlasStatus(project.id);

  assert.equal(status.cacheStatus, 'ok');
  assert.equal(status.generatedAt, atlas.freshness.generatedAt);
  assert.equal(status.nodeCount, 12);
  assert.equal(status.authoring.state, 'chatgpt-authored');
  assert.equal(status.authoring.provenance.provider, 'ChatGPT');
});

test('getProjectAtlasForApi can include copy-ready prompt templates', () => {
  const response = getProjectAtlasForApi(project, {
    mode: 'task-focused',
    query: 'src/3.ts',
    promptVariant: 'plan-implementation',
    taskId: 'DVF-0296',
    taskTitle: 'Project Atlas prompt templates',
    targetFiles: ['src/3.ts'],
  } as any) as any;

  assert.equal(response.promptTemplate.variantId, 'plan-implementation');
  assert.match(response.promptTemplate.prompt, /Project Atlas prompt templates/);
  assert.match(response.promptTemplate.prompt, /verified/i);
  assert.match(response.promptTemplate.prompt, /Do not edit unrelated modules/i);
});

test('getProjectAtlasForApi exposes diff-impact output and task-focused impact warnings', () => {
  const diffImpact = getProjectAtlasForApi(project, {
    mode: 'diff-impact',
    changedFiles: ['src/3.ts'],
  } as any) as any;
  const taskFocused = getProjectAtlasForApi(project, {
    mode: 'task-focused',
    query: 'src/3.ts',
    taskTitle: 'Unknown target files',
    targetFiles: [],
  } as any) as any;

  assert.equal(diffImpact.format, 'impact');
  assert.ok(diffImpact.impact.directNodes.some((node: any) => node.path === 'src/3.ts'));
  assert.match(diffImpact.impact.markdown, /Verified direct impact/);
  assert.match(diffImpact.impact.mermaid, /graph TD/);
  assert.ok(Array.isArray(taskFocused.impact.warnings));
});

test('shouldIncludeAtlasForTask is selective and preserves focused targetFiles', () => {
  assert.equal(shouldIncludeAtlasForTask({ title: 'Small fix', targetFiles: ['src/one.ts'] }).include, false);
  assert.equal(shouldIncludeAtlasForTask({ title: 'Architecture cleanup', targetFiles: ['src/one.ts'] }).include, true);
  assert.equal(shouldIncludeAtlasForTask({ title: 'Unknown implementation', targetFiles: [] }).reason, 'missing-target-files');
});

test('getTaskFocusedAtlasContext renders read order and guardrails', () => {
  const context = getTaskFocusedAtlasContext(project, {
    title: 'Update src/3.ts behavior',
    targetFiles: [],
  });

  assert.equal(context?.included, true);
  assert.match(context?.markdown ?? '', /Recommended Read Order/);
  assert.match(context?.markdown ?? '', /targetFiles.*authoritative/i);
  assert.ok((context?.recommendedReadOrder ?? []).some((entry: string) => entry.includes('src/3.ts')));
});

test('maybeRefreshAtlasOnProjectOpen leaves a fresh matching atlas idle', () => {
  saveLatestAtlas({
    ...atlas,
    freshness: {
      status: 'fresh',
      generatedAt: '2026-07-02T00:30:00.000Z',
      repoFingerprint: 'rev-current',
    },
  });

  const scheduled: Array<() => void> = [];
  const result = maybeRefreshAtlasOnProjectOpen(project, {
    now: '2026-07-02T01:00:00.000Z',
    repoRevision: { token: 'rev-current', head: '0123456789abcdef', branch: 'develop', changedFiles: [] },
    scheduler: (run: () => void) => scheduled.push(run),
  } as any) as any;

  assert.equal(result.shouldRefresh, false);
  assert.equal(result.lifecycleState, 'fresh');
  assert.equal(result.reason, 'not-needed');
  assert.equal(scheduled.length, 0);
});

test('maybeRefreshAtlasOnProjectOpen schedules one revision-aware refresh and preserves the last good graph', () => {
  fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'src', '0.ts'), 'export const changed = true;\n', 'utf8');
  saveLatestAtlas({
    ...atlas,
    freshness: {
      status: 'fresh',
      generatedAt: '2026-07-02T00:00:00.000Z',
      repoFingerprint: 'rev-old',
    },
  });

  const scheduled: Array<() => void> = [];
  const repoRevision = {
    token: 'rev-new',
    head: '0123456789abcdef',
    branch: 'develop',
    changedFiles: [{
      path: 'src/0.ts',
      workingPath: 'src/0.ts',
      status: 'M',
      staged: false,
      fingerprint: 'changed',
    }],
  };
  const first = maybeRefreshAtlasOnProjectOpen(project, {
    now: '2026-07-02T01:00:00.000Z',
    repoRevision,
    scheduler: (run: () => void) => scheduled.push(run),
  } as any) as any;
  const second = maybeRefreshAtlasOnProjectOpen(project, {
    now: '2026-07-02T01:00:01.000Z',
    repoRevision,
    scheduler: (run: () => void) => scheduled.push(run),
  } as any) as any;

  assert.equal(first.shouldRefresh, true);
  assert.equal(first.lifecycleState, 'generating');
  assert.equal(first.strategy, 'incremental');
  assert.equal(second.deduplicated, true);
  assert.equal(scheduled.length, 1);
  assert.equal(getProjectAtlasStatus(project.id).nodeCount, atlas.nodes.length);

  scheduled[0]();
  const refreshed = getProjectAtlasStatus(project.id);
  assert.equal(refreshed.freshness.status, 'fresh');
  assert.equal(refreshed.freshness.repoFingerprint, 'rev-new');
  assert.ok(refreshed.nodeCount >= atlas.nodes.length);
  assert.equal(refreshed.authoring.state, 'chatgpt-authored');
});

test('maybeRefreshAtlasOnProjectOpen records scheduler failures without breaking callers', () => {
  saveLatestAtlas({
    ...atlas,
    freshness: {
      status: 'stale',
      generatedAt: '2026-07-01T00:00:00.000Z',
      repoFingerprint: 'rev-before-scheduler-failure',
    },
  });

  let result: any;
  assert.doesNotThrow(() => {
    result = maybeRefreshAtlasOnProjectOpen(project, {
      now: '2026-07-02T02:00:00.000Z',
      repoRevision: { token: 'rev-scheduler-failure', head: 'abcdef0123456789', branch: 'develop', changedFiles: [] },
      scheduler: () => {
        throw new Error('scheduler unavailable');
      },
    } as any);
  });

  assert.equal(result.shouldRefresh, true);
  assert.equal(result.scheduled, false);
  assert.equal(result.lifecycleState, 'failed-retryable');
  const failed = getProjectAtlasStatus(project.id);
  assert.equal(failed.lifecycleState, 'failed-retryable');
  assert.equal(failed.retryable, true);
  assert.equal(failed.nodeCount, atlas.nodes.length);
  assert.match(failed.lastError ?? '', /scheduler unavailable/i);
});

test('maybeRefreshAtlasOnProjectOpen falls back to a full rebuild for unsafe diffs', () => {
  saveLatestAtlas({
    ...atlas,
    freshness: {
      status: 'fresh',
      generatedAt: '2026-07-02T00:00:00.000Z',
      repoFingerprint: 'rev-before-delete',
    },
  });
  const scheduled: Array<() => void> = [];
  const result = maybeRefreshAtlasOnProjectOpen(project, {
    now: '2026-07-02T02:30:00.000Z',
    repoRevision: {
      token: 'rev-delete',
      head: 'abcdef0123456789',
      branch: 'develop',
      changedFiles: [{ path: 'src/deleted.ts', workingPath: 'src/deleted.ts', status: 'D', staged: false, fingerprint: 'missing' }],
    },
    scheduler: (run: () => void) => scheduled.push(run),
  } as any) as any;

  assert.equal(result.strategy, 'full');
  assert.equal(result.lifecycleState, 'generating');
  assert.equal(getProjectAtlasStatus(project.id).nodeCount, atlas.nodes.length);
  scheduled[0]();
  const refreshed = getProjectAtlasStatus(project.id);
  assert.equal(refreshed.freshness.status, 'fresh');
  assert.equal(refreshed.freshness.repoFingerprint, 'rev-delete');
});

test('maybeRefreshAtlasOnProjectOpen bootstraps a missing atlas without blocking the caller', () => {
  const missingProject = { ...project, id: 'project-api-missing' };
  const scheduled: Array<() => void> = [];
  const result = maybeRefreshAtlasOnProjectOpen(missingProject, {
    now: '2026-07-02T03:00:00.000Z',
    repoRevision: { token: 'rev-bootstrap', head: 'abcdef0123456789', branch: 'develop', changedFiles: [] },
    scheduler: (run: () => void) => scheduled.push(run),
  } as any) as any;

  assert.equal(result.cacheStatus, 'missing');
  assert.equal(result.shouldRefresh, true);
  assert.equal(result.lifecycleState, 'generating');
  assert.equal(result.strategy, 'bootstrap');
  assert.equal(scheduled.length, 1);

  scheduled[0]();
  const refreshed = getProjectAtlasStatus(missingProject.id);
  assert.equal(refreshed.cacheStatus, 'ok');
  assert.equal(refreshed.freshness.status, 'fresh');
  assert.equal(refreshed.freshness.repoFingerprint, 'rev-bootstrap');
});

test('rescanProjectAtlasSafely keeps manual rescan semantics', () => {
  const result = rescanProjectAtlasSafely(project, { now: '2026-07-02T04:00:00.000Z' });

  assert.equal(result.ok, true);
  assert.equal(result.atlas.freshness.status, 'fresh');
  assert.equal(result.atlas.freshness.scanMode, 'manual');
});

test('rescanProjectAtlasSafely preserves last good atlas when scan fails', () => {
  saveLatestAtlas(atlas);

  const result = rescanProjectAtlasSafely({ ...project, localPath: '' }, { now: '2026-07-02T02:00:00.000Z' });

  assert.equal(result.ok, false);
  assert.equal(result.atlas.nodes.length, atlas.nodes.length);
  assert.equal(result.atlas.freshness.status, 'error');
  assert.match(result.atlas.freshness.lastError ?? '', /localPath/i);
});
