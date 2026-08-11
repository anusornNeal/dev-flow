export type VerificationStep = {
  label: string;
  command: string;
  args: string[];
  stage: number;
  parallelSafe: boolean;
};

export const FULL_VERIFY_PARALLELISM = 4;

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

export const VERIFICATION_STEPS: VerificationStep[] = [
  { label: 'lint', command: 'npm', args: ['run', 'lint'], stage: 0, parallelSafe: false },
  { label: 'devflow restart route', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowRestartRoute.test.ts'], stage: 1, parallelSafe: false },
  { label: 'devflow restart contract', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowRestartContract.test.ts'], stage: 1, parallelSafe: false },
  { label: 'devflow restart state', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowRestartState.test.ts'], stage: 1, parallelSafe: false },
  { label: 'devflow contract', command: 'npx', args: ['tsx', 'scripts/verify-devflow-contract.ts'], stage: 1, parallelSafe: false },
  { label: 'devflow tool profiles', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowToolProfile.test.ts'], stage: 1, parallelSafe: false },
  { label: 'task claim service', command: 'npx', args: ['tsx', '--test', 'tests/server/taskClaimService.test.ts'], stage: 1, parallelSafe: true },
  { label: 'task claim routes', command: 'npx', args: ['tsx', '--test', 'tests/server/taskRouteModules.test.ts'], stage: 1, parallelSafe: true },
  { label: 'task claim contract', command: 'npx', args: ['tsx', '--test', 'tests/server/taskClaimContract.test.ts'], stage: 1, parallelSafe: true },
  { label: 'board loop skill registry', command: 'npx', args: ['tsx', '--test', 'tests/server/skillsRegistrySeed.test.ts'], stage: 1, parallelSafe: true },
  { label: 'board loop skill content', command: 'npx', args: ['tsx', '--test', 'tests/server/authoringSkillContent.test.ts'], stage: 1, parallelSafe: true },
  { label: 'task claim card ui', command: 'npx', args: ['tsx', '--test', 'tests/taskCardClaimUi.test.ts'], stage: 1, parallelSafe: true },
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
  { label: 'project command service', command: 'npx', args: ['tsx', '--test', 'tests/server/projectCommandService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'git workflow service', command: 'npx', args: ['tsx', '--test', 'tests/server/gitWorkflowService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'local path mutation service', command: 'npx', args: ['tsx', '--test', 'tests/server/localPathMutationService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'task git workflow service', command: 'npx', args: ['tsx', '--test', 'tests/server/taskGitWorkflowService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'task commit plan', command: 'npx', args: ['tsx', '--test', 'tests/server/taskCommitPlanService.test.ts', 'tests/server/devflowContractModules.test.ts', 'tests/server/mcpToolJobRunnerRegistry.test.ts'], stage: 2, parallelSafe: true },
  { label: 'task manual move recovery', command: 'npx', args: ['tsx', '--test', 'tests/server/taskManualMovePolicy.test.ts', 'tests/server/taskManualMoveRoutes.test.ts'], stage: 2, parallelSafe: true },
  { label: 'task workspace finalization', command: 'npx', args: ['tsx', '--test', 'tests/server/taskWorkspaceFinalizationService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'mcp fetch errors', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpFetchErrors.test.ts'], stage: 2, parallelSafe: true },
  { label: 'mcp streamable http', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpStreamableHttp.test.ts'], stage: 2, parallelSafe: true },
  { label: 'runtime identity diagnostics', command: 'npx', args: ['tsx', '--test', 'tests/server/runtimeIdentityDiagnostics.test.ts'], stage: 2, parallelSafe: true },
  { label: 'mcp tool job queue', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpToolJobQueue.test.ts'], stage: 2, parallelSafe: true },
  { label: 'mcp tool job recovery', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpToolJobRecovery.test.ts'], stage: 2, parallelSafe: true },
  { label: 'mcp scheduler policy', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpToolJobScheduler.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project resolution', command: 'npx', args: ['tsx', '--test', 'tests/server/projectResolution.test.ts'], stage: 2, parallelSafe: true },
  { label: 'mcp transport benchmark gate', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpTransportBenchmark.test.ts'], stage: 2, parallelSafe: false },
  { label: 'session workspace service', command: 'npx', args: ['tsx', '--test', 'tests/server/sessionWorkspaceService.test.ts'], stage: 2, parallelSafe: false },
  { label: 'steno session isolation', command: 'npx', args: ['tsx', '--test', 'tests/server/stenoSessionIsolation.test.ts'], stage: 2, parallelSafe: false },
  { label: 'workspace integration service', command: 'npx', args: ['tsx', '--test', 'tests/server/workspaceIntegrationService.test.ts'], stage: 2, parallelSafe: false },
  { label: 'agent runs', command: 'npm', args: ['run', 'test:agent-runs'], stage: 3, parallelSafe: false },
  { label: 'figma integration', command: 'npm', args: ['run', 'test:figma'], stage: 3, parallelSafe: false },
  { label: 'gateway safety', command: 'npm', args: ['run', 'test:gateway'], stage: 3, parallelSafe: false },
  { label: 'start all launcher', command: 'npm', args: ['run', 'test:start-all'], stage: 3, parallelSafe: false },
  { label: 'absolute paths', command: 'npm', args: ['run', 'test:absolute-paths'], stage: 3, parallelSafe: false },
  { label: 'prompt templates', command: 'npm', args: ['run', 'test:prompt-templates'], stage: 3, parallelSafe: false },
  { label: 'orchestration', command: 'npm', args: ['run', 'test:orchestration'], stage: 3, parallelSafe: false },
  { label: 'sqlite persistence', command: 'npm', args: ['run', 'test:sqlite'], stage: 3, parallelSafe: false },
  { label: 'doctor', command: 'npm', args: ['run', 'doctor'], stage: 3, parallelSafe: false },
];
