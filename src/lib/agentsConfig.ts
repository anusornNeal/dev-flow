import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface ModelConfig {
  model_name: string;
  reasoning_support: boolean;
  available_efforts: string[];
  default_effort: string;
}

export type AgentName = 'Codex' | 'Antigravity' | 'Claude';

export const AGENTS_CONFIG: Record<AgentName, ModelConfig[]> = {
  Codex: [
    {
      model_name: "GPT-5.5",
      reasoning_support: true,
      available_efforts: ["low", "medium", "high", "xhigh"],
      default_effort: "medium"
    },
    {
      model_name: "GPT-5.4",
      reasoning_support: true,
      available_efforts: ["low", "medium", "high"],
      default_effort: "medium"
    },
    {
      model_name: "GPT-5.4 Mini",
      reasoning_support: true,
      available_efforts: ["low", "medium"],
      default_effort: "low"
    }
  ],
  Antigravity: [
    {
      model_name: "Gemini 3.5 Flash",
      reasoning_support: true,
      available_efforts: ["low", "medium"],
      default_effort: "low"
    },
    {
      model_name: "Gemini 3.1 Pro",
      reasoning_support: true,
      available_efforts: ["low", "medium", "high"],
      default_effort: "medium"
    }
  ],
  Claude: [
    {
      model_name: "Claude 4.8 Opus",
      reasoning_support: true,
      available_efforts: ["medium", "high", "xhigh"],
      default_effort: "high"
    },
    {
      model_name: "Claude 4.7 Opus",
      reasoning_support: true,
      available_efforts: ["low", "medium", "high"],
      default_effort: "medium"
    },
    {
      model_name: "Claude 4.6 Opus",
      reasoning_support: true,
      available_efforts: ["low", "medium"],
      default_effort: "medium"
    },
    {
      model_name: "Claude 4.6 Sonnet",
      reasoning_support: true,
      available_efforts: ["low", "medium"],
      default_effort: "low"
    }
  ]
};

export type AgentExecutionMode = 'safe' | 'full';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function configPathForAgent(agent: string, baseDir = path.join(__dirname, '..', '..')) {
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

export const getModelConfig = (agentName: string, modelName: string): ModelConfig | undefined => {
  const configs = AGENTS_CONFIG[agentName as AgentName];
  if (!configs) return undefined;
  return configs.find(m => m.model_name === modelName);
};

export const defaultModelForAgent = (agentName: string): string => {
  const configs = AGENTS_CONFIG[agentName as AgentName];
  return configs && configs.length > 0 ? configs[0].model_name : '';
};

export const defaultEffortForModel = (agentName: string, modelName: string): string => {
  const config = getModelConfig(agentName, modelName);
  return config ? config.default_effort : 'medium';
};
