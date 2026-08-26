import type { AppState } from '../types';
import { getProjects } from '../repositories/projectRepository';
import { applyAndVerifyAsync } from './applyAndVerifyService';
import { editFilesBatch } from './fileEditBatchService';
import { commitGitChanges, ensureGitBranch, pushGitBranch } from './gitService';
import { commitTaskOwnedChanges } from './taskCommitPlanService.js';
import { runTaskWorkspaceHappyPathTail } from './taskWorkspaceFinalizationService.js';
import { applyLocalPatchAsync } from './localPatchService';
import { searchLocalFilesAsync } from './localFileService';
import { executeRepoQueryPlan } from './repoQueryPlanService';
import { deleteLocalPath, moveLocalPath } from './localPathMutationService';
import { applyPreparedEditPlan, getPreparedEditRecoveryArgs, prepareEditPlan } from './preparedEditService';
import { applyProjectAtlasAgentUpdate } from './projectAtlasService';
import {
  attachInfrastructureRecoveryAudit,
  bindProjectCommandVerificationCandidate,
  buildProjectCommandInfrastructureRecovery,
  describeProjectCommandResourceProfile,
  isVerificationInfrastructureFailure,
  runProjectCommandAsync,
} from './projectCommandService';
import { prepareCompactEdit } from './stenoEditProtocolService';
import { buildVerificationCoverageIdentity } from './verificationBatchService.js';
import { classifyAndRememberVerificationBlocker, findReusableVerificationBlocker } from './verificationBlockerEvidenceService.js';
import type { ResourceAccessMode } from './mcpToolJobScheduler';
import { executeRecoveryAwareTool } from './devFlowRecoveryRuntime.js';
import {
  assertHarnessExecutionAllowed,
  isHarnessLifecycleAffectingTool,
  recordHarnessExecutionOutcome,
  type HarnessExecutionGuardDecision,
} from './harnessExecutionGuardService.js';
import {
  authorizeTaskExecutionMutationPaths,
  captureExecutionVerificationProvenance,
  getTaskExecutionMutationBinding,
  getExecutionOwnershipState,
  recordTaskExecutionMutationPaths,
  recordTaskExecutionVerificationResult,
} from './executionSessionService.js';

type Logger = { stdout: (data: string) => void; stderr: (data: string) => void };
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

export interface BuiltinToolJobInput {
  toolName: string;
  state: AppState;
  args: any;
}

export interface BuiltinToolJobContext {
  logger: Logger;
  setCancelFn: (fn: () => void) => void;
  transitionAccess: (
    accessMode: ResourceAccessMode,
    request?: VerificationPermitDemand,
  ) => void | VerificationExecutionLease | Promise<void | VerificationExecutionLease>;
}

export type BuiltinToolJobRecoveryPolicy = 'retryable' | 'interrupted';

const BUILTIN_TOOL_RUNNER_NAMES = [
  'run_project_command',
  'apply_patch',
  'search_local_files',
  'execute_repo_query_plan',
  'ensure_git_branch',
  'push_git_branch',
  'commit_git_changes',
  'commit_task_owned_changes',
  'edit_local_files_batch',
  'prepare_edit_plan',
  'apply_prepared_edit_plan',
  'prepare_compact_edit',
  'apply_prepared_edit',
  'apply_and_verify',
  'delete_local_path',
  'move_local_path',
  'apply_project_atlas_agent_update',
  'continue_task_execution_tail',
] as const;

const RETRYABLE_AFTER_RESTART = new Set<string>([
  'search_local_files',
  'execute_repo_query_plan',
]);

RETRYABLE_AFTER_RESTART.add('continue_task_execution_tail');

export function getBuiltinToolRunnerNames() {
  return [...BUILTIN_TOOL_RUNNER_NAMES];
}

export function getBuiltinToolJobRecoveryPolicy(toolName: string): BuiltinToolJobRecoveryPolicy {
  return RETRYABLE_AFTER_RESTART.has(toolName) ? 'retryable' : 'interrupted';
}

function authorizeTaskOwnedPaths(args: any, paths: string[]) {
  return authorizeTaskExecutionMutationPaths(args, paths);
}

function recordTaskOwnedPaths(args: any, paths: string[], source: string) {
  return recordTaskExecutionMutationPaths(args, paths, source);
}

function captureTaskVerification(args: any) {
  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) return null;
  return captureExecutionVerificationProvenance(binding.session.id, { repoRoot: binding.workspace.root });
}

type TaskVerificationBindingDiagnostic = {
  attempted: boolean;
  recorderAccepted: boolean;
  authoritative: boolean;
  verificationFresh: boolean | null;
  reasonCode: string;
  recoveryRequired: boolean;
  message?: string;
  errorCode?: string;
};

function bindTaskVerificationOutcome(
  args: any,
  result: any,
  captured: ReturnType<typeof captureTaskVerification>,
) {
  if (!result?.ok || result?.status !== 'succeeded') {
    recordTaskExecutionVerificationResult(args, result, captured);
    return { result, harnessResult: result };
  }

  const binding = getTaskExecutionMutationBinding(args);
  if (!binding) {
    return { result, harnessResult: result };
  }

  let recorded: ReturnType<typeof recordTaskExecutionVerificationResult> = null;
  let rejection: any = null;
  try {
    recorded = recordTaskExecutionVerificationResult(args, result, captured);
  } catch (error: any) {
    rejection = error;
  }

  const ownership = getExecutionOwnershipState(binding.session.id, { repoRoot: binding.workspace.root });
  const authoritative = ownership.verificationFresh === true;
  const recorderAuthoritative = typeof recorded?.authoritative === 'boolean' ? recorded.authoritative : undefined;
  const recorderReasonCode = typeof recorded?.reasonCode === 'string' ? recorded.reasonCode.trim() : '';
  const recorderMessage = typeof recorded?.message === 'string' ? recorded.message : '';
  const recorderErrorCode = typeof recorded?.errorCode === 'string' ? recorded.errorCode.trim() : '';
  const rejectionCode = String(rejection?.code || rejection?.payload?.code || '').trim();
  const batchIncomplete = recorderReasonCode === 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE';
  const diagnostic: TaskVerificationBindingDiagnostic = {
    attempted: true,
    recorderAccepted: recorderAuthoritative !== undefined ? recorderAuthoritative || batchIncomplete : Boolean(recorded),
    authoritative,
    verificationFresh: ownership.verificationFresh,
    reasonCode: authoritative
      ? recorderReasonCode || 'EXECUTION_VERIFICATION_BOUND'
      : rejectionCode
        || (recorderAuthoritative === false ? recorderReasonCode : '')
        || (recorded ? 'EXECUTION_VERIFICATION_NOT_FRESH' : 'EXECUTION_VERIFICATION_BINDING_MISSING'),
    recoveryRequired: !authoritative && !batchIncomplete,
    ...(recorderMessage ? { message: recorderMessage } : rejection instanceof Error && rejection.message ? { message: rejection.message } : {}),
    ...(recorderErrorCode ? { errorCode: recorderErrorCode } : {}),
  };
  const surfacedResult = { ...result, verificationBinding: diagnostic };

  return {
    result: surfacedResult,
    harnessResult: authoritative || batchIncomplete
      ? surfacedResult
      : { ...surfacedResult, ok: false, status: 'needs-recovery' },
  };
}

export function resolveBuiltinToolJobBindingArgs(toolNameValue: string, args: any) {
  const toolName = String(toolNameValue || '').trim();
  if (toolName !== 'apply_prepared_edit' && toolName !== 'apply_prepared_edit_plan') return args;
  const durableSourceArgs = args?.__preparedEditSourceArgs;
  const sourceArgs = durableSourceArgs && typeof durableSourceArgs === 'object' && !Array.isArray(durableSourceArgs)
    ? durableSourceArgs
    : getPreparedEditRecoveryArgs(String(args?.editPlanId || '')) || args;
  if (sourceArgs === args) return args;
  return {
    ...sourceArgs,
    ...(args?.__executionJobBinding ? { __executionJobBinding: args.__executionJobBinding } : {}),
  };
}

function recoveryPermitDemand(state: AppState, args: Record<string, any>): VerificationPermitDemand {
  const profile = describeProjectCommandResourceProfile(state, args);
  const prediction = profile.prediction;
  const vector = prediction.confidence === 'high' ? prediction.expected : prediction.upperBound;
  return {
    verificationClass: profile.descriptor.verificationClass,
    sharedResources: Array.from(new Set([...profile.descriptor.sharedResources, 'verification-recovery'])),
    resourceDemand: {
      profileKey: prediction.profileKey,
      confidence: prediction.confidence,
      sampleCount: prediction.sampleCount,
      cpuRatio: vector.cpuRatio,
      memoryBytes: vector.memoryBytes,
      durationMs: prediction.expected.durationMs,
      processCount: vector.processCount,
    },
  };
}

export async function runBuiltinToolJob(input: BuiltinToolJobInput, context: BuiltinToolJobContext) {
  const { toolName, state, args } = input;
  const { logger, setCancelFn, transitionAccess } = context;
  const preflight = (guardArgs: any = args): HarnessExecutionGuardDecision | null => isHarnessLifecycleAffectingTool(toolName)
    ? assertHarnessExecutionAllowed(state, toolName, guardArgs)
    : null;
  const complete = (decision: HarnessExecutionGuardDecision | null, result: any) => {
    if (decision) recordHarnessExecutionOutcome(decision, result);
    return result;
  };

  if (toolName === 'continue_task_execution_tail') {
    return await runTaskWorkspaceHappyPathTail(
      state,
      {
        taskId: String(args?.taskId || ''),
        workspaceId: String(args?.workspaceId || ''),
        commitMessage: String(args?.commitMessage || ''),
        triggerJobId: String(args?.triggerJobId || '') || undefined,
      },
      async (request) => {
        logger.stdout(`[Autonomous Tail] Running post-integration verification '${request.command}' at ${request.repoRevision.slice(0, 12)}.\n`);
        return await runProjectCommandAsync(state, {
          projectId: request.projectId,
          command: request.command,
          cacheResult: false,
          singleFlight: false,
          infrastructureRetryPolicy: 'resource-safe-once',
          responseMode: 'compact',
        }, logger, setCancelFn);
      },
    );
  }

  if (toolName === 'run_project_command') {
    const guard = preflight();
    const captured = captureTaskVerification(args);
    const taskBinding = getTaskExecutionMutationBinding(args);
    const initialCoverage = buildVerificationCoverageIdentity(args?.__verificationCandidate?.executionIdentity);
    const reusableBlocker = args?.verificationBatch && taskBinding && captured?.ownedPaths
      ? findReusableVerificationBlocker({
          repoRoot: taskBinding.workspace.root,
          coverage: initialCoverage,
          taskOwnedPaths: captured.ownedPaths,
        })
      : null;
    if (reusableBlocker && args?.__verificationCandidate) {
      const candidate = args.__verificationCandidate;
      const skippedResult = {
        ok: false,
        status: 'failed',
        command: String(args.command ?? args.preset ?? ''),
        cwd: taskBinding!.workspace.root,
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        signal: null,
        stdout: '',
        stderr: `Skipped known unrelated verification blocker (${reusableBlocker.evidence.id}).`,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutEmpty: true,
        stderrEmpty: false,
        outputSummary: { hasStdout: false, hasStderr: true, stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false },
        verificationCandidate: {
          candidateId: String(candidate.candidateId),
          repoRevision: String(candidate.repoRevision),
          snapshotCommit: String(candidate.snapshotCommit || ''),
          executionKey: String(candidate.executionIdentity?.key || ''),
          current: true,
        },
        verificationBlocker: {
          reused: true,
          evidenceId: reusableBlocker.evidence.id,
          phase: reusableBlocker.evidence.phase,
          failureSignature: reusableBlocker.evidence.failureSignature,
          blockerPaths: [...reusableBlocker.evidence.blockerPaths],
          blockerSymbols: [...reusableBlocker.evidence.blockerSymbols],
          retention: 'process-local-bounded',
        },
      };
      const bound = bindTaskVerificationOutcome(args, skippedResult, captured);
      if (guard) recordHarnessExecutionOutcome(guard, bound.harnessResult);
      return bound.result;
    }
    let finalArgs = args;
    let result: any = await runProjectCommandAsync(state, args, logger, setCancelFn);
    if (!result.ok && isVerificationInfrastructureFailure(result)) {
      const recovery = buildProjectCommandInfrastructureRecovery(state, args);
      if (recovery) {
        const recoveryCandidate = args.__verificationCandidate
          ? bindProjectCommandVerificationCandidate(state, recovery.args, args.__verificationCandidate)
          : null;
        finalArgs = {
          ...recovery.args,
          ...(recoveryCandidate ? { __verificationCandidate: recoveryCandidate } : {}),
        };
        const demand = recoveryPermitDemand(state, finalArgs);
        const lease = await transitionAccess('verify', demand);
        try {
          const retried = lease
            ? await lease.runWithPermit(demand, () => runProjectCommandAsync(state, finalArgs, logger, setCancelFn))
            : await runProjectCommandAsync(state, finalArgs, logger, setCancelFn);
          result = attachInfrastructureRecoveryAudit(result, retried, recovery.profile);
        } finally {
          if (lease) lease.dispose();
        }
      }
    }
    if (!result.ok && !isVerificationInfrastructureFailure(result) && taskBinding && captured?.ownedPaths) {
      const coverage = buildVerificationCoverageIdentity(finalArgs?.__verificationCandidate?.executionIdentity);
      const blocker = classifyAndRememberVerificationBlocker({
        repoRoot: taskBinding.workspace.root,
        coverage,
        taskOwnedPaths: captured.ownedPaths,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (blocker) {
        result = {
          ...result,
          verificationBlocker: {
            recorded: true,
            evidenceId: blocker.id,
            phase: blocker.phase,
            failureSignature: blocker.failureSignature,
            blockerPaths: [...blocker.blockerPaths],
            blockerSymbols: [...blocker.blockerSymbols],
            retention: 'process-local-bounded',
          },
        };
      }
    }
    const bound = bindTaskVerificationOutcome(finalArgs, result, captured);
    if (guard) recordHarnessExecutionOutcome(guard, bound.harnessResult);
    return bound.result;
  }
  if (toolName === 'apply_patch') {
    const guard = preflight();
    const result = await applyLocalPatchAsync(state, {
      ...args,
      __authorizeOwnedChanges: (paths: string[]) => authorizeTaskOwnedPaths(args, paths),
      __recordOwnedChanges: (paths: string[]) => recordTaskOwnedPaths(args, paths, toolName),
    }, logger, setCancelFn);
    return complete(guard, result);
  }
  if (toolName === 'search_local_files') {
    return await executeRecoveryAwareTool(
      state,
      toolName,
      args,
      (payload) => searchLocalFilesAsync(state, payload, logger, setCancelFn),
    );
  }
  if (toolName === 'execute_repo_query_plan') {
    return executeRepoQueryPlan(state, args, logger, setCancelFn);
  }
  if (toolName === 'ensure_git_branch') return ensureGitBranch(state, args);
  if (toolName === 'push_git_branch') return pushGitBranch(state, args);
  if (toolName === 'commit_git_changes') {
    const guard = preflight();
    return complete(guard, commitGitChanges(state, args));
  }
  if (toolName === 'commit_task_owned_changes') {
    const guard = preflight();
    return complete(guard, commitTaskOwnedChanges(state, args));
  }
  if (toolName === 'edit_local_files_batch') {
    const guard = preflight();
    const result = editFilesBatch(state, {
      ...args,
      __authorizeOwnedChanges: (paths: string[]) => authorizeTaskOwnedPaths(args, paths),
      __recordOwnedChanges: (paths: string[]) => recordTaskOwnedPaths(args, paths, toolName),
    });
    return complete(guard, result);
  }
  if (toolName === 'prepare_edit_plan') return prepareEditPlan(state, args);
  if (toolName === 'apply_prepared_edit_plan') {
    const sourceArgs = resolveBuiltinToolJobBindingArgs(toolName, args);
    const guard = preflight(sourceArgs);
    const result = await executeRecoveryAwareTool(
      state,
      toolName,
      args,
      (payload) => applyPreparedEditPlan(payload, {
        authorizeOwnedChanges: (paths) => authorizeTaskOwnedPaths(sourceArgs, paths),
        recordOwnedChanges: (paths) => recordTaskOwnedPaths(sourceArgs, paths, toolName),
      }),
    );
    return complete(guard, result);
  }
  if (toolName === 'prepare_compact_edit') return prepareCompactEdit(state, args);
  if (toolName === 'apply_prepared_edit') {
    const sourceArgs = resolveBuiltinToolJobBindingArgs(toolName, args);
    const guard = preflight(sourceArgs);
    const payload = { editPlanId: args?.editPlanId };
    const result = await executeRecoveryAwareTool(
      state,
      toolName,
      payload,
      (nextPayload) => applyPreparedEditPlan(nextPayload, {
        authorizeOwnedChanges: (paths) => authorizeTaskOwnedPaths(sourceArgs, paths),
        recordOwnedChanges: (paths) => recordTaskOwnedPaths(sourceArgs, paths, toolName),
      }),
    );
    return complete(guard, result);
  }
  if (toolName === 'apply_and_verify') {
    const guard = preflight();
    let captured: ReturnType<typeof captureTaskVerification> = null;
    const result = await applyAndVerifyAsync(state, {
      ...args,
      __authorizeOwnedChanges: (paths: string[]) => authorizeTaskOwnedPaths(args, paths),
      __recordOwnedChanges: (paths: string[]) => recordTaskOwnedPaths(args, paths, toolName),
      __captureVerificationProvenance: () => {
        captured = captureTaskVerification(args);
        return captured;
      },
    }, logger, setCancelFn, transitionAccess);
    recordTaskExecutionVerificationResult(args, result, captured);
    return complete(guard, result);
  }
  if (toolName === 'delete_local_path') {
    const guard = preflight();
    const result = deleteLocalPath(state, {
      ...args,
      __authorizeOwnedChanges: (paths: string[]) => authorizeTaskOwnedPaths(args, paths),
      __recordOwnedChanges: (paths: string[]) => recordTaskOwnedPaths(args, paths, toolName),
    });
    return complete(guard, result);
  }
  if (toolName === 'move_local_path') {
    const guard = preflight();
    const result = moveLocalPath(state, {
      ...args,
      __authorizeOwnedChanges: (paths: string[]) => authorizeTaskOwnedPaths(args, paths),
      __recordOwnedChanges: (paths: string[]) => recordTaskOwnedPaths(args, paths, toolName),
    });
    return complete(guard, result);
  }
  if (toolName === 'apply_project_atlas_agent_update') {
    const project = findProjectForAtlasUpdate(args);
    if (!project) throw new Error('Project not found for Project Atlas agent update.');
    logger.stdout(`[Project Atlas] Saving ChatGPT-authored Atlas for ${project.name || project.id}\n`);
    return applyProjectAtlasAgentUpdate(project, args);
  }
  throw new Error(`No async runner implemented for tool: ${toolName}`);
}

function findProjectForAtlasUpdate(args: any) {
  const projects = getProjects();
  if (args?.projectId) {
    const byId = projects.find((project) => project.id === args.projectId);
    if (byId) return byId;
  }
  if (args?.projectName) {
    const normalizedName = String(args.projectName).trim().toLowerCase();
    const byName = projects.find((project) => project.name.trim().toLowerCase() === normalizedName);
    if (byName) return byName;
  }
  if (args?.localPath) {
    const normalizedPath = String(args.localPath).trim().toLowerCase();
    const byPath = projects.find((project) => String(project.localPath || '').trim().toLowerCase() === normalizedPath);
    if (byPath) return byPath;
  }
  return null;
}
