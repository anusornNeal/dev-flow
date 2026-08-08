import { spawnSync } from 'child_process';
import path from 'path';
import { getProject } from '../repositories/projectRepository';
import { createApiError } from './api';
import {
  readReusableGitRemoteEvidence,
  recordGitRemoteEvidence,
  recordGitRemoteFetch,
} from './gitRemoteEvidenceService';

function runGitResult(args: string[], root: string, timeoutMs = 15_000) {
  return spawnSync('git', ['--no-pager', ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: timeoutMs,
  });
}

function runGit(args: string[], root: string, timeoutMs = 15_000) {
  const result = runGitResult(args, root, timeoutMs);
  if (result.error) throw createApiError(500, 'GIT_EXEC_ERROR', `Failed to run git: ${result.error.message}`);
  if (result.status !== 0) throw createApiError(500, 'GIT_ERROR', `Git command failed: ${result.stderr?.trim() || 'unknown error'}`, { details: result.stderr });
  return result.stdout || '';
}

function gitSucceeded(args: string[], root: string) {
  const result = runGitResult(args, root);
  if (result.error) throw createApiError(500, 'GIT_EXEC_ERROR', `Failed to run git: ${result.error.message}`);
  return result.status === 0;
}

function flag(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || String(value).toLowerCase() === 'true';
}

function commitExists(root: string, revision: string) {
  return gitSucceeded(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], root);
}

export function resolveRemoteName(value: unknown) {
  const remote = typeof value === 'string' && value.trim() ? value.trim() : 'origin';
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
    throw createApiError(400, 'INVALID_GIT_REMOTE', `Remote '${remote}' contains unsupported characters.`, { affectedId: remote });
  }
  return remote;
}

export function readRemoteUrl(root: string, remote: string) {
  const result = runGitResult(['remote', 'get-url', remote], root);
  if (result.error || result.status !== 0) {
    throw createApiError(400, 'GIT_REMOTE_NOT_FOUND', `Git remote '${remote}' is not configured.`, {
      affectedId: remote,
      details: result.stderr?.trim() || undefined,
    });
  }
  const remoteUrl = (result.stdout || '').trim();
  if (!remoteUrl || /[\r\n]/.test(remoteUrl)) {
    throw createApiError(400, 'INVALID_GIT_REMOTE_URL', `Git remote '${remote}' has an invalid URL.`, { affectedId: remote });
  }
  const supported = path.isAbsolute(remoteUrl)
    || /^file:\/\//i.test(remoteUrl)
    || /^(https?|ssh|git):\/\//i.test(remoteUrl)
    || /^[^@\s]+@[^:\s]+:.+/.test(remoteUrl);
  if (!supported) {
    throw createApiError(400, 'INVALID_GIT_REMOTE_URL', `Git remote '${remote}' uses an unsupported URL format.`, {
      affectedId: remote,
      details: { remoteUrl },
    });
  }
  return remoteUrl;
}

export function normalizeRepoIdentity(value: string) {
  let normalized = value.trim().replace(/\\/g, '/').replace(/\/$/, '').replace(/\.git$/i, '');
  const scpMatch = normalized.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scpMatch) normalized = `${scpMatch[1]}/${scpMatch[2]}`;
  normalized = normalized.replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function validateRemoteMatchesProject(args: Record<string, any>, remoteUrl: string) {
  const project = typeof args.projectId === 'string' && args.projectId.trim()
    ? getProject(args.projectId.trim())
    : undefined;
  const expectedUrl = typeof args.repoUrl === 'string' && args.repoUrl.trim()
    ? args.repoUrl.trim()
    : project?.repoUrl;
  if (!expectedUrl) return;
  if (normalizeRepoIdentity(String(expectedUrl)) !== normalizeRepoIdentity(remoteUrl)) {
    throw createApiError(409, 'GIT_REMOTE_REPO_MISMATCH', 'Remote URL does not match the selected project repository.', {
      details: { expectedUrl, remoteUrl },
    });
  }
}

export function fetchRemote(root: string, remote: string) {
  const startedAt = Date.now();
  const result = runGitResult(['fetch', '--prune', remote], root, 60_000);
  const durationMs = Date.now() - startedAt;
  recordGitRemoteFetch(durationMs);
  if (result.error || result.status !== 0) {
    throw createApiError(502, 'GIT_FETCH_FAILED', `Failed to fetch git remote '${remote}'.`, {
      affectedId: remote,
      details: result.stderr?.trim() || result.error?.message,
    });
  }
  return durationMs;
}

export function readFetchedRemoteHead(root: string, remote: string, branch: string) {
  const result = runGitResult(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], root);
  if (result.error) {
    throw createApiError(500, 'GIT_EXEC_ERROR', `Failed to read fetched remote ref '${remote}/${branch}'.`, {
      affectedId: `${remote}/${branch}`,
      details: result.error.message,
    });
  }
  return result.status === 0 ? (result.stdout || '').trim() || null : null;
}

export function readRemoteHead(root: string, remote: string, branch: string) {
  const result = runGitResult(['ls-remote', '--heads', remote, `refs/heads/${branch}`], root, 60_000);
  if (result.error || result.status !== 0) {
    throw createApiError(502, 'GIT_REMOTE_READ_FAILED', `Failed to read '${remote}/${branch}'.`, {
      affectedId: `${remote}/${branch}`,
      details: result.stderr?.trim() || result.error?.message,
    });
  }
  const line = (result.stdout || '').trim().split(/\r?\n/).find(Boolean);
  return line ? line.split(/\s+/)[0] : null;
}

export function readTrackingBranch(root: string) {
  const result = runGitResult(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
  return result.status === 0 ? (result.stdout || '').trim() || null : null;
}

export function readAheadBehind(root: string, localHead: string, remoteHead: string | null) {
  if (!remoteHead) return { ahead: 0, behind: 0, diverged: false };
  if (!commitExists(root, remoteHead)) return { ahead: null, behind: null, diverged: false };
  const output = runGit(['rev-list', '--left-right', '--count', `${localHead}...${remoteHead}`], root).trim();
  const [aheadRaw, behindRaw] = output.split(/\s+/);
  const ahead = Number(aheadRaw || 0);
  const behind = Number(behindRaw || 0);
  return { ahead, behind, diverged: ahead > 0 && behind > 0 };
}

export function readPushCommits(root: string, localHead: string, remoteHead: string | null) {
  const range = remoteHead ? `${remoteHead}..${localHead}` : localHead;
  const output = runGit(['log', '-50', '--format=%H%x00%s', range], root).trim();
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, ...messageParts] = line.split('\x00');
    return { hash, message: messageParts.join(' ') };
  });
}

export function observeRemoteBranch(root: string, remote: string, remoteUrl: string, branch: string, localHead: string, args: Record<string, any>) {
  const nowMs = Number.isFinite(Number(args.nowMs)) ? Number(args.nowMs) : Date.now();
  const forceFresh = flag(args.forceFresh);
  const remoteIdentity = normalizeRepoIdentity(remoteUrl);
  const reusable = forceFresh ? undefined : readReusableGitRemoteEvidence(root, remote, remoteIdentity, branch, localHead, nowMs);
  if (reusable) {
    return {
      remoteHead: reusable.remoteHead,
      remoteFetchPerformed: false,
      remoteEvidenceReused: true,
      remoteFetchDurationMs: 0,
      remoteEvidenceObservedAt: new Date(reusable.observedAtMs).toISOString(),
      remoteEvidenceAgeMs: Math.max(0, nowMs - reusable.observedAtMs),
    };
  }
  const shouldFetch = flag(args.fetch) || forceFresh;
  const remoteFetchDurationMs = shouldFetch ? fetchRemote(root, remote) : 0;
  const remoteHead = shouldFetch ? readFetchedRemoteHead(root, remote, branch) : readRemoteHead(root, remote, branch);
  const evidence = recordGitRemoteEvidence(root, remote, remoteIdentity, branch, localHead, remoteHead, nowMs);
  return {
    remoteHead,
    remoteFetchPerformed: shouldFetch,
    remoteEvidenceReused: false,
    remoteFetchDurationMs,
    remoteEvidenceObservedAt: new Date(evidence.observedAtMs).toISOString(),
    remoteEvidenceAgeMs: 0,
  };
}
