import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDevFlowWorkspacesDir } from '../../lib/devFlowPaths';
import { createApiError } from './api';
import {
  markSessionWorkspaceIntegrationRequired,
  resolveSessionWorkspace,
  type SessionWorkspace,
} from './sessionWorkspaceService';

export type WorkspaceIntegrationConflict = {
  status: 'conflict';
  code: 'INTEGRATION_CONFLICT';
  workspaceId: string;
  strategy: 'merge';
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
  strategy: 'merge';
  baseBranch: string;
  sourceBranch: string;
  baseRevision: string;
  baseHeadBefore: string;
  baseHeadAfter: string;
  sourceHead: string;
  sourceCommits: string[];
  changedFiles: string[];
  alreadyIntegrated?: boolean;
};

type PersistedIntegrationState = {
  workspaceId: string;
  status: 'conflict';
  strategy: 'merge';
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
  const workspace = resolveSessionWorkspace(String(workspaceId || '').trim());
  if (!workspace) {
    throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
  }
  return workspace;
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
  const workspace = resolveWorkspaceForIntegration(workspaceId);
  const { baseHead: baseHeadBefore, sourceHead } = validateIntegrationPreconditions(workspace);
  const commits = sourceCommits(workspace.projectRoot, workspace.baseRevision, sourceHead);
  const files = changedFiles(workspace.projectRoot, workspace.baseRevision, sourceHead);

  if (commits.length === 0 || isAncestor(workspace.projectRoot, sourceHead, baseHeadBefore)) {
    clearIntegrationState(workspace.workspaceId);
    markSessionWorkspaceIntegrationRequired(workspace.workspaceId, false);
    return {
      status: 'succeeded',
      workspaceId: workspace.workspaceId,
      strategy: 'merge',
      baseBranch: workspace.baseBranch,
      sourceBranch: workspace.branch,
      baseRevision: workspace.baseRevision,
      baseHeadBefore,
      baseHeadAfter: baseHeadBefore,
      sourceHead,
      sourceCommits: commits,
      changedFiles: files,
      alreadyIntegrated: true,
    };
  }

  markSessionWorkspaceIntegrationRequired(workspace.workspaceId, true);
  const merge = runGit(workspace.projectRoot, ['merge', '--no-ff', '--no-edit', sourceHead], { allowFailure: true, timeoutMs: 60_000 });
  if (merge.status !== 0) {
    const conflicts = conflictedPaths(workspace.projectRoot);
    if (conflicts.length === 0) {
      if (mergeInProgress(workspace.projectRoot)) runGit(workspace.projectRoot, ['merge', '--abort'], { allowFailure: true });
      throw createApiError(409, 'WORKSPACE_INTEGRATION_FAILED', 'Local workspace integration failed without a merge conflict.', {
        affectedId: workspace.workspaceId,
        details: { stderr: merge.stderr, sourceHead, baseHeadBefore },
      });
    }
    const state: PersistedIntegrationState = {
      workspaceId: workspace.workspaceId,
      status: 'conflict',
      strategy: 'merge',
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
    return {
      status: 'conflict',
      code: 'INTEGRATION_CONFLICT',
      workspaceId: state.workspaceId,
      strategy: 'merge',
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

  const baseHeadAfter = head(workspace.projectRoot);
  clearIntegrationState(workspace.workspaceId);
  markSessionWorkspaceIntegrationRequired(workspace.workspaceId, false);
  return {
    status: 'succeeded',
    workspaceId: workspace.workspaceId,
    strategy: 'merge',
    baseBranch: workspace.baseBranch,
    sourceBranch: workspace.branch,
    baseRevision: workspace.baseRevision,
    baseHeadBefore,
    baseHeadAfter,
    sourceHead,
    sourceCommits: commits,
    changedFiles: files,
  };
}

export function abortWorkspaceIntegration(workspaceId: string) {
  const workspace = resolveWorkspaceForIntegration(workspaceId);
  const state = readIntegrationState(workspace.workspaceId);
  if (!state) throw createApiError(409, 'WORKSPACE_INTEGRATION_NOT_PENDING', 'No recoverable workspace integration is pending.', { affectedId: workspace.workspaceId });
  if (mergeInProgress(workspace.projectRoot)) runGit(workspace.projectRoot, ['merge', '--abort']);
  const currentHead = head(workspace.projectRoot);
  if (currentHead !== state.baseHeadBefore || !clean(workspace.projectRoot)) {
    throw createApiError(409, 'WORKSPACE_ABORT_INCOMPLETE', 'Integration abort did not restore the recorded clean base state.', {
      affectedId: workspace.workspaceId,
      details: { expectedHead: state.baseHeadBefore, currentHead },
    });
  }
  clearIntegrationState(workspace.workspaceId);
  markSessionWorkspaceIntegrationRequired(workspace.workspaceId, true);
  return { status: 'aborted' as const, workspaceId: workspace.workspaceId, baseHead: currentHead, sourceHead: state.sourceHead };
}

export function retryWorkspaceIntegration(workspaceId: string): WorkspaceIntegrationSuccess | WorkspaceIntegrationConflict {
  const workspace = resolveWorkspaceForIntegration(workspaceId);
  const state = readIntegrationState(workspace.workspaceId);
  if (!state) return integrateWorkspaceCommits(workspace.workspaceId);

  if (mergeInProgress(workspace.projectRoot)) {
    const conflicts = conflictedPaths(workspace.projectRoot);
    if (conflicts.length > 0) {
      const nextState = { ...state, conflictedPaths: conflicts, recordedAt: new Date().toISOString() };
      writeIntegrationState(nextState);
      return { ...nextState, status: 'conflict', code: 'INTEGRATION_CONFLICT' };
    }
    const commit = runGit(workspace.projectRoot, ['commit', '--no-edit'], { allowFailure: true });
    if (commit.status !== 0) {
      throw createApiError(409, 'WORKSPACE_RESOLUTION_COMMIT_FAILED', 'Resolved integration could not be finalized. Ensure all conflict resolutions are staged.', {
        affectedId: workspace.workspaceId,
        details: { stderr: commit.stderr },
      });
    }
  }

  const baseHeadAfter = head(workspace.projectRoot);
  if (!isAncestor(workspace.projectRoot, state.sourceHead, baseHeadAfter)) {
    throw createApiError(409, 'WORKSPACE_RETRY_STATE_INVALID', 'Base history does not contain the source workspace after retry. Abort and restart integration deliberately.', {
      affectedId: workspace.workspaceId,
      details: { sourceHead: state.sourceHead, baseHeadAfter },
    });
  }
  if (!clean(workspace.projectRoot)) {
    throw createApiError(409, 'WORKSPACE_BASE_DIRTY', 'Base workspace remains dirty after integration retry.', { affectedId: workspace.workspaceId });
  }
  clearIntegrationState(workspace.workspaceId);
  markSessionWorkspaceIntegrationRequired(workspace.workspaceId, false);
  return {
    status: 'succeeded',
    workspaceId: workspace.workspaceId,
    strategy: 'merge',
    baseBranch: state.baseBranch,
    sourceBranch: state.sourceBranch,
    baseRevision: state.baseRevision,
    baseHeadBefore: state.baseHeadBefore,
    baseHeadAfter,
    sourceHead: state.sourceHead,
    sourceCommits: state.sourceCommits,
    changedFiles: state.changedFiles,
  };
}

export function getWorkspaceIntegrationState(workspaceId: string) {
  return readIntegrationState(String(workspaceId || '').trim());
}
