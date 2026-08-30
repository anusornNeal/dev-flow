import type { AppState } from '../types.js';
import { createRevisionVerificationWorkspace } from './sessionWorkspaceService.js';
import type { WorkspaceIntegrationSuccess } from './workspaceIntegrationService.js';
import { loadProjectVerificationImpactRules } from './projectCommandConfigService.js';
import {
  inspectProjectVerificationPresets,
  runProjectCommand,
  type RunProjectCommandResult,
} from './projectCommandService.js';
import {
  planVerification,
  type VerificationImpactCheck,
  type VerificationPlan,
} from './verificationPlannerService.js';
import type { TaskVerificationCoverageResolution } from './taskCommitPlanService.js';

export type TaskWorkspaceFinalizationCheck = {
  name?: string;
  command: string;
  targets?: string[];
  status: 'passed' | 'failed' | 'not-run';
  scope?: 'targeted' | 'broad' | 'full';
  repoRevision?: string;
  summary?: string;
  output?: string;
  recordedAt?: string;
  failureKind?: 'timeout' | 'command-failed' | 'command-error' | 'workspace-setup';
};

export type PostIntegrationRequirement = {
  required: boolean;
  reason: string;
  reasonCodes: string[];
  repoRevision: string;
  requiredCommands: string[];
  missingCommands: string[];
  requiredChecks: VerificationImpactCheck[];
  missingChecks: VerificationImpactCheck[];
  broadEvidenceRequired: boolean;
  requiredScope: 'targeted' | 'broad-or-full';
  baseAdvanced: boolean;
  nextAction: {
    action: 'RUN_POST_INTEGRATION_VERIFICATION_AND_RETRY';
    tool: 'finalize_task_workspace';
    bindChecksToRepoRevision: true;
  };
};

export function __verificationImpactRuleCommandsForTests(rule: ReturnType<typeof loadProjectVerificationImpactRules>[number]) {
  return Array.from(new Set([
    ...(Array.isArray(rule?.commands) ? rule.commands : []),
    ...(Array.isArray(rule?.checks) ? rule.checks.map((check) => check?.command) : []),
  ].map((command) => String(command || '').trim()).filter(Boolean)));
}

export function planCombinedVerification(
  state: AppState,
  projectId: string,
  integration: WorkspaceIntegrationSuccess,
  checks: TaskWorkspaceFinalizationCheck[],
  impactRules: ReturnType<typeof loadProjectVerificationImpactRules>,
  coverageCommands: string[] = [],
) {
  const requestedCommands = Array.from(new Set([
    ...checks.map((check) => String(check.command || '').trim()),
    ...coverageCommands.map((command) => String(command || '').trim()),
    ...impactRules.flatMap((rule) => __verificationImpactRuleCommandsForTests(rule)),
  ].filter(Boolean)));
  const inspection = inspectProjectVerificationPresets(state, { projectId });
  const requestedCommandSet = new Set(requestedCommands);
  const resolvedCommands = Array.isArray(inspection?.presets)
    ? inspection.presets
        .filter((preset: any) => requestedCommandSet.has(String(preset?.command || '')))
        .map((preset: any) => ({
          command: preset.command,
          semanticKey: preset.semanticKey,
          scope: preset.scope,
          cost: preset.cost,
          resourceKey: preset.resourceKey,
          verificationClass: preset.verificationClass,
          sharedResources: Array.isArray(preset.sharedResources) ? [...preset.sharedResources] : [],
          acceptsTargets: preset.acceptsTargets === true,
        }))
    : [];
  const sourcePlan = planVerification({
    changedFiles: integration.changedFiles,
    requestedCommands,
    resolvedCommands,
    impactRules,
  });
  const combinedPlan = planVerification({
    changedFiles: integration.combinedChangedFiles,
    requestedCommands,
    resolvedCommands,
    impactRules,
  });
  return { sourcePlan, combinedPlan };
}

export function normalizeVerificationTargets(targets: unknown) {
  return Array.from(new Set(
    (Array.isArray(targets) ? targets : [])
      .map((target) => String(target || '').replace(/\\/g, '/').replace(/^\.\//, '').trim())
      .filter(Boolean),
  )).sort();
}

export function verificationRequirementLabel(check: VerificationImpactCheck) {
  const targets = normalizeVerificationTargets(check.targets);
  return targets.length > 0 ? `${check.command} ${targets.join(' ')}` : check.command;
}

function verificationCheckMatchesRequirement(
  check: TaskWorkspaceFinalizationCheck,
  requirement: VerificationImpactCheck,
) {
  if (String(check.command || '').trim() !== requirement.command) return false;
  const requiredTargets = normalizeVerificationTargets(requirement.targets);
  if (requiredTargets.length === 0) return true;
  const actualTargets = normalizeVerificationTargets(check.targets);
  return actualTargets.length === requiredTargets.length
    && actualTargets.every((target, index) => target === requiredTargets[index]);
}

export function postIntegrationRequirementsAttempted(
  requirement: PostIntegrationRequirement,
  checks: TaskWorkspaceFinalizationCheck[],
): boolean {
  if (!requirement.required || requirement.missingChecks.length === 0) return true;
  const revisionChecks = checks.filter((check) => String(check.repoRevision || '').trim() === requirement.repoRevision);
  return requirement.missingChecks.every((missing) => revisionChecks.some((check) => (
    (check.status === 'failed' || check.status === 'not-run')
    && verificationCheckMatchesRequirement(check, missing)
  )));
}

export function __postIntegrationRequirementsAttemptedForTests(input: {
  requirement: PostIntegrationRequirement;
  checks: TaskWorkspaceFinalizationCheck[];
}) {
  return postIntegrationRequirementsAttempted(input.requirement, input.checks);
}

type PostIntegrationCommandFailureKind = NonNullable<TaskWorkspaceFinalizationCheck['failureKind']>;

function classifyPostIntegrationCommandResult(
  result: Pick<RunProjectCommandResult, 'ok' | 'status' | 'timedOut' | 'exitCode'>,
): PostIntegrationCommandFailureKind | null {
  if (result.ok) return null;
  if (result.timedOut || result.status === 'timed_out') return 'timeout';
  return 'command-failed';
}

export function __classifyPostIntegrationCommandResultForTests(
  result: Pick<RunProjectCommandResult, 'ok' | 'status' | 'timedOut' | 'exitCode'>,
) {
  return classifyPostIntegrationCommandResult(result);
}

export function evaluatePostIntegrationRequirement(
  integration: WorkspaceIntegrationSuccess,
  checks: TaskWorkspaceFinalizationCheck[],
  sourcePlan: VerificationPlan,
  combinedPlan: VerificationPlan,
  coverage: TaskVerificationCoverageResolution | null = null,
): PostIntegrationRequirement {
  const baseAdvanced = integration.baseHeadBefore !== integration.baseRevision;
  const planEscalated = combinedPlan.risk !== sourcePlan.risk
    || combinedPlan.lane !== sourcePlan.lane
    || combinedPlan.requiresBroadVerify !== sourcePlan.requiresBroadVerify
    || combinedPlan.commands.some((command) => !sourcePlan.commands.includes(command));
  const required = baseAdvanced || combinedPlan.risk === 'high' || planEscalated;
  const revision = integration.baseHeadAfter;
  const revisionChecks = checks.filter((check) => String(check.repoRevision || '').trim() === revision);
  const revisionBound = revisionChecks.filter((check) => check.status === 'passed');
  const revisionAttempts = revisionChecks.filter((check) => check.status !== 'not-run');
  const hasFullEvidence = revisionBound.some((check) => check.scope === 'full');
  const hasBroadEvidence = hasFullEvidence || revisionBound.some((check) => check.scope === 'broad');
  const broadEvidenceRequired = combinedPlan.requiresBroadVerify;
  const reusableCommands = new Set(
    coverage && (coverage.status === 'covered' || coverage.status === 'stale')
      ? coverage.coveredCommands
      : [],
  );
  const requiredChecks: VerificationImpactCheck[] = combinedPlan.steps.map((step) => ({
    command: step.command,
    ...(step.targets?.length ? { targets: normalizeVerificationTargets(step.targets) } : {}),
  }));
  let missingChecks = hasFullEvidence
    ? []
    : requiredChecks.filter((requirement) => {
        if (revisionBound.some((check) => verificationCheckMatchesRequirement(check, requirement))) return false;
        return normalizeVerificationTargets(requirement.targets).length > 0
          || !reusableCommands.has(requirement.command);
      });
  const reusableCoverageSatisfied = Boolean(coverage)
    && (coverage?.status === 'covered' || coverage?.status === 'stale')
    && missingChecks.length === 0
    && (requiredChecks.length === 0 || requiredChecks.every((requirement) => {
      if (revisionBound.some((check) => verificationCheckMatchesRequirement(check, requirement))) return true;
      return normalizeVerificationTargets(requirement.targets).length === 0
        && reusableCommands.has(requirement.command);
    }));
  if (
    required
    && broadEvidenceRequired
    && !hasBroadEvidence
    && !reusableCoverageSatisfied
    && missingChecks.length === 0
    && requiredChecks.length > 0
  ) {
    missingChecks = [
      requiredChecks.find((requirement) => normalizeVerificationTargets(requirement.targets).length === 0)
        || requiredChecks[0],
    ];
  }
  const requiredCommands = requiredChecks.map(verificationRequirementLabel);
  const missingCommands = missingChecks.map(verificationRequirementLabel);
  const noCommandsRequired = requiredChecks.length === 0;
  const evidenceSatisfied = !required
    || (!broadEvidenceRequired && noCommandsRequired)
    || (missingCommands.length === 0
      && (reusableCoverageSatisfied || (broadEvidenceRequired ? hasBroadEvidence : revisionBound.length > 0)));

  let reason = 'Pre-integration evidence remains valid for the integrated state.';
  const reasonCodes = new Set<string>();
  if (required && revisionAttempts.some((check) => check.status === 'failed') && missingChecks.length > 0) {
    reasonCodes.add('RERUN_REQUIRED_CHECK_NON_PASSING');
    reason = `Post-integration verification was attempted at the integrated revision, but these requirements are still non-passing: ${missingCommands.join(', ')}.`;
  } else if (required && evidenceSatisfied && reusableCoverageSatisfied) {
    reasonCodes.add('REUSED_EQUIVALENT_COVERAGE');
    if (baseAdvanced) reasonCodes.add('BASE_ADVANCED_OUTSIDE_VERIFIED_INPUTS');
    reason = 'Reusable authoritative verification coverage remains valid for the integrated affected inputs, dependencies, command configuration, and environment.';
  } else if (required && baseAdvanced) {
    reasonCodes.add('RERUN_BASE_ADVANCED_AFFECTED_STATE');
    reason = 'The target branch advanced after the workspace base revision and reusable coverage is incomplete, so combined-state verification must be revision-bound to the integrated HEAD.';
  } else if (required && combinedPlan.risk === 'high') {
    reasonCodes.add('RERUN_HIGH_RISK_COMBINED_STATE');
    reason = 'High-risk combined changes require revision-bound post-integration verification.';
  } else if (required && planEscalated) {
    reasonCodes.add('RERUN_COMBINED_PLAN_ESCALATED');
    reason = 'Combined-state impact escalated the verification plan after integration.';
  }
  if (coverage?.status === 'stale' && missingChecks.length > 0) reasonCodes.add('RERUN_COVERAGE_IDENTITY_CHANGED');
  if (required && broadEvidenceRequired && !hasBroadEvidence && !reusableCoverageSatisfied) reasonCodes.add('RERUN_BROAD_EVIDENCE_REQUIRED');
  if (!required) reasonCodes.add('SOURCE_EVIDENCE_STILL_VALID');

  return {
    required: required && !evidenceSatisfied,
    reason,
    reasonCodes: Array.from(reasonCodes),
    repoRevision: revision,
    requiredCommands,
    missingCommands,
    requiredChecks,
    missingChecks,
    broadEvidenceRequired,
    requiredScope: broadEvidenceRequired ? 'broad-or-full' : 'targeted',
    baseAdvanced,
    nextAction: {
      action: 'RUN_POST_INTEGRATION_VERIFICATION_AND_RETRY',
      tool: 'finalize_task_workspace',
      bindChecksToRepoRevision: true,
    },
  };
}

export function __evaluatePostIntegrationRequirementForTests(input: {
  integration: WorkspaceIntegrationSuccess;
  checks: TaskWorkspaceFinalizationCheck[];
  sourcePlan: VerificationPlan;
  combinedPlan: VerificationPlan;
  coverage?: TaskVerificationCoverageResolution | null;
}) {
  return evaluatePostIntegrationRequirement(
    input.integration,
    input.checks,
    input.sourcePlan,
    input.combinedPlan,
    input.coverage || null,
  );
}

export function executeRevisionBoundPostIntegrationVerification(
  state: AppState,
  project: { id: string; localPath?: string | null },
  operationId: string,
  requirement: PostIntegrationRequirement,
) {
  const checks: TaskWorkspaceFinalizationCheck[] = [];
  let cleanup: { removed: boolean; cleanupError?: string } = { removed: false };
  let setup: { status: 'succeeded' | 'failed'; error?: string } = { status: 'succeeded' };
  let sandbox: ReturnType<typeof createRevisionVerificationWorkspace> | null = null;
  try {
    sandbox = createRevisionVerificationWorkspace(project, requirement.repoRevision, operationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setup = { status: 'failed', error: message };
    for (const required of requirement.missingChecks) {
      const targets = normalizeVerificationTargets(required.targets);
      checks.push({
        name: `post-integration: ${verificationRequirementLabel(required)}`,
        command: required.command,
        ...(targets.length > 0 ? { targets } : {}),
        status: 'failed',
        failureKind: 'workspace-setup',
        scope: requirement.broadEvidenceRequired ? 'broad' : 'targeted',
        repoRevision: requirement.repoRevision,
        summary: `Verify-only workspace setup failed: ${message}`,
        recordedAt: new Date().toISOString(),
      });
    }
    return { checks, cleanup, repoRevision: requirement.repoRevision, setup };
  }

  try {
    for (const required of requirement.missingChecks) {
      const targets = normalizeVerificationTargets(required.targets);
      try {
        const result = runProjectCommand(state, {
          localPath: sandbox.root,
          command: required.command,
          ...(targets.length > 0 ? { targets } : {}),
          forceFresh: true,
          responseMode: 'compact',
        });
        const failureKind = classifyPostIntegrationCommandResult(result);
        checks.push({
          name: `post-integration: ${verificationRequirementLabel(required)}`,
          command: required.command,
          ...(targets.length > 0 ? { targets } : {}),
          status: result.ok ? 'passed' : 'failed',
          ...(failureKind ? { failureKind } : {}),
          scope: requirement.broadEvidenceRequired ? 'broad' : 'targeted',
          repoRevision: sandbox.repoRevision,
          summary: result.ok
            ? 'Passed in isolated verify-only workspace at the integrated revision.'
            : failureKind === 'timeout'
              ? `Verification timed out after ${result.durationMs}ms.`
              : `Verification failed with exit code ${result.exitCode ?? 'unknown'}.`,
          output: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 8000),
          recordedAt: new Date().toISOString(),
        });
      } catch (error) {
        checks.push({
          name: `post-integration: ${verificationRequirementLabel(required)}`,
          command: required.command,
          ...(targets.length > 0 ? { targets } : {}),
          status: 'failed',
          failureKind: 'command-error',
          scope: requirement.broadEvidenceRequired ? 'broad' : 'targeted',
          repoRevision: sandbox.repoRevision,
          summary: error instanceof Error ? error.message : String(error),
          recordedAt: new Date().toISOString(),
        });
      }
    }
  } finally {
    try {
      cleanup = sandbox.cleanup();
    } catch (error) {
      cleanup = {
        removed: false,
        cleanupError: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { checks, cleanup, repoRevision: sandbox.repoRevision, setup };
}
