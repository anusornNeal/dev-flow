import fs from 'fs';
import path from 'path';
import { getDevFlowAppRoot, resolveFromDevFlowAppRoot } from '../../lib/devFlowPaths';

export { getDevFlowAppRoot, resolveFromDevFlowAppRoot } from '../../lib/devFlowPaths';

export type AgentExecutionMode = 'safe' | 'full';

interface CreateAgentRunFilesInput {
  runId: string;
  prompt: string;
  baseDir?: string;
}

export interface AgentRunHistoryPaths {
  runDir: string;
  promptPath: string;
  logPath: string;
  launchMetadataPath: string;
  outputSummaryPath: string;
  resultPath: string;
}

export type AgentRunResultCode =
  | 'STARTING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export interface AgentRunResultRecord {
  runId: string;
  status: string;
  resultCode: AgentRunResultCode;
  success: boolean | null;
  summary: string;
  exitCode: number | null;
  errorMessage: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export function resolveAgentExecutionMode(value: unknown): AgentExecutionMode {
  return value === 'full' ? 'full' : 'safe';
}

export function getDevFlowApiBaseUrl() {
  return (process.env.DEVFLOW_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export function getAgentTriggerScriptPath(baseDir = getDevFlowAppRoot()) {
  return process.env.DEVFLOW_AGENT_TRIGGER_SCRIPT || path.join(baseDir, 'scripts', 'trigger-agent.bat');
}

export function getInvokeAgentTriggerScriptPath(baseDir = getDevFlowAppRoot()) {
  return path.join(baseDir, 'scripts', 'invoke-agent-trigger.ps1');
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

export function createAgentRunFiles(input: CreateAgentRunFilesInput) {
  const runDir = path.join(getAgentRunsBaseDir(input.baseDir), input.runId);
  fs.mkdirSync(runDir, { recursive: true });
  const historyPaths = getAgentRunHistoryPaths(runDir);
  fs.writeFileSync(historyPaths.promptPath, input.prompt, 'utf8');
  if (!fs.existsSync(historyPaths.logPath)) fs.writeFileSync(historyPaths.logPath, '', 'utf8');
  if (!fs.existsSync(historyPaths.launchMetadataPath)) fs.writeFileSync(historyPaths.launchMetadataPath, '{}\n', 'utf8');
  if (!fs.existsSync(historyPaths.outputSummaryPath)) fs.writeFileSync(historyPaths.outputSummaryPath, '', 'utf8');
  if (!fs.existsSync(historyPaths.resultPath)) fs.writeFileSync(historyPaths.resultPath, '{}\n', 'utf8');

  return { runDir, promptPath: historyPaths.promptPath, logPath: historyPaths.logPath };
}

export function appendAgentRunLog(logPath: string | null | undefined, message: string) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

export function buildPromptReference(promptPath: string) {
  return `Read and follow the DevFlow prompt file at: ${promptPath}`;
}

export function writeAgentRunLaunchMetadata(runDir: string, metadata: Record<string, unknown>) {
  const historyPaths = getAgentRunHistoryPaths(runDir);
  fs.writeFileSync(historyPaths.launchMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

export function writeAgentRunOutputSummary(runDir: string, summary: string) {
  const historyPaths = getAgentRunHistoryPaths(runDir);
  fs.writeFileSync(historyPaths.outputSummaryPath, summary.trim() ? `${summary.trim()}\n` : '', 'utf8');
}

export function writeAgentRunResult(runDir: string, result: AgentRunResultRecord | Record<string, unknown>) {
  const historyPaths = getAgentRunHistoryPaths(runDir);
  fs.writeFileSync(historyPaths.resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

export function createAgentRunResultRecord(input: {
  runId: string;
  status: string;
  summary: string;
  success?: boolean | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  updatedAt?: string;
  completedAt?: string | null;
}): AgentRunResultRecord {
  const normalizedStatus = input.status.toLowerCase();
  const resultCodeMap: Record<string, AgentRunResultCode> = {
    queued: 'STARTING',
    starting: 'STARTING',
    running: 'RUNNING',
    succeeded: 'SUCCEEDED',
    failed: 'FAILED',
    cancelled: 'CANCELLED',
  };

  return {
    runId: input.runId,
    status: normalizedStatus,
    resultCode: resultCodeMap[normalizedStatus] || 'FAILED',
    success: input.success ?? null,
    summary: input.summary,
    exitCode: input.exitCode ?? null,
    errorMessage: input.errorMessage ?? null,
    updatedAt: input.updatedAt || new Date().toISOString(),
    completedAt: input.completedAt ?? null,
  };
}
