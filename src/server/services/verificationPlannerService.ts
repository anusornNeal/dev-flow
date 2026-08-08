export type VerificationRisk = 'low' | 'medium' | 'high';
export type ExecutionLane = 'fast' | 'safe';

export type VerificationPlanInput = {
  changedFiles?: string[];
  requestedLane?: ExecutionLane;
  requestedCommands?: string[];
  resourceIsolatedCommands?: string[];
};

export type VerificationPlanStep = {
  command: string;
  parallelGroup?: string;
  reason: string;
};

export type VerificationPlan = {
  risk: VerificationRisk;
  lane: ExecutionLane;
  commands: string[];
  steps: VerificationPlanStep[];
  requiresBroadVerify: boolean;
  reasons: string[];
};

const HIGH_RISK_PATHS = [
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
  /(^|\/)(build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties)$/i,
  /(^|\/)src\/server\/contracts\//i,
  /(^|\/)src\/server\/types\.ts$/i,
  /(^|\/)(migrations?|schema)\//i,
  /(^|\/)(auth|security|payments?|billing)\//i,
];

const LOW_RISK_PATHS = [
  /(^|\/)(README|CHANGELOG)(?:\.[^/]+)?$/i,
  /\.(md|txt)$/i,
  /(^|\/)docs?\//i,
];

const UI_PATH = /(^|\/)(components?|ui|screens?|views?)\//i;

function normalizePath(value: string) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function classifyRisk(files: string[]) {
  const normalized = files.map(normalizePath);
  if (normalized.some((file) => HIGH_RISK_PATHS.some((pattern) => pattern.test(file)))) {
    return { risk: 'high' as const, reason: 'Shared contract, build/config, schema, or sensitive infrastructure changed.' };
  }
  if (normalized.length > 0 && normalized.every((file) => LOW_RISK_PATHS.some((pattern) => pattern.test(file)))) {
    return { risk: 'low' as const, reason: 'Only documentation/text-only paths changed.' };
  }
  if (normalized.some((file) => UI_PATH.test(file))) {
    return { risk: 'medium' as const, reason: 'Isolated UI/component source changed.' };
  }
  if (normalized.length === 0) {
    return { risk: 'high' as const, reason: 'Changed-file impact is unknown.' };
  }
  return { risk: 'medium' as const, reason: 'Application/source logic changed without a high-risk path signal.' };
}

function selectCommands(risk: VerificationRisk, requested: string[]) {
  const available = unique(requested);
  if (available.length === 0) return [];
  if (risk === 'high') {
    if (available.includes('verify')) return unique([...available.filter((command) => command !== 'build'), 'verify']);
    return available;
  }
  if (risk === 'low') {
    const preferred = ['typecheck', 'lint'].filter((command) => available.includes(command));
    return preferred.length > 0 ? preferred : available.slice(0, 1);
  }
  const preferred = ['typecheck', 'test', 'lint'].filter((command) => available.includes(command));
  return preferred.length > 0 ? preferred : available.filter((command) => command !== 'build' && command !== 'verify');
}

export function planVerification(input: VerificationPlanInput): VerificationPlan {
  const files = unique((input.changedFiles || []).map(normalizePath));
  const classification = classifyRisk(files);
  const reasons = [classification.reason];
  let lane: ExecutionLane = classification.risk === 'high' ? 'safe' : 'fast';

  if (input.requestedLane === 'safe') {
    lane = 'safe';
    reasons.push('SAFE lane was explicitly requested.');
  } else if (input.requestedLane === 'fast' && classification.risk === 'high') {
    lane = 'safe';
    reasons.push('FAST request was escalated because high-risk change signals require SAFE verification.');
  } else if (input.requestedLane === 'fast') {
    lane = 'fast';
  }

  const requestedCommands = unique(input.requestedCommands || []);
  let commands = selectCommands(classification.risk, requestedCommands);
  if (lane === 'safe' && classification.risk !== 'high') {
    commands = requestedCommands.length > 0 ? requestedCommands : commands;
  }

  const isolated = new Set(input.resourceIsolatedCommands || []);
  const steps = commands.map((command) => ({
    command,
    ...(isolated.has(command) ? { parallelGroup: 'isolated' } : {}),
    reason: lane === 'safe' ? 'Selected by SAFE verification plan.' : 'Selected by targeted FAST verification plan.',
  }));

  return {
    risk: classification.risk,
    lane,
    commands,
    steps,
    requiresBroadVerify: lane === 'safe' || classification.risk === 'high',
    reasons,
  };
}
