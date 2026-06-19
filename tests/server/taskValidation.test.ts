import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskPayload } from '../../src/server/services/taskService.js';

test('validateTaskPayload accepts category tags frontend backend general', () => {
  const error = validateTaskPayload({
    title: 'Valid tags',
    tags: ['frontend', 'backend', 'general'],
  });

  assert.equal(error, null);
});

test('validateTaskPayload rejects tags outside the allowed category set', () => {
  const error = validateTaskPayload({
    title: 'Invalid tags',
    tags: ['frontend', 'api'],
  });

  assert.equal(error, "Field 'tags' must contain only: frontend, backend, general.");
});
