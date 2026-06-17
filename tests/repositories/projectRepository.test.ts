import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRepository } from '../../src/repositories/projectRepository.js';

test('projectRepository.list returns array of DomainProject', async () => {
  (globalThis as any).fetch = async () => {
    return new Response(JSON.stringify({ projects: [
      { id: 'p-1', name: 'dev-flow' },
      { id: 'p-2', name: 'other' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await projectRepository.list();
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'p-1');
  assert.equal(result[0].name, 'dev-flow');
});

test('projectRepository.list supports mode=summary query', async () => {
  let capturedUrl = '';
  (globalThis as any).fetch = async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ projects: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  await projectRepository.list({ mode: 'summary' });
  assert.match(capturedUrl, /mode=summary/);
});
