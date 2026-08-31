export type VerificationStep = {
  label: string;
  command: string;
  args: string[];
  stage: number;
  parallelSafe: boolean;
  parallelWeight?: number;
  exclusiveResources?: string[];
  expectedDurationMs?: number;
  databasePathMode?: 'runner' | 'self-managed';
};

export const FULL_VERIFY_PARALLELISM = 6;

export type VerificationStageSegment = {
  parallel: boolean;
  steps: VerificationStep[];
};

export function buildVerificationStageSegments(steps: VerificationStep[]): VerificationStageSegment[] {
  const segments: VerificationStageSegment[] = [];
  for (const step of steps) {
    const parallel = step.parallelSafe;
    const current = segments[segments.length - 1];
    if (current && current.parallel === parallel) {
      current.steps.push(step);
      continue;
    }
    segments.push({ parallel, steps: [step] });
  }
  return segments;
}

export function verificationStepWeight(step: VerificationStep) {
  return Math.max(1, Math.min(FULL_VERIFY_PARALLELISM, step.parallelWeight ?? 1));
}

export function findRunnableVerificationStepIndex(
  steps: VerificationStep[],
  availableCapacity: number,
  activeResources: ReadonlySet<string> = new Set(),
) {
  let bestIndex = -1;
  let bestExpectedDurationMs = -1;
  for (const [index, step] of steps.entries()) {
    if (verificationStepWeight(step) > availableCapacity) continue;
    if ((step.exclusiveResources ?? []).some((resource) => activeResources.has(resource))) continue;
    const expectedDurationMs = Math.max(0, step.expectedDurationMs ?? 0);
    if (expectedDurationMs <= bestExpectedDurationMs) continue;
    bestIndex = index;
    bestExpectedDurationMs = expectedDurationMs;
  }
  return bestIndex;
}

const TASK_FINALIZATION_FOUNDATION_PATTERN_BODY = '(?:already-committed|detached finalization|committed workspace|execution-stage finalization|finalization rejects malformed|dirty workspace|integration conflict)';
const TASK_FINALIZATION_COVERAGE_PATTERN_BODY = '(?:finalization preserves|finalization rejects invalid|finalization records|reusable coverage|combined repository mapping|post-integration evidence failure)';
const TASK_FINALIZATION_DURABLE_PATTERN_BODY = '(?:durable finalization operation)';
const TASK_FINALIZATION_AUTONOMOUS_PATTERN_BODY = '(?:autonomous tail |autonomous happy-path tail)';
const TASK_FINALIZATION_EDGE_PATTERN_BODY = '(?:task presentation drift|fresh retry|frozen finalization operation|local finalization|cleanup failure|reopened prerequisite)';

export const VERIFICATION_STEPS: VerificationStep[] = [
  { label: 'lint', command: 'npm', args: ['run', 'lint'], stage: 0, parallelSafe: false },
  { label: 'devflow restart route', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowRestartRoute.test.ts'], stage: 1, parallelSafe: true },
  { label: 'devflow restart contract', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowRestartContract.test.ts'], stage: 1, parallelSafe: true },
  { label: 'devflow restart state', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowRestartState.test.ts'], stage: 1, parallelSafe: true },
  { label: 'devflow contract', command: 'npx', args: ['tsx', 'scripts/verify-devflow-contract.ts'], stage: 1, parallelSafe: true },
  { label: 'devflow tool profiles', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowToolProfile.test.ts'], stage: 1, parallelSafe: true },
  { label: 'task claim service', command: 'npx', args: ['tsx', '--test', 'tests/server/taskClaimService.test.ts'], stage: 2, parallelSafe: true, parallelWeight: 2, exclusiveResources: ['git-authority', 'io-heavy'], expectedDurationMs: 100_500 },
  { label: 'task claim routes', command: 'npx', args: ['tsx', '--test', 'tests/server/taskRouteModules.test.ts'], stage: 2, parallelSafe: true },
  { label: 'task claim contract', command: 'npx', args: ['tsx', '--test', 'tests/server/taskClaimContract.test.ts'], stage: 2, parallelSafe: true },
  { label: 'board loop skill registry', command: 'npx', args: ['tsx', '--test', 'tests/server/skillsRegistrySeed.test.ts'], stage: 2, parallelSafe: true },
  { label: 'board loop skill content', command: 'npx', args: ['tsx', '--test', 'tests/server/authoringSkillContent.test.ts'], stage: 2, parallelSafe: true },
  { label: 'task claim card ui', command: 'npx', args: ['tsx', '--test', 'tests/taskCardClaimUi.test.ts'], stage: 2, parallelSafe: true },
  { label: 'board refresh and atlas ui retirement', command: 'npx', args: ['tsx', '--test', 'tests/viewModels/boardPagingState.test.ts', 'tests/server/serverEventsClient.test.ts', 'tests/scripts/startAllHmrPolicy.test.ts', 'tests/server/projectAtlasUiRemoval.test.ts', 'tests/components/sidebarLayout.test.tsx', 'tests/components/projectSwitcher.test.tsx'], stage: 2, parallelSafe: true },
  { label: 'ui preview library repository service', command: 'npx', args: ['tsx', '--test', 'tests/server/uiPreviewRepository.test.ts', 'tests/server/uiPreviewService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'ui preview library routes', command: 'npx', args: ['tsx', '--test', 'tests/server/uiPreviewRoutes.test.ts'], stage: 2, parallelSafe: true },
  { label: 'ui preview frozen evidence attach', command: 'npx', args: ['tsx', '--test', 'tests/server/taskUiEvidenceService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'ui preview library client ui', command: 'npx', args: ['tsx', '--test', 'tests/client/uiPreviewClient.test.ts', 'tests/components/uiPreviewLibraryPage.test.tsx', 'tests/components/uiDesignEvidenceSection.test.tsx'], stage: 2, parallelSafe: true },
  { label: 'project atlas cache', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasCacheService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas agent update', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasAgentUpdateService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas api', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasApiService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas domains', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasDomainService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas exports', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasExport.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas impact', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasImpactService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas prompt templates', command: 'npx', args: ['tsx', '--test', 'tests/lib/projectAtlasPromptTemplates.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas scanner', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasScannerService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas view model', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasViewModel.test.ts'], stage: 2, parallelSafe: true },
  { label: 'task detail bug visibility', command: 'npx', args: ['tsx', '--test', 'tests/components/taskDetailsDrawerBugThreads.test.tsx'], stage: 2, parallelSafe: true },
  { label: 'project command service', command: 'npx', args: ['tsx', '--test', 'tests/server/projectCommandService.test.ts'], stage: 2, parallelSafe: true, parallelWeight: 3, exclusiveResources: ['command-runtime'], expectedDurationMs: 47_300 },
  { label: 'git workflow service', command: 'npx', args: ['tsx', '--test', 'tests/server/gitWorkflowService.test.ts'], stage: 2, parallelSafe: true, expectedDurationMs: 22_300 },
  { label: 'local path mutation service', command: 'npx', args: ['tsx', '--test', 'tests/server/localPathMutationService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'task git workflow service', command: 'npx', args: ['tsx', '--test', 'tests/server/taskGitWorkflowService.test.ts'], stage: 2, parallelSafe: true, exclusiveResources: ['git-authority'], expectedDurationMs: 37_400 },
  { label: 'task commit plan', command: 'npx', args: ['tsx', '--test', 'tests/server/taskCommitPlanService.test.ts', 'tests/server/devflowContractModules.test.ts', 'tests/server/mcpToolJobRunnerRegistry.test.ts'], stage: 2, parallelSafe: true, exclusiveResources: ['git-authority'], expectedDurationMs: 60_300 },
  { label: 'task manual move recovery', command: 'npx', args: ['tsx', '--test', 'tests/server/taskManualMovePolicy.test.ts', 'tests/server/taskManualMoveRoutes.test.ts'], stage: 2, parallelSafe: true, expectedDurationMs: 20_200 },
  { label: 'task workspace finalization foundation', command: 'npx', args: ['tsx', '--test', `--test-name-pattern=^${TASK_FINALIZATION_FOUNDATION_PATTERN_BODY}`, 'tests/server/taskWorkspaceFinalizationService.test.ts'], stage: 2, parallelSafe: true, parallelWeight: 3, expectedDurationMs: 34_300 },
  { label: 'task workspace finalization coverage', command: 'npx', args: ['tsx', '--test', `--test-name-pattern=^${TASK_FINALIZATION_COVERAGE_PATTERN_BODY}`, 'tests/server/taskWorkspaceFinalizationService.test.ts'], stage: 2, parallelSafe: true, parallelWeight: 3, expectedDurationMs: 32_000 },
  { label: 'task workspace finalization durable recovery', command: 'npx', args: ['tsx', '--test', `--test-name-pattern=^${TASK_FINALIZATION_DURABLE_PATTERN_BODY}`, 'tests/server/taskWorkspaceFinalizationService.test.ts'], stage: 2, parallelSafe: true, parallelWeight: 3, exclusiveResources: ['io-heavy'], expectedDurationMs: 49_300 },
  { label: 'task workspace finalization autonomous tail', command: 'npx', args: ['tsx', '--test', `--test-name-pattern=^${TASK_FINALIZATION_AUTONOMOUS_PATTERN_BODY}`, 'tests/server/taskWorkspaceFinalizationService.test.ts'], stage: 2, parallelSafe: true, parallelWeight: 3, exclusiveResources: ['io-heavy'], expectedDurationMs: 46_600 },
  { label: 'task workspace finalization edge', command: 'npx', args: ['tsx', '--test', `--test-name-pattern=^${TASK_FINALIZATION_EDGE_PATTERN_BODY}`, 'tests/server/taskWorkspaceFinalizationService.test.ts'], stage: 2, parallelSafe: true, parallelWeight: 3, expectedDurationMs: 27_100 },
  { label: 'mcp fetch errors', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpFetchErrors.test.ts'], stage: 2, parallelSafe: true },
  { label: 'mcp streamable http', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpStreamableHttp.test.ts'], stage: 2, parallelSafe: true, expectedDurationMs: 15_700 },
  { label: 'runtime identity diagnostics', command: 'npx', args: ['tsx', '--test', 'tests/server/runtimeIdentityDiagnostics.test.ts'], stage: 2, parallelSafe: true, expectedDurationMs: 21_700 },
  { label: 'mcp tool job queue', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpToolJobQueue.test.ts'], stage: 2, parallelSafe: true, exclusiveResources: ['command-runtime'], expectedDurationMs: 26_600 },
  { label: 'mcp tool job recovery', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpToolJobRecovery.test.ts'], stage: 2, parallelSafe: true },
  { label: 'mcp scheduler policy', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpToolJobScheduler.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project resolution', command: 'npx', args: ['tsx', '--test', 'tests/server/projectResolution.test.ts'], stage: 2, parallelSafe: true },
  { label: 'session workspace service', command: 'npx', args: ['tsx', '--test', 'tests/server/sessionWorkspaceService.test.ts'], stage: 2, parallelSafe: true, expectedDurationMs: 30_300 },
  { label: 'steno session isolation', command: 'npx', args: ['tsx', '--test', 'tests/server/stenoSessionIsolation.test.ts'], stage: 2, parallelSafe: true },
  { label: 'workspace integration service', command: 'npx', args: ['tsx', '--test', 'tests/server/workspaceIntegrationService.test.ts'], stage: 2, parallelSafe: true, exclusiveResources: ['io-heavy'], expectedDurationMs: 49_000 },
  { label: 'agent runs', command: 'npm', args: ['run', 'test:agent-runs'], stage: 2, parallelSafe: true },
  { label: 'figma integration', command: 'npm', args: ['run', 'test:figma'], stage: 2, parallelSafe: true },
  { label: 'gateway safety', command: 'npm', args: ['run', 'test:gateway'], stage: 2, parallelSafe: true },
  { label: 'absolute paths', command: 'npm', args: ['run', 'test:absolute-paths'], stage: 2, parallelSafe: true },
  { label: 'prompt templates', command: 'npm', args: ['run', 'test:prompt-templates'], stage: 2, parallelSafe: true },
  { label: 'orchestration', command: 'npx', args: ['tsx', '--test', 'tests/server/codexExternalHandoffIntegration.test.ts', 'tests/server/externalTaskStatusRoutes.test.ts'], stage: 2, parallelSafe: true },
  { label: 'sqlite persistence', command: 'npm', args: ['run', 'test:sqlite'], stage: 2, parallelSafe: true, databasePathMode: 'self-managed' },
  { label: 'mcp transport benchmark gate', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpTransportBenchmark.test.ts'], stage: 2, parallelSafe: false },
  { label: 'start all launcher', command: 'npm', args: ['run', 'test:start-all'], stage: 3, parallelSafe: false },
  { label: 'doctor', command: 'npm', args: ['run', 'doctor'], stage: 3, parallelSafe: false },
];
