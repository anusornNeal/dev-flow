import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearLocalFileSearchCache,
  clearLocalSearchRuntimeState,
  getLocalSearchRuntimeStatus,
  searchResolvedLocalFiles,
} from '../../src/server/services/localSearchService.js';

test('local search runtime is exposed through a focused service', () => {
  assert.equal(typeof clearLocalSearchRuntimeState, 'function');
  assert.equal(typeof clearLocalFileSearchCache, 'function');
  assert.equal(typeof getLocalSearchRuntimeStatus, 'function');
  assert.equal(typeof searchResolvedLocalFiles, 'function');
});

test('runtime status reports one active backend and keeps fallback available', () => {
  clearLocalSearchRuntimeState();
  const status = getLocalSearchRuntimeStatus();
  assert.ok(status.backend === 'ripgrep' || status.backend === 'fallback');
  assert.equal(status.fallbackAvailable, true);
});
