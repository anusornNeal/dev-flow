import type { AppState } from '../types.js';
import { getProject } from '../repositories/projectRepository.js';
import { getTaskByIdentifier } from '../repositories/taskRepository.js';
import { getLatestTaskFinalizationOperation } from '../repositories/taskFinalizationOperationRepository.js';
import { buildTaskCommitPlan, commitTaskOwnedChanges } from './taskCommitPlanService.js';
import { getRepoRevisionForRoot } from './repoRevisionService.js';
import { inspectWorkspaceRecovery } from './workspaceRecoveryService.js';
import type { VerificationImpactCheck } from './verificationPlannerService.js';
import {
  normalizeVerificationTargets,
  verificationRequirementLabel,
  type TaskWorkspaceFinalizationCheck,
} from './taskWorkspaceFinalizationVerificationService.js';

export type TaskWorkspaceHappyPathTailVerificationRequest = {
  projectId: string;
  command: string;
  targets?: string[];
  repoRevision: string;
  requiredScope: 'targeted' | 'broad-or-full';
};

export type TaskWorkspaceHappyPathTailInput = {
  taskId: string;
  workspaceId: string;
  commitMessage: string;
  triggerJobId?: string;
  completedChecklistIds?: string[];
};

export type TaskWorkspaceHappyPathTailVerificationRunner = (
  request: TaskWorkspaceHappyPathTailVerificationRequest,
) => Promise<any>;

export type TaskWorkspaceFinalizer = (
  state: AppState,
  input: {
    taskId: string;
    workspaceId: string;
    operationId?: string;
    checks?: TaskWorkspaceFinalizationCheck[];
    deferPostIntegrationVerification?: boolean;
    completedChecklistIds?: string[];
  },
) => any;

function autonomousTailAttention(
  stage: string,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return { ok: false as const, status: 'attention' as const, stage, code, message, ...extra };
}

export async function runTaskWorkspaceHappyPathTailWithFinalizer(
  state: AppState,
  input: TaskWorkspaceHappyPathTailInput,
  finalizeTaskWorkspace: TaskWorkspaceFinalizer,
  runPostIntegrationVerification?: TaskWorkspaceHappyPathTailVerificationRunner,
) {
  const taskId = String(input.taskId || '').trim();
  const workspaceId = String(input.workspaceId || '').trim();
  const commitMessage = String(input.commitMessage || '').trim();
  const transitions: Array<{ stage: string; status: string; detail?: string }> = [];
  if (!taskId || !workspaceId) {
    return autonomousTailAttention(
      'admission',
      'AUTONOMOUS_TAIL_IDENTITY_REQUIRED',
      'Autonomous tail requires an exact task and managed workspace identity.',
    );
  }
  if (!commitMessage) {
    return autonomousTailAttention(
      'admission',
      'AUTONOMOUS_TAIL_COMMIT_MESSAGE_REQUIRED',
      'Autonomous tail will not guess a commit message; the initiating verification handoff must provide one.',
    );
  }

  const existingTask = getTaskByIdentifier(taskId, 'full');
  const existingFinalization = existingTask
    ? getLatestTaskFinalizationOperation(existingTask.id, workspaceId)
    : null;
  if (existingTask?.status === 'done' && existingFinalization?.status === 'completed') {
    transitions.push({ stage: 'finalization', status: 'already-completed', detail: existingFinalization.id });
    return {
      ok: true as const,
      status: 'completed' as const,
      taskId,
      workspaceId,
      triggerJobId: input.triggerJobId || null,
      operationId: existingFinalization.id,
      idempotent: true,
      transitions,
      result: { status: 'completed', operation: existingFinalization, task: existingTask },
    };
  }

  let operationId = existingFinalization && existingFinalization.status !== 'completed'
    ? existingFinalization.id
    : undefined;

  if (operationId) {
    transitions.push({ stage: 'finalization', status: 'resuming', detail: operationId });
  } else {
    let plan: ReturnType<typeof buildTaskCommitPlan>;
    try {
      plan = buildTaskCommitPlan(state, { taskId, workspaceId });
    } catch (error: any) {
      return autonomousTailAttention(
        'commit-plan',
        String(error?.payload?.code || error?.code || 'AUTONOMOUS_TAIL_COMMIT_PLAN_FAILED'),
        String(error?.message || 'Commit planning failed.'),
        { transitions },
      );
    }
    const planDebt = (plan as any).qualityDebt;
    const workspaceRecovery = inspectWorkspaceRecovery(workspaceId);
    const noOwnedChangesOnly = plan.blockers.length === 1
      && plan.blockers[0]?.code === 'TASK_COMMIT_NO_OWNED_CHANGES';
    const cleanNoOpSource = noOwnedChangesOnly
      && plan.ownedChangedFiles.length === 0
      && plan.unrelatedChangedFiles.length === 0
      && plan.scopeDrift.length === 0
      && plan.ownershipDrift.length === 0
      && workspaceRecovery.dirtyFiles.length === 0
      && workspaceRecovery.uniqueCommits.length === 0
      && ['already-integrated', 'patch-equivalent'].includes(workspaceRecovery.disposition);
    const effectiveBlockers = cleanNoOpSource ? [] : plan.blockers;
    if (
      effectiveBlockers.length > 0
      || plan.verificationFresh !== true
      || plan.verificationCoverage?.status !== 'covered'
      || plan.verificationCoverage?.reusable !== true
      || (planDebt && planDebt.status !== 'clear')
    ) {
      return autonomousTailAttention(
        'commit-plan',
        'AUTONOMOUS_TAIL_SOURCE_NOT_GREEN',
        'Autonomous tail stops unless source verification and ownership are unambiguously GREEN and reusable.',
        {
          transitions,
          blockers: effectiveBlockers,
          verificationFresh: plan.verificationFresh,
          verificationCoverage: plan.verificationCoverage,
          qualityDebt: planDebt || null,
        },
      );
    }
    if (plan.commitDisposition === 'ambiguous-no-changes' && !cleanNoOpSource) {
      return autonomousTailAttention(
        'commit-plan',
        'AUTONOMOUS_TAIL_COMMIT_AMBIGUOUS',
        'Autonomous tail cannot prove whether a task-owned commit is required.',
        { transitions },
      );
    }

    try {
      if (cleanNoOpSource) {
        transitions.push({
          stage: 'commit',
          status: 'skipped-clean-no-op',
          detail: workspaceRecovery.disposition,
        });
      } else if (plan.commitDisposition === 'commit-required') {
        const committed = commitTaskOwnedChanges(state, { taskId, workspaceId, message: commitMessage });
        transitions.push({
          stage: 'commit',
          status: 'completed',
          detail: String((committed as any).commitHash || (committed as any).hash || ''),
        });
      } else {
        transitions.push({
          stage: 'commit',
          status: 'already-completed',
          detail: String(plan.alreadyCommitted?.commitHash || ''),
        });
      }
    } catch (error: any) {
      return autonomousTailAttention(
        'commit',
        String(error?.payload?.code || error?.code || 'AUTONOMOUS_TAIL_COMMIT_FAILED'),
        String(error?.message || 'Task-owned commit failed.'),
        { transitions },
      );
    }
  }

  let postIntegrationChecks: TaskWorkspaceFinalizationCheck[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let result: any;
    try {
      result = finalizeTaskWorkspace(state, {
        taskId,
        workspaceId,
        ...(operationId ? { operationId } : {}),
        checks: postIntegrationChecks,
        deferPostIntegrationVerification: Boolean(runPostIntegrationVerification),
        ...(Array.isArray(input.completedChecklistIds) ? { completedChecklistIds: input.completedChecklistIds } : {}),
      });
    } catch (error: any) {
      return autonomousTailAttention(
        'finalization',
        String(error?.payload?.code || error?.code || 'AUTONOMOUS_TAIL_FINALIZATION_FAILED'),
        String(error?.message || 'Finalization failed.'),
        { transitions, operationId: operationId || null },
      );
    }
    operationId = String(result?.operation?.id || operationId || '').trim() || undefined;

    if (result?.status === 'completed') {
      transitions.push({ stage: 'finalization', status: 'completed', detail: operationId });
      return {
        ok: true as const,
        status: 'completed' as const,
        taskId,
        workspaceId,
        triggerJobId: input.triggerJobId || null,
        operationId: operationId || null,
        transitions,
        result,
      };
    }

    if (result?.status === 'cleanup-pending') {
      transitions.push({ stage: 'cleanup', status: 'retrying', detail: operationId });
      if (attempt < 3) continue;
      return autonomousTailAttention(
        'cleanup',
        'FINALIZATION_CLEANUP_PENDING',
        'Managed workspace cleanup remains pending after bounded idempotent retry.',
        { transitions, operationId: operationId || null, result },
      );
    }

    const postIntegration = result?.postIntegration;
    if (result?.status === 'continuation' && postIntegration?.required === true) {
      const normalizeChecks = (value: unknown): VerificationImpactCheck[] => Array.isArray(value)
        ? value.flatMap((entry: any) => {
            const command = String(entry?.command || '').trim();
            if (!command) return [];
            const targets = normalizeVerificationTargets(entry?.targets);
            return [{ command, ...(targets.length ? { targets } : {}) }];
          })
        : [];
      const missingChecks = normalizeChecks(postIntegration.missingChecks);
      const requiredChecks = normalizeChecks(postIntegration.requiredChecks);
      const checksToRun = missingChecks.length > 0 ? missingChecks : requiredChecks;
      if (!runPostIntegrationVerification || checksToRun.length === 0) {
        return autonomousTailAttention(
          'post-integration-verification',
          'POST_INTEGRATION_VERIFICATION_REQUIRED',
          String(postIntegration.reason || 'Post-integration verification requires attention.'),
          { transitions, operationId: operationId || null, postIntegration },
        );
      }
      const project = getProject(String(result?.operation?.projectId || '').trim());
      if (!project?.localPath) {
        return autonomousTailAttention(
          'post-integration-verification',
          'FINALIZATION_PROJECT_ROOT_REQUIRED',
          'Project root is unavailable for autonomous post-integration verification.',
          { transitions, operationId: operationId || null },
        );
      }
      const expectedHead = String(postIntegration.repoRevision || '').trim();
      const before = getRepoRevisionForRoot(project.localPath);
      if (!expectedHead || before.head !== expectedHead || before.changedFiles.length > 0) {
        return autonomousTailAttention(
          'post-integration-verification',
          'POST_INTEGRATION_REVISION_DRIFT',
          'Integrated project state changed before autonomous post-integration verification could start.',
          {
            transitions,
            expectedHead,
            observedHead: before.head,
            changedFiles: before.changedFiles.map((entry) => entry.path),
          },
        );
      }

      const verificationResults = await Promise.all(checksToRun.map(async (requirement) => {
        const command = requirement.command;
        const targets = normalizeVerificationTargets(requirement.targets);
        const verification = await runPostIntegrationVerification({
          projectId: project.id,
          command,
          ...(targets.length ? { targets } : {}),
          repoRevision: expectedHead,
          requiredScope: postIntegration.requiredScope === 'broad-or-full' ? 'broad-or-full' : 'targeted',
        });
        return { requirement, command, targets, verification };
      }));
      const after = getRepoRevisionForRoot(project.localPath);
      if (after.head !== expectedHead || after.changedFiles.length > 0) {
        return autonomousTailAttention(
          'post-integration-verification',
          'POST_INTEGRATION_REVISION_DRIFT',
          'Integrated project state changed during autonomous post-integration verification.',
          {
            transitions,
            expectedHead,
            observedHead: after.head,
            changedFiles: after.changedFiles.map((entry) => entry.path),
          },
        );
      }
      const failedVerification = verificationResults.find(({ verification }) => (
        !verification?.ok || verification?.status !== 'succeeded' || verification?.exitCode !== 0
      ));
      if (failedVerification) {
        const { command, verification } = failedVerification;
        return autonomousTailAttention(
          'post-integration-verification',
          'POST_INTEGRATION_VERIFICATION_FAILED',
          `Post-integration verification '${command}' failed; autonomous tail stopped without guessing a repair.`,
          {
            transitions,
            command,
            operationId: operationId || null,
            verification: {
              status: verification?.status || 'failed',
              exitCode: verification?.exitCode ?? null,
              timedOut: verification?.timedOut === true,
            },
          },
        );
      }
      const checks: TaskWorkspaceFinalizationCheck[] = verificationResults.map(({ requirement, command, targets }) => {
        transitions.push({ stage: 'post-integration-verification', status: 'passed', detail: command });
        return {
          name: `autonomous post-integration: ${verificationRequirementLabel(requirement)}`,
          command,
          ...(targets.length ? { targets } : {}),
          status: 'passed' as const,
          scope: postIntegration.requiredScope === 'broad-or-full' ? 'broad' as const : 'targeted' as const,
          repoRevision: expectedHead,
          summary: 'Autonomous tail ran the finalizer-required post-integration verification against the exact integrated HEAD.',
        };
      });
      postIntegrationChecks = checks;
      continue;
    }

    const code = String(
      result?.code
      || result?.continuation?.error?.code
      || result?.operation?.failure?.code
      || 'AUTONOMOUS_TAIL_ATTENTION_REQUIRED',
    );
    return autonomousTailAttention(
      'finalization',
      code,
      String(
        result?.message
        || result?.continuation?.message
        || 'Finalization requires explicit recovery or attention.',
      ),
      { transitions, operationId: operationId || null, result },
    );
  }

  return autonomousTailAttention(
    'finalization',
    'AUTONOMOUS_TAIL_RETRY_BUDGET_EXHAUSTED',
    'Autonomous tail exceeded its bounded continuation retry budget.',
    { transitions, operationId: operationId || null },
  );
}
