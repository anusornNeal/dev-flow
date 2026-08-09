import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFigmaAuthoringContextToTask, buildFigmaAuthoringContext, MAX_FIGMA_AUTHORING_NODES } from '../../src/server/services/figmaAuthoringContextService.js';
import { getToolDefinitionByName } from '../../src/server/contracts/devflowContract.js';
import { FigmaService } from '../../src/server/services/figmaService.js';

function fixture() {
  const calls = { file: 0, specs: 0, ids: [] as string[] };
  const provider = {
    async getFigmaFile(fileKey: string) {
      calls.file += 1;
      return { name: `File ${fileKey}`, lastModified: '2026-08-09T00:00:00.000Z', version: '42', document: { id: 'root' } };
    },
    async getFigmaDesignSpecs(_fileKey: string, ids: string[]) {
      calls.specs += 1;
      calls.ids = [...ids];
      return ids.map((id, index) => ({
        id,
        name: `Node ${index + 1}`,
        type: index === 0 ? 'FRAME' : 'TEXT',
        bounds: { width: 320 + index, height: 180 + index },
        text: index === 0 ? undefined : 'x'.repeat(900),
        layout: { mode: 'HORIZONTAL', padding: [8, 12, 8, 12], spacing: 8 },
        backgroundColor: '#ffffff',
        assets: [{ type: 'IMAGE', imageRef: 'img-ref', scaleMode: 'FILL' }],
        children: [{ id: 'nested' }],
        childCount: 1,
      }));
    },
  };
  return { calls, provider };
}

test('builds compact context from one batched exact-node request', async () => {
  const { calls, provider } = fixture();
  const context = await buildFigmaAuthoringContext(provider, 'file-key', ['1:1', '2:2']);
  assert.equal(calls.file, 1);
  assert.equal(calls.specs, 1);
  assert.deepEqual(calls.ids, ['1:1', '2:2']);
  assert.equal('document' in context.file, false);
  assert.equal(context.nodes.length, 2);
  assert.equal('children' in context.nodes[0], false);
  assert.equal(context.nodes[1].text.length <= 500, true);
  assert.match(context.summaryMarkdown, /Figma Design Context/);
  assert.equal(context.refs.length, 2);
});

test('deduplicates nodes and rejects an oversized node set', async () => {
  const { calls, provider } = fixture();
  const context = await buildFigmaAuthoringContext(provider, 'file-key', ['1:1', '1:1', '2:2']);
  assert.deepEqual(calls.ids, ['1:1', '2:2']);
  assert.equal(context.nodes.length, 2);
  await assert.rejects(() => buildFigmaAuthoringContext(provider, 'file-key', Array.from({ length: MAX_FIGMA_AUTHORING_NODES + 1 }, (_, index) => `${index}:1`)), /at most/i);
});

test('FigmaService batches multi-node normalized specs into one nodes API request', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return new Response(JSON.stringify({
      nodes: {
        '1:1': { document: { id: '1:1', name: 'One', type: 'FRAME', absoluteBoundingBox: { width: 100, height: 50 } } },
        '2:2': { document: { id: '2:2', name: 'Two', type: 'TEXT', characters: 'Hello' } },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const specs = await new FigmaService('token').getFigmaDesignSpecs('file-key', ['1:1', '2:2']);
    assert.equal(specs.length, 2);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /\/nodes\?ids=1:1,2:2$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('attaches every exact node reference to the owning card idempotently', async () => {
  const { provider } = fixture();
  const context = await buildFigmaAuthoringContext(provider, 'file-key', ['1:1', '2:2']);
  const task: any = { id: 'task-1', description: 'Existing requirement.' };
  applyFigmaAuthoringContextToTask(task, context);
  assert.equal(task.sourceUrl, context.refs[0].url);
  assert.equal(context.refs.every((ref) => task.description.includes(ref.url)), true);
  assert.match(task.description, /Node 1/);
  assert.match(task.description, /Node 2/);
  const once = task.description;
  applyFigmaAuthoringContextToTask(task, context);
  assert.equal(task.description, once);
});

test('contracts expose composite retrieval and multi-node attachment', () => {
  const composite = getToolDefinitionByName('get_figma_authoring_context');
  assert.ok(composite);
  assert.equal(composite.inputSchema.properties.nodeIds.maxItems, MAX_FIGMA_AUTHORING_NODES);
  assert.equal(composite.buildHttpRequest({ fileKey: 'file-key', nodeIds: ['1:1'] }).path, '/api/figma/authoring-context');

  const attach = getToolDefinitionByName('attach_figma_context_to_task');
  assert.ok(attach?.inputSchema.properties.nodeIds);
  assert.equal(Array.isArray(attach?.inputSchema.anyOf), true);
  const request = attach?.buildHttpRequest({ taskId: 'DVF-0001', fileKey: 'file-key', nodeIds: ['1:1', '2:2'] });
  assert.deepEqual((request?.body as any).nodeIds, ['1:1', '2:2']);
});
