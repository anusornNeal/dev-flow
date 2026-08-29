import path from 'path';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';

export { getDevFlowAppRoot, resolveFromDevFlowAppRoot } from '../../lib/devFlowPaths';

export function getDevFlowApiBaseUrl() {
  return (process.env.DEVFLOW_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Cold-history compatibility for legacy agent runs.
 *
 * Fresh-process launch/mutation plumbing is retired. These helpers only resolve
 * already-existing run artifacts for read-only audit/history routes; they never
 * create, mutate, launch, retry, cancel, or finalize an agent run.
 */
export interface AgentRunHistoryPaths {
  runDir: string;
  promptPath: string;
  logPath: string;
  launchMetadataPath: string;
  outputSummaryPath: string;
  resultPath: string;
}

export function getAgentRunsBaseDir(baseDir = getDevFlowAppRoot()) {
  return path.join(baseDir, '.devflow', 'runs');
}

export function getAgentRunHistoryPaths(runDir: string): AgentRunHistoryPaths {
  return {
    runDir,
    promptPath: path.join(runDir, 'prompt.md'),
    logPath: path.join(runDir, 'agent.log'),
    launchMetadataPath: path.join(runDir, 'launch.json'),
    outputSummaryPath: path.join(runDir, 'summary.txt'),
    resultPath: path.join(runDir, 'result.json'),
  };
}
