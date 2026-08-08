export type VerificationStep = {
  label: string;
  command: string;
  args: string[];
  stage: number;
  parallelSafe: boolean;
};

export const FULL_VERIFY_PARALLELISM = 4;

export const VERIFICATION_STEPS: VerificationStep[] = [
  { label: 'lint', command: 'npm', args: ['run', 'lint'], stage: 0, parallelSafe: false },
  { label: 'devflow restart route', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowRestartRoute.test.ts'], stage: 1, parallelSafe: false },
  { label: 'devflow restart contract', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowRestartContract.test.ts'], stage: 1, parallelSafe: false },
  { label: 'devflow restart state', command: 'npx', args: ['tsx', '--test', 'tests/server/devflowRestartState.test.ts'], stage: 1, parallelSafe: false },
  { label: 'devflow contract', command: 'npx', args: ['tsx', 'scripts/verify-devflow-contract.ts'], stage: 1, parallelSafe: false },
  { label: 'project atlas cache', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasCacheService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas agent update', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasAgentUpdateService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas api', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasApiService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas domains', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasDomainService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas exports', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasExport.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas impact', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasImpactService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas prompt templates', command: 'npx', args: ['tsx', '--test', 'tests/lib/projectAtlasPromptTemplates.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas scanner', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasScannerService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas view model', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasViewModel.test.ts'], stage: 2, parallelSafe: true },
  { label: 'project atlas graph edge visibility', command: 'npx', args: ['tsx', '--test', 'tests/components/projectAtlas/atlasGraphEdgeVisibility.test.ts'], stage: 2, parallelSafe: true },
  { label: 'task detail bug visibility', command: 'npx', args: ['tsx', '--test', 'tests/components/taskDetailsDrawerBugThreads.test.tsx'], stage: 2, parallelSafe: true },
  { label: 'project command service', command: 'npx', args: ['tsx', '--test', 'tests/server/projectCommandService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'git workflow service', command: 'npx', args: ['tsx', '--test', 'tests/server/gitWorkflowService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'local path mutation service', command: 'npx', args: ['tsx', '--test', 'tests/server/localPathMutationService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'task git workflow service', command: 'npx', args: ['tsx', '--test', 'tests/server/taskGitWorkflowService.test.ts'], stage: 2, parallelSafe: true },
  { label: 'mcp fetch errors', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpFetchErrors.test.ts'], stage: 2, parallelSafe: true },
  { label: 'mcp tool job queue', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpToolJobQueue.test.ts'], stage: 2, parallelSafe: true },
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
