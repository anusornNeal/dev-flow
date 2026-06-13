import fs from 'fs';
import path from 'path';
import type { AgentExecutionMode } from './agentRunService';
import { getAgentRunsBaseDir, getAgentTriggerScriptPath, getDevFlowAppRoot, getInvokeAgentTriggerScriptPath } from './agentRunService';

export type EffortHandlingMode = 'cli-flag' | 'prompt-only' | 'none';

export interface FileAgentConfig {
  name: string;
  executables: { type: 'env' | 'path' | 'command'; value: string }[];
  flags: {
    model: string | null;
    effort?: string | string[] | null;
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

export interface AgentLaunchPlan {
  ok: boolean;
  error?: string;
  agent: string;
  config?: FileAgentConfig;
  devFlowModel: string;
  resolvedModel: string;
  selectedEffort: string;
  effortHandling: {
    mode: EffortHandlingMode;
    detail: string;
  };
  executionMode: AgentExecutionMode;
}

export type AgentLaunchPreflightCode =
  | 'OK'
  | 'NO_AGENT'
  | 'PROJECT_PATH_MISSING'
  | 'PROJECT_PATH_NOT_FOUND'
  | 'PROJECT_PATH_INVALID'
  | 'LAUNCH_PLAN_INVALID'
  | 'EXECUTABLE_NOT_FOUND'
  | 'TRIGGER_SCRIPT_MISSING'
  | 'INVOKE_TRIGGER_SCRIPT_MISSING'
  | 'RUN_ARTIFACT_DIR_UNAVAILABLE';

export interface AgentLaunchPreflightResult {
  ok: boolean;
  code: AgentLaunchPreflightCode;
  message: string;
  agent: string;
  launchPlan?: AgentLaunchPlan;
  executablePath?: string;
  triggerScriptPath?: string;
  invokeTriggerScriptPath?: string;
  runArtifactsDir?: string;
}

function configPathForAgent(agent: string, baseDir = process.cwd()) {
  return path.join(baseDir, 'config', 'agents', `${agent.toLowerCase()}.json`);
}

function resolveEnvVariables(str: string): string {
  return str.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
}

export function resolveAgentExecutable(executables: FileAgentConfig['executables']): string | null {
  for (const exec of executables) {
    if (exec.type === 'env') {
      const value = process.env[exec.value];
      if (value && fs.existsSync(value)) return value;
      continue;
    }

    if (exec.type === 'path') {
      const value = resolveEnvVariables(exec.value);
      if (value && fs.existsSync(value)) return value;
      continue;
    }

    if (exec.type === 'command') {
      const pathEnv = process.env.PATH || '';
      for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
        for (const candidate of [exec.value, `${exec.value}.cmd`, `${exec.value}.bat`, `${exec.value}.exe`]) {
          const resolved = path.join(dir, candidate);
          if (fs.existsSync(resolved)) return resolved;
        }
      }
    }
  }

  return null;
}

export function loadAgentLaunchConfig(agent: string, baseDir?: string): FileAgentConfig | null {
  const configPath = configPathForAgent(agent, baseDir);
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as FileAgentConfig;
}

export function resolveAgentLaunchPlan(input: {
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
  executionMode: AgentExecutionMode;
  baseDir?: string;
}): AgentLaunchPlan {
  const agent = input.agent || '';
  const devFlowModel = input.model || '';
  const selectedEffort = input.effort || '';
  const config = agent ? loadAgentLaunchConfig(agent, input.baseDir) : null;

  if (!agent || !config) {
    return {
      ok: false,
      error: agent ? `Configuration file not found for agent '${agent}'.` : 'Task has no assigned agent.',
      agent,
      devFlowModel,
      resolvedModel: '',
      selectedEffort,
      effortHandling: { mode: 'none', detail: 'No effort selected.' },
      executionMode: input.executionMode,
    };
  }

  const resolvedModel = devFlowModel ? config.modelMap?.[devFlowModel] : '';
  if (devFlowModel && !resolvedModel) {
    const supported = Object.keys(config.modelMap || {});
    return {
      ok: false,
      error: `Model '${devFlowModel}' is not supported by ${config.name}. Supported models: ${supported.join(', ') || 'none'}.`,
      agent: config.name,
      config,
      devFlowModel,
      resolvedModel: '',
      selectedEffort,
      effortHandling: { mode: 'none', detail: 'Launch blocked before effort handling.' },
      executionMode: input.executionMode,
    };
  }

  let effortHandling: AgentLaunchPlan['effortHandling'] = { mode: 'none', detail: 'No effort selected.' };
  if (selectedEffort) {
    if (config.flags.effort) {
      effortHandling = { mode: 'cli-flag', detail: `Passed via ${Array.isArray(config.flags.effort) ? config.flags.effort.join(' ') : config.flags.effort}.` };
    } else if (config.promptFallback?.effort) {
      effortHandling = { mode: 'prompt-only', detail: 'No verified CLI effort flag; effort is included in prompt metadata only.' };
    } else {
      effortHandling = { mode: 'none', detail: 'No verified CLI effort flag or prompt fallback is configured.' };
    }
  }

  return {
    ok: true,
    agent: config.name,
    config,
    devFlowModel,
    resolvedModel,
    selectedEffort,
    effortHandling,
    executionMode: input.executionMode,
  };
}

export function runAgentLaunchPreflight(input: {
  agent?: string | null;
  localPath?: string | null;
  model?: string | null;
  effort?: string | null;
  executionMode: AgentExecutionMode;
  appRoot?: string;
}): AgentLaunchPreflightResult {
  const appRoot = path.resolve(input.appRoot || getDevFlowAppRoot());
  const agent = input.agent || '';
  const localPath = input.localPath || '';

  if (!agent) {
    return {
      ok: false,
      code: 'NO_AGENT',
      message: 'Task has no assigned agent.',
      agent,
    };
  }

  if (!localPath) {
    return {
      ok: false,
      code: 'PROJECT_PATH_MISSING',
      message: 'Project localPath is missing. Task cannot be run.',
      agent,
    };
  }

  if (!fs.existsSync(localPath)) {
    return {
      ok: false,
      code: 'PROJECT_PATH_NOT_FOUND',
      message: `Project localPath does not exist: ${localPath}`,
      agent,
    };
  }

  if (!fs.statSync(localPath).isDirectory()) {
    return {
      ok: false,
      code: 'PROJECT_PATH_INVALID',
      message: `Project localPath is not a directory: ${localPath}`,
      agent,
    };
  }

  const launchPlan = resolveAgentLaunchPlan({
    agent,
    model: input.model,
    effort: input.effort,
    executionMode: input.executionMode,
    baseDir: appRoot,
  });

  if (!launchPlan.ok || !launchPlan.config) {
    return {
      ok: false,
      code: 'LAUNCH_PLAN_INVALID',
      message: launchPlan.error || 'Agent launch configuration is invalid.',
      agent,
      launchPlan,
    };
  }

  const executablePath = resolveAgentExecutable(launchPlan.config.executables);
  if (!executablePath) {
    return {
      ok: false,
      code: 'EXECUTABLE_NOT_FOUND',
      message: `${launchPlan.config.name} executable was not found from the configured env/path/command sources.`,
      agent,
      launchPlan,
    };
  }

  const triggerScriptPath = getAgentTriggerScriptPath(appRoot);
  if (!fs.existsSync(triggerScriptPath)) {
    return {
      ok: false,
      code: 'TRIGGER_SCRIPT_MISSING',
      message: `Agent trigger script is missing: ${triggerScriptPath}`,
      agent,
      launchPlan,
      executablePath,
    };
  }

  const invokeTriggerScriptPath = getInvokeAgentTriggerScriptPath(appRoot);
  if (!fs.existsSync(invokeTriggerScriptPath)) {
    return {
      ok: false,
      code: 'INVOKE_TRIGGER_SCRIPT_MISSING',
      message: `Agent trigger wrapper script is missing: ${invokeTriggerScriptPath}`,
      agent,
      launchPlan,
      executablePath,
      triggerScriptPath,
    };
  }

  const runArtifactsDir = getAgentRunsBaseDir(appRoot);
  try {
    fs.mkdirSync(runArtifactsDir, { recursive: true });
    fs.accessSync(runArtifactsDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return {
      ok: false,
      code: 'RUN_ARTIFACT_DIR_UNAVAILABLE',
      message: `Run artifact folder is not ready: ${runArtifactsDir}`,
      agent,
      launchPlan,
      executablePath,
      triggerScriptPath,
      invokeTriggerScriptPath,
      runArtifactsDir,
    };
  }

  return {
    ok: true,
    code: 'OK',
    message: 'Agent launch preflight passed.',
    agent,
    launchPlan,
    executablePath,
    triggerScriptPath,
    invokeTriggerScriptPath,
    runArtifactsDir,
  };
}

export function buildLaunchMetadataBlock(plan: AgentLaunchPlan) {
  return [
    '### DevFlow Agent Launch Metadata',
    `- Selected agent: ${plan.agent || 'None'}`,
    `- DevFlow model label: ${plan.devFlowModel || 'None'}`,
    `- Resolved CLI model id: ${plan.resolvedModel || 'None'}`,
    `- Selected effort: ${plan.selectedEffort || 'None'}`,
    `- Effort handling mode: ${plan.effortHandling.mode}`,
    `- Effort handling detail: ${plan.effortHandling.detail}`,
    `- Execution mode: ${plan.executionMode}`,
    '',
  ].join('\n');
}
