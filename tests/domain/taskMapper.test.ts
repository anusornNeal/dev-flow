import test from 'node:test';
import assert from 'node:assert/strict';
import { toDomainTask, toDtoTask } from '../../src/domain/mappers/taskMapper.js';

test('toDomainTask unifies legacy designImage + designImages + images into one images array', () => {
  const dto = {
    id: 'task-1',
    displayId: 'DVF-0001',
    title: 't',
    designImage: 'https://x/a.png',
    designImages: ['https://x/b.png', 'https://x/c.png'],
    images: [{ absolutePath: '/d.png', filename: 'd.png' }],
  };
  const domain = toDomainTask(dto as any);
  assert.equal(domain.images.length, 4);
  const urls = domain.images.map((i) => i.url).filter(Boolean);
  const paths = domain.images.map((i) => i.absolutePath).filter(Boolean);
  assert.deepEqual(urls, ['https://x/a.png', 'https://x/b.png', 'https://x/c.png']);
  assert.deepEqual(paths, ['/d.png']);
  const legacy = domain.images.filter((i) => i.legacy);
  assert.equal(legacy.length, 3);
});

test('toDomainTask handles missing legacy fields gracefully', () => {
  const dto = { id: 'task-2', displayId: 'DVF-0002', title: 't', status: 'todo' };
  const domain = toDomainTask(dto as any);
  assert.equal(domain.images.length, 0);
  assert.equal(domain.status, 'todo');
});

test('toDomainTask preserves all non-image fields including status, priority, parentId', () => {
  const dto = {
    id: 'task-3',
    displayId: 'DVF-0003',
    title: 't',
    status: 'in-progress',
    priority: 'high',
    parentId: 'task-parent',
    tags: ['a', 'b'],
    checklist: [{ id: 'c1', text: 'x', completed: false }],
  };
  const domain = toDomainTask(dto as any);
  assert.equal(domain.status, 'in-progress');
  assert.equal(domain.priority, 'high');
  assert.equal(domain.parentId, 'task-parent');
  assert.deepEqual(domain.tags, ['a', 'b']);
  assert.equal((domain.checklist as any[]).length, 1);
});

test('toDtoTask serializes domain back with legacy image fields preserved', () => {
  const dto = {
    id: 'task-4',
    displayId: 'DVF-0004',
    title: 't',
    designImage: 'https://x/a.png',
    designImages: ['https://x/b.png'],
    images: [{ absolutePath: '/d.png' }],
  };
  const domain = toDomainTask(dto as any);
  const back = toDtoTask(domain) as any;
  assert.equal(back.designImage, 'https://x/a.png');
  assert.deepEqual(back.designImages, ['https://x/b.png']);
  assert.equal(back.images[0].absolutePath, '/d.png');
});
