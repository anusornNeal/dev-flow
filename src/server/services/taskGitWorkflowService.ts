import type { AppState } from '../types';
import type { TaskGitEvidence, VerificationEvidenceCheck, VerificationEvidenceStatus } from '../../types';
import { getTasks } from '../repositories/taskRepository';
import { listExecutionSessionsForTask } from '../repositories/executionSessionRepository';
import { getGitBranch, getGitStatus, getGitSyncStatus } from './gitService';
import { createApiError } from './api';
import { getExecutionOwnershipState } from './executionSessionService';
import { resolveProjectRoot } from './localFileService';
import { getSessionWorkspaceMetadataForRecovery } from './sessionWorkspaceService';
import { getTaskPrerequisiteBlockers } from './taskDependencyService.js';

const VALID_VERIFICATION_STATUSES = new Set<VerificationEvidenceStatus>(['passed', 'failed', 'not-run']);
const VALID_VERIFICATION_SCOPES = new Set(['targeted', 'broad', 'full']);
const UNRESOLVED_BUG_STATUSES = new Set(['open', 'fixing', 'fixed', 'reopened']);

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
    const rawScope = entry.scope == null ? '' : String(entry.scope).trim().toLowerCase();
    if (rawScope && !VALID_VERIFICATION_SCOPES.has(rawScope)) {
      throw createApiError(400, 'INVALID_VERIFICATION_SCOPE', `Verification check '${name}' scope must be targeted, broad, or full.`, {
        details: { index, scope: entry.scope },
      });
    }
    const repoRevision = entry.repoRevision == null ? '' : String(entry.repoRevision).trim();
    if (entry.repoRevision != null && !repoRevision) {
      throw createApiError(400, 'INVALID_VERIFICATION_REPO_REVISION', `Verification check '${name}' repoRevision must be a non-empty revision when supplied.`, {
        details: { index },
      });
    }
    return {
      name,
      command,
      status: rawStatus,
      ...(rawScope ? { scope: rawScope as VerificationEvidenceCheck['scope'] } : {}),
      ...(repoRevision ? { repoRevision } : {}),
      summary: typeof entry.summary === 'string' && entry.summary.trim() ? entry.summary.trim() : undefined,
      output: typeof entry.output === 'string' && entry.output.trim() ? entry.output : undefined,
      recordedAt: typeof entry.recordedAt === 'string' && entry.recordedAt.trim() ? entry.recordedAt : now,
    };
  });
}

function collectGitEvidence(
  state: AppState,
  task: any,
  args: Record<string, any>,
  options: { rejectBranchMismatch?: boolean } = {},
): TaskGitEvidence {
  if (!task?.projectId) {
    throw createApiError(400, 'TASK_PROJECT_REQUIRED', 'Task must belong to a project before Git evidence can be collected.', {
      affectedId: task?.id,
    });
  }
  const remote = typeof args.remote === 'string' && args.remote.trim() ? args.remote.trim() : 'origin';
  const workspaceId = typeof args.workspaceId === 'string' && args.workspaceId.trim() ? args.workspaceId.trim() : undefined;
  const managedWorkspace = workspaceId ? getSessionWorkspaceMetadataForRecovery(workspaceId) : null;
  if (workspaceId) {
    if (!managedWorkspace || managedWorkspace.projectId !== task.projectId) {
      throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found for task project '${task.projectId}'.`, { affectedId: workspaceId });
    }
    const claim = task.claim;
    if (!claim || claim.workspaceId !== workspaceId) {
      throw createApiError(409, 'TASK_GIT_EVIDENCE_CLAIM_MISMATCH', 'Managed workspace Git evidence must come from the task active claimed workspace.', {
        affectedId: task.displayId || task.id,
        details: { workspaceId, claimedWorkspaceId: claim?.workspaceId || null },
      });
    }
    const expiresAtMs = Date.parse(String(claim.expiresAt || ''));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw createApiError(409, 'TASK_GIT_EVIDENCE_CLAIM_INACTIVE', 'Managed workspace Git evidence requires a non-expired active task claim.', {
        affectedId: task.displayId || task.id,
        details: { workspaceId, expiresAt: claim.expiresAt || null },
      });
    }
  }
  const sync = getGitSyncStatus(state, {
    projectId: task.projectId,
    workspaceId,
    remote,
    fetch: flag(args.fetch, true),
    forceFresh: flag(args.forceFresh, false),
    nowMs: args.nowMs,
  });
  const expectedBranch = typeof task.branch === 'string' ? task.branch.trim() : '';
  if (workspaceId && sync.branch !== managedWorkspace!.branch) {
    throw createApiError(409, 'TASK_GIT_EVIDENCE_WORKSPACE_BRANCH_MISMATCH', `Managed workspace Git evidence resolved physical branch '${sync.branch}', expected '${managedWorkspace!.branch}'.`, {
      affectedId: task.displayId || task.id,
      details: {
        workspaceId,
        targetBranch: managedWorkspace!.baseBranch,
        expectedWorkspaceBranch: managedWorkspace!.branch,
        observedWorkspaceBranch: sync.branch,
      },
    });
  }
  if (options.rejectBranchMismatch && expectedBranch) {
    if (workspaceId) {
      if (managedWorkspace!.baseBranch !== expectedBranch) {
        throw createApiError(409, 'TASK_GIT_EVIDENCE_BRANCH_MISMATCH', `Task expects base branch '${expectedBranch}' but managed workspace was created from '${managedWorkspace!.baseBranch}'.`, {
          affectedId: task.displayId || task.id,
          details: {
            expectedBranch,
            observedBranch: sync.branch,
            observedBaseBranch: managedWorkspace!.baseBranch,
            evidenceSource: 'managed-workspace',
            workspaceId,
          },
        });
      }
    } else if (sync.branch !== expectedBranch) {
      throw createApiError(409, 'TASK_GIT_EVIDENCE_BRANCH_MISMATCH', `Task expects branch '${expectedBranch}' but Git evidence resolved branch '${sync.branch}'.`, {
        affectedId: task.displayId || task.id,
        details: {
          expectedBranch,
          observedBranch: sync.branch,
          evidenceSource: 'project-root',
        },
      });
    }
  }
  return {
    evidenceSource: workspaceId ? 'managed-workspace' : 'project-root',
    workspaceId,
    branch: sync.branch,
    targetBranch: workspaceId ? managedWorkspace!.baseBranch : undefined,
    workspaceBranch: workspaceId ? managedWorkspace!.branch : undefined,
    commit: sync.localHead,
    remote: sync.remote,
    trackingBranch: sync.trackingBranch,
    remoteHead: sync.remoteHead,
    ahead: sync.ahead,
    behind: sync.behind,
    diverged: sync.diverged,
    pushed: sync.pushed,
    workingTreeClean: sync.workingTreeClean,
    remoteFetchPerformed: sync.remoteFetchPerformed,
    remoteEvidenceReused: sync.remoteEvidenceReused,
    remoteFetchDurationMs: sync.remoteFetchDurationMs,
    remoteEvidenceObservedAt: sync.remoteEvidenceObservedAt,
    remoteEvidenceAgeMs: sync.remoteEvidenceAgeMs,
    recordedAt: new Date().toISOString(),
  };
}

function hasExplicitVerificationEvidenceInput(args: Record<string, any>) {
  return ['checks', 'verificationEvidence', 'tests'].some((key) => Object.prototype.hasOwnProperty.call(args, key));
}

function evidenceTargetBranch(evidence: TaskGitEvidence) {
  return String(evidence.targetBranch || evidence.branch || '').trim();
}

export function deriveParentCompletionVerificationEvidence(task: any, gitEvidence: TaskGitEvidence | undefined): VerificationEvidenceCheck[] {
  if (!task?.id || !task?.projectId || !gitEvidence?.commit) return [];
  const children = getTasks().filter((entry) => entry.projectId === task.projectId && entry.parentId === task.id);
  if (children.length === 0 || children.some((child) => child.status !== 'done')) return [];

  const targetCommit = String(gitEvidence.commit).trim();
  const targetBranch = evidenceTargetBranch(gitEvidence);
  const collected: VerificationEvidenceCheck[] = [];
  for (const child of children) {
    const childGit = child.gitEvidence as TaskGitEvidence | undefined;
    if (!childGit || String(childGit.commit || '').trim() !== targetCommit || childGit.workingTreeClean !== true || childGit.diverged === true) return [];
    if (targetBranch && evidenceTargetBranch(childGit) !== targetBranch) return [];

    const checks = Array.isArray(child.verificationEvidence) ? child.verificationEvidence as VerificationEvidenceCheck[] : [];
    if (checks.length === 0) return [];
    for (const check of checks) {
      const scope = String(check?.scope || '').trim();
      const repoRevision = String(check?.repoRevision || '').trim();
      if (check?.status !== 'passed' || !VALID_VERIFICATION_SCOPES.has(scope) || repoRevision !== targetCommit) return [];
      collected.push({ ...check, scope: scope as VerificationEvidenceCheck['scope'], repoRevision });
    }
  }

  const seen = new Set<string>();
  return collected.filter((check) => {
    const key = [check.name, check.command, check.scope || '', check.repoRevision || ''].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function syncTaskWithGit(state: AppState, task: any, args: Record<string, any>) {
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', 'Task was not found.');
  const gitEvidence = collectGitEvidence(state, task, args, { rejectBranchMismatch: true });
  let verificationEvidence = normalizeVerificationEvidence(args, task);
  if (!hasExplicitVerificationEvidenceInput(args) && verificationEvidence.length === 0) {
    verificationEvidence = deriveParentCompletionVerificationEvidence(task, gitEvidence);
  }
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

function branchValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function isManagedWorkspaceGitEvidence(evidence: TaskGitEvidence | undefined) {
  return Boolean(evidence && (evidence.evidenceSource === 'managed-workspace' || evidence.workspaceId));
}

function managedEvidenceIdentity(evidence: TaskGitEvidence) {
  return {
    targetBranch: branchValue(evidence.targetBranch),
    workspaceBranch: branchValue(evidence.workspaceBranch),
    observedBranch: branchValue(evidence.branch),
  };
}

export function getExecutionOwnershipReviewBlockers(state: AppState, task: any, args: Record<string, any>): ReviewBlocker[] {
  if (!task?.id || !task?.projectId) return [];
  const workspaceId = typeof args.workspaceId === 'string' && args.workspaceId.trim() ? args.workspaceId.trim() : undefined;
  const sessions = listExecutionSessionsForTask(task.id);
  const session = workspaceId
    ? sessions.find((entry) => entry.workspaceId === workspaceId)
    : sessions.find((entry) => !entry.workspaceId);
  if (!session) return [];

  try {
    const root = resolveProjectRoot(state, { projectId: task.projectId, ...(workspaceId ? { workspaceId } : {}) });
    const ownership = getExecutionOwnershipState(session.id, { repoRoot: root });
    const blockers: ReviewBlocker[] = [];
    if (ownership.ownershipDrift.length > 0 && ownership.verificationFresh !== true) {
      addBlocker(blockers, 'EXECUTION_OWNERSHIP_DRIFT', `${ownership.ownershipDrift.length} execution-owned file(s) changed after the last known execution revision.`, {
        files: ownership.ownershipDrift,
        executionSessionId: session.id,
      });
    }
    if (ownership.scopeDrift.length > 0) {
      addBlocker(blockers, 'EXECUTION_SCOPE_DRIFT', `${ownership.scopeDrift.length} changed file(s) are outside the recorded task/session scope.`, {
        files: ownership.scopeDrift,
        executionSessionId: session.id,
      });
    }
    if (ownership.verificationFresh === false) {
      addBlocker(blockers, 'EXECUTION_VERIFICATION_STALE', 'Execution verification evidence is stale because owned content changed after verification.', {
        executionSessionId: session.id,
        verificationRecordedAt: ownership.verificationRecordedAt,
      });
    }
    return blockers;
  } catch (error: any) {
    return [{
      code: 'EXECUTION_OWNERSHIP_UNAVAILABLE',
      message: error?.payload?.message || error?.message || 'Execution ownership state could not be evaluated.',
      details: { executionSessionId: session.id, code: error?.payload?.code || error?.code },
    }];
  }
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
      } else if (isManagedWorkspaceGitEvidence(gitEvidence)) {
        const identity = managedEvidenceIdentity(gitEvidence);
        if (!identity.targetBranch || !identity.workspaceBranch) {
          addBlocker(blockers, 'TASK_BRANCH_EVIDENCE_INCOMPLETE', 'Historical managed-workspace Git evidence does not identify both the logical target branch and physical workspace branch, so task branch authority cannot be proven.', {
            taskBranch: task.branch,
            evidenceBranch: identity.observedBranch || null,
            targetBranch: identity.targetBranch || null,
            workspaceBranch: identity.workspaceBranch || null,
            workspaceId: gitEvidence.workspaceId || null,
          });
        } else {
          if (task.branch !== identity.targetBranch) {
            addBlocker(blockers, 'TASK_BRANCH_MISMATCH', `Task expects target branch '${task.branch}', but managed workspace evidence targets '${identity.targetBranch}'.`, {
              taskBranch: task.branch,
              targetBranch: identity.targetBranch,
              workspaceBranch: identity.workspaceBranch,
              observedBranch: identity.observedBranch || null,
            });
          }
          if (identity.observedBranch && identity.observedBranch !== identity.workspaceBranch) {
            addBlocker(blockers, 'WORKSPACE_BRANCH_EVIDENCE_MISMATCH', `Managed workspace evidence was collected on '${identity.observedBranch}', but its recorded physical branch is '${identity.workspaceBranch}'.`, {
              targetBranch: identity.targetBranch,
              workspaceBranch: identity.workspaceBranch,
              observedBranch: identity.observedBranch,
            });
          }
        }
      } else if (task.branch !== gitEvidence.branch) {
        addBlocker(blockers, 'TASK_BRANCH_MISMATCH', `Task expects branch '${task.branch}', but the repository is on '${gitEvidence.branch}'.`, {
          taskBranch: task.branch,
          repositoryBranch: gitEvidence.branch,
          evidenceSource: gitEvidence.evidenceSource || 'project-root',
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

  const prerequisiteBlockers = getTaskPrerequisiteBlockers(task, getTasks().filter((entry: any) => entry.projectId === task.projectId));
  if (prerequisiteBlockers.length > 0) {
    addBlocker(blockers, 'TASK_PREREQUISITE_DRIFT', `${prerequisiteBlockers.length} prerequisite task(s) are not done.`, {
      prerequisites: prerequisiteBlockers,
      preserveWorkspace: true,
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
  const readinessDebt = validateTaskState(task, gitEvidence, verificationEvidence, args);
  return {
    // Recorded readiness is descriptive lifecycle evidence, not global status authority.
    // Callers that reconcile board status can proceed while preserving this debt explicitly.
    blocked: false,
    blockers: [],
    ready: readinessDebt.length === 0,
    readinessDebt,
    gitEvidence,
    verificationEvidence,
  };
}

export function evaluateReviewSubmission(state: AppState, task: any, args: Record<string, any>) {
  if (!task) throw createApiError(404, 'TASK_NOT_FOUND', 'Task was not found.');
  let verificationEvidence = normalizeVerificationEvidence(args, task);
  let gitEvidence: TaskGitEvidence | undefined;
  const readinessDebt: ReviewBlocker[] = [];
  try {
    gitEvidence = collectGitEvidence(state, task, args);
  } catch (error: any) {
    addBlocker(readinessDebt, 'GIT_EVIDENCE_UNAVAILABLE', error?.payload?.message || error?.message || 'Git evidence could not be collected.', {
      code: error?.payload?.code,
      details: error?.payload?.details,
    });
  }
  if (gitEvidence && !hasExplicitVerificationEvidenceInput(args) && verificationEvidence.length === 0) {
    verificationEvidence = deriveParentCompletionVerificationEvidence(task, gitEvidence);
  }
  readinessDebt.push(...validateTaskState(task, gitEvidence, verificationEvidence, args));
  readinessDebt.push(...getExecutionOwnershipReviewBlockers(state, task, args));
  return {
    // submit-review is allowed to require review readiness for that operation, while the
    // same quality debt must not become global authority over ordinary lifecycle status.
    blocked: readinessDebt.length > 0,
    blockers: readinessDebt,
    ready: readinessDebt.length === 0,
    readinessDebt,
    gitEvidence,
    verificationEvidence,
  };
}

function addWarning(warnings: TaskWorkflowWarning[], code: string, message: string, severity: 'warning' | 'error' = 'warning', details?: unknown) {
  if (warnings.some((warning) => warning.code === code)) return;
  warnings.push({ code, message, severity, ...(details === undefined ? {} : { details }) });
}

type DoneDebtState = 'active' | 'historical' | 'superseded' | 'follow-up-resolved';

interface RecoveryDispositionRecord {
  disposition: Record<string, any>;
  logId: string | null;
  recordedAt: string | null;
}

interface DoneDebtProjection {
  state: DoneDebtState;
  actionable: boolean;
  provenance: Record<string, any> | null;
}

function readRecoveryDispositionFromLogs(task: any): RecoveryDispositionRecord | null {
  const logs = Array.isArray(task?.logs) ? [...task.logs].reverse() : [];
  for (const entry of logs) {
    const message = String(entry?.message || '');
    const marker = '[recovery-disposition] ';
    const index = message.indexOf(marker);
    if (index < 0) continue;
    try {
      const parsed = JSON.parse(message.slice(index + marker.length));
      if (parsed?.classification && parsed?.summary) {
        return {
          disposition: parsed,
          logId: entry?.id ? String(entry.id) : null,
          recordedAt: entry?.timestamp ? String(entry.timestamp) : null,
        };
      }
    } catch {
      // Ignore malformed historical log entries; they must not break task reads.
    }
  }
  return null;
}

function resolveDoneDebtProjection(task: any, recoveryRecord: RecoveryDispositionRecord | null): DoneDebtProjection {
  if (!recoveryRecord) return { state: 'active', actionable: true, provenance: null };

  const disposition = recoveryRecord.disposition;
  const classification = String(disposition.classification || '');
  const baseProvenance: Record<string, any> = {
    source: 'recovery-disposition-log',
    logId: recoveryRecord.logId,
    recordedAt: recoveryRecord.recordedAt,
    classification,
    summary: String(disposition.summary || ''),
    ...(disposition.followUpTaskId ? { followUpTaskId: String(disposition.followUpTaskId) } : {}),
    ...(disposition.workspaceId ? { workspaceId: String(disposition.workspaceId) } : {}),
  };

  if (classification === 'implemented-metadata-drift') {
    return { state: 'historical', actionable: false, provenance: baseProvenance };
  }
  if (classification === 'superseded') {
    return { state: 'superseded', actionable: false, provenance: baseProvenance };
  }
  if (classification === 'follow-up') {
    const followUpTaskId = String(disposition.followUpTaskId || '').trim();
    if (!followUpTaskId) {
      return {
        state: 'active',
        actionable: true,
        provenance: { ...baseProvenance, resolutionState: 'follow-up-reference-missing' },
      };
    }
    const followUpTask = getTasks().find((entry: any) =>
      entry?.projectId === task.projectId
      && entry?.id !== task.id
      && (entry?.id === followUpTaskId || entry?.displayId === followUpTaskId));
    if (!followUpTask) {
      return {
        state: 'active',
        actionable: true,
        provenance: { ...baseProvenance, resolutionState: 'follow-up-not-found' },
      };
    }
    if (followUpTask.status !== 'done') {
      return {
        state: 'active',
        actionable: true,
        provenance: {
          ...baseProvenance,
          resolutionState: 'follow-up-not-done',
          followUpTask: { id: followUpTask.id, displayId: followUpTask.displayId, status: followUpTask.status },
        },
      };
    }
    return {
      state: 'follow-up-resolved',
      actionable: false,
      provenance: {
        ...baseProvenance,
        resolutionState: 'follow-up-done',
        followUpTask: { id: followUpTask.id, displayId: followUpTask.displayId, status: followUpTask.status },
      },
    };
  }

  return { state: 'active', actionable: true, provenance: baseProvenance };
}

function doneDebtDetails(projection: DoneDebtProjection, details: Record<string, any> = {}) {
  return {
    ...details,
    debtState: projection.state,
    actionable: projection.actionable,
    resolutionProvenance: projection.provenance,
  };
}

function doneDebtMessage(projection: DoneDebtProjection, activeMessage: string, debtLabel: string) {
  if (projection.actionable) return activeMessage;
  return `Task is DONE with ${debtLabel} retained as ${projection.state} evidence; explicit durable recovery provenance marks this debt as non-actionable.`;
}

export function buildTaskGitWarnings(task: any): TaskWorkflowWarning[] {
  const warnings: TaskWorkflowWarning[] = [];
  if (!task?.projectId) return warnings;

  const evidence = task.gitEvidence as TaskGitEvidence | undefined;
  const claimWorkspaceId = task.claim?.workspaceId && Date.parse(String(task.claim?.expiresAt || '')) > Date.now()
    ? String(task.claim.workspaceId)
    : '';
  const claimedWorkspace = claimWorkspaceId ? getSessionWorkspaceMetadataForRecovery(claimWorkspaceId) : null;
  const hasManagedBranchContext = Boolean(claimWorkspaceId || isManagedWorkspaceGitEvidence(evidence));

  try {
    const status = getGitStatus({} as AppState, { projectId: task.projectId });
    if (task.branch && claimedWorkspace && task.branch !== claimedWorkspace.baseBranch) {
      addWarning(warnings, 'TASK_BRANCH_MISMATCH', `Task targets '${task.branch}', but its managed workspace targets '${claimedWorkspace.baseBranch}'.`, 'error', {
        taskBranch: task.branch,
        targetBranch: claimedWorkspace.baseBranch,
        workspaceBranch: claimedWorkspace.branch,
        workspaceId: claimedWorkspace.workspaceId,
      });
    } else if (task.branch && claimWorkspaceId && !claimedWorkspace) {
      addWarning(warnings, 'TASK_BRANCH_AUTHORITY_UNAVAILABLE', 'The active managed workspace branch authority is unavailable; project-root branch state is not used as a substitute.', 'error', {
        taskBranch: task.branch,
        workspaceId: claimWorkspaceId,
      });
    } else if (task.branch && !hasManagedBranchContext) {
      const branch = getGitBranch({} as AppState, { projectId: task.projectId });
      if (branch.current && task.branch !== branch.current) {
        addWarning(warnings, 'TASK_BRANCH_MISMATCH', `Task expects '${task.branch}', but the repository is on '${branch.current}'.`, 'error', {
          taskBranch: task.branch,
          repositoryBranch: branch.current,
          evidenceSource: 'project-root',
        });
      }
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
    if (isManagedWorkspaceGitEvidence(evidence)) {
      const identity = managedEvidenceIdentity(evidence);
      if (!identity.targetBranch || !identity.workspaceBranch) {
        addWarning(warnings, 'RECORDED_BRANCH_IDENTITY_INCOMPLETE', 'Recorded managed-workspace Git evidence predates explicit target/workspace branch identity, so branch authority cannot be assumed.', 'error', {
          taskBranch: task.branch || null,
          evidenceBranch: identity.observedBranch || null,
          targetBranch: identity.targetBranch || null,
          workspaceBranch: identity.workspaceBranch || null,
          workspaceId: evidence.workspaceId || null,
        });
      } else {
        if (task.branch && task.branch !== identity.targetBranch) {
          addWarning(warnings, 'RECORDED_BRANCH_MISMATCH', `Recorded managed Git evidence targets '${identity.targetBranch}', not task branch '${task.branch}'.`, 'error', {
            taskBranch: task.branch,
            targetBranch: identity.targetBranch,
            workspaceBranch: identity.workspaceBranch,
            observedBranch: identity.observedBranch || null,
          });
        }
        if (identity.observedBranch && identity.observedBranch !== identity.workspaceBranch) {
          addWarning(warnings, 'RECORDED_WORKSPACE_BRANCH_MISMATCH', `Recorded Git evidence was observed on '${identity.observedBranch}', not physical workspace branch '${identity.workspaceBranch}'.`, 'error', {
            targetBranch: identity.targetBranch,
            workspaceBranch: identity.workspaceBranch,
            observedBranch: identity.observedBranch,
          });
        }
      }
    } else if (task.branch && evidence.branch && task.branch !== evidence.branch) {
      addWarning(warnings, 'RECORDED_BRANCH_MISMATCH', `Recorded project-root Git evidence is for '${evidence.branch}', not task branch '${task.branch}'.`, 'error', {
        taskBranch: task.branch,
        repositoryBranch: evidence.branch,
        evidenceSource: evidence.evidenceSource || 'project-root',
      });
    }
  }

  const recoveryRecord = readRecoveryDispositionFromLogs(task);
  const doneDebtProjection = resolveDoneDebtProjection(task, recoveryRecord);

  if (task.status === 'done') {
    const incomplete = Array.isArray(task.checklist) ? task.checklist.filter((item: any) => !item?.completed) : [];
    if (incomplete.length > 0) {
      addWarning(warnings, 'DONE_CHECKLIST_DEBT', doneDebtMessage(
        doneDebtProjection,
        `Task is DONE with ${incomplete.length} incomplete checklist item(s); DONE records lifecycle completion and does not imply review approval.`,
        `${incomplete.length} incomplete checklist item(s)`,
      ), 'warning', doneDebtDetails(doneDebtProjection, {
        items: incomplete.map((item: any) => ({ id: item.id, text: item.text })),
      }));
    }

    const unresolvedBugs = Array.isArray(task.bugs)
      ? task.bugs.filter((bug: any) => UNRESOLVED_BUG_STATUSES.has(String(bug?.status || '').toLowerCase()))
      : [];
    if (unresolvedBugs.length > 0) {
      addWarning(warnings, 'DONE_UNRESOLVED_BUGS', doneDebtMessage(
        doneDebtProjection,
        `Task is DONE with ${unresolvedBugs.length} unresolved bug thread(s); DONE records lifecycle completion and does not imply defect resolution.`,
        `${unresolvedBugs.length} unresolved bug thread(s)`,
      ), 'warning', doneDebtDetails(doneDebtProjection, {
        bugs: unresolvedBugs.map((bug: any) => ({ id: bug.id, title: bug.title, status: bug.status })),
      }));
    }

    const verificationEvidence = Array.isArray(task.verificationEvidence) ? task.verificationEvidence : [];
    if (verificationEvidence.length === 0) {
      addWarning(warnings, 'DONE_VERIFICATION_MISSING', doneDebtMessage(
        doneDebtProjection,
        'Task is DONE without structured verification evidence; DONE does not imply GREEN verification.',
        'missing structured verification evidence',
      ), 'warning', doneDebtDetails(doneDebtProjection));
    } else {
      const nonPassing = verificationEvidence.filter((check: any) => check?.status !== 'passed');
      if (nonPassing.length > 0) {
        addWarning(warnings, 'DONE_VERIFICATION_NOT_GREEN', doneDebtMessage(
          doneDebtProjection,
          `Task is DONE with ${nonPassing.length} non-passing verification check(s); DONE does not imply GREEN verification.`,
          `${nonPassing.length} non-passing verification check(s)`,
        ), 'warning', doneDebtDetails(doneDebtProjection, {
          checks: nonPassing.map((check: any) => ({ name: check?.name, command: check?.command, status: check?.status })),
        }));
      }
      if (evidence?.commit) {
        const staleRevision = verificationEvidence.filter((check: any) => check?.repoRevision && String(check.repoRevision) !== String(evidence.commit));
        if (staleRevision.length > 0) {
          addWarning(warnings, 'DONE_VERIFICATION_REVISION_MISMATCH', doneDebtMessage(
            doneDebtProjection,
            `Task is DONE with ${staleRevision.length} verification check(s) recorded for a different Git revision.`,
            `${staleRevision.length} verification check(s) recorded for a different Git revision`,
          ), 'warning', doneDebtDetails(doneDebtProjection, {
            commit: evidence.commit,
            checks: staleRevision.map((check: any) => ({ name: check?.name, command: check?.command, repoRevision: check?.repoRevision })),
          }));
        }
      }
    }
    if (!evidence) {
      addWarning(warnings, 'DONE_GIT_EVIDENCE_MISSING', doneDebtMessage(
        doneDebtProjection,
        'Task is DONE without recorded Git evidence; DONE does not imply review approval.',
        'missing recorded Git evidence',
      ), 'warning', doneDebtDetails(doneDebtProjection));
    } else if (!evidence.pushed) {
      addWarning(warnings, 'DONE_HEAD_NOT_PUSHED', doneDebtMessage(
        doneDebtProjection,
        'Task is DONE while the recorded HEAD is not published; DONE does not imply review approval.',
        'an unpublished recorded HEAD',
      ), 'warning', doneDebtDetails(doneDebtProjection));
    }
  }

  if (recoveryRecord) {
    addWarning(warnings, 'RECOVERY_DISPOSITION_RECORDED', `Task closure records recovery disposition '${recoveryRecord.disposition.classification}'.`, 'warning', {
      recoveryDisposition: recoveryRecord.disposition,
      provenance: {
        source: 'recovery-disposition-log',
        logId: recoveryRecord.logId,
        recordedAt: recoveryRecord.recordedAt,
      },
      debtProjection: doneDebtProjection,
    });
  }

  if (task.status === 'ready-for-review' && !evidence?.pushed) {
    addWarning(warnings, 'REVIEW_HEAD_NOT_PUSHED', 'Task is ready-for-review but has no evidence that the current HEAD is published.', 'error');
  }
  if (task.status === 'ready-for-review' && (!Array.isArray(task.verificationEvidence) || task.verificationEvidence.length === 0)) {
    addWarning(warnings, 'REVIEW_VERIFICATION_MISSING', 'Task is ready-for-review without structured verification evidence.', 'error');
  }

  return warnings;
}
