import test from 'node:test';
import assert from 'node:assert/strict';
import { getMcpToolList, getToolDefinitionByName } from '../../src/server/contracts/devflowContract.js';

const names = ['create_ui_preview', 'update_ui_preview', 'get_ui_preview', 'attach_ui_preview_to_task'] as const;

test('UI preview tools are exposed in full and coding profiles with bounded source semantics', () => {
  const full = new Set(getMcpToolList('full').map((tool: any) => tool.name));
  const coding = new Set(getMcpToolList('coding').map((tool: any) => tool.name));
  for (const name of names) {
    assert.equal(full.has(name), true, `${name} must be in full profile`);
    assert.equal(coding.has(name), true, `${name} must be in coding profile`);
  }

  const create = getToolDefinitionByName('create_ui_preview')!;
  assert.ok(create);
  assert.ok(create.inputSchema.properties.idempotencyKey);
  const createRequest = create.buildHttpRequest({ html: '<main>x</main>', spec: { schemaVersion: 1, summary: { screen: 'X' } }, idempotencyKey: 'create-1' });
  assert.equal(createRequest.method, 'POST');
  assert.equal(createRequest.path, '/api/ui-previews');
  assert.equal((createRequest.body as any).idempotencyKey, 'create-1');

  const update = getToolDefinitionByName('update_ui_preview')!;
  assert.ok(update.inputSchema.properties.idempotencyKey);
  const updateRequest = update.buildHttpRequest({ previewId: 'uip_demo', expectedRevision: 2, html: '<main>y</main>', idempotencyKey: 'update-1' });
  assert.equal(updateRequest.method, 'PUT');
  assert.equal(updateRequest.path, '/api/ui-previews/uip_demo');
  assert.equal((updateRequest.body as any).previewId, undefined);

  const get = getToolDefinitionByName('get_ui_preview')!;
  const summaryRequest = get.buildHttpRequest({ previewId: 'uip_demo' });
  assert.equal(summaryRequest.method, 'GET');
  assert.equal(summaryRequest.path, '/api/ui-previews/uip_demo?mode=summary');
  const sourceRequest = get.buildHttpRequest({ previewId: 'uip_demo', revision: 2, mode: 'source' });
  assert.match(sourceRequest.path, /revision=2/);
  assert.match(sourceRequest.path, /mode=source/);

  const attach = getToolDefinitionByName('attach_ui_preview_to_task')!;
  assert.ok(attach.inputSchema.properties.idempotencyKey);
  const attachRequest = attach.buildHttpRequest({ taskId: 'DVF-0485', previewId: 'uip_demo', revision: 2, idempotencyKey: 'attach-1' });
  assert.equal(attachRequest.method, 'POST');
  assert.equal(attachRequest.path, '/api/tasks/DVF-0485/ui-evidence');
  assert.deepEqual(attachRequest.body, { previewId: 'uip_demo', revision: 2, idempotencyKey: 'attach-1' });
});
