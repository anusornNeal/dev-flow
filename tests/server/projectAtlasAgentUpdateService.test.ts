import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-atlas-agent-update-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;

const { getProjectAtlasStatus, applyProjectAtlasAgentUpdate } = await import('../../src/server/services/projectAtlasService.js');
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

function writeAuthoringFixture() {
  writeFixture('src/server/routes/devflow.ts');
  writeFixture('src/server/services/projectAtlasService.ts');
}

function validAuthoredAtlas() {
  return {
    projectId: project.id,
    generatedAt: '2026-07-04T09:00:00.000Z',
    provenance: {
      provider: 'ChatGPT',
      model: 'GPT-5.5',
      prompt: 'Atlas semantic review',
    },
    coverage: {
      notes: ['Read HTTP routes before Atlas services.'],
      skippedAreas: [{ path: 'node_modules', reason: 'Dependency directory excluded from repo authoring.' }],
    },
    groupingRationale: {
      summary: 'Grouped by user-facing Atlas responsibility after staged repo reads.',
      domainRationales: [
        {
          domainId: 'domain:atlas',
          rationale: 'Atlas service and route collaborate on read/write behavior.',
          evidence: [{ path: 'src/server/services/projectAtlasService.ts', nodeId: 'file:src/server/services/projectAtlasService.ts' }],
        },
      ],
    },
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
        id: 'authored-edge:route-service',
        source: 'file:src/server/routes/devflow.ts',
        target: 'file:src/server/services/projectAtlasService.ts',
        kind: 'related',
        fact: { source: 'inferred', summary: 'Route delegates authored Atlas saves to the service.' },
      },
    ],
    domains: [
      {
        id: 'domain:atlas',
        name: 'Project Atlas',
        nodeIds: ['file:src/server/routes/devflow.ts', 'file:src/server/services/projectAtlasService.ts'],
        origin: 'inferred',
        summary: 'Owns Atlas authored save/read behavior.',
        metadata: {
          rationale: 'ChatGPT grouped route and service as one Atlas authoring surface.',
          evidence: [{ path: 'src/server/routes/devflow.ts', nodeId: 'file:src/server/routes/devflow.ts' }],
        },
      },
    ],
    flows: [],
    summary: { inferred: { source: 'inferred', summary: 'ChatGPT-authored Atlas.' } },
    readOrder: [
      { nodeId: 'file:src/server/routes/devflow.ts', path: 'src/server/routes/devflow.ts', reason: 'Start at the HTTP surface.' },
    ],
    warnings: [{ message: 'Some generated files were skipped.', severity: 'info' }],
    evidence: [{ path: 'src/server/services/projectAtlasService.ts', nodeId: 'file:src/server/services/projectAtlasService.ts' }],
  };
}

test('applyProjectAtlasAgentUpdate saves a full ChatGPT-authored Atlas without a local baseline', () => {
  writeAuthoringFixture();

  const result = applyProjectAtlasAgentUpdate(project, validAuthoredAtlas(), { now: '2026-07-04T09:00:00.000Z' });
  const cached = readAtlasCache({ projectId: project.id }).atlas;

  assert.equal(result.ok, true);
  assert.equal(result.atlas?.authoring?.provenance.provider, 'ChatGPT');
  assert.equal(result.atlas?.authoring?.coverage.skippedAreas[0].reason, 'Dependency directory excluded from repo authoring.');
  assert.equal(cached.nodes.length, 2);
  assert.equal(cached.edges.length, 1);
  assert.equal(cached.domains[0].id, 'domain:atlas');
  assert.equal(cached.authoring?.groupingRationale.summary, 'Grouped by user-facing Atlas responsibility after staged repo reads.');
  assert.equal(cached.authoring?.readOrder[0].nodeId, 'file:src/server/routes/devflow.ts');

  const status = getProjectAtlasStatus(project.id);
  assert.equal(status.authoring.state, 'chatgpt-authored');
  assert.equal(status.authoring.provenance?.provider, 'ChatGPT');
  assert.equal(status.authoring.coverage?.skippedAreas.length, 1);
});

test('applyProjectAtlasAgentUpdate rejects invalid authored evidence and leaves cache unchanged', () => {
  writeAuthoringFixture();
  applyProjectAtlasAgentUpdate(project, validAuthoredAtlas(), { now: '2026-07-04T09:00:00.000Z' });
  const before = readAtlasCache({ projectId: project.id }).atlas;
  const patch = validAuthoredAtlas();
  patch.evidence[0].path = 'src/server/services/missing.ts';

  const result = applyProjectAtlasAgentUpdate(project, patch, { now: '2026-07-04T09:00:00.000Z' });
  const after = readAtlasCache({ projectId: project.id }).atlas;

  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0].message, /path/i);
  assert.deepEqual(after, before);
});

test('applyProjectAtlasAgentUpdate rejects edge/domain references outside authored nodes and oversized payloads', () => {
  writeAuthoringFixture();
  const invalid = validAuthoredAtlas();
  invalid.edges[0].target = 'file:missing.ts';

  const invalidResult = applyProjectAtlasAgentUpdate(project, invalid);
  assert.equal(invalidResult.ok, false);
  assert.match(invalidResult.diagnostics[0].message, /unknown Atlas node/i);

  const oversized = validAuthoredAtlas();
  oversized.summary.inferred.summary = 'x'.repeat(70_000);
  const oversizedResult = applyProjectAtlasAgentUpdate(project, oversized);
  assert.equal(oversizedResult.ok, false);
  assert.match(oversizedResult.diagnostics[0].message, /size/i);
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
