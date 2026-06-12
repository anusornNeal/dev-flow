import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildPromptReference, resolveAgentExecutionMode, type AgentExecutionMode } from './server/services/agentRunService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AgentConfig {
  name: string;
  executables: { type: 'env' | 'path' | 'command'; value: string }[];
  flags: {
    model: string | null;
    effort?: string | null;
    workingDir?: string | null;
    alwaysAllow?: string | null;
    interactiveArgs?: string[];
  };
  executionModes?: Partial<Record<AgentExecutionMode, { args: string[] }>>;
  modelMap?: Record<string, string>;
  promptFallback?: {
    effort?: string;
  };
  launchStyle: 'start' | 'cmd_k';
}

interface BuildAgentCliArgsInput {
  config: AgentConfig;
  localPath: string;
  model: string;
  effort: string;
  promptReference: string;
  executionMode: AgentExecutionMode;
}

function resolveEnvVariables(str: string): string {
  return str.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
}

function resolveExecutable(executables: AgentConfig['executables']): string | null {
  for (const exec of executables) {
    if (exec.type === 'env') {
      const val = process.env[exec.value];
      if (val && fs.existsSync(val)) return val;
    } else if (exec.type === 'path') {
      const val = resolveEnvVariables(exec.value);
      if (val && fs.existsSync(val)) return val;
    } else if (exec.type === 'command') {
      try {
        const out = execSync(`where ${exec.value} 2>nul`, { encoding: 'utf8' });
        const lines = out.trim().split('\n');
        if (lines.length > 0 && fs.existsSync(lines[0].trim())) {
          return lines[0].trim();
        }
      } catch (e) {
        // Not found
      }
    }
  }
  return null;
}

export function mapModelForAgent(config: Pick<AgentConfig, 'modelMap'>, model: string) {
  return config.modelMap?.[model] || model;
}

export function buildAgentCliArgs(input: BuildAgentCliArgsInput) {
  const { config, localPath, effort, promptReference, executionMode } = input;
  const model = input.model ? mapModelForAgent(config, input.model) : '';
  const spawnArgs: string[] = [];

  if (localPath && config.flags.workingDir) {
    spawnArgs.push(config.flags.workingDir, localPath);
  }

  if (model) {
    if (config.flags.model) {
      spawnArgs.push(config.flags.model, model);
    } else {
      console.warn(`[runner] WARNING: ${config.name} does not support model flag natively via config.`);
    }
  }

  if (effort) {
    if (config.flags.effort) {
      spawnArgs.push(config.flags.effort, effort);
    } else if (config.promptFallback?.effort) {
      console.warn(`[runner] WARNING: ${config.name} config states no effort flag. Using prompt fallback.`);
      spawnArgs.push(config.promptFallback.effort.replace('{EFFORT}', effort));
    }
  }

  if (config.flags.interactiveArgs) {
    spawnArgs.push(...config.flags.interactiveArgs);
  }

  const modeArgs = config.executionModes?.[executionMode]?.args;
  if (modeArgs) {
    spawnArgs.push(...modeArgs);
  } else if (executionMode === 'full' && config.flags.alwaysAllow) {
    spawnArgs.push(config.flags.alwaysAllow);
  }

  spawnArgs.push(promptReference);
  return spawnArgs;
}

function readPromptReference(taskId: string, promptPath: string, apiBaseUrl: string) {
  if (promptPath && fs.existsSync(promptPath)) {
    return buildPromptReference(promptPath);
  }
  return `Fetch and follow the DevFlow task prompt from: ${apiBaseUrl}/api/tasks/${taskId}/prompt`;
}

function main() {
  const args = process.argv.slice(2);
  const agentId = args[0]?.toLowerCase();
  const taskId = args[1];
  const localPath = args[2] === 'none' ? '' : args[2];
  const model = args[3] === 'none' ? '' : args[3];
  const effort = args[4] === 'none' ? '' : args[4];
  const runId = args[5] === 'none' ? '' : args[5];
  const promptPath = args[6] === 'none' ? '' : args[6];
  const logPath = args[7] === 'none' ? '' : args[7];
  const apiBaseUrl = (args[8] === 'none' || !args[8] ? process.env.DEVFLOW_API_BASE_URL || 'http://localhost:3000' : args[8]).replace(/\/$/, '');
  const executionMode = resolveAgentExecutionMode(args[9] || process.env.DEVFLOW_AGENT_EXECUTION_MODE);

  if (!agentId || !taskId) {
    console.error('[runner] Missing required arguments: agentId taskId');
    process.exit(1);
  }

  const configPath = path.join(__dirname, '..', 'config', 'agents', `${agentId}.json`);
  if (!fs.existsSync(configPath)) {
    console.error(`[runner] Configuration file not found for agent '${agentId}' at ${configPath}`);
    process.exit(1);
  }

  const config: AgentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log(`[runner] Loaded configuration for ${config.name}`);

  const executable = resolveExecutable(config.executables);
  if (!executable) {
    console.error(`[runner] Executable not found for ${config.name}. Checked:`, config.executables);
    process.exit(1);
  }
  console.log(`[runner] Resolved executable: ${executable}`);

  const promptReference = readPromptReference(taskId, promptPath, apiBaseUrl);
  if (!promptReference) {
    console.error(`[runner] Invalid prompt reference for task ${taskId}`);
    process.exit(1);
  }

  const spawnArgs = buildAgentCliArgs({ config, localPath, model, effort, promptReference, executionMode });

  console.log(`[runner] Launching ${config.name} in a new window for run=${runId || 'none'} mode=${executionMode}...`);

  // We need to launch the agent in a new visible console window, starting in the localPath.
  const cwd = localPath || process.cwd();

  // Escape arguments for the command line execution
  const escapedArgs = spawnArgs.map(arg => {
    // If argument contains spaces and is not already quoted, quote it.
    // Replace inner double quotes with \"
    return `"${arg.replace(/"/g, '\\"')}"`;
  });

  const commandString = `"${executable}" ${escapedArgs.join(' ')}`;

  let finalCmd = '';
  let finalArgs: string[] = [];

  if (config.launchStyle === 'start') {
    finalCmd = 'cmd.exe';
    finalArgs = ['/c', 'start', `"${config.name} Agent"`, '/d', cwd, executable, ...escapedArgs];
  } else if (config.launchStyle === 'cmd_k') {
    finalCmd = 'cmd.exe';
    finalArgs = ['/c', 'start', `"${config.name} Agent"`, '/d', cwd, 'cmd.exe', '/k', commandString];
  } else {
    console.error(`[runner] Unknown launchStyle: ${config.launchStyle}`);
    process.exit(1);
  }

  const child = spawn(finalCmd, finalArgs, {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true
  });

  child.unref();
  if (logPath) fs.appendFileSync(logPath, `[${new Date().toISOString()}] Runner dispatched ${config.name} for task ${taskId}\n`, 'utf8');
  console.log(`[runner] Trigger dispatched successfully.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
