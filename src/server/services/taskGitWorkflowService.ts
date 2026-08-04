import type { AppState } from '../types';
import type { TaskGitEvidence, VerificationEvidenceCheck, VerificationEvidenceStatus } from '../../types';
import { getTasks } from '../repositories/taskRepository';
import { getGitBranch, getGitStatus, getGitSyncStatus } from './gitService';
import { createApiError } from './api';

const VALID_VERIFICATION_STATUSES = new Set<VerificationEvidenceStatus>(['passed', 'failed', 'not-run']);
const UNRESOLVED_BUG_STATUSES = new Set(['open', 'fixing', 'reopened']);

export interface ReviewBlocker {
  code: string;
  message: string;
  details?: unknown;
}

export interface TaskWorkflowWarning {
  code: string;
  message: string;
  severity: 'warning' | 'error';
  details?: unknown;
}

function flag(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || String(value).toLowerCase() === 'true';
}

function readChecks(args: Record<string, any>, task: any): unknown[] {
  if (Array.isArray(args.checks)) return args.checks;
  if (Array.isArray(args.verificationEvidence)) return args.verificationEvidence;
  if (Array.isArray(args.tests)) return args.tests;
  if (Array.isArray(task?.verificationEvidence)) return task.verificationEvidence;
  return [];
}

export function normalizeVerificationEvidence(args: Record<string, any>, task?: any): VerificationEvidenceCheck[] {
  const now = new Date().toISOString();
  return readChecks(args, task).map((entry: any, index) => {
    if (!entry || typeof entry !== 'object') {
      throw createApiError(400, 'INVALID_VERIFICATION_EVIDENCE', `Verification check ${index + 1} must be an object.`);
    }
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    const name = typeof entry.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : command || `check-${index + 1}`;
    const rawStatus = String(entry.status ?? entry.result ?? '').trim().toLowerCase() as VerificationEvidenceStatus;
    if (!command) {
      throw createApiError(400, 'VERIFICATION_COMMAND_REQUIRED', `Verification check '${name}' requires a command.`, {
        details: { index },
      });
    }
    if (!VALID_VERIFICATION_STATUSES.has(rawStatus)) {
      throw createApiError(400, 'INVALID_VERIFICATION_STATUS', `Verification check '${name}' status must be passed, failed, or not-run.`, {
        details: { index, status: entry.status ?? entry.result },
      });
    }
    return {
      name,
      command,
      status: rawStatus,
      summary: typeof entry.summary === 'string' && entry.summary.trim() ? entry.summary.trim() : undefined,
      output: typeof entry.output === 'string' && entry.output.trim() ? entry.output : undefined,
      recordedAt: typeof entry.recordedAt === 'string' && entry.recordedAt.trim() ? entry.recordedAt : now,
    };
  });
}

function collectGitEvidence(state: AppState, task: any, args: Record<string, any>): TaskGitEvidence {
  if (!task?.projectId) {
    throw createApiError(400, 'TASK_PROJECT_REQUIRED', 'Task must belong to a project before Git evidence can be collected.', {
      affectedId: task?.id,
    });
  }
  const remote = typeof args.remote === 'string' && args.remote.trim() ? args.remote.trim() : 'origin';
  const sync = getGitSyncStatus(state, {
    projectId: task.projectId,
    remote,
    fetch: flag(args.fetch, true),
  });
  return {
    branch: sync.branch,
    commit: sync.localHead,
    remote: sync.remote,
    trackingBranch: sync.trackingBranch,
    remoteHead: sync.remoteHead,
    ahead: sync.ahead,
    behind: sync.behind,
    diverged: sync.diverged,
    pushed: sync.pushed,
    workingTreeClean: sync.workingTreeClean,
    recordedAt: new Date().toISOString(),
  };
}

export function syncTaskWithGit(state: AppState, task: any, args: Record<string, any>) {
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', 'Task was not found.');
  const gitEvidence = collectGitEvidence(state, task, args);
  const verificationEvidence = normalizeVerificationEvidence(args, task);
  return {
    gitEvidence,
    verificationEvidence,
    task: {
      ...task,
      gitEvidence,
      verificationEvidence,
      updatedAt: new Date().toISOString(),
    },
  };
}

function addBlocker(blockers: ReviewBlocker[], code: string, message: string, details?: unknown) {
  if (blockers.some((blocker) => blocker.code === code)) return;
  blockers.push({ code, message, ...(details === undefined ? {} : { details }) });
}

function validateTaskState(task: any, gitEvidence: TaskGitEvidence | undefined, verificationEvidence: VerificationEvidenceCheck[], args: Record<string, any>) {
  const blockers: ReviewBlocker[] = [];
  const requireCleanTree = flag(args.requireCleanTree, true);
  const requirePushedHead = flag(args.requirePushedHead, true);
  const requireBranchMatch = flag(args.requireBranchMatch, true);
  const requireChecklistComplete = flag(args.requireChecklistComplete, true);
  const requireVerificationEvidence = flag(args.requireVerificationEvidence, true);

  if (task.status !== 'in-progress' && task.status !== 'ready-for-review') {
    addBlocker(blockers, 'TASK_NOT_IN_PROGRESS', `Task must be in-progress before review submission; current status is '${task.status}'.`);
  }

  if (requireChecklistComplete) {
    const incomplete = Array.isArray(task.checklist)
      ? task.checklist.filter((item: any) => !item?.completed)
      : [];
    if (incomplete.length > 0) {
      addBlocker(blockers, 'CHECKLIST_INCOMPLETE', `${incomplete.length} checklist item(s) are incomplete.`, {
        items: incomplete.map((item: any) => ({ id: item.id, text: item.text })),
      });
    }
  }

  if (requireVerificationEvidence) {
    if (verificationEvidence.length === 0) {
      addBlocker(blockers, 'VERIFICATION_EVIDENCE_MISSING', 'At least one structured verification check is required.');
    } else {
      const failed = verificationEvidence.filter((check) => check.status === 'failed');
      const notRun = verificationEvidence.filter((check) => check.status === 'not-run');
      if (failed.length > 0) {
        addBlocker(blockers, 'VERIFICATION_FAILED', `${failed.length} verification check(s) failed.`, {
          checks: failed.map((check) => ({ name: check.name, command: check.command, summary: check.summary })),
        });
      }
      if (notRun.length > 0) {
        addBlocker(blockers, 'VERIFICATION_NOT_RUN', `${notRun.length} verification check(s) were not run.`, {
          checks: notRun.map((check) => ({ name: check.name, command: check.command })),
        });
      }
    }
  }

  if (!gitEvidence && (requireCleanTree || requirePushedHead || requireBranchMatch)) {
    addBlocker(blockers, 'GIT_EVIDENCE_MISSING', 'Current Git branch, commit, remote synchronization, and cleanliness evidence is required. Use sync_task_with_git or submit_task_for_review first.');
  }

  if (gitEvidence) {
    if (requireBranchMatch) {
      if (!task.branch) {
        addBlocker(blockers, 'TASK_BRANCH_MISSING', 'Task branch metadata is required before review submission.');
      } else if (task.branch !== gitEvidence.branch) {
        addBlocker(blockers, 'TASK_BRANCH_MISMATCH', `Task expects branch '${task.branch}', but the repository is on '${gitEvidence.branch}'.`, {
          taskBranch: task.branch,
          repositoryBranch: gitEvidence.branch,
        });
      }
    }
    if (requireCleanTree && !gitEvidence.workingTreeClean) {
      addBlocker(blockers, 'WORKING_TREE_DIRTY', 'The working tree has uncommitted changes.');
    }
    if (gitEvidence.diverged) {
      addBlocker(blockers, 'BRANCH_DIVERGED', 'The local and remote branches have diverged.', {
        ahead: gitEvidence.ahead,
        behind: gitEvidence.behind,
      });
    }
    if ((gitEvidence.ahead ?? 0) > 0) {
      addBlocker(blockers, 'LOCAL_BRANCH_AHEAD', `The local branch is ${gitEvidence.ahead} commit(s) ahead of the remote.`, {
        ahead: gitEvidence.ahead,
      });
    }
    if ((gitEvidence.behind ?? 0) > 0) {
      addBlocker(blockers, 'LOCAL_BRANCH_BEHIND', `The local branch is ${gitEvidence.behind} commit(s) behind the remote.`, {
        behind: gitEvidence.behind,
      });
    }
    if (requirePushedHead && !gitEvidence.pushed) {
      addBlocker(blockers, 'HEAD_NOT_PUSHED', 'The current local HEAD is not published on the remote branch.', {
        localHead: gitEvidence.commit,
        remoteHead: gitEvidence.remoteHead,
      });
    }
    if (requirePushedHead && !gitEvidence.trackingBranch) {
      addBlocker(blockers, 'UPSTREAM_NOT_CONFIGURED', 'The active branch has no upstream tracking branch.');
    }
  }

  const children = getTasks().filter((entry: any) => entry.parentId === task.id);
  const blockingChildren = children.filter((entry: any) => !['ready-for-review', 'done'].includes(entry.status));
  if (blockingChildren.length > 0) {
    addBlocker(blockers, 'CHILD_TASK_BLOCKING', `${blockingChildren.length} child task(s) are not ready for integration/review.`, {
      children: blockingChildren.map((entry: any) => ({
        id: entry.id,
        displayId: entry.displayId,
        title: entry.title,
        status: entry.status,
      })),
    });
  }

  const unresolvedBugs = Array.isArray(task.bugs)
    ? task.bugs.filter((bug: any) => UNRESOLVED_BUG_STATUSES.has(String(bug?.status || '').toLowerCase()))
    : [];
  if (unresolvedBugs.length > 0) {
    addBlocker(blockers, 'UNRESOLVED_BUGS', `${unresolvedBugs.length} unresolved bug thread(s) block review submission.`, {
      bugs: unresolvedBugs.map((bug: any) => ({ id: bug.id, title: bug.title, status: bug.status })),
    });
  }

  return blockers;
}

export function validateRecordedReviewSubmission(task: any, args: Record<string, any> = {}) {
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', 'Task was not found.');
  const verificationEvidence = normalizeVerificationEvidence(args, task);
  const gitEvidence = task.gitEvidence as TaskGitEvidence | undefined;
  const blockers = validateTaskState(task, gitEvidence, verificationEvidence, args);
  return {
    blocked: blockers.length > 0,
    blockers,
    gitEvidence,
    verificationEvidence,
  };
}

export function evaluateReviewSubmission(state: AppState, task: any, args: Record<string, any>) {
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', 'Task was not found.');
  const verificationEvidence = normalizeVerificationEvidence(args, task);
  let gitEvidence: TaskGitEvidence | undefined;
  const blockers: ReviewBlocker[] = [];
  try {
    gitEvidence = collectGitEvidence(state, task, args);
  } catch (error: any) {
    addBlocker(blockers, 'GIT_EVIDENCE_UNAVAILABLE', error?.payload?.message || error?.message || 'Git evidence could not be collected.', {
      code: error?.payload?.code,
      details: error?.payload?.details,
    });
  }
  blockers.push(...validateTaskState(task, gitEvidence, verificationEvidence, args));
  return {
    blocked: blockers.length > 0,
    blockers,
    gitEvidence,
    verificationEvidence,
  };
}

function addWarning(warnings: TaskWorkflowWarning[], code: string, message: string, severity: 'warning' | 'error' = 'warning', details?: unknown) {
  if (warnings.some((warning) => warning.code === code)) return;
  warnings.push({ code, message, severity, ...(details === undefined ? {} : { details }) });
}

export function buildTaskGitWarnings(task: any): TaskWorkflowWarning[] {
  const warnings: TaskWorkflowWarning[] = [];
  if (!task?.projectId) return warnings;

  try {
    const branch = getGitBranch({} as AppState, { projectId: task.projectId });
    const status = getGitStatus({} as AppState, { projectId: task.projectId });
    if (task.branch && branch.current && task.branch !== branch.current) {
      addWarning(warnings, 'TASK_BRANCH_MISMATCH', `Task expects '${task.branch}', but the repository is on '${branch.current}'.`, 'error', {
        taskBranch: task.branch,
        repositoryBranch: branch.current,
      });
    }
    const checklistComplete = !Array.isArray(task.checklist) || task.checklist.every((item: any) => item?.completed);
    if (checklistComplete && status.count > 0) {
      addWarning(warnings, 'WORKING_TREE_DIRTY', 'Checklist is complete but the working tree still has changes.', 'warning', {
        changedFileCount: status.count,
      });
    }
  } catch (error: any) {
    addWarning(warnings, 'GIT_STATUS_UNAVAILABLE', error?.payload?.message || error?.message || 'Git status is unavailable.');
  }

  const evidence = task.gitEvidence as TaskGitEvidence | undefined;
  if (evidence) {
    if (!evidence.trackingBranch) {
      addWarning(warnings, 'UPSTREAM_NOT_CONFIGURED', 'The recorded implementation branch has no upstream tracking branch.');
    }
    if (evidence.diverged) {
      addWarning(warnings, 'BRANCH_DIVERGED', 'Recorded local and remote branches are diverged.', 'error', {
        ahead: evidence.ahead,
        behind: evidence.behind,
      });
    } else {
      if ((evidence.ahead ?? 0) > 0) {
        addWarning(warnings, 'LOCAL_BRANCH_AHEAD', `Recorded branch is ${evidence.ahead} commit(s) ahead of remote.`);
      }
      if ((evidence.behind ?? 0) > 0) {
        addWarning(warnings, 'LOCAL_BRANCH_BEHIND', `Recorded branch is ${evidence.behind} commit(s) behind remote.`);
      }
    }
    if (task.branch && evidence.branch && task.branch !== evidence.branch) {
      addWarning(warnings, 'RECORDED_BRANCH_MISMATCH', `Recorded Git evidence is for '${evidence.branch}', not task branch '${task.branch}'.`, 'error');
    }
  }

  if (task.status === 'ready-for-review' && !evidence?.pushed) {
    addWarning(warnings, 'REVIEW_HEAD_NOT_PUSHED', 'Task is ready-for-review but has no evidence that the current HEAD is published.', 'error');
  }
  if (task.status === 'ready-for-review' && (!Array.isArray(task.verificationEvidence) || task.verificationEvidence.length === 0)) {
    addWarning(warnings, 'REVIEW_VERIFICATION_MISSING', 'Task is ready-for-review without structured verification evidence.', 'error');
  }

  return warnings;
}
