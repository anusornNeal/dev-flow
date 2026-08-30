import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  getBlockerForQueueEntry,
  getSchedulerCapacitySnapshot,
  getSchedulerPriority,
  getSchedulerProfile,
  buildQueueEntryDiagnostics,
  classifyBackgroundPipelineJob,
  classifyReasoningPipelineBoundary,
  scopeVerificationResources,
  resetSchedulerResourceStateForTests,
  incrementScheduledResource,
  decrementScheduledResource,
  selectNextRunnableQueueIndex,
  setGlobalVerifyCapacityForTests,
  transitionScheduledResource,
  tryAcquireVerificationProcessPermit,
  releaseVerificationProcessPermit,
  recordVerificationInterferenceSampleForTests,
  setVerificationMachinePressureForTests,
  setVerificationResourceBudgetForTests,  setResidualVerificationSnapshotProviderForTests,
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

test('background pipeline classifier treats explicit commit intent as the terminal verification handoff without enabled ceremony', () => {
  assert.deepEqual(classifyBackgroundPipelineJob({ toolName: 'run_project_command', status: 'queued', args: {} }), {
    pipelineCapable: false,
    state: 'not-pipeline',
    phase: 'none',
    reasonCode: null,
  });
  assert.deepEqual(classifyBackgroundPipelineJob({
    toolName: 'run_project_command',
    status: 'running',
    args: { autonomousTail: { commitMessage: 'feat: finish card' } },
  }), {
    pipelineCapable: true,
    state: 'in-flight',
    phase: 'verification',
    reasonCode: 'BACKGROUND_VERIFICATION_IN_FLIGHT',
  });
  assert.equal(classifyBackgroundPipelineJob({
    toolName: 'run_project_command',
    status: 'failed',
    args: { autonomousTail: { commitMessage: 'feat: finish card' } },
  }).state, 'attention');
  assert.equal(classifyBackgroundPipelineJob({
    toolName: 'run_project_command',
    status: 'running',
    args: { autonomousTail: {} },
  }).pipelineCapable, false);
  assert.deepEqual(classifyBackgroundPipelineJob({ toolName: 'continue_task_execution_tail', status: 'running', args: {} }), {
    pipelineCapable: true,
    state: 'in-flight',
    phase: 'execution-tail',
    reasonCode: 'BACKGROUND_EXECUTION_TAIL_IN_FLIGHT',
  });
  assert.equal(classifyBackgroundPipelineJob({ toolName: 'continue_task_execution_tail', status: 'succeeded', args: {} }).state, 'completed');
});

test('reasoning pipeline boundary permits only safe independent foreground progression', () => {
  const verifyingA = classifyReasoningPipelineBoundary([{ taskId: 'A', pipelineState: 'in-flight' }]);
  assert.equal(verifyingA.canClaimIndependent, true, 'A verifying in background should allow independent B reasoning');
  assert.deepEqual(verifyingA.backgroundTaskIds, ['A']);

  const failedAWhileBAtomic = classifyReasoningPipelineBoundary([
    { taskId: 'A', pipelineState: 'attention' },
    { taskId: 'B', pipelineState: 'not-pipeline' },
  ]);
  assert.deepEqual(failedAWhileBAtomic.foregroundTaskIds, ['B']);
  assert.deepEqual(failedAWhileBAtomic.attentionTaskIds, ['A']);
  assert.equal(failedAWhileBAtomic.shouldSurfaceAttention, false, 'A failure must not interrupt active atomic B reasoning');
  assert.equal(failedAWhileBAtomic.canClaimIndependent, false);

  const failedAAtBoundary = classifyReasoningPipelineBoundary([{ taskId: 'A', pipelineState: 'attention' }]);
  assert.equal(failedAAtBoundary.shouldSurfaceAttention, true, 'A failure should surface at the next safe scheduler boundary');
  assert.equal(failedAAtBoundary.canClaimIndependent, false);

  const activeB = classifyReasoningPipelineBoundary([
    { taskId: 'A', pipelineState: 'in-flight' },
    { taskId: 'B', pipelineState: 'not-pipeline' },
  ]);
  assert.deepEqual(activeB.foregroundTaskIds, ['B']);
  assert.equal(activeB.canClaimIndependent, false, 'scheduler must not start C while B is the active foreground scope');

  const ambiguous = classifyReasoningPipelineBoundary([
    { taskId: 'B', pipelineState: 'not-pipeline' },
    { taskId: 'C', pipelineState: 'completed' },
  ]);
  assert.equal(ambiguous.ambiguousForeground, true);
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
  const activeA = entry({ jobId: 'verify-a', resourceKey: 'workspace:a', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command', verificationClass: 'fast' });
  const activeB = entry({ jobId: 'verify-b', resourceKey: 'workspace:b', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command', verificationClass: 'fast' });
  incrementScheduledResource(activeA);
  incrementScheduledResource(activeB);
  const queued = entry({ jobId: 'verify-c', resourceKey: 'workspace:c', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command', verificationClass: 'fast' });
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
  const activeA = entry({ jobId: 'verify-a', resourceKey: 'workspace:a', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command', verificationClass: 'fast' });
  const activeB = entry({ jobId: 'verify-b', resourceKey: 'workspace:b', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command', verificationClass: 'fast' });
  incrementScheduledResource(activeA);
  incrementScheduledResource(activeB);

  const queuedVerify = entry({ jobId: 'verify-c', resourceKey: 'workspace:c', accessMode: 'verify', costClass: 'verify', kind: 'repo-command', toolName: 'run_project_command', verificationClass: 'fast' });
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

test('residual process debt blocks heavy verification while fast verification and lightweight work remain admissible', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  setResidualVerificationSnapshotProviderForTests(() => ({
    count: 2,
    oldestAgeMs: 5_000,
    attempts: 3,
    states: { 'termination-unconfirmed': 2 },
    resourceEstimate: { cpuRatio: 0.5, memoryBytes: 512 * 1024 ** 2, processCount: 2 },
  }));

  const heavy = tryAcquireVerificationProcessPermit({
    jobId: 'heavy-under-residual-debt',
    verificationClass: 'heavy',
    sharedResources: ['project:a:gradle'],
  });
  assert.equal(heavy.permit, null);
  assert.equal(heavy.blocker?.blockReason, 'residual_resource_debt');

  const fast = tryAcquireVerificationProcessPermit({
    jobId: 'fast-under-residual-debt',
    verificationClass: 'fast',
    sharedResources: ['project:b:typescript'],
  });
  assert.ok(fast.permit, 'safe fast verification should remain available while heavy work is quarantined');
  assert.equal(getSchedulerCapacitySnapshot().verify.residual.count, 2);
  assert.equal(releaseVerificationProcessPermit(fast.permit), true);

  const interactiveRead = entry({ jobId: 'read-under-residual-debt', resourceKey: 'workspace:c' });
  assert.equal(getBlockerForQueueEntry(interactiveRead, 0, [interactiveRead], []), null);
  resetSchedulerResourceStateForTests();
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

test('global shared resources conflict across projects while unprefixed resources remain project scoped', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  const projectA = scopeVerificationResources({ projectId: 'a' }, undefined, ['global:port:5432', 'typescript']);
  const projectB = scopeVerificationResources({ projectId: 'b' }, undefined, ['global:port:5432', 'typescript']);
  assert.deepEqual(projectA, ['global:port:5432', 'project:a:typescript']);
  assert.deepEqual(projectB, ['global:port:5432', 'project:b:typescript']);

  const holder = tryAcquireVerificationProcessPermit({ jobId: 'project-a', verificationClass: 'fast', sharedResources: projectA });
  assert.ok(holder.permit);
  const blocked = tryAcquireVerificationProcessPermit({ jobId: 'project-b', verificationClass: 'fast', sharedResources: projectB });
  assert.equal(blocked.permit, null);
  assert.equal(blocked.blocker?.blockReason, 'shared_resource_conflict');
  assert.equal(blocked.blocker?.blockedByJobId, 'project-a');
  assert.equal(releaseVerificationProcessPermit(holder.permit), true);

  const afterRelease = tryAcquireVerificationProcessPermit({ jobId: 'project-b', verificationClass: 'fast', sharedResources: projectB });
  assert.ok(afterRelease.permit);
  assert.equal(releaseVerificationProcessPermit(afterRelease.permit), true);
});

test('queue diagnostics expose priority aging without changing scheduler ordering', () => {
  const now = 120_000;
  const heavy = entry({
    jobId: 'aged-heavy',
    resourceKey: 'workspace:a',
    accessMode: 'verify',
    costClass: 'verify',
    verificationClass: 'heavy',
    schedulerPriority: 2,
    enqueuedAt: now - 61_000,
  });
  const diagnostics = buildQueueEntryDiagnostics(heavy, 0, [heavy], [], now) as any;
  assert.equal(diagnostics.schedulerPriority, 2);
  assert.equal(diagnostics.agingBoost, 2);
  assert.equal(diagnostics.effectivePriority, 0);
  assert.equal(diagnostics.queueAgeMs, 61_000);
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

test('independent verification permits sharing one scheduler resource can fill configured capacity', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(3);
  const activeA = entry({
    jobId: 'green-a',
    resourceKey: 'workspace:green',
    accessMode: 'verify',
    costClass: 'verify',
    kind: 'repo-command',
    toolName: 'run_project_command',
    verificationClass: 'fast',
    sharedResources: ['project:a:test-a'],
  });
  const activeB = entry({
    jobId: 'green-b',
    resourceKey: 'workspace:green',
    accessMode: 'verify',
    costClass: 'verify',
    kind: 'repo-command',
    toolName: 'run_project_command',
    verificationClass: 'fast',
    sharedResources: ['project:a:test-b'],
  });
  incrementScheduledResource(activeA);
  incrementScheduledResource(activeB);

  const queued = entry({
    jobId: 'green-c',
    resourceKey: 'workspace:green',
    accessMode: 'verify',
    costClass: 'verify',
    kind: 'repo-command',
    toolName: 'run_project_command',
    verificationClass: 'fast',
    sharedResources: ['project:a:test-c'],
  });

  assert.equal(getSchedulerCapacitySnapshot().verify.active, 2);
  assert.equal(getBlockerForQueueEntry(queued, 0, [queued], [activeA, activeB]), null);
  incrementScheduledResource(queued);
  assert.equal(getSchedulerCapacitySnapshot().verify.active, 3);
  decrementScheduledResource(queued);
  decrementScheduledResource(activeB);
  decrementScheduledResource(activeA);
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
  assert.equal(snapshot.verify.heavy.capacity, 1);
  decrementScheduledResource(heavy);
  decrementScheduledResource(fast);
});

test('heavy verification is serialized to one process while fast verification can use remaining machine capacity', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  setVerificationMachinePressureForTests({ cpuRatio: 0.1, memoryPressureRatio: 0.1, totalMemoryBytes: 16 * 1024 * 1024 * 1024 });
  setVerificationResourceBudgetForTests({
    targetCpuRatio: 0.8,
    hardCpuRatio: 0.95,
    targetMemoryPressure: 0.8,
    hardMemoryPressure: 0.95,
    maxAdaptiveProcesses: 4,
  });

  const heavyA = entry({
    jobId: 'heavy-a',
    accessMode: 'verify',
    costClass: 'verify',
    verificationClass: 'heavy',
    verificationDemand: weightedDemand('heavy-a', 0.1, 128),
  });
  incrementScheduledResource(heavyA);

  const heavyB = entry({
    jobId: 'heavy-b',
    resourceKey: 'repo:b',
    accessMode: 'verify',
    costClass: 'verify',
    verificationClass: 'heavy',
    verificationDemand: weightedDemand('heavy-b', 0.1, 128),
  });
  const fast = entry({
    jobId: 'fast-b',
    resourceKey: 'repo:c',
    accessMode: 'verify',
    costClass: 'verify',
    verificationClass: 'fast',
    verificationDemand: weightedDemand('fast-b', 0.1, 128),
  });

  assert.equal(getBlockerForQueueEntry(heavyB, 0, [heavyB], [heavyA])?.blockReason, 'capacity_saturated');
  assert.equal(getBlockerForQueueEntry(fast, 0, [fast], [heavyA]), null);
  const snapshot: any = getSchedulerCapacitySnapshot();
  assert.equal(snapshot.verify.heavy.active, 1);
  assert.equal(snapshot.verify.heavy.capacity, 1);

  decrementScheduledResource(heavyA);
  assert.equal(getSchedulerCapacitySnapshot().verify.active, 0);
  assert.equal(getBlockerForQueueEntry(heavyB, 0, [heavyB], []), null, 'heavy permit must be reusable after release');
});

function weightedDemand(profileKey: string, cpuRatio: number, memoryMb: number, durationMs = 10_000, confidence: 'none' | 'low' | 'medium' | 'high' = 'high') {
  return {
    profileKey,
    confidence,
    sampleCount: confidence === 'none' ? 0 : 6,
    cpuRatio,
    memoryBytes: memoryMb * 1024 ** 2,
    durationMs,
    processCount: 1,
  };
}

test('adaptive verification budget admits heavy plus multiple light jobs when weighted demand fits', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  setVerificationResourceBudgetForTests({ targetCpuRatio: 0.8, hardCpuRatio: 0.9, targetMemoryPressure: 0.8, hardMemoryPressure: 0.9, maxAdaptiveProcesses: 6 });
  setVerificationMachinePressureForTests({ cpuRatio: 0.2, memoryPressureRatio: 0.35, totalMemoryBytes: 8 * 1024 ** 3 });

  const heavy = tryAcquireVerificationProcessPermit({
    jobId: 'adaptive-heavy', verificationClass: 'heavy', sharedResources: ['project:a:gradle'],
    resourceDemand: weightedDemand('profile-heavy', 0.4, 512, 12_000),
  });
  const lightA = tryAcquireVerificationProcessPermit({
    jobId: 'adaptive-light-a', verificationClass: 'fast', sharedResources: ['project:b:typescript'],
    resourceDemand: weightedDemand('profile-light-a', 0.1, 128, 4_000),
  });
  const lightB = tryAcquireVerificationProcessPermit({
    jobId: 'adaptive-light-b', verificationClass: 'fast', sharedResources: ['project:c:typescript'],
    resourceDemand: weightedDemand('profile-light-b', 0.1, 128, 4_000),
  });

  assert.ok(heavy.permit);
  assert.ok(lightA.permit);
  assert.ok(lightB.permit, 'adaptive admission should safely exceed the fixed capacity of two when weighted demand fits');
  const snapshot: any = getSchedulerCapacitySnapshot();
  assert.equal(snapshot.verify.active, 3);
  assert.equal(snapshot.verify.weighted.activeCpuRatio, 0.6);
  assert.equal(snapshot.verify.mode, 'adaptive');
  assert.equal(200 > 120, true, 'three-way safe overlap beats a two-slot synthetic makespan baseline');

  const interactiveRead = entry({ jobId: 'read-under-adaptive-load', resourceKey: 'workspace:read', accessMode: 'read', costClass: 'light-read', kind: 'repo-read' });
  assert.equal(getBlockerForQueueEntry(interactiveRead, 0, [interactiveRead], []), null);

  assert.equal(releaseVerificationProcessPermit(heavy.permit), true);
  assert.equal(releaseVerificationProcessPermit(lightA.permit), true);
  assert.equal(releaseVerificationProcessPermit(lightB.permit), true);
});

test('single-machine heavy serialization takes precedence over adaptive weighted admission', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  setVerificationResourceBudgetForTests({ targetCpuRatio: 0.75, hardCpuRatio: 0.9, targetMemoryPressure: 0.8, hardMemoryPressure: 0.9, maxAdaptiveProcesses: 4 });
  setVerificationMachinePressureForTests({ cpuRatio: 0.2, memoryPressureRatio: 0.3, totalMemoryBytes: 4 * 1024 ** 3 });

  const first = tryAcquireVerificationProcessPermit({
    jobId: 'heavy-a', verificationClass: 'heavy', sharedResources: ['project:a:gradle'],
    resourceDemand: weightedDemand('profile-heavy-a', 0.5, 900, 20_000),
  });
  const second = tryAcquireVerificationProcessPermit({
    jobId: 'heavy-b', verificationClass: 'heavy', sharedResources: ['project:b:gradle'],
    resourceDemand: weightedDemand('profile-heavy-b', 0.5, 900, 20_000),
  });

  assert.ok(first.permit);
  assert.equal(second.permit, null);
  assert.equal(second.blocker?.blockReason, 'capacity_saturated');
  assert.equal(getSchedulerCapacitySnapshot().verify.active, 1);
  assert.equal(releaseVerificationProcessPermit(first.permit), true);
});

test('live CPU or memory pressure pauses new adaptive admissions without cancelling healthy permits', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  setVerificationResourceBudgetForTests({ targetCpuRatio: 0.75, hardCpuRatio: 0.9, targetMemoryPressure: 0.8, hardMemoryPressure: 0.9, maxAdaptiveProcesses: 5 });
  setVerificationMachinePressureForTests({ cpuRatio: 0.2, memoryPressureRatio: 0.35, totalMemoryBytes: 8 * 1024 ** 3 });
  const running = tryAcquireVerificationProcessPermit({
    jobId: 'healthy-running', verificationClass: 'fast', sharedResources: ['project:a:typescript'],
    resourceDemand: weightedDemand('profile-running', 0.15, 128, 5_000),
  });
  assert.ok(running.permit);

  setVerificationMachinePressureForTests({ cpuRatio: 0.82, memoryPressureRatio: 0.35, totalMemoryBytes: 8 * 1024 ** 3 });
  const cpuBlocked = tryAcquireVerificationProcessPermit({
    jobId: 'cpu-blocked', verificationClass: 'fast', sharedResources: ['project:b:typescript'],
    resourceDemand: weightedDemand('profile-cpu-blocked', 0.1, 128, 5_000),
  });
  assert.equal(cpuBlocked.permit, null);
  assert.equal(cpuBlocked.blocker?.blockReason, 'live_pressure_saturated');
  assert.equal(getSchedulerCapacitySnapshot().verify.active, 1, 'live pressure must not kill healthy running work');

  setVerificationMachinePressureForTests({ cpuRatio: 0.2, memoryPressureRatio: 0.86, totalMemoryBytes: 8 * 1024 ** 3 });
  const memoryBlocked = tryAcquireVerificationProcessPermit({
    jobId: 'memory-blocked', verificationClass: 'fast', sharedResources: ['project:c:typescript'],
    resourceDemand: weightedDemand('profile-memory-blocked', 0.1, 128, 5_000),
  });
  assert.equal(memoryBlocked.permit, null);
  assert.equal(memoryBlocked.blocker?.blockReason, 'live_pressure_saturated');
  assert.equal(releaseVerificationProcessPermit(running.permit), true);
});

test('adaptive admission falls back to fixed capacity when profiles or live signals are uncertain', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  setVerificationResourceBudgetForTests({ targetCpuRatio: 0.8, hardCpuRatio: 0.9, targetMemoryPressure: 0.8, hardMemoryPressure: 0.9, maxAdaptiveProcesses: 6 });
  setVerificationMachinePressureForTests({ cpuRatio: 0.2, memoryPressureRatio: 0.3, totalMemoryBytes: 8 * 1024 ** 3 });

  const first = tryAcquireVerificationProcessPermit({ jobId: 'fallback-a', verificationClass: 'fast', resourceDemand: weightedDemand('fallback-a', 0.1, 64, 2_000, 'low') });
  const second = tryAcquireVerificationProcessPermit({ jobId: 'fallback-b', verificationClass: 'fast', resourceDemand: weightedDemand('fallback-b', 0.1, 64, 2_000, 'none') });
  const third = tryAcquireVerificationProcessPermit({ jobId: 'fallback-c', verificationClass: 'fast', resourceDemand: weightedDemand('fallback-c', 0.1, 64, 2_000, 'high') });
  assert.ok(first.permit);
  assert.ok(second.permit);
  assert.equal(third.permit, null);
  assert.equal(third.blocker?.blockReason, 'capacity_saturated');
  assert.equal((getSchedulerCapacitySnapshot().verify as any).mode, 'fallback');
  assert.equal(releaseVerificationProcessPermit(first.permit), true);
  assert.equal(releaseVerificationProcessPermit(second.permit), true);

  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(1);
  setVerificationMachinePressureForTests(null);
  const unknownSignalA = tryAcquireVerificationProcessPermit({ jobId: 'signal-a', resourceDemand: weightedDemand('signal-a', 0.1, 64) });
  const unknownSignalB = tryAcquireVerificationProcessPermit({ jobId: 'signal-b', resourceDemand: weightedDemand('signal-b', 0.1, 64) });
  assert.ok(unknownSignalA.permit);
  assert.equal(unknownSignalB.permit, null);
  assert.equal(unknownSignalB.blocker?.blockReason, 'capacity_saturated');
  assert.equal(releaseVerificationProcessPermit(unknownSignalA.permit), true);
});

test('shared-resource conflicts still block before weighted budget admission', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(1);
  setVerificationResourceBudgetForTests({ targetCpuRatio: 0.9, hardCpuRatio: 0.95, targetMemoryPressure: 0.85, hardMemoryPressure: 0.95, maxAdaptiveProcesses: 6 });
  setVerificationMachinePressureForTests({ cpuRatio: 0.1, memoryPressureRatio: 0.2, totalMemoryBytes: 8 * 1024 ** 3 });
  const holder = tryAcquireVerificationProcessPermit({
    jobId: 'shared-holder', verificationClass: 'fast', sharedResources: ['project:a:typescript'], resourceDemand: weightedDemand('shared-holder', 0.1, 64),
  });
  const blocked = tryAcquireVerificationProcessPermit({
    jobId: 'shared-blocked', verificationClass: 'fast', sharedResources: ['project:a:typescript'], resourceDemand: weightedDemand('shared-blocked', 0.1, 64),
  });
  assert.ok(holder.permit);
  assert.equal(blocked.permit, null);
  assert.equal(blocked.blocker?.blockReason, 'shared_resource_conflict');
  assert.equal(releaseVerificationProcessPermit(holder.permit), true);
});

test('verification recovery shared resource serializes concurrent recovery permits', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(4);
  setVerificationResourceBudgetForTests({ targetCpuRatio: 0.9, hardCpuRatio: 0.95, targetMemoryPressure: 0.85, hardMemoryPressure: 0.95, maxAdaptiveProcesses: 6 });
  setVerificationMachinePressureForTests({ cpuRatio: 0.1, memoryPressureRatio: 0.2, totalMemoryBytes: 8 * 1024 ** 3 });
  const holder = tryAcquireVerificationProcessPermit({
    jobId: 'recovery-holder', verificationClass: 'fast', sharedResources: ['project:a:verification-recovery'], resourceDemand: weightedDemand('recovery-holder', 0.1, 64),
  });
  const blocked = tryAcquireVerificationProcessPermit({
    jobId: 'recovery-blocked', verificationClass: 'fast', sharedResources: ['project:a:verification-recovery'], resourceDemand: weightedDemand('recovery-blocked', 0.1, 64),
  });
  assert.ok(holder.permit);
  assert.equal(blocked.permit, null);
  assert.equal(blocked.blocker?.blockReason, 'shared_resource_conflict');
  assert.equal(releaseVerificationProcessPermit(holder.permit), true);
});

test('measured parallel slowdown can serialize a nominally fitting profile pair', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(2);
  setVerificationResourceBudgetForTests({ targetCpuRatio: 0.85, hardCpuRatio: 0.95, targetMemoryPressure: 0.85, hardMemoryPressure: 0.95, maxAdaptiveProcesses: 6 });
  setVerificationMachinePressureForTests({ cpuRatio: 0.15, memoryPressureRatio: 0.25, totalMemoryBytes: 8 * 1024 ** 3 });
  recordVerificationInterferenceSampleForTests('profile-a', 'profile-b', 1.6);
  recordVerificationInterferenceSampleForTests('profile-a', 'profile-b', 1.5);

  const a = tryAcquireVerificationProcessPermit({ jobId: 'pair-a', verificationClass: 'fast', resourceDemand: weightedDemand('profile-a', 0.15, 128, 5_000) });
  const b = tryAcquireVerificationProcessPermit({ jobId: 'pair-b', verificationClass: 'fast', resourceDemand: weightedDemand('profile-b', 0.15, 128, 5_000) });
  assert.ok(a.permit);
  assert.equal(b.permit, null);
  assert.equal(b.blocker?.blockReason, 'interference_risk');
  assert.equal(releaseVerificationProcessPermit(a.permit), true);
});

test('weighted resource budget is released exactly once and reset cannot leak permits', () => {
  resetSchedulerResourceStateForTests();
  setGlobalVerifyCapacityForTests(1);
  setVerificationResourceBudgetForTests({ targetCpuRatio: 0.8, hardCpuRatio: 0.9, targetMemoryPressure: 0.8, hardMemoryPressure: 0.9, maxAdaptiveProcesses: 4 });
  setVerificationMachinePressureForTests({ cpuRatio: 0.2, memoryPressureRatio: 0.3, totalMemoryBytes: 8 * 1024 ** 3 });
  const permit = tryAcquireVerificationProcessPermit({ jobId: 'release-weighted', resourceDemand: weightedDemand('profile-release', 0.25, 256, 5_000) });
  assert.ok(permit.permit);
  assert.equal((getSchedulerCapacitySnapshot().verify as any).weighted.activeCpuRatio, 0.25);
  assert.equal(releaseVerificationProcessPermit(permit.permit), true);
  assert.equal(releaseVerificationProcessPermit(permit.permit), false);
  const released: any = getSchedulerCapacitySnapshot().verify;
  assert.equal(released.active, 0);
  assert.equal(released.weighted.activeCpuRatio, 0);
  assert.equal(released.weighted.activeMemoryBytes, 0);

  resetSchedulerResourceStateForTests();
  const reset: any = getSchedulerCapacitySnapshot().verify;
  assert.equal(reset.active, 0);
  assert.equal(reset.weighted.activeCpuRatio, 0);
  assert.equal(reset.interference.pairs, 0);
});

test('DVF-0476 benchmark declares the 3+3 adaptive gate before execution', () => {
  const source = fs.readFileSync(new URL('../../scripts/benchmark-session-isolation.ts', import.meta.url), 'utf8');
  assert.match(source, /DVF_0476_AGENT_SPLIT\s*=\s*\{\s*devflow:\s*3,\s*sumora:\s*3\s*\}/);
  assert.match(source, /DVF_0476_MIN_IMPROVEMENT_PCT\s*=\s*15/);
  assert.match(source, /adaptiveVerificationGate/);
  assert.match(source, /fixedBaseline/);
  assert.match(source, /crossRepoFairness/);
});

test('resource accounting blocks saturated same-cost work and releases after decrement', () => {
  resetSchedulerResourceStateForTests();
  const active = Array.from({ length: 8 }, (_, index) => entry({ jobId: `active-${index}` }));
  active.forEach(incrementScheduledResource);
  const queued = entry({ jobId: 'queued' });
  assert.equal(getBlockerForQueueEntry(queued, 0, [queued], active).blockReason, 'cost_pool_saturated');
  decrementScheduledResource(active[0]);
  assert.equal(getBlockerForQueueEntry(queued, 0, [queued], active.slice(1)), null);
  active.slice(1).forEach((activeEntry) => decrementScheduledResource(activeEntry));
});
