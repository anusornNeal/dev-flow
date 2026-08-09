import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBlockerForQueueEntry,
  getSchedulerProfile,
  resetSchedulerResourceStateForTests,
  incrementScheduledResource,
  decrementScheduledResource,
  selectNextRunnableQueueIndex,
  setGlobalVerifyCapacityForTests,
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

test('global verify capacity blocks a third workspace separately from correctness locks', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  const activeA = entry({ jobId: 'verify-a', resourceKey: 'workspace:a', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command' });
  const activeB = entry({ jobId: 'verify-b', resourceKey: 'workspace:b', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command' });
  incrementScheduledResource(activeA);
  incrementScheduledResource(activeB);
  const queued = entry({ jobId: 'verify-c', resourceKey: 'workspace:c', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command' });
  const blocker = getBlockerForQueueEntry(queued, 0, [queued], [activeA, activeB]);
  assert.equal(blocker?.blockReason, 'capacity_saturated');
  assert.equal(blocker?.waitType, 'capacity');
  decrementScheduledResource(activeA);
  assert.equal(getBlockerForQueueEntry(queued, 0, [queued], [activeB]), null);
  decrementScheduledResource(activeB);
});

test('verify saturation does not block interactive reads or independent workspace writes', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  const activeA = entry({ jobId: 'verify-a', resourceKey: 'workspace:a', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command' });
  const activeB = entry({ jobId: 'verify-b', resourceKey: 'workspace:b', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command' });
  incrementScheduledResource(activeA);
  incrementScheduledResource(activeB);

  const queuedVerify = entry({ jobId: 'verify-c', resourceKey: 'workspace:c', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command' });
  const interactiveRead = entry({ jobId: 'read-c', resourceKey: 'workspace:c', accessMode: 'read', costClass: 'light-read', kind: 'repo-read' });
  const independentWrite = entry({ jobId: 'write-c', resourceKey: 'workspace:c', accessMode: 'write', costClass: 'write', kind: 'repo-write' });
  const conflictingWrite = entry({ jobId: 'write-a', resourceKey: 'workspace:a', accessMode: 'write', costClass: 'write', kind: 'repo-write' });
  const queue = [queuedVerify, interactiveRead, independentWrite, conflictingWrite];

  assert.equal(getBlockerForQueueEntry(queuedVerify, 0, queue, [activeA, activeB])?.blockReason, 'capacity_saturated');
  assert.equal(getBlockerForQueueEntry(interactiveRead, 1, queue, [activeA, activeB]), null);
  assert.equal(getBlockerForQueueEntry(independentWrite, 2, queue, [activeA, activeB]), null);
  assert.equal(getBlockerForQueueEntry(conflictingWrite, 3, queue, [activeA, activeB])?.blockReason, 'active_resource');
  assert.equal(selectNextRunnableQueueIndex(queue, [activeA, activeB]), 1, 'interactive read should be admitted ahead of blocked verification');

  decrementScheduledResource(activeA);
  decrementScheduledResource(activeB);
});

test('targeted verification can start ahead of queued full verification while aging prevents permanent starvation', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(1);
  const now = 100_000;
  const full = entry({ jobId: 'full', resourceKey: 'workspace:a', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command', args: { command: 'test' }, schedulerPriority: 2, enqueuedAt: now - 1_000 });
  const targeted = entry({ jobId: 'targeted', resourceKey: 'workspace:b', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command', args: { command: 'lint' }, schedulerPriority: 1, enqueuedAt: now });
  assert.equal(selectNextRunnableQueueIndex([full, targeted], [], now), 1);
  full.enqueuedAt = now - 70_000;
  assert.equal(selectNextRunnableQueueIndex([full, targeted], [], now), 0);
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
