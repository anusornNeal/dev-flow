export type VerificationRisk = 'low' | 'medium' | 'high';
export type ExecutionLane = 'fast' | 'safe' | 'full';
export type VerificationCommandScope = 'targeted' | 'broad' | 'full';
export type VerificationCommandCost = 'low' | 'medium' | 'high';
export type VerificationExecutionClass = 'fast' | 'heavy';
export type VerificationRedProof = 'obvious' | 'non-obvious';
export type VerificationResourcePressure = 'available' | 'saturated';
export type VerificationTddState = 'authored-test' | 'red-required' | 'red-deferred' | 'green-required' | 'verified';
export type VerificationRedDecision = 'required' | 'deferred';
export type VerificationRedEvidence = 'not-run' | 'deferred' | 'failed-as-expected' | 'executed';

export type VerificationTddInput = {
  testAuthored?: boolean;
  redProof?: VerificationRedProof;
  resourcePressure?: VerificationResourcePressure;
  strictTdd?: boolean;
  redExecuted?: boolean;
  redFailedAsExpected?: boolean;
  greenPassed?: boolean;
};

export type VerificationTddPolicy = {
  state: VerificationTddState;
  redDecision: VerificationRedDecision;
  redEvidence: VerificationRedEvidence;
  greenRequired: boolean;
  canIntegrate: boolean;
  reasons: string[];
};


export type VerificationCommandDescriptor = {
  command: string;
  semanticKey: string;
  scope: VerificationCommandScope;
  cost: VerificationCommandCost;
  resourceKey: string;
  verificationClass?: VerificationExecutionClass;
  sharedResources?: string[];
  acceptsTargets?: boolean;
};

export type VerificationImpactCheck = {
  command: string;
  targets?: string[];
};

export type VerificationImpactRule = {
  id?: string;
  patterns: string[];
  commands?: string[];
  targets?: string[];
  checks?: VerificationImpactCheck[];
  lane?: ExecutionLane;
  reason?: string;
};

export type VerificationImpactDecision = {
  mode: 'configured' | 'fallback';
  coveredFiles: string[];
  unknownFiles: string[];
  matchedRuleIds: string[];
  selectedCommands: string[];
  selectedChecks: VerificationImpactCheck[];
  unavailableChecks: Array<{ command: string; reason: string }>;
  omittedCommands: Array<{ command: string; reason: string }>;
};

export type VerificationPlanInput = {
  changedFiles?: string[];
  requestedLane?: ExecutionLane;
  requestedCommands?: string[];
  resolvedCommands?: VerificationCommandDescriptor[];
  resourceIsolatedCommands?: string[];
  impactRules?: VerificationImpactRule[];
  tdd?: VerificationTddInput;
};

export type VerificationPlanStep = {
  checkId: string;
  command: string;
  parallelGroup?: string;
  semanticKey?: string;
  scope?: VerificationCommandScope;
  cost?: VerificationCommandCost;
  resourceKey?: string;
  verificationClass?: VerificationExecutionClass;
  sharedResources?: string[];
  targets?: string[];
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
  impact: VerificationImpactDecision;
  tdd: VerificationTddPolicy;
};

const HIGH_RISK_PATHS = [
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
  /(^|\/)(build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties)$/i,
  /(^|\/)src\/server\/contracts\//i,
  /(^|\/)src\/server\/types\.ts$/i,
  /(^|\/)(migrations?|schema)\//i,
  /(^|\/)(auth|security|payments?|billing)\//i,
  /(^|\/)\.devflow\/(verification-impact\.json|commands\.(?:yaml|json))$/i,
  /(^|\/)src\/server\/services\/(verificationPlannerService|projectCommandConfigService|projectCommandService|applyAndVerifyService)\.ts$/i,
];

const LOW_RISK_PATHS = [
  /(^|\/)(README|CHANGELOG)(?:\.[^/]+)?$/i,
  /\.(md|txt)$/i,
  /(^|\/)docs?\//i,
];

const UI_PATH = /(^|\/)(components?|ui|screens?|views?)\//i;

function normalizePath(value: string) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
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
const LANE_RANK: Record<ExecutionLane, number> = { fast: 0, safe: 1, full: 2 };

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

function globMatches(file: string, pattern: string) {
  const normalizedPattern = normalizePath(pattern).trim();
  if (!normalizedPattern) return false;
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(normalizePath(file));
}

function normalizeImpactRules(rules: VerificationImpactRule[] | undefined) {
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((rule, index) => {
    const patterns = unique(Array.isArray(rule?.patterns) ? rule.patterns.map(normalizePath) : []);
    const legacyCommands = unique(Array.isArray(rule?.commands) ? rule.commands.map((entry) => String(entry || '').trim()) : []);
    const legacyTargets = unique(Array.isArray(rule?.targets) ? rule.targets.map(normalizePath) : []);
    const legacyChecks: VerificationImpactCheck[] = legacyCommands
      .map((command) => ({ command, ...(legacyCommands.length === 1 && legacyTargets.length > 0 ? { targets: legacyTargets } : {}) }));
    const structuredChecks: VerificationImpactCheck[] = Array.isArray(rule?.checks)
      ? rule.checks.flatMap((check) => {
          const command = String(check?.command || '').trim();
          if (!command) return [];
          const targets = unique(Array.isArray(check?.targets) ? check.targets.map(normalizePath) : []);
          return [{ command, ...(targets.length > 0 ? { targets } : {}) }];
        })
      : [];
    const checks = [...legacyChecks, ...structuredChecks].filter((check, checkIndex, array) => {
      const key = JSON.stringify([check.command, ...(check.targets || []).slice().sort()]);
      return array.findIndex((candidate) => JSON.stringify([candidate.command, ...(candidate.targets || []).slice().sort()]) === key) === checkIndex;
    });
    if (patterns.length === 0 || checks.length === 0) return [];
    const lane = rule.lane === 'safe' || rule.lane === 'full' || rule.lane === 'fast' ? rule.lane : undefined;
    return [{
      id: String(rule.id || `rule-${index + 1}`),
      patterns,
      commands: unique(checks.map((check) => check.command)),
      checks,
      lane,
      reason: typeof rule.reason === 'string' ? rule.reason.trim() : '',
    }];
  });
}

function evaluateImpact(
  files: string[],
  rules: ReturnType<typeof normalizeImpactRules>,
  availableCommands: string[],
  resolvedCommands: VerificationCommandDescriptor[],
  risk: VerificationRisk,
) {
  const coveredFiles: string[] = [];
  const unknownFiles: string[] = [];
  const matchedRules: typeof rules = [];
  for (const file of files) {
    const matching = rules.filter((rule) => rule.patterns.some((pattern) => globMatches(file, pattern)));
    if (matching.length === 0) unknownFiles.push(file);
    else {
      coveredFiles.push(file);
      matchedRules.push(...matching);
    }
  }
  const uniqueMatchedRules = matchedRules.filter((rule, index, array) => array.findIndex((candidate) => candidate.id === rule.id) === index);
  const groupedChecks = new Map<string, { command: string; targets: Set<string>; untargeted: boolean }>();
  for (const check of uniqueMatchedRules.flatMap((rule) => rule.checks)) {
    const current = groupedChecks.get(check.command) || { command: check.command, targets: new Set<string>(), untargeted: false };
    const targets = unique((check.targets || []).map(normalizePath));
    if (targets.length === 0) current.untargeted = true;
    else targets.forEach((target) => current.targets.add(target));
    groupedChecks.set(check.command, current);
  }

  const available = new Set(availableCommands);
  const resolvedByCommand = new Map(resolvedCommands.map((entry) => [entry.command, entry]));
  const configuredChecks: VerificationImpactCheck[] = [];
  const unavailableChecks: Array<{ command: string; reason: string }> = [];
  for (const grouped of groupedChecks.values()) {
    if (!available.has(grouped.command)) {
      unavailableChecks.push({ command: grouped.command, reason: 'Mapped verification command is not available in the current repository command catalog.' });
      continue;
    }
    const descriptor = resolvedByCommand.get(grouped.command);
    const targets = Array.from(grouped.targets).sort();
    if (targets.length > 0 && (!descriptor || descriptor.acceptsTargets !== true)) {
      unavailableChecks.push({ command: grouped.command, reason: descriptor
        ? 'Mapped verification targets require a preset that accepts targets.'
        : 'Mapped verification targets require a resolved command descriptor before coverage can narrow.' });
      continue;
    }
    if (grouped.untargeted && descriptor?.acceptsTargets === true) {
      unavailableChecks.push({ command: grouped.command, reason: 'Target-aware verification preset requires explicit mapped targets before coverage can narrow.' });
      continue;
    }
    configuredChecks.push({ command: grouped.command, ...(targets.length > 0 ? { targets } : {}) });
  }
  const configuredCommands = unique(configuredChecks.map((check) => check.command));
  const completeCoverage = files.length > 0
    && rules.length > 0
    && unknownFiles.length === 0
    && groupedChecks.size > 0
    && unavailableChecks.length === 0
    && configuredChecks.length === groupedChecks.size;
  const mode: 'configured' | 'fallback' = completeCoverage && risk !== 'high' ? 'configured' : 'fallback';
  const lane = uniqueMatchedRules.reduce<ExecutionLane | undefined>((current, rule) => {
    if (!rule.lane) return current;
    if (!current || LANE_RANK[rule.lane] > LANE_RANK[current]) return rule.lane;
    return current;
  }, undefined);
  return {
    mode,
    coveredFiles,
    unknownFiles,
    matchedRuleIds: uniqueMatchedRules.map((rule) => rule.id),
    configuredCommands,
    configuredChecks,
    unavailableChecks,
    lane,
    reasons: unique(uniqueMatchedRules.map((rule) => rule.reason).filter(Boolean)),
  };
}

export function planTddPolicy(risk: VerificationRisk, input: VerificationTddInput = {}): VerificationTddPolicy {
  const reasons: string[] = [];
  if (!input.testAuthored) {
    return {
      state: 'authored-test',
      redDecision: 'required',
      redEvidence: 'not-run',
      greenRequired: true,
      canIntegrate: false,
      reasons: ['Author a focused test before implementation.'],
    };
  }

  const redProof = input.redProof ?? 'non-obvious';
  const resourcePressure = input.resourcePressure ?? 'available';
  const redCanDefer = input.strictTdd !== true
    && risk !== 'high'
    && redProof === 'obvious'
    && resourcePressure === 'saturated';
  const redDecision: VerificationRedDecision = redCanDefer ? 'deferred' : 'required';

  if (input.strictTdd === true) reasons.push('Strict TDD requires executed RED evidence.');
  if (risk === 'high') reasons.push('High-risk work requires executed RED evidence.');
  if (redProof === 'non-obvious') reasons.push('Non-obvious RED proof must be executed.');
  if (resourcePressure === 'available') reasons.push('Verification capacity is available, so RED runs normally.');
  if (redCanDefer) reasons.push('RED is deferred because proof is obvious and verification resources are saturated.');

  const redEvidence: VerificationRedEvidence = input.redExecuted
    ? (input.redFailedAsExpected ? 'failed-as-expected' : 'executed')
    : redCanDefer
      ? 'deferred'
      : 'not-run';
  const redSatisfied = redCanDefer || (input.redExecuted === true && input.redFailedAsExpected === true);
  if (input.greenPassed === true && redSatisfied) {
    return {
      state: 'verified',
      redDecision,
      redEvidence,
      greenRequired: false,
      canIntegrate: true,
      reasons: [...reasons, 'Focused GREEN passed.'],
    };
  }

  if (redCanDefer) {
    return {
      state: 'red-deferred',
      redDecision,
      redEvidence,
      greenRequired: true,
      canIntegrate: false,
      reasons,
    };
  }

  if (redSatisfied) {
    return {
      state: 'green-required',
      redDecision,
      redEvidence,
      greenRequired: true,
      canIntegrate: false,
      reasons,
    };
  }

  return {
    state: 'red-required',
    redDecision,
    redEvidence,
    greenRequired: true,
    canIntegrate: false,
    reasons,
  };
}

export function planVerification(input: VerificationPlanInput): VerificationPlan {
  const files = unique((input.changedFiles || []).map(normalizePath));
  const classification = classifyRisk(files);
  const reasons = [classification.reason];
  const requestedCommands = unique(input.requestedCommands || []);
  const resolvedCommands = Array.isArray(input.resolvedCommands) ? input.resolvedCommands : [];
  const availableCommands = unique([...requestedCommands, ...resolvedCommands.map((entry) => entry.command)]);
  const impactEvaluation = evaluateImpact(files, normalizeImpactRules(input.impactRules), availableCommands, resolvedCommands, classification.risk);
  const tdd = planTddPolicy(classification.risk, input.tdd);
  let lane: ExecutionLane = classification.risk === 'high' ? 'safe' : 'fast';

  if (impactEvaluation.mode === 'configured') {
    reasons.push(`Configured verification impact mapping covered ${impactEvaluation.coveredFiles.length} changed file(s).`);
    reasons.push(...impactEvaluation.reasons);
    if (impactEvaluation.lane && LANE_RANK[impactEvaluation.lane] > LANE_RANK[lane]) lane = impactEvaluation.lane;
  } else if (Array.isArray(input.impactRules) && input.impactRules.length > 0) {
    const detail = impactEvaluation.unknownFiles.length > 0
      ? `unknown changed files: ${impactEvaluation.unknownFiles.join(', ')}`
      : impactEvaluation.unavailableChecks.length > 0
        ? `mapped checks are not runnable: ${impactEvaluation.unavailableChecks.map((entry) => `${entry.command} (${entry.reason})`).join(', ')}`
        : classification.risk === 'high'
          ? 'high-risk paths require conservative verification'
          : 'configured rules did not resolve an executable verification command';
    reasons.push(`Impact mapping fallback used because ${detail}.`);
  }

  if (impactEvaluation.unavailableChecks.length > 0 && lane === 'fast') {
    lane = 'safe';
    reasons.push('Mapped verification requirements are unavailable, so FAST narrowing is disabled until broader evidence is available.');
  }

  if (input.requestedLane === 'full') {
    lane = 'full';
    reasons.push('FULL lane was explicitly requested.');
  } else if (input.requestedLane === 'safe') {
    lane = 'safe';
    reasons.push('SAFE lane was explicitly requested.');
  } else if (input.requestedLane === 'fast' && (classification.risk === 'high' || impactEvaluation.unavailableChecks.length > 0)) {
    lane = 'safe';
    reasons.push(classification.risk === 'high'
      ? 'FAST request was escalated because high-risk change signals require SAFE verification.'
      : 'FAST request was escalated because mapped verification requirements are unavailable.');
  } else if (input.requestedLane === 'fast') {
    lane = 'fast';
  }

  let selectedResolved: VerificationCommandDescriptor[] = [];
  let commands: string[] = [];
  const mappingMayNarrow = impactEvaluation.mode === 'configured'
    && lane === 'fast'
    && input.requestedLane !== 'safe'
    && input.requestedLane !== 'full'
    && classification.risk !== 'high';

  if (mappingMayNarrow) {
    commands = impactEvaluation.configuredCommands;
    if (resolvedCommands.length > 0) {
      const configured = new Set(commands);
      selectedResolved = dedupeResolvedCommands(resolvedCommands.filter((entry) => configured.has(entry.command)));
      if (selectedResolved.length > 0) commands = selectedResolved.map((entry) => entry.command);
    }
  } else {
    const fallbackResolvedCommands = impactEvaluation.mode === 'fallback'
      && requestedCommands.length === 0
      && lane === 'fast'
      ? resolvedCommands.filter((entry) => entry.scope !== 'targeted')
      : resolvedCommands;
    selectedResolved = fallbackResolvedCommands.length > 0
      ? selectResolvedCommands(classification.risk, lane, fallbackResolvedCommands)
      : [];
    commands = selectedResolved.length > 0
      ? selectedResolved.map((command) => command.command)
      : selectCommands(classification.risk, requestedCommands);
    if (selectedResolved.length === 0 && lane === 'safe' && classification.risk !== 'high') {
      commands = requestedCommands.length > 0 ? requestedCommands : commands;
    }
    if (selectedResolved.length === 0 && lane === 'full' && requestedCommands.includes('verify')) {
      commands = ['verify'];
    }
  }

  if (impactEvaluation.unavailableChecks.length > 0) {
    if (resolvedCommands.length > 0) {
      selectedResolved = selectedResolved.filter((entry) => entry.scope !== 'targeted');
      commands = selectedResolved.map((entry) => entry.command);
    } else if (!commands.includes('verify')) {
      commands = [];
    }
    if (commands.length === 0) {
      reasons.push('No broad or full verification evidence is available to substitute for the unavailable mapped requirement; verification must remain incomplete.');
    }
  }

  commands = unique(commands);
  const isolated = new Set(input.resourceIsolatedCommands || []);
  const selectedByCommand = new Map(selectedResolved.map((command) => [command.command, command]));
  const configuredTargetsByCommand = new Map(impactEvaluation.configuredChecks.map((check) => [check.command, check.targets || []]));
  const steps = commands.map((command) => {
    const descriptor = selectedByCommand.get(command);
    const mappedTargets = configuredTargetsByCommand.get(command) || [];
    const targets = mappingMayNarrow || descriptor?.acceptsTargets === true ? mappedTargets : [];
    const mappingReason = impactEvaluation.mode === 'configured' && impactEvaluation.configuredCommands.includes(command)
      ? 'Selected by configured change-impact mapping.'
      : undefined;
    return {
      checkId: `green:${descriptor?.semanticKey || command}${targets.length > 0 ? `:${targets.join(',')}` : ''}`,
      command,
      ...(targets.length > 0 ? { targets } : {}),
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
      reason: mappingReason || (lane === 'full'
        ? 'Selected by FULL verification plan.'
        : lane === 'safe'
          ? 'Selected by SAFE verification plan.'
          : 'Selected by targeted FAST verification plan.'),
    };
  });

  const omittedCommands = availableCommands
    .filter((command) => !commands.includes(command))
    .map((command) => ({
      command,
      reason: impactEvaluation.mode === 'configured'
        ? 'Command was not selected by the configured impact rules for the changed files.'
        : 'Command was not selected by the conservative fallback plan for this lane and risk.',
    }));

  return {
    risk: classification.risk,
    lane,
    commands,
    steps,
    requiresBroadVerify: lane !== 'fast' || classification.risk === 'high',
    reasons,
    impact: {
      mode: impactEvaluation.mode,
      coveredFiles: impactEvaluation.coveredFiles,
      unknownFiles: impactEvaluation.unknownFiles,
      matchedRuleIds: impactEvaluation.matchedRuleIds,
      selectedCommands: commands,
      selectedChecks: steps.map((step) => ({ command: step.command, ...(step.targets?.length ? { targets: [...step.targets] } : {}) })),
      unavailableChecks: impactEvaluation.unavailableChecks,
      omittedCommands,
    },
    tdd,
  };
}
