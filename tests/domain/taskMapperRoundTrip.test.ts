import test from 'node:test';
import assert from 'node:assert/strict';
import { toDomainTask, toDtoTask } from '../../src/domain/mappers/taskMapper.js';

test('toDtoTask preserves all legacy image URLs across round-trip', () => {
  // Original DTO: only designImages array (no designImage field)
  const original = {
    id: 'task-1',
    displayId: 'DVF-0001',
    title: 't',
    designImages: ['https://x/a.png', 'https://x/b.png', 'https://x/c.png'],
  };
  const domain = toDomainTask(original);
  // Domain now has 3 legacy images
  assert.equal(domain.images.length, 3);
  // Round-trip: toDtoTask places first legacy URL in designImage, rest in designImages.
  // This is the documented behavior for compatibility with legacy clients that read designImage as a string.
  const back = toDtoTask(domain) as any;
  const allLegacyUrls = [back.designImage, ...(back.designImages || [])].filter(Boolean);
  assert.equal(allLegacyUrls.length, 3);
  assert.equal(back.designImage, 'https://x/a.png');
  assert.deepEqual(back.designImages, ['https://x/b.png', 'https://x/c.png']);
});

test('toDtoTask round-trips designImage string + designImages array correctly', () => {
  const original = {
    id: 'task-2',
    displayId: 'DVF-0002',
    title: 't',
    designImage: 'https://x/only.png',
  };
  const domain = toDomainTask(original);
  assert.equal(domain.images.length, 1);
  const back = toDtoTask(domain) as any;
  assert.equal(back.designImage, 'https://x/only.png');
  assert.deepEqual(back.designImages, []);
});

test('toDtoTask round-trips native images field unchanged', () => {
  const original = {
    id: 'task-3',
    displayId: 'DVF-0003',
    title: 't',
    images: [{ absolutePath: '/a.png', filename: 'a.png' }],
  };
  const domain = toDomainTask(original);
  assert.equal(domain.images.length, 1);
  assert.equal(domain.images[0].absolutePath, '/a.png');
  const back = toDtoTask(domain) as any;
  assert.equal(back.designImage, undefined);
  assert.deepEqual(back.designImages, []);
  assert.equal(back.images[0].absolutePath, '/a.png');
});
