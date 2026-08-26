// DVF-0685: frozen verification candidates retain reusable coverage identity.
import crypto from 'node:crypto';

export const MAX_VERIFICATION_BATCH_CHECKS = 64;

export type VerificationCoverageIdentity = Readonly<{
  key: string;
  command: string;
  semanticKey: string;
  commandConfigFingerprint?: string;
  affectedInputFingerprint?: string;
  affectedInputPaths: readonly string[];
  dependencyFingerprint?: string;
  environmentFingerprint?: string;
  platform?: string;
  arch?: string;
  runtime?: string;
}>;

export function buildVerificationCoverageIdentity(value: any): VerificationCoverageIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const semanticKey = typeof value.semanticKey === 'string' ? value.semanticKey.trim() : '';
  if (!command || !semanticKey) return null;
  const affectedInputPaths: string[] = Array.isArray(value.affectedInputPaths)
    ? Array.from(new Set<string>(
        value.affectedInputPaths
          .map((entry: unknown): string => String(entry || '').trim())
          .filter((entry: string) => entry.length > 0),
      )).sort()
    : [];
  const comparable = {
    command,
    semanticKey,
    commandConfigFingerprint: typeof value.commandConfigFingerprint === 'string' ? value.commandConfigFingerprint : null,
    affectedInputFingerprint: typeof value.affectedInputFingerprint === 'string' ? value.affectedInputFingerprint : null,
    affectedInputPaths,
    dependencyFingerprint: typeof value.dependencyFingerprint === 'string' ? value.dependencyFingerprint : null,
    environmentFingerprint: typeof value.environmentFingerprint === 'string' ? value.environmentFingerprint : null,
    platform: typeof value.platform === 'string' ? value.platform : null,
    arch: typeof value.arch === 'string' ? value.arch : null,
    runtime: typeof value.runtime === 'string' ? value.runtime : null,
  };
  return Object.freeze({
    key: crypto.createHash('sha256').update(JSON.stringify(comparable)).digest('hex'),
    command,
    semanticKey,
    ...(comparable.commandConfigFingerprint ? { commandConfigFingerprint: comparable.commandConfigFingerprint } : {}),
    ...(comparable.affectedInputFingerprint ? { affectedInputFingerprint: comparable.affectedInputFingerprint } : {}),
    affectedInputPaths: Object.freeze([...affectedInputPaths]),
    ...(comparable.dependencyFingerprint ? { dependencyFingerprint: comparable.dependencyFingerprint } : {}),
    ...(comparable.environmentFingerprint ? { environmentFingerprint: comparable.environmentFingerprint } : {}),
    ...(comparable.platform ? { platform: comparable.platform } : {}),
    ...(comparable.arch ? { arch: comparable.arch } : {}),
    ...(comparable.runtime ? { runtime: comparable.runtime } : {}),
  });
}

export type VerificationBatchCandidateIdentity = Readonly<{
  candidateId: string;
  repoRevision: string;
  executionKey: string;
  coverage?: VerificationCoverageIdentity;
}>;

export type VerificationBatchResultStatus = 'passed' | 'failed' | 'stale' | 'blocked';

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
  blocked: readonly string[];
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
  const coverage = buildVerificationCoverageIdentity(candidate?.coverage);
  return Object.freeze({
    candidateId: requireIdentityField(candidate?.candidateId, 'candidateId'),
    repoRevision: requireIdentityField(candidate?.repoRevision, 'repoRevision'),
    executionKey: requireIdentityField(candidate?.executionKey, 'executionKey'),
    ...(coverage ? { coverage } : {}),
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
    || (expected.coverage?.key || null) !== (buildVerificationCoverageIdentity(actual?.coverage)?.key || null)
  ) {
    throw new Error('Verification batch result candidate/revision/execution identity does not match the frozen batch candidate.');
  }
}

function assertResultStatus(status: unknown): asserts status is VerificationBatchResultStatus {
  if (status !== 'passed' && status !== 'failed' && status !== 'stale' && status !== 'blocked') {
    throw new Error('Verification batch result status must be passed, failed, stale, or blocked.');
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
    const blocked = requiredChecks.filter((checkId) => results.get(checkId) === 'blocked');
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
      blocked: Object.freeze(blocked),
      canComplete: requiredChecks.length > 0
        && pending.length === 0
        && failed.length === 0
        && stale.length === 0
        && blocked.length === 0
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
