import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-atlas-cache-'));
process.env.DEVFLOW_APP_ROOT = tempDir;

const {
  buildEmptyProjectAtlas,
  isAtlasStale,
  markAtlasDailyOpenChecked,
  readAtlasCache,
  shouldRefreshAtlasForDailyOpen,
  writeAtlasCache,
} = await import('../../src/server/services/projectAtlasCacheService.js');
const { getProjectAtlasCachePath } = await import('../../src/lib/devFlowPaths.js');

test('readAtlasCache returns a safe empty state when no snapshot exists', () => {
  const result = readAtlasCache({ projectId: 'project-empty' });

  assert.equal(result.status, 'missing');
  assert.equal(result.atlas.projectId, 'project-empty');
  assert.equal(result.atlas.nodes.length, 0);
  assert.equal(result.atlas.edges.length, 0);
  assert.equal(result.atlas.freshness.status, 'not-generated');
});

test('readAtlasCache tolerates invalid JSON without throwing', () => {
  const cachePath = getProjectAtlasCachePath('project-invalid');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, '{not json', 'utf8');

  const result = readAtlasCache({ projectId: 'project-invalid' });

  assert.equal(result.status, 'invalid');
  assert.equal(result.atlas.projectId, 'project-invalid');
  assert.equal(result.atlas.nodes.length, 0);
  assert.match(result.error ?? '', /Expected property name|JSON/);
});

test('writeAtlasCache preserves graph, metadata, and freshness fields', () => {
  const atlas = buildEmptyProjectAtlas({
    projectId: 'project-valid',
    generatedAt: '2026-07-01T10:00:00.000Z',
    repoFingerprint: 'abc123',
    scanMode: 'manual',
  });
  atlas.nodes.push({
    id: 'file:src/App.tsx',
    label: 'App.tsx',
    kind: 'file',
    path: 'src/App.tsx',
    verified: { source: 'verified', description: 'file exists' },
    inferred: { source: 'inferred', summary: 'main UI entry' },
  });
  atlas.edges.push({
    id: 'contains:src->app',
    source: 'folder:src',
    target: 'file:src/App.tsx',
    kind: 'contains',
    fact: { source: 'verified', description: 'path containment' },
  });
  atlas.domains.push({
    id: 'domain:ui',
    name: 'UI',
    nodeIds: ['file:src/App.tsx'],
    origin: 'user-edited',
    summary: 'User-maintained UI grouping',
  });
  atlas.flows.push({
    id: 'flow:open-task',
    name: 'Open task',
    nodeIds: ['file:src/App.tsx'],
    origin: 'inferred',
  });
  atlas.summary = {
    verified: { source: 'verified', description: '1 file scanned' },
    inferred: { source: 'inferred', summary: 'React app shell' },
    userEdited: { source: 'user-edited', notes: 'Keep UI domain separate' },
  };

  writeAtlasCache({ atlas });
  const result = readAtlasCache({ projectId: 'project-valid' });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.atlas.nodes, atlas.nodes);
  assert.deepEqual(result.atlas.edges, atlas.edges);
  assert.deepEqual(result.atlas.domains, atlas.domains);
  assert.deepEqual(result.atlas.flows, atlas.flows);
  assert.deepEqual(result.atlas.summary, atlas.summary);
  assert.equal(result.atlas.freshness.repoFingerprint, 'abc123');
  assert.equal(result.atlas.freshness.scanMode, 'manual');
});

test('freshness detects stale snapshots and manual rescan override', () => {
  const freshness = {
    generatedAt: '2026-07-01T00:00:00.000Z',
    scanMode: 'automatic',
    repoFingerprint: 'old',
    status: 'fresh',
  } as const;

  assert.equal(isAtlasStale(freshness, { now: '2026-07-02T00:00:01.000Z', repoFingerprint: 'old' }), true);
  assert.equal(isAtlasStale(freshness, { now: '2026-07-01T12:00:00.000Z', repoFingerprint: 'old' }), false);
  assert.equal(isAtlasStale(freshness, { now: '2026-07-01T12:00:00.000Z', repoFingerprint: 'new' }), true);
  assert.equal(isAtlasStale(freshness, { manualRescan: true, now: '2026-07-01T12:00:00.000Z', repoFingerprint: 'old' }), true);
});

test('daily-open refresh is eligible at most once per local day', () => {
  const freshness = {
    generatedAt: '2026-07-01T00:00:00.000Z',
    lastDailyOpenCheckedAt: '2026-07-02T01:00:00.000Z',
    scanMode: 'automatic',
    repoFingerprint: 'old',
    status: 'stale',
  } as const;

  assert.equal(shouldRefreshAtlasForDailyOpen(freshness, { now: '2026-07-02T12:00:00.000Z' }), false);
  assert.equal(shouldRefreshAtlasForDailyOpen(freshness, { now: '2026-07-03T00:00:00.000Z' }), true);
  assert.equal(shouldRefreshAtlasForDailyOpen({ ...freshness, status: 'fresh' }, { now: '2026-07-03T00:00:00.000Z' }), false);
});

test('markAtlasDailyOpenChecked persists throttle timestamp on last good atlas', () => {
  const atlas = buildEmptyProjectAtlas({
    projectId: 'project-daily-open',
    generatedAt: '2026-07-01T00:00:00.000Z',
  });
  atlas.freshness.status = 'stale';
  writeAtlasCache({ atlas });

  const result = markAtlasDailyOpenChecked('project-daily-open', '2026-07-02T03:00:00.000Z');
  const cached = readAtlasCache({ projectId: 'project-daily-open' });

  assert.equal(result.atlas.freshness.lastDailyOpenCheckedAt, '2026-07-02T03:00:00.000Z');
  assert.equal(cached.atlas.freshness.lastDailyOpenCheckedAt, '2026-07-02T03:00:00.000Z');
  assert.equal(cached.atlas.freshness.status, 'stale');
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
