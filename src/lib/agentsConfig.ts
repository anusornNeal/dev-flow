export interface ModelConfig {
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
      available_efforts: ["low", "medium", "high"],
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
