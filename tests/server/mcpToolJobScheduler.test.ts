import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBlockerForQueueEntry,
  getSchedulerProfile,
  resetSchedulerResourceStateForTests,
  incrementScheduledResource,
  decrementScheduledResource,
  type SchedulerQueueEntry,
} from '../../src/server/services/mcpToolJobScheduler.js';

function entry(overrides: Partial<SchedulerQueueEntry> = {}): SchedulerQueueEntry {
  return {
    jobId: 'job-1',
    resourceKey: 'repo:a',
    kind: 'repo-read',
    toolName: 'read_local_file',
    args: {},
    accessMode: 'read',
    costClass: 'light-read',
    enqueuedAt: 1,
    ...overrides,
  };
}

test('scheduler profile preserves read/search/write cost classes', () => {
  assert.deepEqual(getSchedulerProfile({} as any, 'read_local_file', {}, 'repo-read'), { accessMode: 'read', costClass: 'light-read' });
  assert.deepEqual(getSchedulerProfile({} as any, 'search_local_files', {}, 'repo-read'), { accessMode: 'read', costClass: 'search' });
  assert.deepEqual(getSchedulerProfile({} as any, 'edit_local_files_batch', {}, 'repo-write'), { accessMode: 'write', costClass: 'write' });
  assert.deepEqual(getSchedulerProfile({} as any, 'get_authoring_skill', {}, 'skill-read'), { accessMode: 'read', costClass: 'light-read' });
});

test('writer barrier blocks later read for the same resource but not another resource', () => {
  resetSchedulerResourceStateForTests();
  const writer = entry({ jobId: 'writer', accessMode: 'write', costClass: 'write', kind: 'repo-write' });
  const sameRepoRead = entry({ jobId: 'read-a' });
  const otherRepoRead = entry({ jobId: 'read-b', resourceKey: 'repo:b' });
  const queue = [writer, sameRepoRead, otherRepoRead];
  assert.equal(getBlockerForQueueEntry(sameRepoRead, 1, queue, []).blockReason, 'writer_barrier');
  assert.equal(getBlockerForQueueEntry(otherRepoRead, 2, queue, []), null);
});

test('resource accounting blocks saturated same-cost work and releases after decrement', () => {
  resetSchedulerResourceStateForTests();
  const active = Array.from({ length: 8 }, (_, index) => entry({ jobId: `active-${index}` }));
  active.forEach(incrementScheduledResource);
  const queued = entry({ jobId: 'queued' });
  assert.equal(getBlockerForQueueEntry(queued, 0, [queued], active).blockReason, 'cost_pool_saturated');
  decrementScheduledResource(active[0]);
  assert.equal(getBlockerForQueueEntry(queued, 0, [queued], active.slice(1)), null);
  active.slice(1).forEach(decrementScheduledResource);
});
