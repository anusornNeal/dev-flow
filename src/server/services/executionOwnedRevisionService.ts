import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withDbTransaction } from '../../db/index.js';
import {
  listExecutionSessionEvidence,
  saveExecutionSessionEvidence,
  updateExecutionSessionRecord,
} from '../repositories/executionSessionRepository.js';
import { getTask } from '../repositories/taskRepository.js';
import { getFileRevision, resolveSafePath } from './localFileService.js';
import { buildRepoEvidenceIdentity, getRepoRevisionForRoot } from './repoRevisionService.js';
import {
  assertExecutionSessionActive,
  executionSessionError,
  readExecutionStringMetadata,
  requireExecutionSession,
} from './executionSessionPolicyPrimitives.js';

export interface RecordExecutionOwnedChangesOptions {
  repoRoot: string;
  source: string;
  now?: Date;
  metadata?: Record<string, unknown>;
  metadataByPath?: Record<string, Record<string, unknown>>;
}

export type ExecutionOwnedRevisionReconciliationFile = {
  path: string;
  expectedKnownRevision: string;
  expectedCurrentRevision: string;
};

export interface ExecutionOwnershipState {
  sessionId: string;
  repoRevision: string;
  ownedFingerprint: string;
  ownedFiles: Array<{
    path: string;
    acquisitionFileRevision: string;
    knownFileRevision: string;
    currentFileRevision: string;
    observedFileRevision: string;
    source: string;
    acquiredAt?: string;
    observedAt?: string;
    drifted: boolean;
  }>;
  ownedChanges: string[];
  unrelatedChanges: string[];
  scopeDrift: string[];
  ownershipDrift: Array<{ path: string; knownFileRevision: string; currentFileRevision: string }>;
  verifiedOwnershipDrift: Array<{ path: string; knownFileRevision: string; currentFileRevision: string }>;
  verificationFresh: boolean | null;
  verificationRecordedAt?: string;
}

export type ExecutionVerificationAuthorityInvalidator = (
  id: string,
  reconciliationId: string,
  nowIso: string,
) => void;

function normalizeEvidencePath(value?: string | null) {
  if (value == null || String(value).trim() === '') return null;
  const normalized = String(value).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw executionSessionError('EXECUTION_SESSION_EVIDENCE_PATH_INVALID', 'Evidence paths must be repository-relative paths.');
  }
  return normalized;
}

function normalizeStringList(values?: string[]) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim().replace(/\\/g, '/')).filter(Boolean))].sort();
}

function normalizeClaimScopePath(value: string) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function requireRepoRoot(repoRoot?: string) {
  if (!repoRoot) throw executionSessionError('EXECUTION_SESSION_REPO_ROOT_REQUIRED', 'repoRoot is required for execution ownership provenance.');
  return path.resolve(repoRoot);
}

function currentOwnedFileRevision(root: string, relativePath: string) {
  try {
    const fullPath = resolveSafePath(root, relativePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return 'missing';
    return getFileRevision(fullPath).token;
  } catch {
    return 'missing';
  }
}

function ownedRevisionContentIdentity(revision: string) {
  const normalized = String(revision || '').trim();
  if (!normalized || normalized === 'missing') return normalized || 'missing';
  const parts = normalized.split(':');
  if (parts.length < 3) return normalized;
  return `${parts[0]}:${parts[parts.length - 1]}`;
}

function sameOwnedContentRevision(left: string, right: string) {
  return ownedRevisionContentIdentity(left) === ownedRevisionContentIdentity(right);
}

function ownedRevisionFingerprint(entries: Array<{ path: string; revision: string }>) {
  const digest = crypto.createHash('sha256');
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(entry.path);
    digest.update('\0');
    digest.update(entry.revision);
    digest.update('\0');
  }
  return digest.digest('hex').slice(0, 32);
}

function evidenceId(sessionId: string, input: { kind: string; path: string | null; contextHandle: string | null }) {
  const digest = crypto.createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(input.kind)
    .update('\0')
    .update(input.path || '')
    .update('\0')
    .update(input.contextHandle || '')
    .digest('hex')
    .slice(0, 24);
  return `evidence-${digest}`;
}

export function recordExecutionOwnedChanges(
  id: string,
  paths: string[],
  options: RecordExecutionOwnedChangesOptions,
) {
  const session = requireExecutionSession(id);
  assertExecutionSessionActive(session);
  const root = requireRepoRoot(options.repoRoot);
  const nowIso = (options.now || new Date()).toISOString();
  const source = String(options.source || '').trim();
  if (!source) throw executionSessionError('EXECUTION_OWNERSHIP_SOURCE_REQUIRED', 'Execution ownership source is required.');
  const repo = getRepoRevisionForRoot(root);
  const existing = new Map(
    listExecutionSessionEvidence(id)
      .filter((entry) => entry.kind === 'owned-change' && entry.path)
      .map((entry) => [entry.path!, entry] as const),
  );
  const ownedPaths = normalizeStringList(paths)
    .map((entry) => normalizeEvidencePath(entry))
    .filter((entry): entry is string => Boolean(entry));

  withDbTransaction(() => {
    for (const ownedPath of ownedPaths) {
      const currentFileRevision = currentOwnedFileRevision(root, ownedPath);
      const prior = existing.get(ownedPath);
      const priorMetadata = prior?.metadata || {};
      const acquisitionFileRevision = readExecutionStringMetadata(priorMetadata, 'acquisitionFileRevision') || prior?.fileRevision || currentFileRevision;
      const acquisitionRepoRevision = readExecutionStringMetadata(priorMetadata, 'acquisitionRepoRevision') || prior?.repoRevision || repo.token;
      const acquiredAt = readExecutionStringMetadata(priorMetadata, 'acquiredAt') || prior?.createdAt || nowIso;
      saveExecutionSessionEvidence({
        id: evidenceId(id, { kind: 'owned-change', path: ownedPath, contextHandle: session.contextHandle }),
        sessionId: id,
        kind: 'owned-change',
        path: ownedPath,
        repoRevision: repo.token,
        fileRevision: currentFileRevision,
        revisionIdentity: buildRepoEvidenceIdentity({ repoRevision: repo.token, filePath: ownedPath, fileRevision: currentFileRevision }),
        contextHandle: session.contextHandle,
        stale: false,
        metadata: {
          ...priorMetadata,
          ...(options.metadata || {}),
          ...(options.metadataByPath?.[ownedPath] || {}),
          executionSource: source,
          acquisitionFileRevision,
          acquisitionRepoRevision,
          acquiredAt,
          knownFileRevision: currentFileRevision,
          observedAt: nowIso,
        },
        createdAt: prior?.createdAt || nowIso,
        updatedAt: nowIso,
      });
    }

    updateExecutionSessionRecord(id, {
      changedFiles: normalizeStringList([...session.changedFiles, ...ownedPaths]),
      repoRevision: repo.token,
      updatedAt: nowIso,
    });
  });
  return getExecutionOwnershipState(id, { repoRoot: root });
}

export function getExecutionOwnershipState(
  id: string,
  options: { repoRoot: string; expectedPaths?: string[] },
): ExecutionOwnershipState {
  const session = requireExecutionSession(id);
  const root = requireRepoRoot(options.repoRoot);
  const repo = getRepoRevisionForRoot(root);
  const evidence = listExecutionSessionEvidence(id);
  const ownedEvidence = evidence.filter((entry) => entry.kind === 'owned-change' && entry.path);
  const ownedFiles = ownedEvidence.map((entry) => {
    const metadata = entry.metadata || {};
    const observedFileRevision = currentOwnedFileRevision(root, entry.path!);
    const knownFileRevision = readExecutionStringMetadata(metadata, 'knownFileRevision') || entry.fileRevision || 'missing';
    const contentEquivalent = sameOwnedContentRevision(observedFileRevision, knownFileRevision);
    const currentFileRevision = contentEquivalent ? knownFileRevision : observedFileRevision;
    return {
      path: entry.path!,
      acquisitionFileRevision: readExecutionStringMetadata(metadata, 'acquisitionFileRevision') || entry.fileRevision || 'missing',
      knownFileRevision,
      currentFileRevision,
      observedFileRevision,
      source: readExecutionStringMetadata(metadata, 'executionSource') || 'unknown',
      acquiredAt: readExecutionStringMetadata(metadata, 'acquiredAt'),
      observedAt: readExecutionStringMetadata(metadata, 'observedAt'),
      drifted: !contentEquivalent,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  const ownedPathSet = new Set(ownedFiles.map((entry) => entry.path));
  const changedPaths = normalizeStringList(repo.changedFiles.map((entry) => entry.workingPath));
  const ownedChanges = changedPaths.filter((entry) => ownedPathSet.has(entry));
  const unrelatedChanges = changedPaths.filter((entry) => !ownedPathSet.has(entry));
  const task = session.taskId ? getTask(session.taskId) : undefined;
  const taskScope = [
    ...(Array.isArray(task?.targetFiles) ? task.targetFiles : []),
    ...(Array.isArray((task?.claim as any)?.reservedPaths) ? (task!.claim as any).reservedPaths : []),
  ];
  const expectedScope = new Set(
    normalizeStringList(options.expectedPaths || taskScope)
      .map(normalizeClaimScopePath)
      .filter(Boolean),
  );
  const scopeDrift = expectedScope.size > 0
    ? changedPaths.filter((entry) => !expectedScope.has(normalizeClaimScopePath(entry)))
    : [];
  const currentOwnedFingerprint = ownedRevisionFingerprint(
    ownedFiles.map((entry) => ({ path: entry.path, revision: entry.currentFileRevision })),
  );
  const verificationBinding = evidence
    .filter((entry) => entry.kind === 'verification-binding' && !readExecutionStringMetadata(entry.metadata || {}, 'invalidatedAt'))
    .at(-1);
  const boundFingerprint = verificationBinding ? readExecutionStringMetadata(verificationBinding.metadata || {}, 'ownedFingerprint') : undefined;
  const verificationPolicy = verificationBinding
    ? readExecutionStringMetadata(verificationBinding.metadata || {}, 'verificationPolicy')
    : undefined;
  const verificationFresh = verificationBinding
    ? Boolean(boundFingerprint)
      && boundFingerprint === currentOwnedFingerprint
      && (session.verification.length > 0 || verificationPolicy === 'no-checks-required' || verificationPolicy === 'operator-break-glass')
    : session.verification.length === 0
      ? null
      : false;
  const ownershipDrift = ownedFiles
    .filter((entry) => entry.drifted)
    .map((entry) => ({ path: entry.path, knownFileRevision: entry.knownFileRevision, currentFileRevision: entry.currentFileRevision }));
  const verifiedOwnershipDrift = verificationFresh === true ? ownershipDrift : [];

  return {
    sessionId: id,
    repoRevision: repo.token,
    ownedFingerprint: currentOwnedFingerprint,
    ownedFiles,
    ownedChanges,
    unrelatedChanges,
    scopeDrift,
    ownershipDrift,
    verifiedOwnershipDrift,
    verificationFresh,
    verificationRecordedAt: verificationBinding ? readExecutionStringMetadata(verificationBinding.metadata || {}, 'recordedAt') : undefined,
  };
}

export function adoptExecutionOwnedChanges(
  id: string,
  files: Array<{ path: string; expectedRevision: string }>,
  options: { repoRoot: string; reason: string; now?: Date },
) {
  const session = requireExecutionSession(id);
  assertExecutionSessionActive(session);
  const root = requireRepoRoot(options.repoRoot);
  const reason = String(options.reason || '').trim();
  if (reason.length < 10) {
    throw executionSessionError('EXECUTION_ADOPTION_REASON_REQUIRED', 'Legacy ownership adoption requires an audit reason of at least 10 characters.');
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > 100) {
    throw executionSessionError('EXECUTION_ADOPTION_FILES_REQUIRED', 'Legacy ownership adoption requires 1-100 explicit path+expectedRevision entries.');
  }

  const ownership = getExecutionOwnershipState(id, { repoRoot: root });
  const unrelated = new Set(ownership.unrelatedChanges);
  const normalized = files.map((entry) => {
    const ownedPath = normalizeEvidencePath(entry?.path);
    if (!ownedPath) {
      throw executionSessionError('EXECUTION_ADOPTION_PATH_REQUIRED', 'Legacy ownership adoption requires an explicit repository-relative path.');
    }
    const expectedRevision = String(entry?.expectedRevision || '').trim();
    if (!expectedRevision) {
      throw executionSessionError('EXECUTION_ADOPTION_REVISION_REQUIRED', `Expected revision is required for '${ownedPath}'.`);
    }
    if (!unrelated.has(ownedPath)) {
      throw executionSessionError('EXECUTION_ADOPTION_NOT_UNOWNED_DIRTY', `Path '${ownedPath}' is not a current dirty/unowned workspace path.`);
    }
    const currentRevision = currentOwnedFileRevision(root, ownedPath);
    if (currentRevision !== expectedRevision) {
      throw executionSessionError('EXECUTION_ADOPTION_REVISION_MISMATCH', `Path '${ownedPath}' changed since adoption evidence was captured.`);
    }
    return { path: ownedPath, expectedRevision, currentRevision };
  });
  if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) {
    throw executionSessionError('EXECUTION_ADOPTION_DUPLICATE_PATH', 'Legacy ownership adoption paths must be unique.');
  }

  const adoptedAt = (options.now || new Date()).toISOString();
  const metadataByPath = Object.fromEntries(normalized.map((entry) => [entry.path, {
    adoptionReason: reason,
    adoptionExpectedRevision: entry.expectedRevision,
    adoptedAt,
    adoptionMode: 'explicit-legacy-recovery',
  }]));
  const result = recordExecutionOwnedChanges(id, normalized.map((entry) => entry.path), {
    repoRoot: root,
    source: 'legacy-adoption',
    now: options.now,
    metadataByPath,
  });
  return {
    sessionId: id,
    adoptedPaths: normalized.map((entry) => entry.path),
    reason,
    ownership: result,
  };
}

function ownedRevisionReconciliationId(
  sessionId: string,
  files: ExecutionOwnedRevisionReconciliationFile[],
  reason: string,
  provenance: string,
) {
  const digest = crypto.createHash('sha256')
    .update(sessionId)
    .update('|owned-revision-reconciliation|')
    .update(JSON.stringify(files))
    .update('|')
    .update(reason)
    .update('|')
    .update(provenance)
    .digest('hex')
    .slice(0, 24);
  return `owned-revision-reconciliation-${digest}`;
}

export function reconcileExecutionOwnedRevisionDrift(
  id: string,
  files: ExecutionOwnedRevisionReconciliationFile[],
  options: {
    repoRoot: string;
    reason: string;
    provenance: string;
    now?: Date;
    invalidateVerificationAuthority?: ExecutionVerificationAuthorityInvalidator;
  },
) {
  const session = requireExecutionSession(id);
  assertExecutionSessionActive(session);
  const root = requireRepoRoot(options.repoRoot);
  const reason = String(options.reason || '').trim();
  const provenance = String(options.provenance || '').trim();
  if (reason.length < 10 || reason.length > 500) {
    throw executionSessionError('EXECUTION_RECONCILIATION_REASON_REQUIRED', 'Owned revision reconciliation requires an audit reason between 10 and 500 characters.');
  }
  if (provenance.length < 3 || provenance.length > 240) {
    throw executionSessionError('EXECUTION_RECONCILIATION_PROVENANCE_REQUIRED', 'Owned revision reconciliation requires bounded provenance between 3 and 240 characters.');
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > 100) {
    throw executionSessionError('EXECUTION_RECONCILIATION_FILES_REQUIRED', 'Owned revision reconciliation requires 1-100 explicit revision-guarded files.');
  }

  const normalized = files.map((entry) => {
    const ownedPath = normalizeEvidencePath(entry?.path);
    if (!ownedPath) {
      throw executionSessionError('EXECUTION_RECONCILIATION_PATH_REQUIRED', 'Owned revision reconciliation requires an explicit repository-relative path.');
    }
    const expectedKnownRevision = String(entry?.expectedKnownRevision || '').trim();
    const expectedCurrentRevision = String(entry?.expectedCurrentRevision || '').trim();
    if (!expectedKnownRevision || !expectedCurrentRevision) {
      throw executionSessionError('EXECUTION_RECONCILIATION_REVISION_REQUIRED', `Owned revision reconciliation requires prior/current revision guards for '${ownedPath}'.`);
    }
    return { path: ownedPath, expectedKnownRevision, expectedCurrentRevision };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) {
    throw executionSessionError('EXECUTION_RECONCILIATION_DUPLICATE_PATH', 'Owned revision reconciliation paths must be unique.');
  }

  const ownership = getExecutionOwnershipState(id, { repoRoot: root });
  const ownedStateByPath = new Map(ownership.ownedFiles.map((entry) => [entry.path, entry] as const));
  const ownedEvidenceByPath = new Map(
    listExecutionSessionEvidence(id)
      .filter((entry) => entry.kind === 'owned-change' && entry.path)
      .map((entry) => [entry.path!, entry] as const),
  );
  const reconciliationId = ownedRevisionReconciliationId(id, normalized, reason, provenance);
  const replayFlags = normalized.map((entry) => {
    const evidence = ownedEvidenceByPath.get(entry.path);
    const state = ownedStateByPath.get(entry.path);
    if (!evidence || !state) return false;
    return readExecutionStringMetadata(evidence.metadata || {}, 'ownedRevisionReconciliationId') === reconciliationId
      && state.knownFileRevision === entry.expectedCurrentRevision
      && currentOwnedFileRevision(root, entry.path) === entry.expectedCurrentRevision;
  });
  if (replayFlags.every(Boolean)) {
    return {
      sessionId: id,
      reconciliationId,
      reconciledPaths: normalized.map((entry) => entry.path),
      reason,
      provenance,
      idempotent: true,
      ownership: getExecutionOwnershipState(id, { repoRoot: root }),
    };
  }
  if (replayFlags.some(Boolean)) {
    throw executionSessionError('EXECUTION_RECONCILIATION_PARTIAL_REPLAY', 'Owned revision reconciliation request is only partially replayed and cannot be applied safely.');
  }

  for (const entry of normalized) {
    const state = ownedStateByPath.get(entry.path);
    const evidence = ownedEvidenceByPath.get(entry.path);
    if (!state || !evidence) {
      throw executionSessionError('EXECUTION_RECONCILIATION_NOT_OWNED', `Path '${entry.path}' is not owned by the selected execution session.`);
    }
    if (state.knownFileRevision !== entry.expectedKnownRevision) {
      throw executionSessionError('EXECUTION_RECONCILIATION_PRIOR_REVISION_MISMATCH', `Path '${entry.path}' prior owned revision no longer matches reconciliation evidence.`);
    }
    const currentRevision = currentOwnedFileRevision(root, entry.path);
    if (currentRevision !== entry.expectedCurrentRevision) {
      throw executionSessionError('EXECUTION_RECONCILIATION_CURRENT_REVISION_MISMATCH', `Path '${entry.path}' current revision changed since reconciliation evidence was captured.`);
    }
    if (!state.drifted) {
      throw executionSessionError('EXECUTION_RECONCILIATION_NOT_DRIFTED', `Path '${entry.path}' is already aligned with its known owned revision.`);
    }
  }

  const nowIso = (options.now || new Date()).toISOString();
  const repo = getRepoRevisionForRoot(root);
  withDbTransaction(() => {
    for (const entry of normalized) {
      const currentRevision = currentOwnedFileRevision(root, entry.path);
      if (currentRevision !== entry.expectedCurrentRevision) {
        throw executionSessionError('EXECUTION_RECONCILIATION_CURRENT_REVISION_MISMATCH', `Path '${entry.path}' changed while reconciliation was being applied.`);
      }
    }
    for (const entry of normalized) {
      const prior = ownedEvidenceByPath.get(entry.path)!;
      const priorMetadata = prior.metadata || {};
      saveExecutionSessionEvidence({
        id: prior.id,
        sessionId: id,
        kind: 'owned-change',
        path: entry.path,
        repoRevision: repo.token,
        fileRevision: entry.expectedCurrentRevision,
        revisionIdentity: buildRepoEvidenceIdentity({ repoRevision: repo.token, filePath: entry.path, fileRevision: entry.expectedCurrentRevision }),
        contextHandle: session.contextHandle,
        stale: false,
        metadata: {
          ...priorMetadata,
          executionSource: 'owned-revision-reconciliation',
          knownFileRevision: entry.expectedCurrentRevision,
          observedAt: nowIso,
          ownedRevisionReconciliationId: reconciliationId,
          reconciliationExpectedKnownRevision: entry.expectedKnownRevision,
          reconciliationExpectedCurrentRevision: entry.expectedCurrentRevision,
          reconciliationReason: reason,
          reconciliationProvenance: provenance,
          reconciledAt: nowIso,
        },
        createdAt: prior.createdAt,
        updatedAt: nowIso,
      });
    }
    updateExecutionSessionRecord(id, { repoRevision: repo.token, updatedAt: nowIso });
    options.invalidateVerificationAuthority?.(id, reconciliationId, nowIso);
  });

  return {
    sessionId: id,
    reconciliationId,
    reconciledPaths: normalized.map((entry) => entry.path),
    reason,
    provenance,
    idempotent: false,
    ownership: getExecutionOwnershipState(id, { repoRoot: root }),
  };
}
