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
  type VerificationCoverageRequirement,
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

export type PostIntegrationVerificationCheck = VerificationImpactCheck & {
  requiredScope: VerificationCoverageRequirement;
};

export type PostIntegrationRequirement = {
  required: boolean;
  reason: string;
  reasonCodes: string[];
  repoRevision: string;
  requiredCommands: string[];
  missingCommands: string[];
  requiredChecks: PostIntegrationVerificationCheck[];
  missingChecks: PostIntegrationVerificationCheck[];
  broadEvidenceRequired: boolean;
  requiredScope: VerificationCoverageRequirement;
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
  const sourceChangedFiles = Array.isArray(integration.changedFiles) ? integration.changedFiles : [];
  const combinedChangedFiles = Array.isArray(integration.combinedChangedFiles) ? integration.combinedChangedFiles : sourceChangedFiles;
  const sourceInspection = inspectProjectVerificationPresets(state, { projectId, changedFiles: sourceChangedFiles });
  const combinedInspection = inspectProjectVerificationPresets(state, { projectId, changedFiles: combinedChangedFiles });
  const requestedCommandSet = new Set(requestedCommands);
  const presetCatalog = [...(sourceInspection?.presets || []), ...(combinedInspection?.presets || [])];
  const seenPresets = new Set<string>();
  const resolvedCommands = presetCatalog
    .filter((preset: any) => {
      const command = String(preset?.command || '');
      if (!requestedCommandSet.has(command) || seenPresets.has(command)) return false;
      seenPresets.add(command);
      return true;
    })
    .map((preset: any) => ({
      command: preset.command,
      semanticKey: preset.semanticKey,
      scope: preset.scope,
      cost: preset.cost,
      resourceKey: preset.resourceKey,
      verificationClass: preset.verificationClass,
      sharedResources: Array.isArray(preset.sharedResources) ? [...preset.sharedResources] : [],
      acceptsTargets: preset.acceptsTargets === true,
    }));
  const sourcePlan = sourceInspection?.plan || planVerification({
    changedFiles: sourceChangedFiles,
    requestedCommands,
    resolvedCommands,
    impactRules,
  });
  const combinedPlan = combinedInspection?.plan || planVerification({
    changedFiles: combinedChangedFiles,
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

const VERIFICATION_SCOPE_RANK: Record<VerificationCoverageRequirement, number> = {
  targeted: 0,
  broad: 1,
  full: 2,
};

function normalizeVerificationScope(value: unknown, fallback: VerificationCoverageRequirement): VerificationCoverageRequirement {
  return value === 'targeted' || value === 'broad' || value === 'full' ? value : fallback;
}

function planRequirementChecks(plan: VerificationPlan): PostIntegrationVerificationCheck[] {
  return plan.steps.map((step) => {
    const targets = normalizeVerificationTargets(step.targets);
    const requiredScope = normalizeVerificationScope(
      (step as any).scope,
      targets.length > 0 ? 'targeted' : plan.coverageRequirement,
    );
    return {
      command: step.command,
      ...(targets.length > 0 ? { targets } : {}),
      requiredScope,
    };
  });
}

function finalizationCheckScope(check: TaskWorkspaceFinalizationCheck): VerificationCoverageRequirement {
  return normalizeVerificationScope(check.scope, normalizeVerificationTargets(check.targets).length > 0 ? 'targeted' : 'broad');
}

function exactTargetsMatch(left: unknown, right: unknown) {
  const leftTargets = normalizeVerificationTargets(left);
  const rightTargets = normalizeVerificationTargets(right);
  return leftTargets.length === rightTargets.length
    && leftTargets.every((target, index) => target === rightTargets[index]);
}

function verificationCheckMatchesRequirement(
  check: TaskWorkspaceFinalizationCheck,
  requirement: PostIntegrationVerificationCheck,
) {
  if (String(check.command || '').trim() !== requirement.command) return false;
  const actualScope = finalizationCheckScope(check);
  if (VERIFICATION_SCOPE_RANK[actualScope] < VERIFICATION_SCOPE_RANK[requirement.requiredScope]) return false;
  const requiredTargets = normalizeVerificationTargets(requirement.targets);
  if (requiredTargets.length === 0 || actualScope !== 'targeted') return true;
  return exactTargetsMatch(check.targets, requiredTargets);
}

function reusableRequirementMatches(
  source: PostIntegrationVerificationCheck,
  requirement: PostIntegrationVerificationCheck,
) {
  if (source.command !== requirement.command) return false;
  if (VERIFICATION_SCOPE_RANK[source.requiredScope] < VERIFICATION_SCOPE_RANK[requirement.requiredScope]) return false;
  const requiredTargets = normalizeVerificationTargets(requirement.targets);
  if (requiredTargets.length === 0 || source.requiredScope !== 'targeted') return true;
  return exactTargetsMatch(source.targets, requiredTargets);
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
  const requiredScope = combinedPlan.coverageRequirement;
  const broadEvidenceRequired = requiredScope !== 'targeted';
  const planEscalated = combinedPlan.risk !== sourcePlan.risk
    || combinedPlan.lane !== sourcePlan.lane
    || combinedPlan.coverageRequirement !== sourcePlan.coverageRequirement
    || combinedPlan.requiresFullRegression !== sourcePlan.requiresFullRegression
    || combinedPlan.commands.some((command) => !sourcePlan.commands.includes(command));
  const revalidationTriggered = baseAdvanced
    || combinedPlan.risk === 'high'
    || combinedPlan.requiresFullRegression
    || planEscalated;
  const revision = integration.baseHeadAfter;
  const revisionChecks = checks.filter((check) => String(check.repoRevision || '').trim() === revision);
  const revisionBound = revisionChecks.filter((check) => check.status === 'passed');
  const revisionAttempts = revisionChecks.filter((check) => check.status !== 'not-run');
  const reusableCommands = new Set(
    coverage && (coverage.status === 'covered' || coverage.status === 'stale')
      ? coverage.coveredCommands
      : [],
  );
  const sourceRequirements = planRequirementChecks(sourcePlan);
  const reusableSourceRequirements = sourceRequirements.filter((requirement) => reusableCommands.has(requirement.command));
  const requiredChecks = planRequirementChecks(combinedPlan);
  const requirementSatisfied = (requirement: PostIntegrationVerificationCheck) => (
    revisionBound.some((check) => verificationCheckMatchesRequirement(check, requirement))
    || reusableSourceRequirements.some((source) => reusableRequirementMatches(source, requirement))
  );
  const missingChecks = requiredChecks.filter((requirement) => !requirementSatisfied(requirement));
  const reusableCoverageSatisfied = Boolean(coverage)
    && (coverage?.status === 'covered' || coverage?.status === 'stale')
    && requiredChecks.length > 0
    && missingChecks.length === 0;
  const finalRequired = revalidationTriggered && missingChecks.length > 0;
  const requiredCommands = requiredChecks.map(verificationRequirementLabel);
  const missingCommands = missingChecks.map(verificationRequirementLabel);

  let reason = 'Pre-integration evidence remains valid for the integrated state.';
  const reasonCodes = new Set<string>();
  const failedRequiredCheck = revisionAttempts.some((check) => check.status === 'failed'
    && missingChecks.some((requirement) => verificationCheckMatchesRequirement(check, requirement)));
  if (finalRequired && failedRequiredCheck) {
    reasonCodes.add('RERUN_REQUIRED_CHECK_NON_PASSING');
    reason = `Post-integration verification was attempted at the integrated revision, but these requirements are still non-passing: ${missingCommands.join(', ')}.`;
  } else if (revalidationTriggered && !finalRequired && reusableCoverageSatisfied) {
    reasonCodes.add('REUSED_EQUIVALENT_COVERAGE');
    if (baseAdvanced) reasonCodes.add('BASE_ADVANCED_OUTSIDE_VERIFIED_INPUTS');
    reason = 'Reusable authoritative verification coverage remains valid for the exact combined affected scope and does not need to be replayed after integration.';
  } else if (finalRequired && baseAdvanced) {
    reasonCodes.add('RERUN_BASE_ADVANCED_AFFECTED_STATE');
    reason = 'The target branch advanced after the workspace base revision, so only verification coverage missing from the recomputed combined affected scope must run at the integrated HEAD.';
  } else if (finalRequired && combinedPlan.requiresFullRegression) {
    reasonCodes.add('RERUN_EXPLICIT_FULL_COMBINED_STATE');
    reason = 'The integrated planner explicitly established repository-wide FULL authority; only the missing FULL requirement remains unsatisfied.';
  } else if (finalRequired && combinedPlan.risk === 'high') {
    reasonCodes.add('RERUN_HIGH_RISK_COMBINED_STATE');
    reason = 'High-risk combined changes require only their still-missing revision-bound verification coverage.';
  } else if (finalRequired && planEscalated) {
    reasonCodes.add('RERUN_COMBINED_PLAN_ESCALATED');
    reason = 'Combined-state impact changed the verification plan after integration; only newly missing coverage must run.';
  }
  if (coverage?.status === 'stale' && finalRequired) reasonCodes.add('RERUN_COVERAGE_IDENTITY_CHANGED');
  if (finalRequired && requiredScope === 'broad') reasonCodes.add('RERUN_BROAD_EVIDENCE_REQUIRED');
  if (finalRequired && requiredScope === 'full') reasonCodes.add('RERUN_FULL_EVIDENCE_REQUIRED');
  if (!finalRequired) reasonCodes.add('SOURCE_EVIDENCE_STILL_VALID');

  return {
    required: finalRequired,
    reason,
    reasonCodes: Array.from(reasonCodes),
    repoRevision: revision,
    requiredCommands,
    missingCommands,
    requiredChecks,
    missingChecks,
    broadEvidenceRequired,
    requiredScope,
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
        scope: required.requiredScope,
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
          scope: required.requiredScope,
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
          scope: required.requiredScope,
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
