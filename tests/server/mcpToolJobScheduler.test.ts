import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBlockerForQueueEntry,
  getSchedulerCapacitySnapshot,
  getSchedulerPriority,
  getSchedulerProfile,
  resetSchedulerResourceStateForTests,
  incrementScheduledResource,
  decrementScheduledResource,
  selectNextRunnableQueueIndex,
  setGlobalVerifyCapacityForTests,
  transitionScheduledResource,
  tryAcquireVerificationProcessPermit,
  releaseVerificationProcessPermit,
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

test('write to verify transition requires a reserved process permit and never overbooks capacity', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(1);
  const activeVerify = entry({
    jobId: 'verify-active',
    resourceKey: 'workspace:a',
    accessMode: 'verify',
    costClass: 'verify',
    kind: 'repo-command',
    toolName: 'run_project_command',
    verificationClass: 'heavy',
    sharedResources: ['project:a:compiler'],
  });
  const writer = entry({
    jobId: 'writer-transition',
    resourceKey: 'workspace:b',
    accessMode: 'write',
    costClass: 'write',
    kind: 'repo-command',
    toolName: 'apply_and_verify',
  });
  incrementScheduledResource(activeVerify);
  incrementScheduledResource(writer);

  const saturated = tryAcquireVerificationProcessPermit({
    jobId: writer.jobId,
    verificationClass: 'heavy',
    sharedResources: ['project:b:typescript'],
  });
  assert.equal(saturated.permit, null);
  assert.equal(saturated.blocker?.blockReason, 'capacity_saturated');
  assert.equal(getSchedulerCapacitySnapshot().verify.active, 1);
  assert.throws(() => transitionScheduledResource(writer, 'verify'), /verification process permit/i);
  assert.equal(writer.accessMode, 'write');

  decrementScheduledResource(activeVerify);
  const reserved = tryAcquireVerificationProcessPermit({
    jobId: writer.jobId,
    verificationClass: 'heavy',
    sharedResources: ['project:b:typescript'],
  });
  assert.ok(reserved.permit);
  assert.equal(getSchedulerCapacitySnapshot().verify.active, 1);
  assert.equal(transitionScheduledResource(writer, 'verify', reserved.permit), true);
  assert.equal(writer.accessMode, 'verify');
  assert.equal(getSchedulerCapacitySnapshot().verify.active, 1, 'composite parent must not double-count its reserved child permit');

  assert.equal(releaseVerificationProcessPermit(reserved.permit), true);
  decrementScheduledResource(writer);
  assert.equal(getSchedulerCapacitySnapshot().verify.active, 0);
});

test('write to verify transition honors shared verification resource conflicts before downgrade', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  const writer = entry({
    jobId: 'writer-shared-transition',
    resourceKey: 'workspace:writer',
    accessMode: 'write',
    costClass: 'write',
    kind: 'repo-command',
    toolName: 'apply_and_verify',
  });
  incrementScheduledResource(writer);

  const holder = tryAcquireVerificationProcessPermit({
    jobId: 'verify-holder',
    verificationClass: 'fast',
    sharedResources: ['project:a:typescript'],
  });
  assert.ok(holder.permit);

  const blocked = tryAcquireVerificationProcessPermit({
    jobId: writer.jobId,
    verificationClass: 'fast',
    sharedResources: ['project:a:typescript'],
  });
  assert.equal(blocked.permit, null);
  assert.equal(blocked.blocker?.blockReason, 'shared_resource_conflict');
  assert.equal(blocked.blocker?.blockedByJobId, 'verify-holder');
  assert.equal(writer.accessMode, 'write');
  assert.equal(getSchedulerCapacitySnapshot().verify.active, 1);

  assert.equal(releaseVerificationProcessPermit(holder.permit), true);
  const reserved = tryAcquireVerificationProcessPermit({
    jobId: writer.jobId,
    verificationClass: 'fast',
    sharedResources: ['project:a:typescript'],
  });
  assert.ok(reserved.permit);
  assert.equal(transitionScheduledResource(writer, 'verify', reserved.permit), true);
  assert.equal(writer.accessMode, 'verify');
  assert.equal(releaseVerificationProcessPermit(reserved.permit), true);
  decrementScheduledResource(writer);
  assert.equal(getSchedulerCapacitySnapshot().verify.active, 0);
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

test('verification class metadata drives fast priority while aging still promotes heavy work', () => {
  const now = 100_000;
  const heavyPriority = getSchedulerPriority('run_project_command', { command: 'custom-heavy' }, 'verify', 'heavy');
  const fastPriority = getSchedulerPriority('run_project_command', { command: 'custom-fast' }, 'verify', 'fast');
  assert.equal(heavyPriority, 2);
  assert.equal(fastPriority, 1);

  const heavy = entry({
    jobId: 'heavy',
    resourceKey: 'workspace:a',
    accessMode: 'verify',
    costClass: 'verify',
    kind: 'repo-command',
    toolName: 'run_project_command',
    verificationClass: 'heavy',
    schedulerPriority: heavyPriority,
    enqueuedAt: now - 1_000,
  });
  const fast = entry({
    jobId: 'fast',
    resourceKey: 'workspace:b',
    accessMode: 'verify',
    costClass: 'verify',
    kind: 'repo-command',
    toolName: 'run_project_command',
    verificationClass: 'fast',
    schedulerPriority: fastPriority,
    enqueuedAt: now,
  });
  assert.equal(selectNextRunnableQueueIndex([heavy, fast], [], now), 1);
  heavy.enqueuedAt = now - 31_000;
  assert.equal(selectNextRunnableQueueIndex([heavy, fast], [], now), 0);
});

test('same shared verification resource serializes while independent resource classes overlap', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  const active = entry({
    jobId: 'active-heavy',
    resourceKey: 'workspace:a',
    accessMode: 'verify',
    costClass: 'verify',
    kind: 'repo-command',
    toolName: 'run_project_command',
    verificationClass: 'heavy',
    sharedResources: ['project:a:compiler'],
  });
  incrementScheduledResource(active);

  const sameResource = entry({
    jobId: 'same-resource',
    resourceKey: 'workspace:b',
    accessMode: 'verify',
    costClass: 'verify',
    kind: 'repo-command',
    toolName: 'run_project_command',
    verificationClass: 'heavy',
    sharedResources: ['project:a:compiler'],
  });
  const independent = entry({
    jobId: 'independent-fast',
    resourceKey: 'workspace:c',
    accessMode: 'verify',
    costClass: 'verify',
    kind: 'repo-command',
    toolName: 'run_project_command',
    verificationClass: 'fast',
    sharedResources: ['project:a:typescript'],
  });

  assert.equal(getBlockerForQueueEntry(sameResource, 0, [sameResource], [active])?.blockReason, 'shared_resource_conflict');
  assert.equal(getBlockerForQueueEntry(independent, 0, [independent], [active]), null);
  decrementScheduledResource(active);
});

test('same fast verification resource consumes its own capacity pool', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  const active = entry({
    jobId: 'active-fast',
    resourceKey: 'workspace:a',
    accessMode: 'verify',
    costClass: 'verify',
    verificationClass: 'fast',
    sharedResources: ['project:a:typescript'],
  });
  incrementScheduledResource(active);
  const queued = entry({
    jobId: 'queued-fast',
    resourceKey: 'workspace:b',
    accessMode: 'verify',
    costClass: 'verify',
    verificationClass: 'fast',
    sharedResources: ['project:a:typescript'],
  });

  assert.equal(getBlockerForQueueEntry(queued, 0, [queued], [active])?.blockReason, 'shared_resource_conflict');
  decrementScheduledResource(active);
});

test('verification capacity snapshot accounts for fast and heavy work separately without raising total capacity', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  const heavy = entry({ jobId: 'heavy', accessMode: 'verify', costClass: 'verify', verificationClass: 'heavy' });
  const fast = entry({ jobId: 'fast', resourceKey: 'repo:b', accessMode: 'verify', costClass: 'verify', verificationClass: 'fast' });
  incrementScheduledResource(heavy);
  incrementScheduledResource(fast);
  const snapshot: any = getSchedulerCapacitySnapshot();
  assert.equal(snapshot.verify.capacity, 2);
  assert.equal(snapshot.verify.active, 2);
  assert.equal(snapshot.verify.fast.active, 1);
  assert.equal(snapshot.verify.heavy.active, 1);
  assert.equal(snapshot.verify.heavy.capacity, 2);
  decrementScheduledResource(heavy);
  decrementScheduledResource(fast);
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
