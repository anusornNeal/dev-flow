import { createHash } from 'node:crypto';
import type { AppState } from '../types';
import { editFilesBatch } from './fileEditBatchService';
import { applyPreparedEditPlan } from './preparedEditService';
import { getChangedGitFilesForRoot, getGitDiff } from './gitService';
import {
  attachInfrastructureRecoveryAudit,
  bindProjectCommandVerificationCandidate,
  buildProjectCommandInfrastructureRecovery,
  describeProjectCommandForPlanning,
  describeProjectCommandResourceProfile,
  isVerificationInfrastructureFailure,
  runProjectCommand,
  runProjectCommandAsync,
  type RunProjectCommandResult,
} from './projectCommandService';
import { planVerification } from './verificationPlannerService';
import { resolveProjectRoot } from './localFileService';
import { createVerificationCandidate, releaseVerificationCandidate } from './verificationCandidateService';
import { loadProjectVerificationImpactRules } from './projectCommandConfigService';
import { createVerificationBatch, type VerificationBatchSnapshot } from './verificationBatchService';

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

function completeCandidatePaths(state: AppState, args: Record<string, any>, edit: any) {
  const root = resolveProjectRoot(state, args);
  const editFiles = changedPaths(edit);
  const workingFiles = getChangedGitFilesForRoot(root).map((file) => file.path);
  const suppliedFiles = Array.isArray(args.changedFiles)
    ? args.changedFiles.map((file: unknown) => String(file || '')).filter(Boolean)
    : [];
  return Array.from(new Set([...workingFiles, ...editFiles, ...suppliedFiles].map((file) => file.replace(/\\/g, '/'))));
}

function buildVerificationPlan(state: AppState, args: Record<string, any>, files: string[]) {
  const requestedCommands = Array.isArray(args.requestedCommands) ? args.requestedCommands : [];
  const impactRules = loadProjectVerificationImpactRules(resolveProjectRoot(state, args));
  const resolvedCommands = requestedCommands.map((command: string) => describeProjectCommandForPlanning(state, {
    ...projectScopeArgs(args),
    command,
  }));
  return planVerification({
    changedFiles: files.length > 0 ? files : (Array.isArray(args.changedFiles) ? args.changedFiles : []),
    requestedLane: args.lane,
    requestedCommands,
    resolvedCommands,
    resourceIsolatedCommands: Array.isArray(args.resourceIsolatedCommands) ? args.resourceIsolatedCommands : [],
    impactRules,
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
    ? applyPreparedEditPlan(
      { editPlanId: args.editPlanId },
      {
        authorizeOwnedChanges: typeof args.__authorizeOwnedChanges === 'function' ? args.__authorizeOwnedChanges : undefined,
        recordOwnedChanges: typeof args.__recordOwnedChanges === 'function' ? args.__recordOwnedChanges : undefined,
      },
    )
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

  const files = completeCandidatePaths(state, args, edit);
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
  if (plan.steps.length === 0 && args.noChecksRequired !== true) {
    return {
      ok: false,
      status: 'verification_incomplete' as const,
      noChanges,
      edit,
      plan,
      diff,
      verification,
      verificationPolicy: 'checks-required' as const,
    };
  }
  for (const step of plan.steps) {
    const result = runProjectCommand(state, {
      ...projectScopeArgs(args),
      command: step.command,
      ...(step.targets?.length ? { targets: [...step.targets] } : {}),
      ...(args.cacheVerificationResults === false ? { cacheResult: false } : {}),
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
    verificationPolicy: plan.steps.length === 0 ? 'no-checks-required' as const : 'checks-passed' as const,
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
    ? applyPreparedEditPlan(
      { editPlanId: args.editPlanId },
      {
        authorizeOwnedChanges: typeof args.__authorizeOwnedChanges === 'function' ? args.__authorizeOwnedChanges : undefined,
        recordOwnedChanges: typeof args.__recordOwnedChanges === 'function' ? args.__recordOwnedChanges : undefined,
      },
    )
    : editFilesBatch(state, { ...args, mode: 'apply', files: args.files });

  if (!edit.ok) {
    return { ok: false, status: 'edit_failed' as const, edit, diff: null, verification: [] as RunProjectCommandResult[], parallelVerification: false };
  }

  const files = completeCandidatePaths(state, args, edit);
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

  if (typeof args.__captureVerificationProvenance === 'function') {
    args.__captureVerificationProvenance();
  }
  if (plan.steps.length === 0) {
    if (args.noChecksRequired !== true) {
      return {
        ok: false,
        status: 'verification_incomplete' as const,
        noChanges,
        edit,
        plan,
        diff,
        verification: [] as RunProjectCommandResult[],
        verificationPolicy: 'checks-required' as const,
        parallelVerification: false,
      };
    }
    return {
      ok: true,
      status: 'succeeded' as const,
      noChanges,
      edit,
      plan,
      diff,
      verification: [] as RunProjectCommandResult[],
      verificationPolicy: 'no-checks-required' as const,
      parallelVerification: false,
      verificationPerformance: { wallMs: 0, summedExecutionMs: 0, processSpawns: 0, cacheHits: 0, candidatePreparationMs: 0 },
    };
  }
  const candidatePreparationStartedAt = Date.now();
  const sourceRoot = resolveProjectRoot(state, args);
  const baseCandidate = plan.steps.length > 0 ? createVerificationCandidate(sourceRoot) : null;
  const candidatePreparationMs = Date.now() - candidatePreparationStartedAt;
  const verification: RunProjectCommandResult[] = [];
  const batchCandidate = baseCandidate ? Object.freeze({
    candidateId: baseCandidate.candidateId,
    repoRevision: baseCandidate.repoRevision,
    executionKey: createHash('sha256').update(JSON.stringify({
      candidateId: baseCandidate.candidateId,
      repoRevision: baseCandidate.repoRevision,
      snapshotCommit: baseCandidate.snapshotCommit,
      requiredChecks: plan.steps.map((step) => step.checkId),
    })).digest('hex'),
  }) : null;
  const verificationBatch = batchCandidate
    ? createVerificationBatch(batchCandidate, plan.steps.map((step) => step.checkId))
    : null;
  const completedVerification: Array<{ step: (typeof plan.steps)[number]; result: RunProjectCommandResult }> = [];
  const expectedExecutionKeys = new Map<string, string>();
  const verificationStartedAt = Date.now();
  const verificationPerformance = () => ({
    ...summarizeVerificationPerformance(verificationStartedAt, verification),
    candidatePreparationMs,
  });
  const activeCancels = new Set<() => void>();
  setCancelFn(() => {
    for (const cancel of activeCancels) cancel();
  });

  const commandArgs = (command: string, targets?: string[]) => ({
    projectId: args.projectId,
    projectName: args.projectName,
    repo: args.repo,
    repoUrl: args.repoUrl,
    localPath: args.localPath,
    command,
    ...(targets?.length ? { targets: [...targets] } : {}),
    ...(args.cacheVerificationResults === false ? { cacheResult: false } : {}),
    forceFresh: args.forceFresh === true,
    maxOutputBytes: args.maxOutputBytes,
    timeoutMs: args.timeoutMs,
    responseMode: args.responseMode ?? 'compact',
    infrastructureRetryPolicy: args.infrastructureRetryPolicy ?? 'resource-safe-once',
  });

  const buildVerificationBatchSnapshot = (): VerificationBatchSnapshot | undefined => {
    if (!verificationBatch || !batchCandidate) return undefined;
    for (const { step, result } of completedVerification) {
      const verifiedCandidate = result.verificationCandidate;
      const expectedExecutionKey = expectedExecutionKeys.get(step.checkId);
      const candidateCurrent = Boolean(
        verifiedCandidate
        && verifiedCandidate.candidateId === batchCandidate.candidateId
        && verifiedCandidate.repoRevision === batchCandidate.repoRevision
        && verifiedCandidate.current !== false
        && expectedExecutionKey
        && verifiedCandidate.executionKey === expectedExecutionKey
      );
      verificationBatch.recordResult({
        checkId: step.checkId,
        status: candidateCurrent ? (result.ok ? 'passed' : 'failed') : 'stale',
        candidate: batchCandidate,
      });
    }
    return verificationBatch.snapshot();
  };

  const staleCommandsForBatch = (snapshot: VerificationBatchSnapshot | undefined) => {
    if (!snapshot || snapshot.stale.length === 0) return [] as string[];
    const stale = new Set(snapshot.stale);
    return Array.from(new Set(completedVerification.flatMap(({ step }) => stale.has(step.checkId) ? [step.command] : [])));
  };

  const permitDemandForStep = (step: (typeof plan.steps)[number], recovery = false): VerificationPermitDemand => {
    const profile = describeProjectCommandResourceProfile(state, commandArgs(step.command, step.targets));
    const prediction = profile.prediction;
    const admissionVector = prediction.confidence === 'high' ? prediction.expected : prediction.upperBound;
    const baseResources = step.sharedResources?.length
      ? step.sharedResources
      : step.resourceKey
        ? [step.resourceKey]
        : [];
    return {
      verificationClass: step.verificationClass,
      sharedResources: recovery ? Array.from(new Set([...baseResources, 'verification-recovery'])) : baseResources,
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
    const stepArgs = commandArgs(step.command, step.targets);
    const runAttempt = async (attemptArgs: Record<string, any>, recovery = false) => {
      const boundCandidate = baseCandidate
        ? bindProjectCommandVerificationCandidate(state, attemptArgs, baseCandidate)
        : null;
      if (boundCandidate) expectedExecutionKeys.set(step.checkId, boundCandidate.executionIdentity.key);
      return verificationExecutionLease.runWithPermit(permitDemandForStep(step, recovery), async () => {
        let cancelFn: (() => void) | undefined;
        try {
          return await runProjectCommandAsync(state, {
            ...attemptArgs,
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

    const first = await runAttempt(stepArgs, false);
    if (!first.ok && isVerificationInfrastructureFailure(first)) {
      const recovery = buildProjectCommandInfrastructureRecovery(state, stepArgs);
      if (recovery) {
        const retried = await runAttempt(recovery.args, true);
        return attachInfrastructureRecoveryAudit(first, retried, recovery.profile);
      }
    }
    return first;
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
      const claimedResources = stageSteps.flatMap((step) => {
        if (step.parallelGroup === 'isolated') return [] as string[];
        if (step.sharedResources?.length) return step.sharedResources;
        if (step.resourceKey) return [step.resourceKey];
        return ['repo'];
      });
      const resourceSafe = stageSteps.every((step) => {
        if (step.parallelGroup === 'isolated') return true;
        const resources = step.sharedResources?.length ? step.sharedResources : step.resourceKey ? [step.resourceKey] : ['repo'];
        return resources.length > 0 && !resources.includes('repo');
      });
      const resourcesDistinct = new Set(claimedResources).size === claimedResources.length;
      const canParallelizeStage = stageSteps.length > 1 && resourceSafe && resourcesDistinct;

      if (canParallelizeStage) {
        parallelVerification = true;
        const results = await Promise.all(stageSteps.map(runStep));
        verification.push(...results);
        completedVerification.push(...results.map((result, index) => ({ step: stageSteps[index], result })));
        const failed = results.find((result) => !result.ok);
        if (failed) {
          const verificationBatchSnapshot = buildVerificationBatchSnapshot();
          const staleVerificationCommands = staleCommandsForBatch(verificationBatchSnapshot);
          return {
            ok: false,
            status: staleVerificationCommands.length > 0
              ? 'verification_stale' as const
              : failed.timedOut
                ? 'verification_timed_out' as const
                : 'verification_failed' as const,
            edit,
            plan,
            diff,
            verification,
            verificationBatch: verificationBatchSnapshot,
            staleVerificationCommands,
            failingVerificationChecks: verificationBatchSnapshot
              ? [...verificationBatchSnapshot.failed, ...verificationBatchSnapshot.stale]
              : [],
            parallelVerification,
            verificationPerformance: verificationPerformance(),
          };
        }
        continue;
      }

      for (const step of stageSteps) {
        const result = await runStep(step);
        verification.push(result);
        completedVerification.push({ step, result });
        if (!result.ok) {
          const verificationBatchSnapshot = buildVerificationBatchSnapshot();
          const staleVerificationCommands = staleCommandsForBatch(verificationBatchSnapshot);
          return {
            ok: false,
            status: staleVerificationCommands.length > 0
              ? 'verification_stale' as const
              : result.timedOut
                ? 'verification_timed_out' as const
                : 'verification_failed' as const,
            edit,
            plan,
            diff,
            verification,
            verificationBatch: verificationBatchSnapshot,
            staleVerificationCommands,
            failingVerificationChecks: verificationBatchSnapshot
              ? [...verificationBatchSnapshot.failed, ...verificationBatchSnapshot.stale]
              : [],
            parallelVerification,
            verificationPerformance: verificationPerformance(),
          };
        }
      }
    }

    const verificationBatchSnapshot = buildVerificationBatchSnapshot();
    const staleVerificationCommands = staleCommandsForBatch(verificationBatchSnapshot);
    if (!verificationBatchSnapshot?.canComplete) {
      return {
        ok: false,
        status: staleVerificationCommands.length > 0 ? 'verification_stale' as const : 'verification_incomplete' as const,
        noChanges,
        edit,
        plan,
        diff,
        verification,
        verificationBatch: verificationBatchSnapshot,
        staleVerificationCommands,
        failingVerificationChecks: verificationBatchSnapshot
          ? [...verificationBatchSnapshot.failed, ...verificationBatchSnapshot.stale, ...verificationBatchSnapshot.pending]
          : [],
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
      verificationBatch: verificationBatchSnapshot,
      staleVerificationCommands: [] as string[],
      failingVerificationChecks: [] as string[],
      parallelVerification,
      verificationPerformance: verificationPerformance(),
      verificationPolicy: 'checks-passed' as const,
    };
  } finally {
    verificationExecutionLease.dispose();
    if (baseCandidate) releaseVerificationCandidate(baseCandidate.candidateId);
  }
}
