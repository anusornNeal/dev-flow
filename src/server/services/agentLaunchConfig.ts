import fs from 'fs';
import path from 'path';
import type { AgentExecutionMode } from './agentRunService';

export type EffortHandlingMode = 'cli-flag' | 'prompt-only' | 'none';

export interface FileAgentConfig {
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

function configPathForAgent(agent: string, baseDir = process.cwd()) {
  return path.join(baseDir, 'config', 'agents', `${agent.toLowerCase()}.json`);
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
      effortHandling = { mode: 'cli-flag', detail: `Passed via ${config.flags.effort}.` };
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
