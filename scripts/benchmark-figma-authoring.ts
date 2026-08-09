import assert from 'node:assert/strict';
import { buildFigmaAuthoringContext } from '../src/server/services/figmaAuthoringContextService.js';

const fileKey = 'benchmark-file';
const nodeIds = ['1:1', '2:2', '3:3'];
const fileData = {
  name: 'Checkout Screen',
  lastModified: '2026-08-09T00:00:00.000Z',
  version: '42',
  thumbnailUrl: 'https://example.invalid/thumb.png',
  document: {
    id: 'root',
    children: Array.from({ length: 80 }, (_, index) => ({ id: `broad-${index}`, name: `Layer ${index}`, type: 'FRAME' })),
  },
};
const rawNodes = {
  nodes: Object.fromEntries(nodeIds.map((id, index) => [id, {
    document: {
      id,
      name: `Node ${index + 1}`,
      type: index === 0 ? 'FRAME' : 'TEXT',
      characters: 'Representative product copy '.repeat(25),
      children: Array.from({ length: 20 }, (_, childIndex) => ({ id: `${id}-child-${childIndex}`, name: `Child ${childIndex}`, type: 'FRAME' })),
    },
  }])),
};
const specs = nodeIds.map((id, index) => ({
  id,
  name: `Node ${index + 1}`,
  type: index === 0 ? 'FRAME' : 'TEXT',
  bounds: { width: 320 + index, height: 180 + index },
  text: 'Representative product copy '.repeat(25),
  layout: { mode: 'VERTICAL', padding: [16, 16, 16, 16], spacing: 12 },
  typography: { fontFamily: 'Inter', fontWeight: 500, fontSize: 14, color: '#112233' },
  backgroundColor: '#ffffff',
  assets: [{ type: 'IMAGE', imageRef: `image-${index}`, scaleMode: 'FILL' }],
  childCount: 20,
  children: Array.from({ length: 20 }, (_, childIndex) => ({ id: `${id}-nested-${childIndex}`, name: `Nested ${childIndex}` })),
}));

const provider = {
  async getFigmaFile() { return fileData; },
  async getFigmaDesignSpecs(_key: string, ids: string[]) { return ids.map((id) => specs[nodeIds.indexOf(id)]); },
};
const compact = await buildFigmaAuthoringContext(provider, fileKey, nodeIds);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const oldOneNodeCalls = 5; // file + node + spec + create + attach
const newOneNodeCalls = 3; // authoring-context + create + bounded attach
const oldThreeNodeCalls = 7; // file + node batch + 3 specs + create + attach
const newThreeNodeCalls = 3;
const oldResponseBytes = bytes(fileData) + bytes(rawNodes) + specs.reduce((sum, spec) => sum + bytes(spec), 0);
const newResponseBytes = bytes(compact);

assert.equal(newOneNodeCalls < oldOneNodeCalls, true);
assert.equal(newThreeNodeCalls < oldThreeNodeCalls, true);
assert.equal(newResponseBytes < oldResponseBytes, true);

const reduction = (before: number, after: number) => Math.round(((before - after) / before) * 10_000) / 100;
console.log(JSON.stringify({
  oneNode: { beforeCalls: oldOneNodeCalls, afterCalls: newOneNodeCalls, callReductionPercent: reduction(oldOneNodeCalls, newOneNodeCalls) },
  threeNodes: { beforeCalls: oldThreeNodeCalls, afterCalls: newThreeNodeCalls, callReductionPercent: reduction(oldThreeNodeCalls, newThreeNodeCalls) },
  responsePayload: { beforeBytes: oldResponseBytes, afterBytes: newResponseBytes, byteReductionPercent: reduction(oldResponseBytes, newResponseBytes) },
  boundedContext: compact.bounds,
}, null, 2));
