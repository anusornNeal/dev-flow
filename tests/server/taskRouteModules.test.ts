import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerTaskBugRoutes } from '../../src/server/routes/taskBugRoutes.js';
import { registerTaskReviewRoutes } from '../../src/server/routes/taskReviewRoutes.js';
import { registerLegacyTaskAgentRoutes } from '../../src/server/routes/taskLegacyAgentRoutes.js';
import { registerTaskReadRoutes } from '../../src/server/routes/taskReadRoutes.js';
import { registerTaskWorkflowRoutes } from '../../src/server/routes/taskWorkflowRoutes.js';

test('task bug and review route modules expose focused registration functions', () => {
  assert.equal(typeof registerTaskBugRoutes, 'function');
  assert.equal(typeof registerTaskReviewRoutes, 'function');
  assert.equal(typeof registerLegacyTaskAgentRoutes, 'function');
  assert.equal(typeof registerTaskReadRoutes, 'function');
  assert.equal(typeof registerTaskWorkflowRoutes, 'function');
});

test('registerTaskRoutes composes focused bug and review modules instead of owning their endpoints', () => {
  const source = fs.readFileSync('src/server/routes/tasks.ts', 'utf8');
  assert.match(source, /registerTaskReadRoutes\(app, deps\)/);
  assert.match(source, /registerTaskBugRoutes\(app, deps\)/);
  assert.match(source, /registerTaskReviewRoutes\(app, deps\)/);
  assert.match(source, /registerLegacyTaskAgentRoutes\(app, deps\)/);
  assert.match(source, /registerTaskWorkflowRoutes\(app, deps\)/);
  assert.doesNotMatch(source, /app\.post\('\/api\/tasks\/:id\/bugs'/);
  assert.doesNotMatch(source, /app\.post\('\/api\/tasks\/:id\/sync-git'/);
  assert.doesNotMatch(source, /app\.get\('\/api\/tasks\/:id\/agent-runs'/);
  assert.doesNotMatch(source, /app\.get\('\/api\/tasks'/);
  assert.doesNotMatch(source, /app\.post\('\/api\/tasks\/:id\/move'/);
});
