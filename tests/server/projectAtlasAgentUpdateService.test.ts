import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-atlas-agent-update-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;

const { saveLatestAtlas, getProjectAtlasStatus, applyProjectAtlasAgentUpdate } = await import('../../src/server/services/projectAtlasService.js');
const { readAtlasCache } = await import('../../src/server/services/projectAtlasCacheService.js');

const project: any = {
  id: 'project-agent-update',
  name: 'Agent Update Project',
  localPath: tempRoot,
};

function writeFixture(relativePath: string, content = 'export const value = true;\n') {
  const fullPath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function seedAtlas() {
  writeFixture('src/server/routes/devflow.ts');
  writeFixture('src/server/services/projectAtlasService.ts');
  saveLatestAtlas({
    schemaVersion: 1,
    projectId: project.id,
    nodes: [
      {
        id: 'file:src/server/routes/devflow.ts',
        label: 'devflow.ts',
        kind: 'file',
        path: 'src/server/routes/devflow.ts',
        verified: { source: 'verified', description: 'route file exists' },
      },
      {
        id: 'file:src/server/services/projectAtlasService.ts',
        label: 'projectAtlasService.ts',
        kind: 'file',
        path: 'src/server/services/projectAtlasService.ts',
        verified: { source: 'verified', description: 'service file exists' },
      },
    ],
    edges: [
      {
        id: 'imports:route->service',
        source: 'file:src/server/routes/devflow.ts',
        target: 'file:src/server/services/projectAtlasService.ts',
        kind: 'imports',
        fact: { source: 'verified', description: 'route imports service' },
      },
    ],
    domains: [],
    flows: [],
    summary: { verified: { source: 'verified', description: 'deterministic baseline' } },
    freshness: {
      generatedAt: '2026-07-04T08:00:00.000Z',
      repoFingerprint: 'base-fingerprint',
      scanMode: 'manual',
      status: 'fresh',
    },
  });
}

function validPatch() {
  return {
    projectId: project.id,
    base: {
      generatedAt: '2026-07-04T08:00:00.000Z',
      repoFingerprint: 'base-fingerprint',
      nodeCount: 2,
      edgeCount: 1,
    },
    provenance: {
      provider: 'ChatGPT',
      model: 'GPT-5.5',
      prompt: 'Atlas semantic review',
    },
    domains: [
      {
        id: 'agent-domain:atlas',
        name: 'Project Atlas',
        nodeIds: ['file:src/server/services/projectAtlasService.ts'],
        summary: 'Owns Atlas read/status/update behavior.',
        evidence: [
          {
            path: 'src/server/services/projectAtlasService.ts',
            nodeId: 'file:src/server/services/projectAtlasService.ts',
            excerpt: 'export function getProjectAtlasStatus',
          },
        ],
      },
    ],
    summaries: [
      {
        nodeId: 'file:src/server/routes/devflow.ts',
        summary: 'Exposes DevFlow HTTP endpoints for Atlas operations.',
        evidence: [{ path: 'src/server/routes/devflow.ts', nodeId: 'file:src/server/routes/devflow.ts' }],
      },
    ],
    inferredRelationships: [
      {
        id: 'agent-edge:route-applies-overlay',
        source: 'file:src/server/routes/devflow.ts',
        target: 'file:src/server/services/projectAtlasService.ts',
        kind: 'related',
        summary: 'Route delegates Atlas overlay writes to the service.',
        evidence: [{ path: 'src/server/routes/devflow.ts', nodeId: 'file:src/server/routes/devflow.ts' }],
      },
    ],
    readOrder: [
      {
        nodeId: 'file:src/server/routes/devflow.ts',
        path: 'src/server/routes/devflow.ts',
        reason: 'Start at the HTTP surface.',
        evidence: [{ path: 'src/server/routes/devflow.ts', nodeId: 'file:src/server/routes/devflow.ts' }],
      },
    ],
    warnings: [
      {
        message: 'Overlay is agent-inferred and must not replace scanner facts.',
        severity: 'info',
        evidence: [{ path: 'src/server/services/projectAtlasService.ts', nodeId: 'file:src/server/services/projectAtlasService.ts' }],
      },
    ],
  };
}

test('applyProjectAtlasAgentUpdate stores a provenance overlay without changing deterministic facts', () => {
  seedAtlas();

  const result = applyProjectAtlasAgentUpdate(project, validPatch(), { now: '2026-07-04T09:00:00.000Z' });
  const cached = readAtlasCache({ projectId: project.id }).atlas;

  assert.equal(result.ok, true);
  assert.equal(cached.nodes.length, 2);
  assert.equal(cached.edges.length, 1);
  assert.equal(cached.summary.verified?.description, 'deterministic baseline');
  assert.equal(cached.agentOverlay?.status, 'applied');
  assert.equal(cached.agentOverlay?.updatedAt, '2026-07-04T09:00:00.000Z');
  assert.equal(cached.agentOverlay?.base.generatedAt, '2026-07-04T08:00:00.000Z');
  assert.equal(cached.agentOverlay?.domains[0].origin, 'inferred');
  assert.equal(cached.agentOverlay?.summaries[0].nodeId, 'file:src/server/routes/devflow.ts');

  const status = getProjectAtlasStatus(project.id);
  assert.equal(status.overlay.state, 'chatgpt-managed');
  assert.equal(status.overlay.updatedAt, '2026-07-04T09:00:00.000Z');
  assert.equal(status.overlay.base.generatedAt, '2026-07-04T08:00:00.000Z');
  assert.equal(status.overlay.diagnostics.length, 0);
});

test('getProjectAtlasStatus reports stale overlay diagnostics when baseline metadata changes', () => {
  seedAtlas();
  applyProjectAtlasAgentUpdate(project, validPatch(), { now: '2026-07-04T09:00:00.000Z' });
  const cached = readAtlasCache({ projectId: project.id }).atlas;
  saveLatestAtlas({
    ...cached,
    nodes: cached.nodes.slice(0, 1),
  });

  const status = getProjectAtlasStatus(project.id);

  assert.equal(status.overlay.state, 'chatgpt-managed');
  assert.match(status.overlay.diagnostics[0].message, /stale|base/i);
});

test('applyProjectAtlasAgentUpdate rejects an invalid evidence path and leaves cache unchanged', () => {
  seedAtlas();
  const before = readAtlasCache({ projectId: project.id }).atlas;
  const patch = validPatch();
  patch.domains[0].evidence[0].path = 'src/server/services/missing.ts';

  const result = applyProjectAtlasAgentUpdate(project, patch, { now: '2026-07-04T09:00:00.000Z' });
  const after = readAtlasCache({ projectId: project.id }).atlas;

  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0].message, /path/i);
  assert.deepEqual(after, before);
});

test('applyProjectAtlasAgentUpdate rejects stale base metadata and oversized patches', () => {
  seedAtlas();
  const stale = validPatch();
  stale.base.generatedAt = '2026-07-03T08:00:00.000Z';

  const staleResult = applyProjectAtlasAgentUpdate(project, stale);
  assert.equal(staleResult.ok, false);
  assert.match(staleResult.diagnostics[0].message, /stale|base/i);

  const oversized = validPatch();
  oversized.summaries[0].summary = 'x'.repeat(70_000);
  const oversizedResult = applyProjectAtlasAgentUpdate(project, oversized);
  assert.equal(oversizedResult.ok, false);
  assert.match(oversizedResult.diagnostics[0].message, /size/i);
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
