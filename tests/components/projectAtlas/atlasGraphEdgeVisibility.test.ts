import test from 'node:test';
import assert from 'node:assert/strict';

const {
  selectReadableAtlasEdges,
} = await import('../../../src/components/projectAtlas/AtlasGraph.js');

const edges: any[] = [
  { id: 'imports:domain:a->domain:b', source: 'domain:a', target: 'domain:b', kind: 'imports', label: 'Imports', sourceEdgeIds: ['raw:1', 'raw:2'] },
  { id: 'tests:domain:c->domain:a', source: 'domain:c', target: 'domain:a', kind: 'tests', label: 'Tests', sourceEdgeIds: ['raw:3'] },
  { id: 'related:domain:c->domain:d', source: 'domain:c', target: 'domain:d', kind: 'related', label: 'Related', sourceEdgeIds: ['raw:4'] },
  { id: 'exports:domain:a->domain:e', source: 'domain:a', target: 'domain:e', kind: 'exports', label: 'Exports', sourceEdgeIds: ['raw:5', 'raw:6', 'raw:7'] },
];

test('selectReadableAtlasEdges hides all visual edges until a domain is focused', () => {
  const readable = selectReadableAtlasEdges(edges, null, 2);

  assert.deepEqual(readable.visibleEdges, []);
  assert.deepEqual(readable.relationshipGroups, []);
  assert.equal(readable.hiddenFocusedEdgeCount, 0);
  assert.equal(readable.focusedEdgeCount, 0);
});

test('selectReadableAtlasEdges returns only direct grouped relationships for a focused domain', () => {
  const readable = selectReadableAtlasEdges(edges, 'domain:a', 4);

  assert.deepEqual(readable.visibleEdges.map((edge: any) => edge.id), [
    'exports:domain:a->domain:e',
    'imports:domain:a->domain:b',
    'tests:domain:c->domain:a',
  ]);
  assert.deepEqual(readable.relationshipGroups, [
    { id: 'exports:domain:a->domain:e', source: 'domain:a', target: 'domain:e', kind: 'exports', label: 'Exports', rawRelationshipCount: 3 },
    { id: 'imports:domain:a->domain:b', source: 'domain:a', target: 'domain:b', kind: 'imports', label: 'Imports', rawRelationshipCount: 2 },
    { id: 'tests:domain:c->domain:a', source: 'domain:c', target: 'domain:a', kind: 'tests', label: 'Tests', rawRelationshipCount: 1 },
  ]);
  assert.equal(readable.focusedEdgeCount, 3);
  assert.equal(readable.hiddenFocusedEdgeCount, 0);
});

test('selectReadableAtlasEdges caps focused visual clutter but keeps total counts', () => {
  const readable = selectReadableAtlasEdges(edges, 'domain:a', 2);

  assert.deepEqual(readable.visibleEdges.map((edge: any) => edge.id), [
    'exports:domain:a->domain:e',
    'imports:domain:a->domain:b',
  ]);
  assert.deepEqual(readable.relationshipGroups.map((group: any) => group.id), [
    'exports:domain:a->domain:e',
    'imports:domain:a->domain:b',
  ]);
  assert.equal(readable.focusedEdgeCount, 3);
  assert.equal(readable.hiddenFocusedEdgeCount, 1);
});
