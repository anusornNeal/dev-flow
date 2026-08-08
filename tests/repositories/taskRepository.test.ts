import test from 'node:test';
import assert from 'node:assert/strict';
import { taskRepository } from '../../src/repositories/taskRepository.js';
import { apiClient } from '../../src/client/apiClient.js';

function mockFetchOnce(response: { status: number; body: unknown; contentType?: string }) {
  (globalThis as any).fetch = async () => {
    return new Response(typeof response.body === 'string' ? response.body : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': response.contentType || 'application/json' },
    });
  };
}

test('taskRepository.list calls /api/tasks and maps each item to DomainTask', async () => {
  mockFetchOnce({ status: 200, body: { tasks: [
    { id: 't-1', displayId: 'DVF-0001', title: 'a', designImage: 'https://x/a.png' },
    { id: 't-2', displayId: 'DVF-0002', title: 'b', designImages: ['https://x/b.png'] },
  ] } });
  const result = await taskRepository.list();
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 't-1');
  assert.equal(result[0].images.length, 1);
  assert.equal(result[0].images[0].url, 'https://x/a.png');
  assert.equal(result[0].images[0].legacy, true);
  assert.equal(result[1].images.length, 1);
  assert.equal(result[1].images[0].url, 'https://x/b.png');
});

test('taskRepository.list requests board mode by default', async () => {
  let capturedUrl = '';
  (globalThis as any).fetch = async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ tasks: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await taskRepository.list();

  assert.equal(capturedUrl, '/api/tasks?mode=board');
});

test('taskRepository.list forwards projectId and status query params', async () => {
  let capturedUrl = '';
  (globalThis as any).fetch = async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ tasks: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  await taskRepository.list({ projectId: 'p-1', status: 'in-progress' });
  assert.match(capturedUrl, /^\/api\/tasks\?/);
  assert.match(capturedUrl, /mode=board/);
  assert.match(capturedUrl, /projectId=p-1/);
  assert.match(capturedUrl, /status=in-progress/);
});

test('taskRepository.listPage returns lane paging metadata and related child tasks', async () => {
  let capturedUrl = '';
  (globalThis as any).fetch = async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify({
      items: [{ id: 'parent-1', title: 'Parent', status: 'todo' }],
      relatedItems: [{ id: 'child-1', title: 'Child', status: 'todo', parentId: 'parent-1' }],
      total: 60,
      limit: 25,
      offset: 25,
      hasMore: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const page = await taskRepository.listPage({ projectId: 'p-1', status: 'todo', limit: 25, offset: 25 });
  assert.match(capturedUrl, /status=todo/);
  assert.match(capturedUrl, /limit=25/);
  assert.match(capturedUrl, /offset=25/);
  assert.equal(page.items[0].id, 'parent-1');
  assert.equal(page.relatedItems[0].id, 'child-1');
  assert.equal(page.total, 60);
  assert.equal(page.hasMore, true);
});

test('taskRepository.get returns a single DomainTask', async () => {
  mockFetchOnce({ status: 200, body: { id: 't-3', displayId: 'DVF-0003', title: 'c' } });
  const result = await taskRepository.get('t-3');
  assert.equal(result.id, 't-3');
  assert.deepEqual(result.images, []);
});

test('taskRepository.get requests full mode for drawer detail reads', async () => {
  let capturedUrl = '';
  (globalThis as any).fetch = async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ id: 't-3', displayId: 'DVF-0003', title: 'c' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await taskRepository.get('t-3');

  assert.equal(capturedUrl, '/api/tasks/t-3?mode=full');
});
