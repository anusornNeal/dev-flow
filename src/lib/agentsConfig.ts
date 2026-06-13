interface ModelConfig {
  model_name: string;
  display_name?: string;
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
      display_name: "3.5 flash",
      reasoning_support: true,
      available_efforts: ["low", "medium"],
      default_effort: "low"
    },
    {
      model_name: "Gemini 3.1 Pro",
      display_name: "3.1 pro",
      reasoning_support: true,
      available_efforts: ["low", "medium", "high"],
      default_effort: "medium"
    }
  ],
  Claude: [
    {
      model_name: "Claude 4.6 Opus",
      display_name: "Opus 4.6",
      reasoning_support: true,
      available_efforts: ["low", "medium"],
      default_effort: "medium"
    },
    {
      model_name: "Claude 4.7 Opus",
      display_name: "Opus 4.7",
      reasoning_support: true,
      available_efforts: ["low", "medium", "high"],
      default_effort: "medium"
    },
    {
      model_name: "Claude 4.8 Opus",
      display_name: "Opus 4.8",
      reasoning_support: true,
      available_efforts: ["medium", "high", "xhigh"],
      default_effort: "high"
    },
    {
      model_name: "Claude 4.6 Sonnet",
      display_name: "Sonnet 4.6",
      reasoning_support: true,
      available_efforts: ["low", "medium"],
      default_effort: "low"
    }
  ]
};

export const getDisplayModelName = (agentName: string | undefined, modelName: string | undefined): string => {
  if (!modelName) return '';
  if (!agentName) return modelName;
  
  const configs = AGENTS_CONFIG[agentName as AgentName];
  if (!configs) return modelName;
  
  const config = configs.find(m => m.model_name === modelName);
  return config?.display_name || modelName;
};

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
