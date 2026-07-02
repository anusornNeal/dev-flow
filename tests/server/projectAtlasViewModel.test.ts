import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildAtlasGraphViewModel,
  buildNodeContext,
  buildNodeRelationships,
  searchAtlas,
  toggleAtlasLayer,
} = await import('../../src/lib/projectAtlasViewModel.js');

const atlas: any = {
  nodes: [
    { id: 'domain:ui-components', label: 'UI Components', kind: 'domain', metadata: { nodeCount: 3 } },
    { id: 'domain:tests', label: 'Tests', kind: 'domain', metadata: { nodeCount: 2 } },
    {
      id: 'file:src/components/App.tsx',
      label: 'App.tsx',
      kind: 'component',
      path: 'src/components/App.tsx',
      verified: { source: 'verified', description: 'React application shell' },
      metadata: { domainId: 'domain:ui-components', symbols: ['ProjectAtlasPage'] },
    },
    { id: 'file:tests/server/app.test.ts', label: 'app.test.ts', kind: 'test', path: 'tests/server/app.test.ts', metadata: { domainId: 'domain:tests' } },
  ],
  edges: [
    { id: 'related:domain:tests->domain:ui-components', source: 'domain:tests', target: 'domain:ui-components', kind: 'related', fact: { source: 'inferred', description: 'Tests cover UI' } },
    { id: 'tests:file:tests/server/app.test.ts->file:src/components/App.tsx', source: 'file:tests/server/app.test.ts', target: 'file:src/components/App.tsx', kind: 'tests', fact: { source: 'verified', description: 'app test covers App shell' } },
  ],
  domains: [
    { id: 'domain:ui-components', name: 'UI Components', nodeIds: ['file:src/components/App.tsx'], origin: 'inferred' },
    { id: 'domain:tests', name: 'Tests', nodeIds: ['file:tests/server/app.test.ts'], origin: 'inferred' },
  ],
  freshness: { status: 'fresh', generatedAt: '2026-07-02T00:00:00.000Z' },
};

test('buildAtlasGraphViewModel defaults to domain-collapsed graph', () => {
  const view = buildAtlasGraphViewModel(atlas);

  assert.deepEqual(view.nodes.map((node: any) => node.id), ['domain:tests', 'domain:ui-components']);
  assert.equal(view.edges.length, 1);
  assert.equal(view.layers.tests.visible, true);
  assert.equal(view.domains.length, 2);
});

test('searchAtlas matches deterministic labels, paths, domains, and symbols', () => {
  const result = searchAtlas(atlas, 'ProjectAtlasPage');

  assert.deepEqual(result.matchedNodeIds, ['file:src/components/App.tsx']);
  assert.equal(result.query, 'ProjectAtlasPage');
});

test('buildNodeRelationships groups incoming and outgoing edges', () => {
  const relationships = buildNodeRelationships(atlas, 'file:src/components/App.tsx');

  assert.equal(relationships.length, 1);
  assert.equal(relationships[0].kind, 'tests');
  assert.equal(relationships[0].incoming[0].node.label, 'app.test.ts');
});

test('buildNodeContext creates concise copy text for a selected node', () => {
  const context = buildNodeContext(atlas, 'file:src/components/App.tsx');

  assert.match(context, /App.tsx/);
  assert.match(context, /src\/components\/App.tsx/);
  assert.match(context, /React application shell/);
  assert.match(context, /tests: app.test.ts/);
});

test('buildAtlasGraphViewModel filters layers and can expand domains', () => {
  const hiddenTests = toggleAtlasLayer(undefined, 'tests');
  const collapsed = buildAtlasGraphViewModel(atlas, { layers: hiddenTests });
  const expanded = buildAtlasGraphViewModel(atlas, { collapsedDomains: false, layers: hiddenTests });

  assert.equal(collapsed.nodes.some((node: any) => node.id === 'domain:tests'), false);
  assert.equal(expanded.nodes.some((node: any) => node.id === 'file:tests/server/app.test.ts'), false);
  assert.equal(expanded.nodes.some((node: any) => node.id === 'file:src/components/App.tsx'), true);
});

test('buildAtlasGraphViewModel expands selected node neighborhoods', () => {
  const view = buildAtlasGraphViewModel(atlas, {
    expandedNodeIds: ['file:src/components/App.tsx'],
  });

  assert.equal(view.nodes.some((node: any) => node.id === 'file:src/components/App.tsx'), true);
  assert.equal(view.nodes.some((node: any) => node.id === 'file:tests/server/app.test.ts'), true);
});
