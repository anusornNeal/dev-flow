import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getChangedGitFilesForRoot,
  getGitWorkspaceSnapshotForRoot,
  getGitWorkspaceStatusForRoot,
} from '../../src/server/services/gitLocalService.js';
import {
  clearGitRemoteEvidenceCache,
  getGitRemoteEvidenceMetrics,
} from '../../src/server/services/gitRemoteEvidenceService.js';
import {
  normalizeRepoIdentity,
  resolveRemoteName,
} from '../../src/server/services/gitRemoteService.js';

test('local Git workspace inspection is owned by a focused service', () => {
  assert.equal(typeof getChangedGitFilesForRoot, 'function');
  assert.equal(typeof getGitWorkspaceStatusForRoot, 'function');
  assert.equal(typeof getGitWorkspaceSnapshotForRoot, 'function');
});

test('remote Git identity and validation primitives are owned by a focused service', () => {
  assert.equal(resolveRemoteName(undefined), 'origin');
  assert.equal(normalizeRepoIdentity('https://github.com/Owner/Repo.git'), process.platform === 'win32' ? 'github.com/owner/repo' : 'github.com/Owner/Repo');
});

test('remote evidence cache lifecycle is owned by a focused service', () => {
  clearGitRemoteEvidenceCache();
  const metrics = getGitRemoteEvidenceMetrics();
  assert.equal(metrics.entries, 0);
  assert.ok(metrics.ttlMs >= 1000);
});
