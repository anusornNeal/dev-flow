import test from 'node:test';
import assert from 'node:assert/strict';
import { formatProjectRepoLabel } from '../../src/components/Sidebar.js';

test('formatProjectRepoLabel handles projects without repoUrl', () => {
  assert.equal(formatProjectRepoLabel(null), 'No repository URL');
  assert.equal(formatProjectRepoLabel(undefined), 'No repository URL');
});

test('formatProjectRepoLabel shortens github URLs for display', () => {
  assert.equal(formatProjectRepoLabel('https://github.com/anusornNeal/dev-flow'), 'github.com/anusornNeal/dev-flow');
  assert.equal(formatProjectRepoLabel('https://www.github.com/q-chang/buddy-android'), 'github.com/q-chang/buddy-android');
});
