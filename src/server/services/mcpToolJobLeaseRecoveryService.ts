import type { AppState } from '../types';
import {
  appendJobLog,
  listRecentJobs,
  listRecoverableJobs,
  requeueJobForRecovery,
  setJobRecoveryClassification,
  transitionJobStatus,
  writeJobResult,
  type McpToolJob,
  type JobLeaseGuard,
} from '../repositories/mcpToolJobRepository';
import { getBuiltinToolJobRecoveryPolicy } from './mcpToolJobRunnerRegistry';

type Deadline = {
  executionBudgetMs: number;
  reconciliationGraceMs: number;
  delayMs: number;
};

type RecoveryEntry = {
  jobId: string;
  toolName: string;
  args: any;
};

type StaleActive<TEntry extends RecoveryEntry> = {
  entry: TEntry;
};

export type DurableJobRecoverySummary = {
  resumable: number;
  retryable: number;
  interrupted: number;
};

export type DurableJobRecoveryDependencies<TEntry extends RecoveryEntry> = {
  isSingleFlightFollower: (jobId: string) => boolean;
  hasQueuedOrActive: (jobId: string) => boolean;
  recordDurableExecutionPending: (job: Pick<McpToolJob, 'jobId' | 'toolName' | 'args'>, status: 'accepted' | 'running') => unknown;
  enqueueRecoveredJob: (state: AppState, job: McpToolJob) => boolean;
  releaseStaleActiveLease: (job: McpToolJob) => StaleActive<TEntry> | undefined;
  finalizeSingleFlight: (entry: TEntry) => void;
  safelyReconcileTerminalDurableExecution: (job: McpToolJob | null | undefined) => unknown;
  releaseTerminalVerificationCandidate: (job: Pick<McpToolJob, 'args'> | null | undefined) => boolean;
  releaseVerificationCandidateForArgsAsync: (args: any) => Promise<boolean>;
  invalidateFencedTaskVerification: (entry: TEntry, reason: string) => unknown;
  scheduleProcessQueue: () => void;
  durableExecutionDeadlineDelayMs: (entry: { toolName: string; state: AppState; args: any }) => Deadline | null;
  buildExecutionDeadlineEvidence: (jobId: string, deadline: Deadline, args: Record<string, any>) => any;
  summarizeError: (error: unknown) => string;
};

/**
 * Owns durable lease/restart recovery decisions while delegating façade-local
 * in-memory topology mutations through explicit dependencies. Retry safety stays
 * authoritative in mcpToolJobRunnerRegistry.getBuiltinToolJobRecoveryPolicy.
 */
export function runDurableJobRecoveryPass<TEntry extends RecoveryEntry>(
  state: AppState | undefined,
  nowMs: number,
  deps: DurableJobRecoveryDependencies<TEntry>,
): DurableJobRecoverySummary {
  const summary: DurableJobRecoverySummary = { resumable: 0, retryable: 0, interrupted: 0 };
  let queuedRecoveredWork = false;

  if (state) {
    for (const job of listRecentJobs(200)) {
      if (job.status !== 'running' || job.toolName !== 'run_project_command' || !job.startedAt || !job.leaseOwner || !job.leaseGeneration) continue;
      const deadline = deps.durableExecutionDeadlineDelayMs({ toolName: job.toolName, state, args: job.args });
      if (!deadline || nowMs < Date.parse(job.startedAt) + deadline.delayMs) continue;
      const executionDeadline = deps.buildExecutionDeadlineEvidence(job.jobId, deadline, job.args);
      const failureSummary = `Execution deadline exceeded after ${deadline.executionBudgetMs}ms plus ${deadline.reconciliationGraceMs}ms reconciliation grace. Last active phase: ${executionDeadline.lastActivePhase}.`;
      const guard: JobLeaseGuard = { workerId: job.leaseOwner, leaseGeneration: job.leaseGeneration };
      const wrote = writeJobResult(job.jobId, {
        ok: false,
        status: 'timed_out',
        code: 'JOB_EXECUTION_DEADLINE_EXCEEDED',
        message: failureSummary,
        timedOut: true,
        durationMs: Math.max(0, nowMs - Date.parse(job.startedAt)),
        executionDeadline,
      }, guard);
      const transitioned = wrote
        ? transitionJobStatus(job.jobId, ['running'], {
            status: 'timed_out',
            failureSummary,
            recoveryClassification: 'interrupted',
          }, { workerId: job.leaseOwner, leaseGeneration: job.leaseGeneration, nowMs })
        : null;
      if (!transitioned) continue;

      appendJobLog(job.jobId, 'stderr', `\n[Job Timed Out] ${failureSummary}\n`);
      const staleActive = deps.releaseStaleActiveLease(job);
      if (staleActive) {
        deps.invalidateFencedTaskVerification(staleActive.entry, 'durable-execution-deadline-recovery');
        deps.finalizeSingleFlight(staleActive.entry);
      }
      deps.safelyReconcileTerminalDurableExecution(transitioned);
      void deps.releaseVerificationCandidateForArgsAsync(job.args).catch(() => {});
      summary.interrupted += 1;
      queuedRecoveredWork = true;
    }
  }

  for (const job of listRecoverableJobs(nowMs)) {
    if (deps.isSingleFlightFollower(job.jobId)) continue;
    if (job.status === 'queued') {
      if (deps.hasQueuedOrActive(job.jobId)) continue;
      try {
        deps.recordDurableExecutionPending(job, 'accepted');
      } catch (error) {
        const failed = transitionJobStatus(job.jobId, ['queued'], {
          status: 'failed',
          failureSummary: `Recovered durable job binding is no longer authoritative: ${deps.summarizeError(error)}`,
          recoveryClassification: 'interrupted',
        }, { nowMs });
        if (failed) {
          appendJobLog(job.jobId, 'stderr', `\n[Job Recovery Fenced] ${deps.summarizeError(error)}\n`);
          deps.safelyReconcileTerminalDurableExecution(failed);
          summary.interrupted += 1;
        }
        continue;
      }
      const classified = setJobRecoveryClassification(job.jobId, 'resumable', nowMs);
      if (!classified) continue;
      summary.resumable += 1;
      if (state) queuedRecoveredWork = deps.enqueueRecoveredJob(state, classified) || queuedRecoveredWork;
      continue;
    }

    try {
      deps.recordDurableExecutionPending(job, 'running');
    } catch (error) {
      const staleActive = deps.releaseStaleActiveLease(job);
      const failed = transitionJobStatus(job.jobId, ['running'], {
        status: 'failed',
        failureSummary: `Recovered running job binding is no longer authoritative: ${deps.summarizeError(error)}`,
        recoveryClassification: 'interrupted',
      }, {
        workerId: job.leaseOwner,
        leaseGeneration: job.leaseGeneration,
        nowMs,
      });
      if (failed) {
        appendJobLog(job.jobId, 'stderr', `\n[Job Recovery Fenced] ${deps.summarizeError(error)}\n`);
        deps.safelyReconcileTerminalDurableExecution(failed);
        if (staleActive) deps.finalizeSingleFlight(staleActive.entry);
        summary.interrupted += 1;
      }
      continue;
    }

    const staleActive = deps.releaseStaleActiveLease(job);
    if (getBuiltinToolJobRecoveryPolicy(job.toolName) === 'retryable') {
      const requeued = requeueJobForRecovery(job.jobId, nowMs);
      if (!requeued) continue;
      appendJobLog(job.jobId, 'stderr', '\n[Job Recovery] Previous worker lease expired; retrying retry-safe durable job.\n');
      summary.retryable += 1;
      if (state) queuedRecoveredWork = deps.enqueueRecoveredJob(state, requeued) || queuedRecoveredWork;
      continue;
    }

    const interrupted = transitionJobStatus(job.jobId, ['running'], {
      status: 'failed',
      failureSummary: 'Worker lease expired before this job completed; automatic retry is unsafe.',
      recoveryClassification: 'interrupted',
    }, {
      workerId: job.leaseOwner,
      leaseGeneration: job.leaseGeneration,
      nowMs,
    });
    if (interrupted) {
      appendJobLog(job.jobId, 'stderr', '\n[Job Interrupted] Worker lease expired; this job is not safe to retry automatically.\n');
      deps.releaseTerminalVerificationCandidate(interrupted);
      deps.safelyReconcileTerminalDurableExecution(interrupted);
      if (staleActive) deps.finalizeSingleFlight(staleActive.entry);
      summary.interrupted += 1;
    }
  }

  if (queuedRecoveredWork) deps.scheduleProcessQueue();
  return summary;
}
