import {
  decrementScheduledResource,
  getBlockerForQueueEntry,
  incrementScheduledResource,
  selectNextRunnableQueueIndex,
  type SchedulerQueueEntry,
} from './mcpToolJobScheduler';

export type QueueLifecycleWaitTelemetry = {
  lastObservedAt: number;
  currentWaitType?: 'workspace_lock' | 'capacity';
  lastBlockReason?: string;
  workspaceLockWaitMs: number;
  capacityWaitMs: number;
  blockerReasons: Record<string, number>;
  finalized?: boolean;
};

export type QueueLifecycleEntry<TState = unknown, TVerification = unknown, TPhaseTelemetry = unknown> = SchedulerQueueEntry & {
  state: TState;
  singleFlightKey?: string;
  verification?: TVerification;
  waitTelemetry: QueueLifecycleWaitTelemetry;
  phaseTelemetry: TPhaseTelemetry;
};

type ReleaseObservation = { actualDurationMs?: number };

type ProcessQueueCallbacks<TEntry extends SchedulerQueueEntry> = {
  activeEntries: () => SchedulerQueueEntry[];
  advanceWaitTelemetry: (entry: TEntry, blocker: ReturnType<typeof getBlockerForQueueEntry>, now: number) => void;
  finalizeWaitTelemetry: (entry: TEntry, now: number) => void;
  startJob: (entry: TEntry) => void;
};

/**
 * Owns the in-memory scheduler lease/capacity bookkeeping for one job-service
 * façade instance. State intentionally lives in this factory instance rather
 * than a module singleton so restart/test isolation semantics remain explicit.
 */
export function createMcpToolJobQueueLifecycle() {
  const releasedSchedulerLeases = new Set<string>();
  const schedulerCapacityWaiters = new Set<() => void>();

  const schedulerLeaseKey = (jobId: string, leaseGeneration: number) => `${jobId}:${leaseGeneration}`;

  const notifyCapacityWaiters = () => {
    if (schedulerCapacityWaiters.size === 0) return;
    const waiters = Array.from(schedulerCapacityWaiters);
    schedulerCapacityWaiters.clear();
    for (const wake of waiters) wake();
  };

  return {
    markScheduled(entry: SchedulerQueueEntry) {
      incrementScheduledResource(entry);
    },

    waitForCapacityChange() {
      return new Promise<void>((resolve) => {
        schedulerCapacityWaiters.add(resolve);
      });
    },

    notifyCapacityWaiters,

    releaseSchedulerLease(entry: SchedulerQueueEntry, leaseGeneration: number, observation?: ReleaseObservation) {
      const key = schedulerLeaseKey(entry.jobId, leaseGeneration);
      if (releasedSchedulerLeases.has(key)) return false;
      releasedSchedulerLeases.add(key);
      decrementScheduledResource(entry, observation);
      notifyCapacityWaiters();
      return true;
    },

    hasReleasedSchedulerLease(jobId: string, leaseGeneration: number) {
      return releasedSchedulerLeases.has(schedulerLeaseKey(jobId, leaseGeneration));
    },

    forgetReleasedSchedulerLease(jobId: string, leaseGeneration: number) {
      releasedSchedulerLeases.delete(schedulerLeaseKey(jobId, leaseGeneration));
    },

    resetForTests() {
      releasedSchedulerLeases.clear();
      schedulerCapacityWaiters.clear();
    },

    processQueue<TEntry extends SchedulerQueueEntry>(queue: TEntry[], callbacks: ProcessQueueCallbacks<TEntry>) {
      while (queue.length > 0) {
        const activeEntries = callbacks.activeEntries();
        const observedAt = Date.now();
        queue.forEach((entry, index) => callbacks.advanceWaitTelemetry(
          entry,
          getBlockerForQueueEntry(entry, index, queue, activeEntries),
          observedAt,
        ));
        const index = selectNextRunnableQueueIndex(queue, activeEntries);
        if (index < 0) break;
        const [entry] = queue.splice(index, 1);
        callbacks.finalizeWaitTelemetry(entry, observedAt);
        callbacks.startJob(entry);
      }
    },
  };
}
