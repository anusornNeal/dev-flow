import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDevFlowWorkspacesDir } from '../../lib/devFlowPaths';
import { createApiError } from './api';
import {
  markSessionWorkspaceIntegrated,
  markSessionWorkspaceIntegrationRequired,
  resolveSessionWorkspace,
  resolveSessionWorkspaceForRecovery,
  type SessionWorkspace,
} from './sessionWorkspaceService';

export type WorkspaceIntegrationConflict = {
  status: 'conflict';
  code: 'INTEGRATION_CONFLICT';
  workspaceId: string;
  strategy: 'rebase-ff';
  baseBranch: string;
  sourceBranch: string;
  baseRevision: string;
  baseHeadBefore: string;
  sourceHead: string;
  sourceCommits: string[];
  changedFiles: string[];
  conflictedPaths: string[];
};

export type WorkspaceIntegrationSuccess = {
  status: 'succeeded';
  workspaceId: string;
  strategy: 'rebase-ff';
  baseBranch: string;
  sourceBranch: string;
  baseRevision: string;
  baseHeadBefore: string;
  baseHeadAfter: string;
  sourceHead: string;
  integratedHead: string;
  sourceCommits: string[];
  integratedCommits: string[];
  changedFiles: string[];
  alreadyIntegrated?: boolean;
};

const integrationMetrics = { attempts: 0, successes: 0, conflicts: 0, aborts: 0, retries: 0 };

type PersistedIntegrationState = {
  workspaceId: string;
  status: 'conflict';
  strategy: 'rebase-ff';
  baseBranch: string;
  sourceBranch: string;
  baseRevision: string;
  baseHeadBefore: string;
  sourceHead: string;
  sourceCommits: string[];
  changedFiles: string[];
  conflictedPaths: string[];
  recordedAt: string;
};

function integrationStateDir() {
  return path.join(getDevFlowWorkspacesDir(), 'integrations');
}

function integrationStatePath(workspaceId: string) {
  const safeId = String(workspaceId || '').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(integrationStateDir(), `${safeId}.json`);
}

function writeIntegrationState(state: PersistedIntegrationState) {
  fs.mkdirSync(integrationStateDir(), { recursive: true });
  const target = integrationStatePath(state.workspaceId);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
}

function readIntegrationState(workspaceId: string): PersistedIntegrationState | null {
  const target = integrationStatePath(workspaceId);
  if (!fs.existsSync(target)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(target, 'utf8')) as PersistedIntegrationState;
    return state.workspaceId === workspaceId ? state : null;
  } catch {
    return null;
  }
}

function clearIntegrationState(workspaceId: string) {
  fs.rmSync(integrationStatePath(workspaceId), { force: true });
}

function runGit(root: string, args: string[], options: { allowFailure?: boolean; timeoutMs?: number } = {}) {
  const result = spawnSync('git', ['--no-pager', ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeoutMs ?? 30_000,
  });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    throw createApiError(500, 'WORKSPACE_INTEGRATION_GIT_FAILED', `Git integration command failed: ${result.stderr?.trim() || result.error?.message || args.join(' ')}`, {
      details: { args, status: result.status },
    });
  }
  return {
    status: result.status ?? -1,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error,
  };
}

function head(root: string) {
  return runGit(root, ['rev-parse', 'HEAD']).stdout;
}

function branch(root: string) {
  return runGit(root, ['branch', '--show-current']).stdout || 'HEAD';
}

function clean(root: string) {
  return runGit(root, ['status', '--porcelain', '--untracked-files=all']).stdout.length === 0;
}

function mergeInProgress(root: string) {
  return runGit(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true }).status === 0;
}

function gitPathExists(root: string, name: string) {
  const target = runGit(root, ['rev-parse', '--git-path', name]).stdout;
  if (!target) return false;
  return fs.existsSync(path.isAbsolute(target) ? target : path.resolve(root, target));
}

function rebaseInProgress(root: string) {
  return gitPathExists(root, 'rebase-merge') || gitPathExists(root, 'rebase-apply');
}

function restoreSourceHead(workspace: SessionWorkspace, sourceHead: string) {
  if (rebaseInProgress(workspace.root)) runGit(workspace.root, ['rebase', '--abort'], { allowFailure: true, timeoutMs: 60_000 });
  if (head(workspace.root) !== sourceHead) runGit(workspace.root, ['reset', '--hard', sourceHead], { timeoutMs: 60_000 });
  if (head(workspace.root) !== sourceHead || !clean(workspace.root)) {
    throw createApiError(500, 'WORKSPACE_SOURCE_RECOVERY_FAILED', 'Failed integration could not restore the isolated source workspace to its recorded clean state.', {
      affectedId: workspace.workspaceId,
      details: { expectedHead: sourceHead, currentHead: head(workspace.root) },
    });
  }
}

function isAncestor(root: string, ancestor: string, descendant: string) {
  return runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true }).status === 0;
}

function sourceCommits(root: string, baseRevision: string, sourceHead: string) {
  const output = runGit(root, ['rev-list', '--reverse', `${baseRevision}..${sourceHead}`]).stdout;
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function changedFiles(root: string, baseRevision: string, sourceHead: string) {
  const output = runGit(root, ['diff', '--name-only', `${baseRevision}..${sourceHead}`]).stdout;
  return output ? output.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\\/g, '/')) : [];
}

function conflictedPaths(root: string) {
  const output = runGit(root, ['diff', '--name-only', '--diff-filter=U']).stdout;
  return output ? output.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\\/g, '/')).sort() : [];
}

function resolveWorkspaceForIntegration(workspaceId: string) {
  const cleanWorkspaceId = String(workspaceId || '').trim();
  const workspace = resolveSessionWorkspace(cleanWorkspaceId);
  if (workspace) return workspace;
  if (readIntegrationState(cleanWorkspaceId)) {
    const recoveryWorkspace = resolveSessionWorkspaceForRecovery(cleanWorkspaceId);
    if (recoveryWorkspace) return recoveryWorkspace;
  }
  throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
}

function validateIntegrationPreconditions(workspace: SessionWorkspace) {
  if (!clean(workspace.root)) {
    throw createApiError(409, 'WORKSPACE_SOURCE_DIRTY', 'Source workspace is dirty. Commit or discard workspace changes before integration.', { affectedId: workspace.workspaceId });
  }
  if (!clean(workspace.projectRoot)) {
    throw createApiError(409, 'WORKSPACE_BASE_DIRTY', 'Base workspace is dirty. Integration is blocked before mutation.', { affectedId: workspace.workspaceId });
  }
  const baseBranch = branch(workspace.projectRoot);
  if (baseBranch !== workspace.baseBranch) {
    throw createApiError(409, 'WORKSPACE_BASE_BRANCH_MISMATCH', `Base workspace is on '${baseBranch}', expected '${workspace.baseBranch}'.`, {
      affectedId: workspace.workspaceId,
      details: { expected: workspace.baseBranch, actual: baseBranch },
    });
  }
  const sourceBranch = branch(workspace.root);
  if (sourceBranch !== workspace.branch) {
    throw createApiError(409, 'WORKSPACE_SOURCE_BRANCH_MISMATCH', `Source workspace is on '${sourceBranch}', expected '${workspace.branch}'.`, {
      affectedId: workspace.workspaceId,
      details: { expected: workspace.branch, actual: sourceBranch },
    });
  }
  const baseHead = head(workspace.projectRoot);
  const sourceHead = head(workspace.root);
  if (!isAncestor(workspace.projectRoot, workspace.baseRevision, baseHead)) {
    throw createApiError(409, 'WORKSPACE_BASE_REWRITTEN', 'Base history no longer descends from the workspace base revision. Rebase/recreate the workspace deliberately before integration.', {
      affectedId: workspace.workspaceId,
      details: { baseRevision: workspace.baseRevision, baseHead },
    });
  }
  if (!isAncestor(workspace.projectRoot, workspace.baseRevision, sourceHead)) {
    throw createApiError(409, 'WORKSPACE_SOURCE_REWRITTEN', 'Source workspace history no longer descends from its recorded base revision.', {
      affectedId: workspace.workspaceId,
      details: { baseRevision: workspace.baseRevision, sourceHead },
    });
  }
  return { baseHead, sourceHead };
}

export function integrateWorkspaceCommits(workspaceId: string): WorkspaceIntegrationSuccess | WorkspaceIntegrationConflict {
  integrationMetrics.attempts += 1;
  const workspace = resolveWorkspaceForIntegration(workspaceId);
  const { baseHead: baseHeadBefore, sourceHead } = validateIntegrationPreconditions(workspace);
  const commits = sourceCommits(workspace.projectRoot, workspace.baseRevision, sourceHead);
  const files = changedFiles(workspace.projectRoot, workspace.baseRevision, sourceHead);

  if (isAncestor(workspace.projectRoot, sourceHead, baseHeadBefore)) {
    clearIntegrationState(workspace.workspaceId);
    markSessionWorkspaceIntegrated(workspace.workspaceId, sourceHead);
    integrationMetrics.successes += 1;
    return {
      status: 'succeeded',
      workspaceId: workspace.workspaceId,
      strategy: 'rebase-ff',
      baseBranch: workspace.baseBranch,
      sourceBranch: workspace.branch,
      baseRevision: workspace.baseRevision,
      baseHeadBefore,
      baseHeadAfter: baseHeadBefore,
      sourceHead,
      integratedHead: sourceHead,
      sourceCommits: commits,
      integratedCommits: commits,
      changedFiles: files,
      alreadyIntegrated: true,
    };
  }

  markSessionWorkspaceIntegrationRequired(workspace.workspaceId, true);

  let integratedHead = sourceHead;
  let integratedCommits = commits;
  if (!isAncestor(workspace.root, baseHeadBefore, sourceHead)) {
    const rebase = runGit(workspace.root, ['rebase', '--reapply-cherry-picks', '--empty=keep', '--onto', baseHeadBefore, workspace.baseRevision], { allowFailure: true, timeoutMs: 60_000 });
    if (rebase.status !== 0) {
      const conflicts = conflictedPaths(workspace.root);
      if (conflicts.length === 0 || !rebaseInProgress(workspace.root)) {
        restoreSourceHead(workspace, sourceHead);
        throw createApiError(409, 'WORKSPACE_INTEGRATION_FAILED', 'Local workspace rebase failed without a recoverable conflict.', {
          affectedId: workspace.workspaceId,
          details: { stderr: rebase.stderr, sourceHead, baseHeadBefore },
        });
      }
      const state: PersistedIntegrationState = {
        workspaceId: workspace.workspaceId,
        status: 'conflict',
        strategy: 'rebase-ff',
        baseBranch: workspace.baseBranch,
        sourceBranch: workspace.branch,
        baseRevision: workspace.baseRevision,
        baseHeadBefore,
        sourceHead,
        sourceCommits: commits,
        changedFiles: files,
        conflictedPaths: conflicts,
        recordedAt: new Date().toISOString(),
      };
      writeIntegrationState(state);
      integrationMetrics.conflicts += 1;
      return {
        status: 'conflict',
        code: 'INTEGRATION_CONFLICT',
        workspaceId: state.workspaceId,
        strategy: 'rebase-ff',
        baseBranch: state.baseBranch,
        sourceBranch: state.sourceBranch,
        baseRevision: state.baseRevision,
        baseHeadBefore: state.baseHeadBefore,
        sourceHead: state.sourceHead,
        sourceCommits: state.sourceCommits,
        changedFiles: state.changedFiles,
        conflictedPaths: state.conflictedPaths,
      };
    }
    integratedHead = head(workspace.root);
    integratedCommits = sourceCommits(workspace.root, baseHeadBefore, integratedHead);
    if (integratedCommits.length !== commits.length) {
      restoreSourceHead(workspace, sourceHead);
      throw createApiError(409, 'WORKSPACE_REBASE_COMMIT_MISMATCH', 'Workspace rebase did not preserve the expected number of source commits.', {
        affectedId: workspace.workspaceId,
        details: { expectedCommits: commits.length, actualCommits: integratedCommits.length, sourceHead, integratedHead },
      });
    }
  }

  const currentBaseHead = head(workspace.projectRoot);
  if (mergeInProgress(workspace.projectRoot) || !clean(workspace.projectRoot) || branch(workspace.projectRoot) !== workspace.baseBranch || currentBaseHead !== baseHeadBefore) {
    if (integratedHead !== sourceHead) restoreSourceHead(workspace, sourceHead);
    throw createApiError(409, 'WORKSPACE_BASE_CHANGED_DURING_INTEGRATION', 'Shared base changed while the isolated workspace was being rebased. Retry from the latest clean base.', {
      affectedId: workspace.workspaceId,
      details: { expectedHead: baseHeadBefore, currentHead: currentBaseHead },
    });
  }

  const fastForward = runGit(workspace.projectRoot, ['merge', '--ff-only', integratedHead], { allowFailure: true, timeoutMs: 60_000 });
  if (fastForward.status !== 0) {
    const restoredHead = head(workspace.projectRoot);
    const restoredClean = clean(workspace.projectRoot);
    if (integratedHead !== sourceHead) restoreSourceHead(workspace, sourceHead);
    if (restoredHead !== baseHeadBefore || !restoredClean) {
      throw createApiError(500, 'WORKSPACE_BASE_RECOVERY_FAILED', 'Failed fast-forward integration did not leave the shared base at its recorded clean state.', {
        affectedId: workspace.workspaceId,
        details: { expectedHead: baseHeadBefore, currentHead: restoredHead },
      });
    }
    throw createApiError(409, 'WORKSPACE_INTEGRATION_FAILED', 'Rebased workspace could not be applied to the shared base with fast-forward only.', {
      affectedId: workspace.workspaceId,
      details: { stderr: fastForward.stderr, sourceHead, integratedHead, baseHeadBefore },
    });
  }

  const baseHeadAfter = head(workspace.projectRoot);
  clearIntegrationState(workspace.workspaceId);
  markSessionWorkspaceIntegrated(workspace.workspaceId, baseHeadAfter);
  integrationMetrics.successes += 1;
  return {
    status: 'succeeded',
    workspaceId: workspace.workspaceId,
    strategy: 'rebase-ff',
    baseBranch: workspace.baseBranch,
    sourceBranch: workspace.branch,
    baseRevision: workspace.baseRevision,
    baseHeadBefore,
    baseHeadAfter,
    sourceHead,
    integratedHead,
    sourceCommits: commits,
    integratedCommits,
    changedFiles: files,
  };
}

export function abortWorkspaceIntegration(workspaceId: string) {
  const workspace = resolveWorkspaceForIntegration(workspaceId);
  const state = readIntegrationState(workspace.workspaceId);
  if (!state) throw createApiError(409, 'WORKSPACE_INTEGRATION_NOT_PENDING', 'No recoverable workspace integration is pending.', { affectedId: workspace.workspaceId });

  if (rebaseInProgress(workspace.root)) {
    runGit(workspace.root, ['rebase', '--abort'], { timeoutMs: 60_000 });
  } else if (head(workspace.root) !== state.sourceHead) {
    if (!clean(workspace.root)) {
      throw createApiError(409, 'WORKSPACE_ABORT_INCOMPLETE', 'Resolved workspace has uncommitted changes; refusing to discard them during abort.', {
        affectedId: workspace.workspaceId,
        details: { expectedHead: state.sourceHead, currentHead: head(workspace.root) },
      });
    }
    runGit(workspace.root, ['reset', '--hard', state.sourceHead], { timeoutMs: 60_000 });
  }

  const currentSourceHead = head(workspace.root);
  if (currentSourceHead !== state.sourceHead || !clean(workspace.root)) {
    throw createApiError(409, 'WORKSPACE_ABORT_INCOMPLETE', 'Integration abort did not restore the isolated source workspace to its recorded clean state.', {
      affectedId: workspace.workspaceId,
      details: { expectedHead: state.sourceHead, currentHead: currentSourceHead },
    });
  }

  const currentBaseHead = head(workspace.projectRoot);
  clearIntegrationState(workspace.workspaceId);
  markSessionWorkspaceIntegrationRequired(workspace.workspaceId, true);
  integrationMetrics.aborts += 1;
  return { status: 'aborted' as const, workspaceId: workspace.workspaceId, baseHead: currentBaseHead, sourceHead: state.sourceHead };
}

export function retryWorkspaceIntegration(workspaceId: string): WorkspaceIntegrationSuccess | WorkspaceIntegrationConflict {
  integrationMetrics.retries += 1;
  const workspace = resolveWorkspaceForIntegration(workspaceId);
  const state = readIntegrationState(workspace.workspaceId);
  if (!state) return integrateWorkspaceCommits(workspace.workspaceId);

  if (mergeInProgress(workspace.projectRoot) || !clean(workspace.projectRoot)) {
    throw createApiError(409, 'WORKSPACE_BASE_DIRTY', 'Shared base must be clean before retrying an isolated conflict resolution.', { affectedId: workspace.workspaceId });
  }
  const currentBaseHead = head(workspace.projectRoot);
  if (currentBaseHead !== state.baseHeadBefore) {
    throw createApiError(409, 'WORKSPACE_BASE_CHANGED_DURING_RESOLUTION', 'Shared base changed while this conflict was being resolved. Abort and retry from the latest base.', {
      affectedId: workspace.workspaceId,
      details: { expectedHead: state.baseHeadBefore, currentHead: currentBaseHead },
    });
  }

  if (rebaseInProgress(workspace.root)) {
    const conflicts = conflictedPaths(workspace.root);
    if (conflicts.length > 0) {
      const nextState = { ...state, conflictedPaths: conflicts, recordedAt: new Date().toISOString() };
      writeIntegrationState(nextState);
      integrationMetrics.conflicts += 1;
      return { ...nextState, status: 'conflict', code: 'INTEGRATION_CONFLICT' };
    }
    const continued = runGit(workspace.root, ['-c', 'core.editor=true', 'rebase', '--continue'], { allowFailure: true, timeoutMs: 60_000 });
    if (continued.status !== 0) {
      const nextConflicts = conflictedPaths(workspace.root);
      if (nextConflicts.length > 0 && rebaseInProgress(workspace.root)) {
        const nextState = { ...state, conflictedPaths: nextConflicts, recordedAt: new Date().toISOString() };
        writeIntegrationState(nextState);
        integrationMetrics.conflicts += 1;
        return { ...nextState, status: 'conflict', code: 'INTEGRATION_CONFLICT' };
      }
      throw createApiError(409, 'WORKSPACE_RESOLUTION_REBASE_FAILED', 'Resolved workspace rebase could not continue. Ensure resolutions are staged and the rebase remains recoverable.', {
        affectedId: workspace.workspaceId,
        details: { stderr: continued.stderr },
      });
    }
  }

  const resolutionHead = head(workspace.root);
  const integratedCommits = sourceCommits(workspace.root, state.baseHeadBefore, resolutionHead);
  if (resolutionHead === state.sourceHead || rebaseInProgress(workspace.root) || !clean(workspace.root) || !isAncestor(workspace.root, state.baseHeadBefore, resolutionHead) || integratedCommits.length !== state.sourceCommits.length) {
    throw createApiError(409, 'WORKSPACE_RETRY_STATE_INVALID', 'Isolated resolution is not a clean, commit-preserving rebase on top of the recorded base.', {
      affectedId: workspace.workspaceId,
      details: { sourceHead: state.sourceHead, baseHeadBefore: state.baseHeadBefore, resolutionHead, expectedCommits: state.sourceCommits.length, actualCommits: integratedCommits.length },
    });
  }

  const finalBaseHead = head(workspace.projectRoot);
  if (finalBaseHead !== state.baseHeadBefore || !clean(workspace.projectRoot)) {
    throw createApiError(409, 'WORKSPACE_BASE_CHANGED_DURING_RESOLUTION', 'Shared base changed before the resolved integration could be applied.', {
      affectedId: workspace.workspaceId,
      details: { expectedHead: state.baseHeadBefore, currentHead: finalBaseHead },
    });
  }
  const fastForward = runGit(workspace.projectRoot, ['merge', '--ff-only', resolutionHead], { allowFailure: true, timeoutMs: 60_000 });
  if (fastForward.status !== 0) {
    throw createApiError(409, 'WORKSPACE_RESOLUTION_APPLY_FAILED', 'Resolved rebased workspace could not be fast-forwarded onto the shared base.', {
      affectedId: workspace.workspaceId,
      details: { stderr: fastForward.stderr, resolutionHead, baseHeadBefore: state.baseHeadBefore },
    });
  }

  const baseHeadAfter = head(workspace.projectRoot);
  clearIntegrationState(workspace.workspaceId);
  markSessionWorkspaceIntegrated(workspace.workspaceId, baseHeadAfter);
  integrationMetrics.successes += 1;
  return {
    status: 'succeeded',
    workspaceId: workspace.workspaceId,
    strategy: 'rebase-ff',
    baseBranch: state.baseBranch,
    sourceBranch: state.sourceBranch,
    baseRevision: state.baseRevision,
    baseHeadBefore: state.baseHeadBefore,
    baseHeadAfter,
    sourceHead: state.sourceHead,
    integratedHead: resolutionHead,
    sourceCommits: state.sourceCommits,
    integratedCommits,
    changedFiles: state.changedFiles,
  };
}

export function getWorkspaceIntegrationMetrics() {
  const pendingDir = integrationStateDir();
  const pendingConflicts = fs.existsSync(pendingDir)
    ? fs.readdirSync(pendingDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length
    : 0;
  return { ...integrationMetrics, pendingConflicts };
}

export function getWorkspaceIntegrationState(workspaceId: string) {
  return readIntegrationState(String(workspaceId || '').trim());
}
