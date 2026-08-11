export const MAX_VERIFICATION_BATCH_CHECKS = 64;

export type VerificationBatchCandidateIdentity = Readonly<{
  candidateId: string;
  repoRevision: string;
  executionKey: string;
}>;

export type VerificationBatchResultStatus = 'passed' | 'failed' | 'stale';

export type VerificationBatchResultInput = {
  checkId: string;
  status: VerificationBatchResultStatus;
  candidate: VerificationBatchCandidateIdentity;
};

export type VerificationBatchSnapshot = Readonly<{
  candidate: VerificationBatchCandidateIdentity;
  requiredChecks: readonly string[];
  results: Readonly<Record<string, VerificationBatchResultStatus>>;
  pending: readonly string[];
  passed: readonly string[];
  failed: readonly string[];
  stale: readonly string[];
  canComplete: boolean;
}>;

export interface VerificationBatch {
  registerRequiredCheck(checkId: string): VerificationBatchSnapshot;
  recordResult(result: VerificationBatchResultInput): VerificationBatchSnapshot;
  snapshot(): VerificationBatchSnapshot;
}

function requireIdentityField(value: unknown, field: keyof VerificationBatchCandidateIdentity) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`Verification batch candidate ${field} is required.`);
  }
  return normalized;
}

function freezeCandidate(candidate: VerificationBatchCandidateIdentity): VerificationBatchCandidateIdentity {
  return Object.freeze({
    candidateId: requireIdentityField(candidate?.candidateId, 'candidateId'),
    repoRevision: requireIdentityField(candidate?.repoRevision, 'repoRevision'),
    executionKey: requireIdentityField(candidate?.executionKey, 'executionKey'),
  });
}

function normalizeCheckId(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error('Verification batch required check id is required.');
  if (normalized.length > 200) throw new Error('Verification batch required check id is too long.');
  return normalized;
}

function assertMatchingCandidate(
  expected: VerificationBatchCandidateIdentity,
  actual: VerificationBatchCandidateIdentity,
) {
  if (
    expected.candidateId !== actual?.candidateId
    || expected.repoRevision !== actual?.repoRevision
    || expected.executionKey !== actual?.executionKey
  ) {
    throw new Error('Verification batch result candidate/revision/execution identity does not match the frozen batch candidate.');
  }
}

function assertResultStatus(status: unknown): asserts status is VerificationBatchResultStatus {
  if (status !== 'passed' && status !== 'failed' && status !== 'stale') {
    throw new Error('Verification batch result status must be passed, failed, or stale.');
  }
}

export function createVerificationBatch(
  candidateInput: VerificationBatchCandidateIdentity,
  initialRequiredChecks: readonly string[] = [],
): VerificationBatch {
  const candidate = freezeCandidate(candidateInput);
  const requiredChecks: string[] = [];
  const requiredCheckSet = new Set<string>();
  const results = new Map<string, VerificationBatchResultStatus>();

  function buildSnapshot(): VerificationBatchSnapshot {
    const pending = requiredChecks.filter((checkId) => !results.has(checkId));
    const passed = requiredChecks.filter((checkId) => results.get(checkId) === 'passed');
    const failed = requiredChecks.filter((checkId) => results.get(checkId) === 'failed');
    const stale = requiredChecks.filter((checkId) => results.get(checkId) === 'stale');
    const resultRecord = Object.fromEntries(
      requiredChecks.flatMap((checkId) => {
        const status = results.get(checkId);
        return status ? [[checkId, status] as const] : [];
      }),
    );

    return Object.freeze({
      candidate,
      requiredChecks: Object.freeze([...requiredChecks]),
      results: Object.freeze(resultRecord),
      pending: Object.freeze(pending),
      passed: Object.freeze(passed),
      failed: Object.freeze(failed),
      stale: Object.freeze(stale),
      canComplete: requiredChecks.length > 0
        && pending.length === 0
        && failed.length === 0
        && stale.length === 0
        && passed.length === requiredChecks.length,
    });
  }

  function registerRequiredCheck(checkIdInput: string) {
    const checkId = normalizeCheckId(checkIdInput);
    if (requiredCheckSet.has(checkId)) return buildSnapshot();
    if (requiredChecks.length >= MAX_VERIFICATION_BATCH_CHECKS) {
      throw new Error(`Verification batch has too many required checks; maximum is ${MAX_VERIFICATION_BATCH_CHECKS}.`);
    }
    requiredCheckSet.add(checkId);
    requiredChecks.push(checkId);
    return buildSnapshot();
  }

  function recordResult(input: VerificationBatchResultInput) {
    const checkId = normalizeCheckId(input?.checkId);
    assertResultStatus(input?.status);
    assertMatchingCandidate(candidate, input?.candidate);
    if (!requiredCheckSet.has(checkId)) {
      throw new Error(`Verification batch result check '${checkId}' is not a registered required check.`);
    }
    if (results.has(checkId)) {
      throw new Error(`Verification batch check '${checkId}' already has a terminal result.`);
    }
    results.set(checkId, input.status);
    return buildSnapshot();
  }

  for (const checkId of initialRequiredChecks) registerRequiredCheck(checkId);

  return Object.freeze({
    registerRequiredCheck,
    recordResult,
    snapshot: buildSnapshot,
  });
}
