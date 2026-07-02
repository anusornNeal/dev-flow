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
    verified: { source: 'verified', description: 'Verified API atlas' },
  },
  freshness: { status: 'fresh', generatedAt: '2026-07-02T00:00:00.000Z' },
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
  assert.match(chatgpt.markdown, /Verified API atlas/);
  assert.ok(focused.matchedNodeIds.includes('file:src/3.ts'));
  assert.match(focused.selectedContext, /src\/3.ts/);
});

test('getProjectAtlasStatus includes freshness and counts', () => {
  const status = getProjectAtlasStatus(project.id);

  assert.equal(status.cacheStatus, 'ok');
  assert.equal(status.generatedAt, '2026-07-02T00:00:00.000Z');
  assert.equal(status.nodeCount, 12);
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

test('maybeRefreshAtlasOnProjectOpen marks daily-open check without blocking on scan', () => {
  saveLatestAtlas({
    ...atlas,
    freshness: {
      status: 'stale',
      generatedAt: '2026-07-01T00:00:00.000Z',
    },
  });

  const first = maybeRefreshAtlasOnProjectOpen(project, { now: '2026-07-02T01:00:00.000Z' });
  const second = maybeRefreshAtlasOnProjectOpen(project, { now: '2026-07-02T02:00:00.000Z' });

  assert.equal(first.shouldRefresh, true);
  assert.equal(second.shouldRefresh, false);
});

test('rescanProjectAtlasSafely preserves last good atlas when scan fails', () => {
  saveLatestAtlas(atlas);

  const result = rescanProjectAtlasSafely({ ...project, localPath: '' }, { now: '2026-07-02T02:00:00.000Z' });

  assert.equal(result.ok, false);
  assert.equal(result.atlas.nodes.length, atlas.nodes.length);
  assert.equal(result.atlas.freshness.status, 'error');
  assert.match(result.atlas.freshness.lastError ?? '', /localPath/i);
});
