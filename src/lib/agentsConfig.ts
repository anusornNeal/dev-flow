export type AgentName = 'Codex' | 'Antigravity' | 'Claude';
export type Provider = 'openai' | 'google' | 'anthropic';
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelConfig {
  label: string;
  modelId: string;
  provider: Provider;
  effortParam: 'reasoning.effort' | 'thinkingLevel' | 'output_config.effort';
  availableEfforts: Effort[];
  defaultEffort: Effort;
  recommendedCodingEffort?: Effort;
  // Aliases for backwards compatibility during migration
  model_name: string; 
  display_name?: string;
  reasoning_support: boolean;
}

export const AGENTS_CONFIG: Record<AgentName, ModelConfig[]> = {
  Codex: [
    {
      label: "GPT-5.5",
      modelId: "gpt-5.5",
      provider: "openai",
      effortParam: "reasoning.effort",
      availableEfforts: ["none", "low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
      model_name: "GPT-5.5",
      display_name: "GPT-5.5",
      reasoning_support: true,
    },
    {
      label: "GPT-5.4",
      modelId: "gpt-5.4",
      provider: "openai",
      effortParam: "reasoning.effort",
      availableEfforts: ["none", "low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
      model_name: "GPT-5.4",
      display_name: "GPT-5.4",
      reasoning_support: true,
    },
    {
      label: "GPT-5.4 Mini",
      modelId: "gpt-5.4-mini",
      provider: "openai",
      effortParam: "reasoning.effort",
      availableEfforts: ["none", "low", "medium", "high", "xhigh"],
      defaultEffort: "low",
      model_name: "GPT-5.4 Mini",
      display_name: "GPT-5.4 Mini",
      reasoning_support: true,
    }
  ],
  Antigravity: [
    {
      label: "Gemini 3.5 Flash",
      modelId: "gemini-3.5-flash",
      provider: "google",
      effortParam: "thinkingLevel",
      availableEfforts: ["minimal", "low", "medium", "high"],
      defaultEffort: "medium",
      model_name: "Gemini 3.5 Flash",
      display_name: "3.5 flash",
      reasoning_support: true,
    },
    {
      label: "Gemini 3.1 Pro",
      modelId: "gemini-3.1-pro",
      provider: "google",
      effortParam: "thinkingLevel",
      availableEfforts: ["low", "medium", "high"],
      defaultEffort: "high",
      model_name: "Gemini 3.1 Pro",
      display_name: "3.1 pro",
      reasoning_support: true,
    }
  ],
  Claude: [
    {
      label: "Claude 4.6 Opus",
      modelId: "claude-opus-4-6",
      provider: "anthropic",
      effortParam: "output_config.effort",
      availableEfforts: ["low", "medium", "high", "max"],
      defaultEffort: "high",
      model_name: "Claude 4.6 Opus",
      display_name: "Opus 4.6",
      reasoning_support: true,
    },
    {
      label: "Claude 4.7 Opus",
      modelId: "claude-opus-4-7",
      provider: "anthropic",
      effortParam: "output_config.effort",
      availableEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      recommendedCodingEffort: "xhigh",
      model_name: "Claude 4.7 Opus",
      display_name: "Opus 4.7",
      reasoning_support: true,
    },
    {
      label: "Claude 4.8 Opus",
      modelId: "claude-opus-4-8",
      provider: "anthropic",
      effortParam: "output_config.effort",
      availableEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      recommendedCodingEffort: "xhigh",
      model_name: "Claude 4.8 Opus",
      display_name: "Opus 4.8",
      reasoning_support: true,
    },
    {
      label: "Claude 4.6 Sonnet",
      modelId: "claude-sonnet-4-6",
      provider: "anthropic",
      effortParam: "output_config.effort",
      availableEfforts: ["low", "medium", "high", "max"],
      defaultEffort: "high",
      model_name: "Claude 4.6 Sonnet",
      display_name: "Sonnet 4.6",
      reasoning_support: true,
    }
  ]
};

export const getDisplayModelName = (agentName: string | undefined, modelName: string | undefined): string => {
  if (!modelName) return '';
  if (!agentName) return modelName;
  
  const configs = AGENTS_CONFIG[agentName as AgentName];
  if (!configs) return modelName;
  
  const config = configs.find(m => m.model_name === modelName);
  return config?.display_name || config?.label || modelName;
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
  return config ? config.defaultEffort : 'medium';
};
