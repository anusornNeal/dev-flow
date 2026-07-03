import test from 'node:test';
import assert from 'node:assert/strict';

const {
  exportAtlasJson,
  renderAtlasMarkdown,
  renderAtlasMermaid,
  renderAtlasSvg,
} = await import('../../src/lib/projectAtlasExport.js');

const atlas: any = {
  projectId: 'project-test',
  generatedAt: '2026-07-02T00:00:00.000Z',
  nodes: [
    { id: 'file:src/a.ts', label: 'A <core>', kind: 'file', path: 'src/a.ts', verified: { source: 'verified', description: 'Verified file' }, metadata: { domainId: 'domain:core' } },
    { id: 'file:src/b.ts', label: 'B', kind: 'file', path: 'src/b.ts', inferred: { source: 'inferred', summary: 'Inferred file' }, metadata: { domainId: 'domain:tools' } },
  ],
  edges: [
    { id: 'imports:file:src/a.ts->file:src/b.ts', source: 'file:src/a.ts', target: 'file:src/b.ts', kind: 'imports', fact: { source: 'verified', description: 'A imports B' } },
    { id: 'related:domain:core->domain:tools', source: 'domain:core', target: 'domain:tools', kind: 'related', fact: { source: 'inferred', summary: 'Core relates to tools' } },
  ],
  domains: [
    { id: 'domain:tools', name: 'Tools', nodeIds: ['file:src/b.ts'], origin: 'inferred', summary: 'Tooling domain' },
    { id: 'domain:core', name: 'Core', nodeIds: ['file:src/a.ts'], origin: 'verified', summary: 'Core domain' },
  ],
  flows: [],
  summary: {
    verified: { source: 'verified', description: 'Verified summary' },
    inferred: { source: 'inferred', summary: 'Inferred summary' },
  },
  freshness: { status: 'fresh', generatedAt: '2026-07-02T00:00:00.000Z' },
};

test('exportAtlasJson produces stable ordered graph JSON', () => {
  const exported = JSON.parse(exportAtlasJson(atlas));

  assert.deepEqual(exported.nodes.map((node: any) => node.id), ['file:src/a.ts', 'file:src/b.ts']);
  assert.deepEqual(exported.domains.map((domain: any) => domain.id), ['domain:core', 'domain:tools']);
  assert.equal(exported.freshness.status, 'fresh');
});

test('renderAtlasMarkdown separates verified and inferred facts', () => {
  const markdown = renderAtlasMarkdown(atlas);

  assert.match(markdown, /Verified facts/);
  assert.match(markdown, /Verified summary/);
  assert.match(markdown, /Inferred and user-edited notes/);
  assert.match(markdown, /Inferred summary/);
  assert.match(markdown, /## Domains/);
});

test('renderAtlasMermaid escapes labels and defaults to domain graph', () => {
  const mermaid = renderAtlasMermaid(atlas);

  assert.match(mermaid, /graph TD/);
  assert.match(mermaid, /domain_core\["Core"\]/);
  assert.doesNotMatch(mermaid, /A <core>/);
});

test('renderAtlasSvg escapes labels and renders graph elements', () => {
  const svg = renderAtlasSvg({
    nodes: atlas.nodes,
    edges: atlas.edges.slice(0, 1),
  });

  assert.match(svg, /^<svg/);
  assert.match(svg, /A &lt;core&gt;/);
  assert.match(svg, /<line/);
});
