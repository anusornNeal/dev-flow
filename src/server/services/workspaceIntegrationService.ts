import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDevFlowWorkspacesDir } from '../../lib/devFlowPaths';
import { createApiError } from './api';
import type { GitIntegrationStrategy } from '../../types.js';
import { renderGitWorkflowTemplate, resolveProjectGitWorkflowPolicy, resolveTaskTicketContext, taskCommitSubjectMatchesPolicy } from './projectGitWorkflowPolicyService';
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
  strategy: GitIntegrationStrategy;
  baseBranch: string;
  sourceBranch: string;
  baseRevision: string;
  baseHeadBefore: string;
  sourceHead: string;
  sourceCommits: string[];
  changedFiles: string[];
  conflictedPaths: string[];
  mergeMessage?: string;
};

export type WorkspaceIntegrationSuccess = {
  status: 'succeeded';
  workspaceId: string;
  strategy: GitIntegrationStrategy;
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
  combinedChangedFiles: string[];
  combinedImpactBaseRevision: string;
  combinedImpactHead: string;
  alreadyIntegrated?: boolean;
  patchEquivalent?: boolean;
};

const integrationMetrics = { attempts: 0, successes: 0, conflicts: 0, aborts: 0, retries: 0 };

type PersistedIntegrationState = {
  workspaceId: string;
  status: 'conflict';
  strategy: GitIntegrationStrategy;
  baseBranch: string;
  sourceBranch: string;
  baseRevision: string;
  baseHeadBefore: string;
  sourceHead: string;
  sourceCommits: string[];
  changedFiles: string[];
  conflictedPaths: string[];
  mergeMessage?: string;
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

function branchHead(root: string, branchName: string) {
  const result = runGit(root, ['rev-parse', '--verify', `refs/heads/${branchName}`], { allowFailure: true });
  if (result.status !== 0 || !result.stdout) {
    throw createApiError(409, 'WORKSPACE_TARGET_BRANCH_MISSING', `Target branch '${branchName}' is unavailable for workspace integration.`, {
      affectedId: branchName,
    });
  }
  return result.stdout;
}

function checkedOutBranchRoots(root: string, branchName: string) {
  const output = runGit(root, ['worktree', 'list', '--porcelain']).stdout;
  const matches: string[] = [];
  let worktreeRoot = '';
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) worktreeRoot = line.slice('worktree '.length).trim();
    else if (line === `branch refs/heads/${branchName}` && worktreeRoot) matches.push(path.resolve(worktreeRoot));
  }
  return matches;
}

function applyIntegratedHeadToTarget(workspace: SessionWorkspace, expectedBaseHead: string, integratedHead: string) {
  const observedTargetHead = branchHead(workspace.projectRoot, workspace.baseBranch);
  if (observedTargetHead !== expectedBaseHead) {
    throw createApiError(409, 'WORKSPACE_BASE_CHANGED_DURING_INTEGRATION', `Target branch '${workspace.baseBranch}' moved while the isolated workspace was being integrated.`, {
      affectedId: workspace.workspaceId,
      details: { baseBranch: workspace.baseBranch, expectedHead: expectedBaseHead, currentHead: observedTargetHead },
    });
  }
  if (branch(workspace.projectRoot) === workspace.baseBranch) {
    if (mergeInProgress(workspace.projectRoot) || !clean(workspace.projectRoot) || head(workspace.projectRoot) !== expectedBaseHead) {
      throw createApiError(409, 'WORKSPACE_BASE_CHANGED_DURING_INTEGRATION', 'Checked-out target branch changed or became dirty during integration.', {
        affectedId: workspace.workspaceId,
        details: { baseBranch: workspace.baseBranch, expectedHead: expectedBaseHead, currentHead: head(workspace.projectRoot) },
      });
    }
    const fastForward = runGit(workspace.projectRoot, ['merge', '--ff-only', integratedHead], { allowFailure: true, timeoutMs: 60_000 });
    if (fastForward.status !== 0) {
      throw createApiError(409, 'WORKSPACE_INTEGRATION_FAILED', `Integrated workspace could not fast-forward target branch '${workspace.baseBranch}'.`, {
        affectedId: workspace.workspaceId,
        details: { stderr: fastForward.stderr, integratedHead, expectedBaseHead },
      });
    }
    return head(workspace.projectRoot);
  }
  const checkedOut = checkedOutBranchRoots(workspace.projectRoot, workspace.baseBranch);
  if (checkedOut.length > 0) {
    throw createApiError(409, 'WORKSPACE_TARGET_BRANCH_CHECKED_OUT_ELSEWHERE', `Target branch '${workspace.baseBranch}' is checked out in another worktree and cannot be updated behind that working tree.`, {
      affectedId: workspace.workspaceId,
      details: { baseBranch: workspace.baseBranch, worktreeRoots: checkedOut },
    });
  }
  const updated = runGit(workspace.projectRoot, ['update-ref', `refs/heads/${workspace.baseBranch}`, integratedHead, expectedBaseHead], { allowFailure: true });
  if (updated.status !== 0) {
    throw createApiError(409, 'WORKSPACE_TARGET_BRANCH_UPDATE_FAILED', `Target branch '${workspace.baseBranch}' changed before the atomic ref update could complete.`, {
      affectedId: workspace.workspaceId,
      details: { stderr: updated.stderr, expectedBaseHead, integratedHead },
    });
  }
  return branchHead(workspace.projectRoot, workspace.baseBranch);
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
  if (mergeInProgress(workspace.root)) runGit(workspace.root, ['merge', '--abort'], { allowFailure: true, timeoutMs: 60_000 });
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

function patchEquivalentToBase(root: string, baseHead: string, sourceHead: string) {
  const result = runGit(root, ['cherry', baseHead, sourceHead], { allowFailure: true });
  if (result.status !== 0) return false;
  const rows = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.length > 0 && rows.every((line) => line.startsWith('- '));
}

function sourceCommits(root: string, baseRevision: string, sourceHead: string) {
  const output = runGit(root, ['rev-list', '--reverse', `${baseRevision}..${sourceHead}`]).stdout;
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function validateTaskCommitSubjects(
  workspace: SessionWorkspace,
  commits: string[],
  task?: WorkspaceIntegrationTaskContext,
) {
  if (task?.projectId && task.projectId !== workspace.projectId) {
    throw createApiError(409, 'WORKSPACE_TASK_PROJECT_MISMATCH', 'The integration task belongs to a different project than this workspace.', {
      affectedId: workspace.workspaceId,
      details: { workspaceProjectId: workspace.projectId, taskProjectId: task.projectId },
    });
  }
  const taskContext = task || (workspace.taskDisplayId
    ? { displayId: workspace.taskDisplayId, projectId: workspace.projectId }
    : null);
  if (!taskContext) return;

  const invalid = commits.map((commit) => {
    const subject = runGit(workspace.root, ['show', '-s', '--format=%s', commit]).stdout.trim();
    return taskCommitSubjectMatchesPolicy(subject, taskContext, { gitWorkflowPolicy: workspace.gitWorkflowPolicy } as any)
      ? null
      : { commit, subject };
  }).filter(Boolean) as Array<{ commit: string; subject: string }>;
  if (invalid.length === 0) return;

  const policy = resolveProjectGitWorkflowPolicy({ gitWorkflowPolicy: workspace.gitWorkflowPolicy } as any);
  throw createApiError(409, 'TASK_COMMIT_SUBJECT_INVALID', 'Task-owned workspace contains commit subjects that do not match the authoritative project task-commit policy. Recommit with commit_task_owned_changes before integration.', {
    affectedId: workspace.workspaceId,
    details: {
      workspaceId: workspace.workspaceId,
      taskDisplayId: workspace.taskDisplayId || task?.displayId || null,
      commitMessageTemplate: policy.commitMessageTemplate,
      invalid,
      nextTool: 'commit_task_owned_changes',
    },
  });
}

function changedFiles(root: string, baseRevision: string, sourceHead: string) {
  const output = runGit(root, ['diff', '--name-only', `${baseRevision}..${sourceHead}`]).stdout;
  return output ? output.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\\/g, '/')) : [];
}

function combinedImpact(workspace: SessionWorkspace, combinedHead: string) {
  return {
    combinedChangedFiles: changedFiles(workspace.projectRoot, workspace.baseRevision, combinedHead),
    combinedImpactBaseRevision: workspace.baseRevision,
    combinedImpactHead: combinedHead,
  };
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

function validateIntegrationPreconditions(workspace: SessionWorkspace, task?: WorkspaceIntegrationTaskContext) {
  if (!clean(workspace.root)) {
    throw createApiError(409, 'WORKSPACE_SOURCE_DIRTY', 'Source workspace is dirty. Commit or discard workspace changes before integration.', { affectedId: workspace.workspaceId });
  }
  if (!clean(workspace.projectRoot)) {
    throw createApiError(409, 'WORKSPACE_BASE_DIRTY', 'Base workspace is dirty. Integration is blocked before mutation.', { affectedId: workspace.workspaceId });
  }
  const taskBranch = String(task?.branch || '').trim();
  if (taskBranch && taskBranch !== workspace.baseBranch) {
    throw createApiError(409, 'TASK_WORKSPACE_BRANCH_AUTHORITY_MISMATCH', `Task targets '${taskBranch}', but workspace '${workspace.workspaceId}' is frozen to '${workspace.baseBranch}'.`, {
      affectedId: workspace.workspaceId,
      details: { taskBranch, workspaceBaseBranch: workspace.baseBranch },
    });
  }
  const sourceBranch = branch(workspace.root);
  if (sourceBranch !== workspace.branch) {
    throw createApiError(409, 'WORKSPACE_SOURCE_BRANCH_MISMATCH', `Source workspace is on '${sourceBranch}', expected '${workspace.branch}'.`, {
      affectedId: workspace.workspaceId,
      details: { expected: workspace.branch, actual: sourceBranch },
    });
  }
  const baseHead = branchHead(workspace.projectRoot, workspace.baseBranch);
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

export type WorkspaceIntegrationTaskContext = {
  id?: string;
  displayId?: string;
  jiraKey?: string;
  title?: string;
  category?: string;
  type?: string;
  projectId?: string;
  branch?: string;
};


export type WorkspaceIntegrationOptions = {
  task?: WorkspaceIntegrationTaskContext;
};

function integrateWorkspaceWithMergePolicy(
  workspace: SessionWorkspace,
  baseHeadBefore: string,
  sourceHead: string,
  commits: string[],
  files: string[],
  mergeMessageTemplate: string,
  task?: WorkspaceIntegrationTaskContext,
): WorkspaceIntegrationSuccess | WorkspaceIntegrationConflict {
  if (task?.projectId && task.projectId !== workspace.projectId) {
    throw createApiError(409, 'WORKSPACE_TASK_PROJECT_MISMATCH', 'The integration task belongs to a different project than this workspace.', {
      affectedId: workspace.workspaceId,
      details: { workspaceProjectId: workspace.projectId, taskProjectId: task.projectId },
    });
  }
  const mergeMessage = renderGitWorkflowTemplate(mergeMessageTemplate, resolveTaskTicketContext(task || {}));
  markSessionWorkspaceIntegrationRequired(workspace.workspaceId, true);

  if (!isAncestor(workspace.root, baseHeadBefore, sourceHead)) {
    const probe = runGit(workspace.root, ['merge', '--no-commit', '--no-ff', baseHeadBefore], { allowFailure: true, timeoutMs: 60_000 });
    if (probe.status !== 0) {
      const conflicts = conflictedPaths(workspace.root);
      if (conflicts.length === 0 || !mergeInProgress(workspace.root)) {
        restoreSourceHead(workspace, sourceHead);
        throw createApiError(409, 'WORKSPACE_INTEGRATION_FAILED', 'Local workspace merge preflight failed without a recoverable conflict.', {
          affectedId: workspace.workspaceId,
          details: { stderr: probe.stderr, sourceHead, baseHeadBefore },
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
        mergeMessage,
        recordedAt: new Date().toISOString(),
      };
      writeIntegrationState(state);
      integrationMetrics.conflicts += 1;
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
        mergeMessage,
      };
    }
    if (mergeInProgress(workspace.root)) runGit(workspace.root, ['merge', '--abort'], { timeoutMs: 60_000 });
    if (!clean(workspace.root) || head(workspace.root) !== sourceHead) {
      restoreSourceHead(workspace, sourceHead);
      throw createApiError(409, 'WORKSPACE_SOURCE_PROBE_RESTORE_FAILED', 'Merge preflight did not restore the isolated source workspace cleanly.', {
        affectedId: workspace.workspaceId,
        details: { expectedHead: sourceHead, currentHead: head(workspace.root) },
      });
    }
  }

  const currentBaseHead = head(workspace.projectRoot);
  if (mergeInProgress(workspace.projectRoot) || !clean(workspace.projectRoot) || branch(workspace.projectRoot) !== workspace.baseBranch || currentBaseHead !== baseHeadBefore) {
    throw createApiError(409, 'WORKSPACE_BASE_CHANGED_DURING_INTEGRATION', 'Shared base changed after merge preflight. Retry from the latest clean base.', {
      affectedId: workspace.workspaceId,
      details: { expectedHead: baseHeadBefore, currentHead: currentBaseHead },
    });
  }

  const merge = runGit(workspace.projectRoot, ['merge', '--no-ff', '-m', mergeMessage, sourceHead], { allowFailure: true, timeoutMs: 60_000 });
  if (merge.status !== 0) {
    const conflicts = conflictedPaths(workspace.projectRoot);
    if (mergeInProgress(workspace.projectRoot)) runGit(workspace.projectRoot, ['merge', '--abort'], { allowFailure: true, timeoutMs: 60_000 });
    if (head(workspace.projectRoot) !== baseHeadBefore || !clean(workspace.projectRoot)) {
      throw createApiError(500, 'WORKSPACE_BASE_RECOVERY_FAILED', 'Failed merge integration could not restore the shared base to its recorded clean state.', {
        affectedId: workspace.workspaceId,
        details: { expectedHead: baseHeadBefore, currentHead: head(workspace.projectRoot), conflictedPaths: conflicts },
      });
    }
    throw createApiError(409, 'WORKSPACE_INTEGRATION_FAILED', 'Configured merge integration failed after isolated preflight; the shared base was restored.', {
      affectedId: workspace.workspaceId,
      details: { stderr: merge.stderr, sourceHead, baseHeadBefore, conflictedPaths: conflicts },
    });
  }

  const baseHeadAfter = head(workspace.projectRoot);
  const sourceSync = runGit(workspace.root, ['merge', '--ff-only', baseHeadAfter], { allowFailure: true, timeoutMs: 60_000 });
  if (sourceSync.status !== 0) {
    runGit(workspace.projectRoot, ['reset', '--hard', baseHeadBefore], { timeoutMs: 60_000 });
    restoreSourceHead(workspace, sourceHead);
    throw createApiError(500, 'WORKSPACE_SOURCE_SYNC_FAILED', 'Merge commit was created but could not be mirrored back to the isolated workspace; the shared base was restored.', {
      affectedId: workspace.workspaceId,
      details: { stderr: sourceSync.stderr, baseHeadBefore, attemptedMergeHead: baseHeadAfter },
    });
  }

  const integratedCommits = sourceCommits(workspace.projectRoot, baseHeadBefore, baseHeadAfter);
  clearIntegrationState(workspace.workspaceId);
  markSessionWorkspaceIntegrated(workspace.workspaceId, baseHeadAfter);
  integrationMetrics.successes += 1;
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
    integratedHead: baseHeadAfter,
    sourceCommits: commits,
    integratedCommits,
    changedFiles: files,
    ...combinedImpact(workspace, baseHeadAfter),
  };
}

export function reconstructRecordedWorkspaceIntegration(args: {
  workspaceId: string;
  projectRoot: string;
  baseBranch: string;
  sourceBranch: string;
  baseRevision: string;
  sourceHead: string;
  strategy: GitIntegrationStrategy;
}) : WorkspaceIntegrationSuccess {
  const projectRoot = path.resolve(args.projectRoot);
  const baseHead = branchHead(projectRoot, args.baseBranch);
  const integratedExactly = isAncestor(projectRoot, args.sourceHead, baseHead);
  const patchEquivalent = !integratedExactly && patchEquivalentToBase(projectRoot, baseHead, args.sourceHead);
  if (!integratedExactly && !patchEquivalent) {
    throw createApiError(409, 'FINALIZATION_RECORDED_INTEGRATION_NOT_FOUND', 'The frozen finalization source revision is not represented in the current target branch.', {
      affectedId: args.workspaceId,
      details: { sourceHead: args.sourceHead, baseHead, baseBranch: args.baseBranch },
    });
  }
  const sourceChanges = changedFiles(projectRoot, args.baseRevision, args.sourceHead);
  const combinedChanges = changedFiles(projectRoot, args.baseRevision, baseHead);
  return {
    status: 'succeeded',
    workspaceId: args.workspaceId,
    strategy: args.strategy,
    baseBranch: args.baseBranch,
    sourceBranch: args.sourceBranch,
    baseRevision: args.baseRevision,
    baseHeadBefore: baseHead,
    baseHeadAfter: baseHead,
    sourceHead: args.sourceHead,
    integratedHead: baseHead,
    sourceCommits: sourceCommits(projectRoot, args.baseRevision, args.sourceHead),
    integratedCommits: sourceCommits(projectRoot, args.baseRevision, baseHead),
    changedFiles: sourceChanges,
    combinedChangedFiles: combinedChanges,
    combinedImpactBaseRevision: args.baseRevision,
    combinedImpactHead: baseHead,
    alreadyIntegrated: true,
    ...(patchEquivalent ? { patchEquivalent: true } : {}),
  };
}

export function integrateWorkspaceCommits(workspaceId: string, options: WorkspaceIntegrationOptions = {}): WorkspaceIntegrationSuccess | WorkspaceIntegrationConflict {
  integrationMetrics.attempts += 1;
  const workspace = resolveWorkspaceForIntegration(workspaceId);
  const policy = resolveProjectGitWorkflowPolicy({ gitWorkflowPolicy: workspace.gitWorkflowPolicy } as any);
  const { baseHead: baseHeadBefore, sourceHead } = validateIntegrationPreconditions(workspace, options.task);
  const commits = sourceCommits(workspace.projectRoot, workspace.baseRevision, sourceHead);
  validateTaskCommitSubjects(workspace, commits, options.task);
  const files = changedFiles(workspace.projectRoot, workspace.baseRevision, sourceHead);

  if (isAncestor(workspace.projectRoot, sourceHead, baseHeadBefore)) {
    clearIntegrationState(workspace.workspaceId);
    markSessionWorkspaceIntegrated(workspace.workspaceId, sourceHead);
    integrationMetrics.successes += 1;
    return {
      status: 'succeeded',
      workspaceId: workspace.workspaceId,
      strategy: policy.integrationStrategy,
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
      ...combinedImpact(workspace, baseHeadBefore),
      alreadyIntegrated: true,
    };
  }

  if (commits.length > 0 && patchEquivalentToBase(workspace.root, baseHeadBefore, sourceHead)) {
    clearIntegrationState(workspace.workspaceId);
    markSessionWorkspaceIntegrated(workspace.workspaceId, baseHeadBefore);
    integrationMetrics.successes += 1;
    return {
      status: 'succeeded',
      workspaceId: workspace.workspaceId,
      strategy: policy.integrationStrategy,
      baseBranch: workspace.baseBranch,
      sourceBranch: workspace.branch,
      baseRevision: workspace.baseRevision,
      baseHeadBefore,
      baseHeadAfter: baseHeadBefore,
      sourceHead,
      integratedHead: baseHeadBefore,
      sourceCommits: commits,
      integratedCommits: [],
      changedFiles: files,
      ...combinedImpact(workspace, baseHeadBefore),
      alreadyIntegrated: true,
      patchEquivalent: true,
    };
  }

  if (policy.integrationStrategy === 'merge') {
    if (branch(workspace.projectRoot) !== workspace.baseBranch) {
      throw createApiError(409, 'WORKSPACE_MERGE_TARGET_NOT_CHECKED_OUT', `Merge-policy integration for target '${workspace.baseBranch}' is blocked rather than mutating the currently checked-out '${branch(workspace.projectRoot)}' branch.`, {
        affectedId: workspace.workspaceId,
        details: { targetBranch: workspace.baseBranch, checkedOutBranch: branch(workspace.projectRoot), safeFailure: true },
      });
    }
    return integrateWorkspaceWithMergePolicy(workspace, baseHeadBefore, sourceHead, commits, files, policy.mergeMessageTemplate, options.task);
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

  let baseHeadAfter: string;
  try {
    baseHeadAfter = applyIntegratedHeadToTarget(workspace, baseHeadBefore, integratedHead);
  } catch (error) {
    if (integratedHead !== sourceHead) restoreSourceHead(workspace, sourceHead);
    throw error;
  }
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
    ...combinedImpact(workspace, baseHeadAfter),
  };
}

export function abortWorkspaceIntegration(workspaceId: string) {
  const workspace = resolveWorkspaceForIntegration(workspaceId);
  const state = readIntegrationState(workspace.workspaceId);
  if (!state) throw createApiError(409, 'WORKSPACE_INTEGRATION_NOT_PENDING', 'No recoverable workspace integration is pending.', { affectedId: workspace.workspaceId });

  if (state.strategy === 'merge' && mergeInProgress(workspace.root)) {
    runGit(workspace.root, ['merge', '--abort'], { timeoutMs: 60_000 });
  } else if (rebaseInProgress(workspace.root)) {
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

  if (state.strategy === 'merge') {
    if (mergeInProgress(workspace.root)) {
      const conflicts = conflictedPaths(workspace.root);
      if (conflicts.length > 0) {
        const nextState = { ...state, conflictedPaths: conflicts, recordedAt: new Date().toISOString() };
        writeIntegrationState(nextState);
        integrationMetrics.conflicts += 1;
        return { ...nextState, status: 'conflict', code: 'INTEGRATION_CONFLICT' };
      }
      if (!state.mergeMessage) {
        throw createApiError(409, 'WORKSPACE_MERGE_MESSAGE_MISSING', 'Configured merge resolution is missing its recorded merge message. Abort and retry the integration from a fresh conflict state.', {
          affectedId: workspace.workspaceId,
        });
      }
      const commit = runGit(workspace.root, ['commit', '-m', state.mergeMessage], { allowFailure: true, timeoutMs: 60_000 });
      if (commit.status !== 0) {
        throw createApiError(409, 'WORKSPACE_RESOLUTION_COMMIT_FAILED', 'Resolved merge could not be finalized in the isolated workspace. Ensure all conflict resolutions are staged.', {
          affectedId: workspace.workspaceId,
          details: { stderr: commit.stderr },
        });
      }
    }

    const resolutionHead = head(workspace.root);
    if (resolutionHead === state.sourceHead || mergeInProgress(workspace.root) || !clean(workspace.root) || !isAncestor(workspace.root, state.sourceHead, resolutionHead) || !isAncestor(workspace.root, state.baseHeadBefore, resolutionHead)) {
      throw createApiError(409, 'WORKSPACE_RETRY_STATE_INVALID', 'Isolated merge resolution must be a clean merge commit containing both the recorded source and base revisions.', {
        affectedId: workspace.workspaceId,
        details: { sourceHead: state.sourceHead, baseHeadBefore: state.baseHeadBefore, resolutionHead },
      });
    }

    const fastForward = runGit(workspace.projectRoot, ['merge', '--ff-only', resolutionHead], { allowFailure: true, timeoutMs: 60_000 });
    if (fastForward.status !== 0) {
      throw createApiError(409, 'WORKSPACE_RESOLUTION_APPLY_FAILED', 'Resolved merge could not be fast-forwarded onto the shared base.', {
        affectedId: workspace.workspaceId,
        details: { stderr: fastForward.stderr, resolutionHead, baseHeadBefore: state.baseHeadBefore },
      });
    }

    const baseHeadAfter = head(workspace.projectRoot);
    const integratedCommits = sourceCommits(workspace.projectRoot, state.baseHeadBefore, resolutionHead);
    clearIntegrationState(workspace.workspaceId);
    markSessionWorkspaceIntegrated(workspace.workspaceId, baseHeadAfter);
    integrationMetrics.successes += 1;
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
      integratedHead: resolutionHead,
      sourceCommits: state.sourceCommits,
      integratedCommits,
      changedFiles: state.changedFiles,
      ...combinedImpact(workspace, baseHeadAfter),
    };
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
    ...combinedImpact(workspace, baseHeadAfter),
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
