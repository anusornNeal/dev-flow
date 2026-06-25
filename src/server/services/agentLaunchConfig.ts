import fs from 'fs';
import path from 'path';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';
import type { AgentExecutionMode } from './agentRunService';
import { buildPromptReference, getAgentRunsBaseDir, getAgentTriggerScriptPath, getDevFlowApiBaseUrl, getInvokeAgentTriggerScriptPath } from './agentRunService';

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

export interface BuildAgentCliArgsInput {
  config: FileAgentConfig;
  localPath: string;
  model: string;
  effort: string;
  promptReference: string;
  executionMode: AgentExecutionMode;
}

export interface BuildCodexLaunchConfigInput {
  task: {
    id: string;
    agent?: string | null;
    model?: string | null;
    effort?: string | null;
  };
  project: {
    localPath?: string | null;
  };
  promptPath: string;
  runId: string;
  executionMode: AgentExecutionMode;
  apiBaseUrl?: string;
  appRoot?: string;
  preview?: boolean;
  environment?: Record<string, string | undefined>;
  logPath?: string;
  promptReferenceOverride?: string;
}

export interface BuiltAgentLaunchConfig {
  ok: true;
  executable: string;
  parameters: string[];
  cwd: string;
  environment: Record<string, string>;
  promptReference: string;
  previewText: string;
  launchPlan: AgentLaunchPlan;
}

export interface FailedAgentLaunchConfig {
  ok: false;
  error: string;
  launchPlan?: AgentLaunchPlan;
}

export type BuiltCodexLaunchConfig = BuiltAgentLaunchConfig;
export type FailedCodexLaunchConfig = FailedAgentLaunchConfig;

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

function configPathForAgent(agent: string, baseDir = getDevFlowAppRoot()) {
  return path.join(baseDir, 'config', 'agents', `${agent.toLowerCase()}.json`);
}

function resolveEnvVariables(str: string): string {
  return str.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
}

function appendFlagValue(args: string[], flag: string | string[], value: string) {
  const flagParts = Array.isArray(flag) ? flag : [flag];
  const valueFlag = flagParts.at(-1);
  if (!valueFlag) return;

  args.push(...flagParts.slice(0, -1));
  if (valueFlag.endsWith('=')) {
    args.push(`${valueFlag}${value}`);
  } else {
    args.push(valueFlag, value);
  }
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
      appendFlagValue(spawnArgs, config.flags.effort, effort);
    } else if (config.promptFallback?.effort) {
      console.warn(`[runner] WARNING: ${config.name} config states no effort flag. Using prompt fallback.`);
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

export function mapModelForAgent(config: Pick<FileAgentConfig, 'modelMap'>, model: string) {
  return config.modelMap?.[model] || '';
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
    const message = launchPlan.config.name === 'Antigravity'
      ? 'Antigravity CLI not found. Set DEVFLOW_AGY_EXE or add agy.exe to PATH.'
      : `${launchPlan.config.name} executable was not found from the configured env/path/command sources.`;
    return {
      ok: false,
      code: 'EXECUTABLE_NOT_FOUND',
      message,
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

export function buildAgentLaunchConfig(input: BuildCodexLaunchConfigInput): BuiltAgentLaunchConfig | FailedAgentLaunchConfig {
  const appRoot = path.resolve(input.appRoot || getDevFlowAppRoot());
  const localPath = input.project.localPath || '';
  const agent = input.task.agent || 'Codex';
  const preflight = runAgentLaunchPreflight({
    agent,
    localPath,
    model: input.task.model,
    effort: input.task.effort,
    executionMode: input.executionMode,
    appRoot,
  });

  if (!preflight.ok || !preflight.launchPlan?.config || !preflight.executablePath) {
    return {
      ok: false,
      error: preflight.message,
      launchPlan: preflight.launchPlan,
    };
  }

  const cwd = path.resolve(localPath);
  const promptPath = path.resolve(input.promptPath);
  const promptReference = input.promptReferenceOverride || buildPromptReference(promptPath);
  const parameters = buildAgentCliArgs({
    config: preflight.launchPlan.config,
    localPath: cwd,
    model: input.task.model || '',
    effort: input.task.effort || '',
    promptReference,
    executionMode: input.executionMode,
  });
  const apiBaseUrl = (input.apiBaseUrl || getDevFlowApiBaseUrl()).replace(/\/$/, '');
  const environment = Object.fromEntries(
    Object.entries({
      ...input.environment,
      DEVFLOW_AGENT_EXECUTION_MODE: input.executionMode,
      DEVFLOW_API_BASE_URL: apiBaseUrl,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const previewText = [
    `${preflight.launchPlan.agent} launch preview: run=${input.runId}${input.preview ? ' (preview)' : ''}`,
    `cwd=${cwd}`,
    `executable=${preflight.executablePath}`,
    `args=${parameters.join(' ')}`,
    `promptPath=${promptPath}`,
    `logPath=${input.logPath ? path.resolve(input.logPath) : 'none'}`,
    `resolvedModel=${preflight.launchPlan.resolvedModel || 'none'}`,
    `selectedEffort=${preflight.launchPlan.selectedEffort || 'none'}`,
    `effortHandling=${preflight.launchPlan.effortHandling.mode}`,
    `executionMode=${input.executionMode}`,
  ].join('\n');

  return {
    ok: true,
    executable: preflight.executablePath,
    parameters,
    cwd,
    environment,
    promptReference,
    previewText,
    launchPlan: preflight.launchPlan,
  };
}

export function buildCodexLaunchConfig(input: BuildCodexLaunchConfigInput): BuiltCodexLaunchConfig | FailedCodexLaunchConfig {
  return buildAgentLaunchConfig(input);
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
