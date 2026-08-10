export type VerificationRisk = 'low' | 'medium' | 'high';
export type ExecutionLane = 'fast' | 'safe' | 'full';
export type VerificationCommandScope = 'targeted' | 'broad' | 'full';
export type VerificationCommandCost = 'low' | 'medium' | 'high';
export type VerificationExecutionClass = 'fast' | 'heavy';

export type VerificationCommandDescriptor = {
  command: string;
  semanticKey: string;
  scope: VerificationCommandScope;
  cost: VerificationCommandCost;
  resourceKey: string;
  verificationClass?: VerificationExecutionClass;
  sharedResources?: string[];
};

export type VerificationPlanInput = {
  changedFiles?: string[];
  requestedLane?: ExecutionLane;
  requestedCommands?: string[];
  resolvedCommands?: VerificationCommandDescriptor[];
  resourceIsolatedCommands?: string[];
};

export type VerificationPlanStep = {
  command: string;
  parallelGroup?: string;
  semanticKey?: string;
  scope?: VerificationCommandScope;
  cost?: VerificationCommandCost;
  resourceKey?: string;
  verificationClass?: VerificationExecutionClass;
  sharedResources?: string[];
  stage?: number;
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

const COST_RANK: Record<VerificationCommandCost, number> = { low: 0, medium: 1, high: 2 };

function dedupeResolvedCommands(commands: VerificationCommandDescriptor[]) {
  const seen = new Set<string>();
  const deduped: VerificationCommandDescriptor[] = [];
  for (const command of commands) {
    const key = command.semanticKey || command.command;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(command);
  }
  return deduped;
}

function selectResolvedCommands(risk: VerificationRisk, lane: ExecutionLane, commands: VerificationCommandDescriptor[]) {
  const available = dedupeResolvedCommands(commands)
    .map((command, index) => ({ command, index }))
    .sort((left, right) => COST_RANK[left.command.cost] - COST_RANK[right.command.cost] || left.index - right.index)
    .map((entry) => entry.command);
  if (available.length === 0) return [];

  const full = available.filter((command) => command.scope === 'full');
  if (lane === 'full') return full.length > 0 ? full.slice(0, 1) : available;
  if (lane === 'safe' || risk === 'high') return full.length > 0 ? full.slice(0, 1) : available;

  const fastCandidates = available.filter((command) => command.scope !== 'full');
  const targeted = fastCandidates.filter((command) => command.scope === 'targeted');
  return targeted.length > 0 ? targeted : fastCandidates.slice(0, 1);
}

export function planVerification(input: VerificationPlanInput): VerificationPlan {
  const files = unique((input.changedFiles || []).map(normalizePath));
  const classification = classifyRisk(files);
  const reasons = [classification.reason];
  let lane: ExecutionLane = classification.risk === 'high' ? 'safe' : 'fast';

  if (input.requestedLane === 'full') {
    lane = 'full';
    reasons.push('FULL lane was explicitly requested.');
  } else if (input.requestedLane === 'safe') {
    lane = 'safe';
    reasons.push('SAFE lane was explicitly requested.');
  } else if (input.requestedLane === 'fast' && classification.risk === 'high') {
    lane = 'safe';
    reasons.push('FAST request was escalated because high-risk change signals require SAFE verification.');
  } else if (input.requestedLane === 'fast') {
    lane = 'fast';
  }

  const requestedCommands = unique(input.requestedCommands || []);
  const resolvedCommands = Array.isArray(input.resolvedCommands) ? input.resolvedCommands : [];
  const selectedResolved = resolvedCommands.length > 0
    ? selectResolvedCommands(classification.risk, lane, resolvedCommands)
    : [];
  let commands = selectedResolved.length > 0
    ? selectedResolved.map((command) => command.command)
    : selectCommands(classification.risk, requestedCommands);
  if (selectedResolved.length === 0 && lane === 'safe' && classification.risk !== 'high') {
    commands = requestedCommands.length > 0 ? requestedCommands : commands;
  }
  if (selectedResolved.length === 0 && lane === 'full' && requestedCommands.includes('verify')) {
    commands = ['verify'];
  }

  const isolated = new Set(input.resourceIsolatedCommands || []);
  const selectedByCommand = new Map(selectedResolved.map((command) => [command.command, command]));
  const steps = commands.map((command) => {
    const descriptor = selectedByCommand.get(command);
    return {
      command,
      ...(isolated.has(command) ? { parallelGroup: 'isolated' } : {}),
      ...(descriptor ? {
        semanticKey: descriptor.semanticKey,
        scope: descriptor.scope,
        cost: descriptor.cost,
        resourceKey: descriptor.resourceKey,
        stage: COST_RANK[descriptor.cost],
        verificationClass: descriptor.verificationClass ?? (descriptor.scope === 'full' || descriptor.cost === 'high' ? 'heavy' : 'fast'),
        sharedResources: unique(descriptor.sharedResources?.length ? descriptor.sharedResources : [descriptor.resourceKey]),
      } : {}),
      reason: lane === 'full'
        ? 'Selected by FULL verification plan.'
        : lane === 'safe'
          ? 'Selected by SAFE verification plan.'
          : 'Selected by targeted FAST verification plan.',
    };
  });

  return {
    risk: classification.risk,
    lane,
    commands,
    steps,
    requiresBroadVerify: lane !== 'fast' || classification.risk === 'high',
    reasons,
  };
}
