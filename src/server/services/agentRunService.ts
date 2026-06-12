import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type AgentExecutionMode = 'safe' | 'full';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEVFLOW_APP_ROOT = path.resolve(__dirname, '..', '..', '..');

interface CreateAgentRunFilesInput {
  runId: string;
  prompt: string;
  baseDir?: string;
}

export function resolveAgentExecutionMode(value: unknown): AgentExecutionMode {
  return value === 'full' ? 'full' : 'safe';
}

export function getDevFlowApiBaseUrl() {
  return (process.env.DEVFLOW_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export function getDevFlowAppRoot() {
  return path.resolve(process.env.DEVFLOW_APP_ROOT || DEVFLOW_APP_ROOT);
}

export function resolveFromDevFlowAppRoot(...segments: string[]) {
  return path.join(getDevFlowAppRoot(), ...segments);
}

export function getAgentTriggerScriptPath(baseDir = getDevFlowAppRoot()) {
  return process.env.DEVFLOW_AGENT_TRIGGER_SCRIPT || path.join(baseDir, 'scripts', 'trigger-agent.bat');
}

export function getAgentRunsBaseDir(baseDir = getDevFlowAppRoot()) {
  return path.join(baseDir, '.devflow', 'runs');
}

export function createAgentRunFiles(input: CreateAgentRunFilesInput) {
  const runDir = path.join(getAgentRunsBaseDir(input.baseDir), input.runId);
  fs.mkdirSync(runDir, { recursive: true });

  const promptPath = path.join(runDir, 'prompt.md');
  const logPath = path.join(runDir, 'agent.log');
  fs.writeFileSync(promptPath, input.prompt, 'utf8');
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '', 'utf8');

  return { runDir, promptPath, logPath };
}

export function appendAgentRunLog(logPath: string | null | undefined, message: string) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

export function buildPromptReference(promptPath: string) {
  return `Read and follow the DevFlow prompt file at: ${promptPath}`;
}
