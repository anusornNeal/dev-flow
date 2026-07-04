import test from 'node:test';
import assert from 'node:assert/strict';

const {
  selectReadableAtlasEdges,
} = await import('../../../src/components/projectAtlas/AtlasGraph.js');

const edges: any[] = [
  { id: 'edge:1', source: 'domain:a', target: 'domain:b' },
  { id: 'edge:2', source: 'domain:c', target: 'domain:a' },
  { id: 'edge:3', source: 'domain:c', target: 'domain:d' },
  { id: 'edge:4', source: 'domain:a', target: 'domain:e' },
];

test('selectReadableAtlasEdges hides all edges until a domain is focused', () => {
  const readable = selectReadableAtlasEdges(edges, null, 2);

  assert.deepEqual(readable.visibleEdges, []);
  assert.equal(readable.hiddenFocusedEdgeCount, 0);
  assert.equal(readable.focusedEdgeCount, 0);
});

test('selectReadableAtlasEdges shows only focused edges and caps visual clutter', () => {
  const readable = selectReadableAtlasEdges(edges, 'domain:a', 2);

  assert.deepEqual(readable.visibleEdges.map((edge: any) => edge.id), ['edge:1', 'edge:2']);
  assert.equal(readable.focusedEdgeCount, 3);
  assert.equal(readable.hiddenFocusedEdgeCount, 1);
});
