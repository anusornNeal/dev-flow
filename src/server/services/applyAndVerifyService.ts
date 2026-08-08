import type { AppState } from '../types';
import { editFilesBatch } from './fileEditBatchService';
import { applyPreparedEditPlan } from './preparedEditService';
import { getGitDiff } from './gitService';
import { runProjectCommand, runProjectCommandAsync, type RunProjectCommandResult } from './projectCommandService';
import { planVerification } from './verificationPlannerService';

function changedPaths(edit: any) {
  return (edit?.files || [])
    .filter((file: any) => file?.changed === true)
    .map((file: any) => String(file.filePath || ''))
    .filter(Boolean);
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
  const plan = planVerification({
    changedFiles: files.length > 0 ? files : (Array.isArray(args.changedFiles) ? args.changedFiles : []),
    requestedLane: args.lane,
    requestedCommands: Array.isArray(args.requestedCommands) ? args.requestedCommands : [],
    resourceIsolatedCommands: Array.isArray(args.resourceIsolatedCommands) ? args.resourceIsolatedCommands : [],
  });

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
      projectId: args.projectId,
      projectName: args.projectName,
      repo: args.repo,
      repoUrl: args.repoUrl,
      localPath: args.localPath,
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
      projectId: args.projectId,
      projectName: args.projectName,
      repo: args.repo,
      repoUrl: args.repoUrl,
      localPath: args.localPath,
      command: step.command,
      cacheResult: args.cacheVerificationResults !== false,
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

const silentVerificationLogger: VerificationLogger = {
  stdout: () => {},
  stderr: () => {},
};

export async function applyAndVerifyAsync(
  state: AppState,
  args: Record<string, any>,
  logger: VerificationLogger = silentVerificationLogger,
  setCancelFn: (fn: () => void) => void = () => {},
) {
  const edit = typeof args.editPlanId === 'string' && args.editPlanId.trim()
    ? applyPreparedEditPlan({ editPlanId: args.editPlanId })
    : editFilesBatch(state, { ...args, mode: 'apply', files: args.files });

  if (!edit.ok) {
    return { ok: false, status: 'edit_failed' as const, edit, diff: null, verification: [] as RunProjectCommandResult[], parallelVerification: false };
  }

  const files = changedPaths(edit);
  const plan = planVerification({
    changedFiles: files.length > 0 ? files : (Array.isArray(args.changedFiles) ? args.changedFiles : []),
    requestedLane: args.lane,
    requestedCommands: Array.isArray(args.requestedCommands) ? args.requestedCommands : [],
    resourceIsolatedCommands: Array.isArray(args.resourceIsolatedCommands) ? args.resourceIsolatedCommands : [],
  });
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
      projectId: args.projectId,
      projectName: args.projectName,
      repo: args.repo,
      repoUrl: args.repoUrl,
      localPath: args.localPath,
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

  const verification: RunProjectCommandResult[] = [];
  const activeCancels = new Set<() => void>();
  setCancelFn(() => {
    for (const cancel of activeCancels) cancel();
  });

  const runStep = async (step: { command: string }) => {
    let cancelFn: (() => void) | undefined;
    try {
      return await runProjectCommandAsync(state, {
        projectId: args.projectId,
        projectName: args.projectName,
        repo: args.repo,
        repoUrl: args.repoUrl,
        localPath: args.localPath,
        command: step.command,
        cacheResult: args.cacheVerificationResults !== false,
        maxOutputBytes: args.maxOutputBytes,
        timeoutMs: args.timeoutMs,
        responseMode: args.responseMode ?? 'compact',
      }, logger, (fn) => {
        cancelFn = fn;
        activeCancels.add(fn);
      });
    } finally {
      if (cancelFn) activeCancels.delete(cancelFn);
    }
  };

  const isolated = plan.steps.filter((step) => step.parallelGroup === 'isolated');
  const serial = plan.steps.filter((step) => step.parallelGroup !== 'isolated');
  const parallelVerification = isolated.length > 1;

  if (isolated.length > 0) {
    const results = parallelVerification
      ? await Promise.all(isolated.map(runStep))
      : [await runStep(isolated[0])];
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
      };
    }
  }

  for (const step of serial) {
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
    parallelVerification,
  };
}
