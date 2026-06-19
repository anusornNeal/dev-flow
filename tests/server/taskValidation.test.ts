import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskPayload } from '../../src/server/services/taskService.js';

test('validateTaskPayload accepts explicit category with free-form tags', () => {
  const error = validateTaskPayload({
    title: 'Valid category',
    category: 'frontend',
    tags: ['queue', 'auto-work'],
  });

  assert.equal(error, null);
});

test('validateTaskPayload rejects create payloads without a primary category', () => {
  const error = validateTaskPayload({
    title: 'Missing category',
    tags: ['queue', 'auto-work'],
  });

  assert.equal(error, "Field 'category' is required and must be one of: frontend, backend, general.");
});

test('validateTaskPayload accepts a legacy category tag when category is omitted', () => {
  const error = validateTaskPayload({
    title: 'Legacy tag fallback',
    tags: ['backend', 'queue'],
  });

  assert.equal(error, null);
});

test('validateTaskPayload rejects multiple legacy category tags when category is omitted', () => {
  const error = validateTaskPayload({
    title: 'Ambiguous legacy tags',
    tags: ['frontend', 'backend', 'queue'],
  });

  assert.equal(error, "Field 'tags' can contain at most one legacy category tag when 'category' is omitted.");
});

test('validateTaskPayload rejects invalid explicit category values', () => {
  const error = validateTaskPayload({
    title: 'Invalid category',
    category: 'mobile',
  });

  assert.equal(error, "Field 'category' must be one of: frontend, backend, general. Received: mobile");
});
