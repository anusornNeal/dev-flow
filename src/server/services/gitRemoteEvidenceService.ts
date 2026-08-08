import path from 'path';
import { registerRepoCacheInvalidator } from './repoCacheInvalidationService';

const REMOTE_EVIDENCE_TTL_MS = Math.max(1_000, Math.min(60_000, Number(process.env.DEVFLOW_GIT_REMOTE_EVIDENCE_TTL_MS) || 15_000));
const MAX_REMOTE_EVIDENCE_ENTRIES = 128;

export type GitRemoteEvidence = {
  key: string;
  rootKey: string;
  remote: string;
  remoteIdentity: string;
  branch: string;
  localHead: string;
  remoteHead: string | null;
  observedAtMs: number;
  expiresAtMs: number;
};

const gitRemoteEvidence = new Map<string, GitRemoteEvidence>();
const metrics = { fetchCount: 0, fetchDurationMs: 0, reusedCount: 0 };

function canonicalRootKey(root: string) {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function evidenceKey(root: string, remote: string, remoteIdentity: string, branch: string, localHead: string) {
  return [canonicalRootKey(root), remote, remoteIdentity, branch, localHead].join('|');
}

function prune(nowMs: number) {
  for (const [key, evidence] of gitRemoteEvidence) if (evidence.expiresAtMs <= nowMs) gitRemoteEvidence.delete(key);
  while (gitRemoteEvidence.size > MAX_REMOTE_EVIDENCE_ENTRIES) {
    const oldest = gitRemoteEvidence.keys().next().value;
    if (!oldest) break;
    gitRemoteEvidence.delete(oldest);
  }
}

export function clearGitRemoteEvidenceCache(root?: string) {
  if (!root) {
    const count = gitRemoteEvidence.size;
    gitRemoteEvidence.clear();
    metrics.fetchCount = 0;
    metrics.fetchDurationMs = 0;
    metrics.reusedCount = 0;
    return count;
  }
  const rootKey = canonicalRootKey(root);
  let count = 0;
  for (const [key, evidence] of gitRemoteEvidence) {
    if (evidence.rootKey !== rootKey) continue;
    gitRemoteEvidence.delete(key);
    count += 1;
  }
  return count;
}

registerRepoCacheInvalidator('git-remote-evidence', (root) => clearGitRemoteEvidenceCache(root));

export function getGitRemoteEvidenceMetrics(nowMs = Date.now()) {
  prune(nowMs);
  return { entries: gitRemoteEvidence.size, maxEntries: MAX_REMOTE_EVIDENCE_ENTRIES, ttlMs: REMOTE_EVIDENCE_TTL_MS, ...metrics };
}

export function recordGitRemoteEvidence(
  root: string,
  remote: string,
  remoteIdentity: string,
  branch: string,
  localHead: string,
  remoteHead: string | null,
  nowMs = Date.now(),
) {
  const rootKey = canonicalRootKey(root);
  for (const [key, evidence] of gitRemoteEvidence) {
    if (evidence.rootKey === rootKey && evidence.remote === remote && evidence.branch === branch) gitRemoteEvidence.delete(key);
  }
  const key = evidenceKey(root, remote, remoteIdentity, branch, localHead);
  const evidence: GitRemoteEvidence = { key, rootKey, remote, remoteIdentity, branch, localHead, remoteHead, observedAtMs: nowMs, expiresAtMs: nowMs + REMOTE_EVIDENCE_TTL_MS };
  gitRemoteEvidence.set(key, evidence);
  prune(nowMs);
  return evidence;
}

export function readReusableGitRemoteEvidence(root: string, remote: string, remoteIdentity: string, branch: string, localHead: string, nowMs = Date.now()) {
  prune(nowMs);
  const evidence = gitRemoteEvidence.get(evidenceKey(root, remote, remoteIdentity, branch, localHead));
  if (evidence) metrics.reusedCount += 1;
  return evidence;
}

export function recordGitRemoteFetch(durationMs: number) {
  metrics.fetchCount += 1;
  metrics.fetchDurationMs += Math.max(0, durationMs);
}
