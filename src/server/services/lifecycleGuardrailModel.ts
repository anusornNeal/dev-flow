export type LifecycleGuardrailOperation =
  | 'mutation'
  | 'verification'
  | 'commit'
  | 'integration'
  | 'finalization'
  | 'status'
  | 'review'
  | 'restart'
  | 'cleanup';

export type LifecycleGuardrailCategory =
  | 'ownership'
  | 'concurrency'
  | 'filesystem'
  | 'git'
  | 'verification'
  | 'checklist'
  | 'planning'
  | 'readiness'
  | 'metadata'
  | 'workflow';

export type LifecycleGuardrailIssue = {
  code: string;
  category: LifecycleGuardrailCategory;
  message: string;
  appliesTo?: LifecycleGuardrailOperation[];
  details?: unknown;
};

export type LifecycleReconciliationRecord = {
  code: string;
  message: string;
  from?: unknown;
  to?: unknown;
  details?: unknown;
};

export type LifecycleGuardrailAssessment = {
  allowed: boolean;
  hardBlockers: LifecycleGuardrailIssue[];
  debts: LifecycleGuardrailIssue[];
  warnings: LifecycleGuardrailIssue[];
  reconciliations: LifecycleReconciliationRecord[];
};

export type LifecycleGuardrailAssessmentInput = {
  hardBlockers?: LifecycleGuardrailIssue[];
  debts?: LifecycleGuardrailIssue[];
  warnings?: LifecycleGuardrailIssue[];
  reconciliations?: LifecycleReconciliationRecord[];
};

function uniqueByCode<T extends { code: string }>(entries: T[] | undefined) {
  const unique = new Map<string, T>();
  for (const entry of entries || []) {
    const code = String(entry?.code || '').trim();
    if (!code || unique.has(code)) continue;
    unique.set(code, { ...entry, code });
  }
  return [...unique.values()];
}

export function isLifecycleOperationAllowed(
  assessment: Pick<LifecycleGuardrailAssessment, 'hardBlockers'>,
  operation: LifecycleGuardrailOperation,
) {
  return !assessment.hardBlockers.some((entry) => !entry.appliesTo || entry.appliesTo.length === 0 || entry.appliesTo.includes(operation));
}

export function createLifecycleGuardrailAssessment(
  input: LifecycleGuardrailAssessmentInput = {},
): LifecycleGuardrailAssessment {
  const hardBlockers = uniqueByCode(input.hardBlockers);
  return {
    allowed: hardBlockers.length === 0,
    hardBlockers,
    debts: uniqueByCode(input.debts),
    warnings: uniqueByCode(input.warnings),
    reconciliations: uniqueByCode(input.reconciliations),
  };
}
