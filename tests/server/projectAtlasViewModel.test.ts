import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildAtlasGraphViewModel,
  buildDomainInspector,
  buildDomainMapViewModel,
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
      metadata: { domainId: 'domain:ui-components', symbols: ['ProjectAtlasPage'], language: 'TypeScript', framework: 'React' },
    },
    { id: 'file:tests/server/app.test.ts', label: 'app.test.ts', kind: 'test', path: 'tests/server/app.test.ts', metadata: { domainId: 'domain:tests' } },
    { id: 'file:src/components/App.css', label: 'App.css', kind: 'file', path: 'src/components/App.css', metadata: { domainId: 'domain:ui-components', type: 'style' } },
  ],
  edges: [
    { id: 'related:domain:tests->domain:ui-components', source: 'domain:tests', target: 'domain:ui-components', kind: 'related', fact: { source: 'inferred', description: 'Tests cover UI' } },
    { id: 'tests:file:tests/server/app.test.ts->file:src/components/App.tsx', source: 'file:tests/server/app.test.ts', target: 'file:src/components/App.tsx', kind: 'tests', fact: { source: 'verified', description: 'app test covers App shell' } },
    { id: 'imports:file:src/components/App.tsx->file:src/components/App.css', source: 'file:src/components/App.tsx', target: 'file:src/components/App.css', kind: 'imports', fact: { source: 'verified', description: 'App imports styles' } },
  ],
  domains: [
    { id: 'domain:ui-components', name: 'UI Components', nodeIds: ['file:src/components/App.tsx', 'file:src/components/App.css'], origin: 'inferred', summary: 'React screens and shared UI composition.' },
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
  const testsGroup = relationships.find((group: any) => group.kind === 'tests');

  assert.equal(testsGroup?.incoming[0].node.label, 'app.test.ts');
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

test('buildDomainMapViewModel creates readable domain cards with metrics, files, technologies, and directional edges', () => {
  const view = buildDomainMapViewModel(atlas);

  const uiDomain = view.nodes.find((node: any) => node.id === 'domain:ui-components');
  assert.equal(uiDomain.title, 'UI Components');
  assert.equal(uiDomain.description, 'React screens and shared UI composition.');
  assert.deepEqual(uiDomain.metrics, { files: 2, nodes: 2, dependencies: 2, types: 2 });
  assert.deepEqual(uiDomain.fileTypeCounts, { css: 1, tsx: 1 });
  assert.deepEqual(uiDomain.technologies, ['React', 'TypeScript']);
  assert.deepEqual(uiDomain.files.map((file: any) => file.path), ['src/components/App.css', 'src/components/App.tsx']);
  assert.equal(view.edges[0].source, 'domain:tests');
  assert.equal(view.edges[0].target, 'domain:ui-components');
  assert.equal(view.edges[0].label, 'related');
});

test('buildDomainMapViewModel filters by search and filter chips without losing matching dependency context', () => {
  const searched = buildDomainMapViewModel(atlas, { query: 'ProjectAtlasPage' });
  const filtered = buildDomainMapViewModel(atlas, { activeFilters: ['CODE'] });

  assert.deepEqual(searched.matchedNodeIds, ['domain:ui-components']);
  assert.equal(searched.nodes.some((node: any) => node.id === 'domain:ui-components'), true);
  assert.equal(filtered.nodes.some((node: any) => node.id === 'domain:ui-components'), true);
  assert.equal(filtered.nodes.some((node: any) => node.id === 'domain:tests'), false);
});

test('buildDomainInspector derives info and files for a selected domain', () => {
  const inspector = buildDomainInspector(atlas, 'domain:ui-components');

  assert.equal(inspector?.name, 'UI Components');
  assert.equal(inspector?.status, 'inferred');
  assert.deepEqual(inspector?.fileTypeCounts, { css: 1, tsx: 1 });
  assert.deepEqual(inspector?.technologies, ['React', 'TypeScript']);
  assert.equal(inspector?.files.length, 2);
  assert.equal(inspector?.health, 'unknown');
});

test('buildDomainInspector ranks start-here files before supporting files', () => {
  const inspector = buildDomainInspector(atlas, 'domain:ui-components');

  assert.deepEqual(inspector?.startHereFiles.map((file: any) => file.path), [
    'src/components/App.tsx',
    'src/components/App.css',
  ]);
  assert.equal(inspector?.plainSummary, 'React screens and shared UI composition.');
});

test('buildDomainInspector separates domains this domain depends on from domains that use it', () => {
  const uiInspector = buildDomainInspector(atlas, 'domain:ui-components');
  const testsInspector = buildDomainInspector(atlas, 'domain:tests');

  assert.deepEqual(uiInspector?.incomingDomains.map((domain: any) => domain.name), ['Tests']);
  assert.deepEqual(uiInspector?.outgoingDomains.map((domain: any) => domain.name), []);
  assert.deepEqual(testsInspector?.incomingDomains.map((domain: any) => domain.name), []);
  assert.deepEqual(testsInspector?.outgoingDomains.map((domain: any) => domain.name), ['UI Components']);
});

test('buildDomainInspector handles empty domains with readable defaults', () => {
  const emptyAtlas = {
    ...atlas,
    domains: [
      ...atlas.domains,
      { id: 'domain:empty', name: 'Empty Area', nodeIds: [], origin: 'manual', summary: undefined },
    ],
  };

  const inspector = buildDomainInspector(emptyAtlas, 'domain:empty');

  assert.equal(inspector?.plainSummary, 'Empty Area domain with 0 related Atlas items.');
  assert.deepEqual(inspector?.startHereFiles, []);
  assert.deepEqual(inspector?.incomingDomains, []);
  assert.deepEqual(inspector?.outgoingDomains, []);
});
