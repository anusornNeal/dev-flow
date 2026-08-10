import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerTaskBugRoutes } from '../../src/server/routes/taskBugRoutes.js';
import { registerTaskReviewRoutes } from '../../src/server/routes/taskReviewRoutes.js';
import { registerLegacyTaskAgentRoutes } from '../../src/server/routes/taskLegacyAgentRoutes.js';
import { registerTaskReadRoutes } from '../../src/server/routes/taskReadRoutes.js';
import { registerTaskWorkflowRoutes } from '../../src/server/routes/taskWorkflowRoutes.js';
import { registerTaskClaimRoutes } from '../../src/server/routes/taskClaimRoutes.js';

test('task bug and review route modules expose focused registration functions', () => {
  assert.equal(typeof registerTaskBugRoutes, 'function');
  assert.equal(typeof registerTaskReviewRoutes, 'function');
  assert.equal(typeof registerLegacyTaskAgentRoutes, 'function');
  assert.equal(typeof registerTaskReadRoutes, 'function');
  assert.equal(typeof registerTaskWorkflowRoutes, 'function');
  assert.equal(typeof registerTaskClaimRoutes, 'function');
});

test('blocked review does not persist branch-mismatched diagnostic Git evidence', () => {
  const source = fs.readFileSync('src/server/routes/taskReviewRoutes.ts', 'utf8');
  assert.match(source, /evidenceBranchMismatch/);
  assert.match(source, /blocker\.code === 'TASK_BRANCH_MISMATCH'/);
  assert.match(source, /evaluation\.gitEvidence && !evidenceBranchMismatch/);
});

test('task claim routes expose the composite next-claim fast path', () => {
  const source = fs.readFileSync('src/server/routes/taskClaimRoutes.ts', 'utf8');
  assert.match(source, /\/api\/tasks\/claim-next/);
  assert.match(source, /claimNextTaskForSession/);
});

test('registerTaskRoutes composes focused bug and review modules instead of owning their endpoints', () => {
  const source = fs.readFileSync('src/server/routes/tasks.ts', 'utf8');
  assert.match(source, /registerTaskReadRoutes\(app, deps\)/);
  assert.match(source, /registerTaskBugRoutes\(app, deps\)/);
  assert.match(source, /registerTaskReviewRoutes\(app, deps\)/);
  assert.match(source, /registerLegacyTaskAgentRoutes\(app, deps\)/);
  assert.match(source, /registerTaskWorkflowRoutes\(app, deps\)/);
  assert.match(source, /registerTaskClaimRoutes\(app, deps\)/);
  assert.doesNotMatch(source, /app\.post\('\/api\/tasks\/:id\/bugs'/);
  assert.doesNotMatch(source, /app\.post\('\/api\/tasks\/:id\/sync-git'/);
  assert.doesNotMatch(source, /app\.get\('\/api\/tasks\/:id\/agent-runs'/);
  assert.doesNotMatch(source, /app\.get\('\/api\/tasks'/);
  assert.doesNotMatch(source, /app\.post\('\/api\/tasks\/:id\/move'/);
});
