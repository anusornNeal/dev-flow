import type { AppState } from '../types';
import { editFilesBatch } from './fileEditBatchService';
import { applyPreparedEditPlan } from './preparedEditService';
import { getGitDiff } from './gitService';
import {
  bindProjectCommandVerificationCandidate,
  describeProjectCommand,
  describeProjectCommandResourceProfile,
  getProjectCommandExecutionIdentity,
  runProjectCommand,
  runProjectCommandAsync,
  type RunProjectCommandResult,
} from './projectCommandService';
import { planVerification } from './verificationPlannerService';
import { resolveProjectRoot } from './localFileService';
import { createVerificationCandidate, releaseVerificationCandidate } from './verificationCandidateService';

function projectScopeArgs(args: Record<string, any>) {
  return {
    projectId: args.projectId,
    projectName: args.projectName,
    repo: args.repo,
    repoUrl: args.repoUrl,
    localPath: args.localPath,
    sessionId: args.sessionId,
    workspaceId: args.workspaceId,
  };
}

function changedPaths(edit: any) {
  return (edit?.files || [])
    .filter((file: any) => file?.changed === true)
    .map((file: any) => String(file.filePath || ''))
    .filter(Boolean);
}

function buildVerificationPlan(state: AppState, args: Record<string, any>, files: string[]) {
  const requestedCommands = Array.isArray(args.requestedCommands) ? args.requestedCommands : [];
  const resolvedCommands = requestedCommands.map((command: string) => describeProjectCommand(state, {
    ...projectScopeArgs(args),
    command,
  }));
  return planVerification({
    changedFiles: files.length > 0 ? files : (Array.isArray(args.changedFiles) ? args.changedFiles : []),
    requestedLane: args.lane,
    requestedCommands,
    resolvedCommands,
    resourceIsolatedCommands: Array.isArray(args.resourceIsolatedCommands) ? args.resourceIsolatedCommands : [],
  });
}

function summarizeVerificationPerformance(startedAt: number, verification: RunProjectCommandResult[]) {
  return {
    wallMs: Date.now() - startedAt,
    summedExecutionMs: verification.reduce((sum, entry) => sum + Number(entry.performance?.executionMs ?? entry.durationMs ?? 0), 0),
    processSpawns: verification.reduce((sum, entry) => sum + Number(entry.processSpawns || 0), 0),
    cacheHits: verification.filter((entry) => entry.cache?.hit === true).length,
  };
}

export function applyAndVerify(state: AppState, args: Record<string, any>) {
  const edit = typeof args.editPlanId === 'string' && args.editPlanId.trim()
    ? applyPreparedEditPlan({ editPlanId: args.editPlanId })
    : editFilesBatch(state, { ...args, mode: 'apply', files: args.files });

  if (!edit.ok) {
    return {
      ok: false,
      status: 'edit_failed' as const,
      edit,
      diff: null,
      verification: [] as RunProjectCommandResult[],
    };
  }

  const files = changedPaths(edit);
  const plan = buildVerificationPlan(state, args, files);

  const noChanges = edit.changed !== true;
  if (noChanges && args.forceVerification !== true) {
    return {
      ok: true,
      status: 'no_changes' as const,
      noChanges: true,
      edit,
      plan,
      diff: { diff: '', filesChanged: 0 },
      verification: [] as RunProjectCommandResult[],
    };
  }

  let diff: any;
  try {
    diff = getGitDiff(state, {
      ...projectScopeArgs(args),
      ...(typeof args.diffPath === 'string' && args.diffPath.trim() ? { path: args.diffPath.trim() } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      status: 'diff_failed' as const,
      edit,
      plan,
      diff: null,
      verification: [] as RunProjectCommandResult[],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const verification: RunProjectCommandResult[] = [];
  for (const step of plan.steps) {
    const result = runProjectCommand(state, {
      ...projectScopeArgs(args),
      command: step.command,
      cacheResult: args.cacheVerificationResults !== false,
      forceFresh: args.forceFresh === true,
      maxOutputBytes: args.maxOutputBytes,
      timeoutMs: args.timeoutMs,
    });
    verification.push(result);
    if (!result.ok) {
      return {
        ok: false,
        status: result.timedOut ? 'verification_timed_out' as const : 'verification_failed' as const,
        edit,
        plan,
        diff,
        verification,
      };
    }
  }

  return {
    ok: true,
    status: 'succeeded' as const,
    noChanges,
    edit,
    plan,
    diff,
    verification,
  };
}

type VerificationLogger = { stdout: (data: string) => void; stderr: (data: string) => void };
type VerificationPermitDemand = {
  verificationClass?: 'fast' | 'heavy';
  sharedResources?: string[];
  resourceDemand?: {
    profileKey: string;
    confidence: 'none' | 'low' | 'medium' | 'high';
    sampleCount: number;
    cpuRatio: number;
    memoryBytes: number;
    durationMs: number;
    processCount: number;
  };
};
type VerificationExecutionLease = {
  runWithPermit: <T>(request: VerificationPermitDemand, run: () => Promise<T>) => Promise<T>;
  dispose: () => void;
};

const silentVerificationLogger: VerificationLogger = {
  stdout: () => {},
  stderr: () => {},
};

const unrestrictedVerificationExecutionLease: VerificationExecutionLease = {
  runWithPermit: async (_request, run) => run(),
  dispose: () => {},
};

export async function applyAndVerifyAsync(
  state: AppState,
  args: Record<string, any>,
  logger: VerificationLogger = silentVerificationLogger,
  setCancelFn: (fn: () => void) => void = () => {},
  transitionAccess: (
    accessMode: 'verify',
    request?: VerificationPermitDemand,
  ) => void | VerificationExecutionLease | Promise<void | VerificationExecutionLease> = () => unrestrictedVerificationExecutionLease,
) {
  const edit = typeof args.editPlanId === 'string' && args.editPlanId.trim()
    ? applyPreparedEditPlan({ editPlanId: args.editPlanId })
    : editFilesBatch(state, { ...args, mode: 'apply', files: args.files });

  if (!edit.ok) {
    return { ok: false, status: 'edit_failed' as const, edit, diff: null, verification: [] as RunProjectCommandResult[], parallelVerification: false };
  }

  const files = changedPaths(edit);
  const plan = buildVerificationPlan(state, args, files);
  const noChanges = edit.changed !== true;
  if (noChanges && args.forceVerification !== true) {
    return {
      ok: true,
      status: 'no_changes' as const,
      noChanges: true,
      edit,
      plan,
      diff: { diff: '', filesChanged: 0 },
      verification: [] as RunProjectCommandResult[],
      parallelVerification: false,
    };
  }

  let diff: any;
  try {
    diff = getGitDiff(state, {
      ...projectScopeArgs(args),
      responseMode: args.responseMode ?? 'compact',
      ...(typeof args.diffPath === 'string' && args.diffPath.trim() ? { path: args.diffPath.trim() } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      status: 'diff_failed' as const,
      edit,
      plan,
      diff: null,
      verification: [] as RunProjectCommandResult[],
      parallelVerification: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const candidatePreparationStartedAt = Date.now();
  const sourceRoot = resolveProjectRoot(state, args);
  const baseCandidate = plan.steps.length > 0 ? createVerificationCandidate(sourceRoot) : null;
  const candidatePreparationMs = Date.now() - candidatePreparationStartedAt;
  const verification: RunProjectCommandResult[] = [];
  const verificationStartedAt = Date.now();
  const verificationPerformance = () => ({
    ...summarizeVerificationPerformance(verificationStartedAt, verification),
    candidatePreparationMs,
  });
  const activeCancels = new Set<() => void>();
  setCancelFn(() => {
    for (const cancel of activeCancels) cancel();
  });

  const commandArgs = (command: string) => ({
    projectId: args.projectId,
    projectName: args.projectName,
    repo: args.repo,
    repoUrl: args.repoUrl,
    localPath: args.localPath,
    command,
    cacheResult: args.cacheVerificationResults !== false,
    forceFresh: args.forceFresh === true,
    maxOutputBytes: args.maxOutputBytes,
    timeoutMs: args.timeoutMs,
    responseMode: args.responseMode ?? 'compact',
  });

  const permitDemandForStep = (step: (typeof plan.steps)[number]): VerificationPermitDemand => {
    const profile = describeProjectCommandResourceProfile(state, commandArgs(step.command));
    const prediction = profile.prediction;
    const admissionVector = prediction.confidence === 'high' ? prediction.expected : prediction.upperBound;
    return {
      verificationClass: step.verificationClass,
      sharedResources: step.sharedResources?.length
        ? step.sharedResources
        : step.resourceKey
          ? [step.resourceKey]
          : [],
      resourceDemand: {
        profileKey: prediction.profileKey,
        confidence: prediction.confidence,
        sampleCount: prediction.sampleCount,
        cpuRatio: admissionVector.cpuRatio,
        memoryBytes: admissionVector.memoryBytes,
        durationMs: prediction.expected.durationMs,
        processCount: admissionVector.processCount,
      },
    };
  };
  let verificationExecutionLease = unrestrictedVerificationExecutionLease;

  const runStep = async (step: (typeof plan.steps)[number]) => {
    const stepArgs = commandArgs(step.command);
    const boundCandidate = baseCandidate
      ? bindProjectCommandVerificationCandidate(state, stepArgs, baseCandidate)
      : null;
    return verificationExecutionLease.runWithPermit(permitDemandForStep(step), async () => {
      let cancelFn: (() => void) | undefined;
      try {
        return await runProjectCommandAsync(state, {
          ...stepArgs,
          ...(boundCandidate ? { __verificationCandidate: boundCandidate } : {}),
        }, logger, (fn) => {
          cancelFn = fn;
          activeCancels.add(fn);
        });
      } finally {
        if (cancelFn) activeCancels.delete(cancelFn);
      }
    });
  };

  let parallelVerification = false;
  try {
    if (plan.steps.length > 0) {
      const transitionedLease = await transitionAccess('verify', permitDemandForStep(plan.steps[0]));
      if (transitionedLease) verificationExecutionLease = transitionedLease;
    }

    const stageIds = Array.from(new Set(plan.steps.map((step) => Number.isFinite(step.stage) ? Number(step.stage) : 0))).sort((a, b) => a - b);

    for (const stageId of stageIds) {
      const stageSteps = plan.steps.filter((step) => (Number.isFinite(step.stage) ? Number(step.stage) : 0) === stageId);
      const inferredResourceKeys = stageSteps
        .filter((step) => step.parallelGroup !== 'isolated')
        .map((step) => step.resourceKey)
        .filter((value): value is string => Boolean(value));
      const resourceSafe = stageSteps.every((step) => step.parallelGroup === 'isolated' || Boolean(step.resourceKey && step.resourceKey !== 'repo'));
      const inferredResourcesDistinct = new Set(inferredResourceKeys).size === inferredResourceKeys.length;
      const canParallelizeStage = stageSteps.length > 1 && resourceSafe && inferredResourcesDistinct;

      if (canParallelizeStage) {
        parallelVerification = true;
        for (let offset = 0; offset < stageSteps.length; offset += 4) {
          const batch = stageSteps.slice(offset, offset + 4);
          const results = await Promise.all(batch.map(runStep));
          verification.push(...results);
          const failed = results.find((result) => !result.ok);
          if (failed) {
            return {
              ok: false,
              status: failed.timedOut ? 'verification_timed_out' as const : 'verification_failed' as const,
              edit,
              plan,
              diff,
              verification,
              parallelVerification,
              verificationPerformance: verificationPerformance(),
            };
          }
        }
        continue;
      }

      for (const step of stageSteps) {
        const result = await runStep(step);
        verification.push(result);
        if (!result.ok) {
          return {
            ok: false,
            status: result.timedOut ? 'verification_timed_out' as const : 'verification_failed' as const,
            edit,
            plan,
            diff,
            verification,
            parallelVerification,
            verificationPerformance: verificationPerformance(),
          };
        }
      }
    }

    const staleVerificationCommands = Array.from(new Set(verification.flatMap((result) => {
      const verifiedCandidate = result.verificationCandidate;
      if (!verifiedCandidate) return [];
      const currentIdentity = getProjectCommandExecutionIdentity(state, commandArgs(result.command));
      return currentIdentity?.key === verifiedCandidate.executionKey ? [] : [result.command];
    })));
    if (staleVerificationCommands.length > 0) {
      return {
        ok: false,
        status: 'verification_stale' as const,
        noChanges,
        edit,
        plan,
        diff,
        verification,
        staleVerificationCommands,
        parallelVerification,
        verificationPerformance: verificationPerformance(),
      };
    }

    return {
      ok: true,
      status: 'succeeded' as const,
      noChanges,
      edit,
      plan,
      diff,
      verification,
      parallelVerification,
      verificationPerformance: verificationPerformance(),
    };
  } finally {
    verificationExecutionLease.dispose();
    if (baseCandidate) releaseVerificationCandidate(baseCandidate.candidateId);
  }
}
