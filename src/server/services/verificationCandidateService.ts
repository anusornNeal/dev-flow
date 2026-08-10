import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDevFlowWorkspacesDir } from '../../lib/devFlowPaths';
import { createApiError } from './api';
import { getRepoRevisionForRoot } from './repoRevisionService';
import { getProjectCommandConfigSnapshot } from './projectCommandConfigService';

export type VerificationCandidateIdentity = {
  candidateId: string;
  repoRevision: string;
  snapshotCommit: string;
  createdAt: string;
  commandConfigFingerprint?: string;
};

export type ResolvedVerificationCandidate = VerificationCandidateIdentity & {
  root: string;
  sourceRoot: string;
};

type VerificationCandidateRecord = VerificationCandidateIdentity & {
  sourceRoot: string;
};

const CANDIDATE_ID_PATTERN = /^vc_[a-f0-9]{24}$/;

function candidateBaseDir() {
  return path.join(getDevFlowWorkspacesDir(), 'verification-candidates');
}

function candidateRegistryDir() {
  return path.join(candidateBaseDir(), 'registry');
}

function candidateRootsDir() {
  return path.join(candidateBaseDir(), 'roots');
}

function candidateTempDir() {
  return path.join(candidateBaseDir(), 'tmp');
}

function requireCandidateId(candidateId: string) {
  const normalized = String(candidateId || '').trim();
  if (!CANDIDATE_ID_PATTERN.test(normalized)) {
    throw createApiError(400, 'VERIFICATION_CANDIDATE_INVALID', 'Verification candidate id is invalid.');
  }
  return normalized;
}

function candidateMetadataPath(candidateId: string) {
  return path.join(candidateRegistryDir(), `${requireCandidateId(candidateId)}.json`);
}

function candidateRoot(candidateId: string) {
  return path.join(candidateRootsDir(), requireCandidateId(candidateId));
}

function runGit(
  root: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; timeoutMs?: number } = {},
) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeoutMs ?? 30_000,
    env: options.env,
  });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    throw createApiError(500, 'VERIFICATION_CANDIDATE_GIT_FAILED', `Verification candidate Git command failed: ${String(result.stderr || result.error?.message || args.join(' ')).trim()}`, {
      details: { args, status: result.status },
    });
  }
  return result;
}

function bridgeInstalledDependencies(sourceRoot: string, root: string) {
  const sourceNodeModules = path.join(sourceRoot, 'node_modules');
  const candidateNodeModules = path.join(root, 'node_modules');
  if (!fs.existsSync(sourceNodeModules) || fs.existsSync(candidateNodeModules)) return;
  fs.symlinkSync(sourceNodeModules, candidateNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
}

function removeInstalledDependencyBridge(root: string) {
  const candidateNodeModules = path.join(root, 'node_modules');
  try {
    if (fs.lstatSync(candidateNodeModules).isSymbolicLink()) fs.unlinkSync(candidateNodeModules);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function writeRecord(record: VerificationCandidateRecord) {
  fs.mkdirSync(candidateRegistryDir(), { recursive: true });
  const target = candidateMetadataPath(record.candidateId);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

function readRecord(candidateId: string): VerificationCandidateRecord | null {
  const target = candidateMetadataPath(candidateId);
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as VerificationCandidateRecord;
    if (parsed.candidateId !== candidateId || !CANDIDATE_ID_PATTERN.test(parsed.candidateId)) return null;
    if (!/^[a-f0-9]{40}$/i.test(String(parsed.snapshotCommit || ''))) return null;
    if (!String(parsed.repoRevision || '').trim() || !String(parsed.sourceRoot || '').trim()) return null;
    if (parsed.commandConfigFingerprint !== undefined && !/^[a-f0-9]{64}$/i.test(String(parsed.commandConfigFingerprint))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function publicIdentity(record: VerificationCandidateRecord): VerificationCandidateIdentity {
  return {
    candidateId: record.candidateId,
    repoRevision: record.repoRevision,
    snapshotCommit: record.snapshotCommit,
    createdAt: record.createdAt,
    ...(record.commandConfigFingerprint ? { commandConfigFingerprint: record.commandConfigFingerprint } : {}),
  };
}

export function createVerificationCandidate(repoRoot: string): VerificationCandidateIdentity {
  const sourceRoot = path.resolve(repoRoot);
  const sourceRevision = getRepoRevisionForRoot(sourceRoot);
  const sourceCommandConfig = getProjectCommandConfigSnapshot(sourceRoot);
  const candidateId = `vc_${crypto.randomBytes(12).toString('hex')}`;
  const root = candidateRoot(candidateId);
  fs.mkdirSync(candidateRootsDir(), { recursive: true });
  fs.mkdirSync(candidateTempDir(), { recursive: true });
  const indexPath = path.join(candidateTempDir(), `${candidateId}.index`);
  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: 'DevFlow Verification',
    GIT_AUTHOR_EMAIL: 'devflow-verification@local',
    GIT_COMMITTER_NAME: 'DevFlow Verification',
    GIT_COMMITTER_EMAIL: 'devflow-verification@local',
  };

  let snapshotCommit = '';
  try {
    runGit(sourceRoot, ['read-tree', 'HEAD'], { env: gitEnv });
    runGit(sourceRoot, ['add', '-A', '--', '.'], { env: gitEnv });
    if (sourceCommandConfig.relativePaths.length > 0) {
      runGit(sourceRoot, ['add', '-f', '--', ...sourceCommandConfig.relativePaths], { env: gitEnv });
    }
    const tree = String(runGit(sourceRoot, ['write-tree'], { env: gitEnv }).stdout || '').trim();
    if (!/^[a-f0-9]{40}$/i.test(tree)) {
      throw createApiError(500, 'VERIFICATION_CANDIDATE_TREE_INVALID', 'Verification candidate tree could not be created.');
    }
    snapshotCommit = String(runGit(sourceRoot, ['commit-tree', tree, '-p', sourceRevision.head, '-m', `DevFlow verification candidate ${candidateId}`], { env: gitEnv }).stdout || '').trim();
    if (!/^[a-f0-9]{40}$/i.test(snapshotCommit)) {
      throw createApiError(500, 'VERIFICATION_CANDIDATE_COMMIT_INVALID', 'Verification candidate snapshot commit could not be created.');
    }

    runGit(sourceRoot, ['worktree', 'add', '--detach', root, snapshotCommit], { timeoutMs: 60_000 });
    bridgeInstalledDependencies(sourceRoot, root);
    const candidateCommandConfig = getProjectCommandConfigSnapshot(root);
    if (candidateCommandConfig.fingerprint !== sourceCommandConfig.fingerprint) {
      throw createApiError(409, 'VERIFICATION_CANDIDATE_CONFIG_MISMATCH', 'Repository command configuration changed while the verification candidate was being created.');
    }
    const record: VerificationCandidateRecord = {
      candidateId,
      repoRevision: sourceRevision.token,
      snapshotCommit,
      createdAt: new Date().toISOString(),
      commandConfigFingerprint: sourceCommandConfig.fingerprint,
      sourceRoot,
    };
    writeRecord(record);
    return publicIdentity(record);
  } catch (error) {
    if (fs.existsSync(root)) {
      removeInstalledDependencyBridge(root);
      runGit(sourceRoot, ['worktree', 'remove', '--force', root], { allowFailure: true, timeoutMs: 60_000 });
      fs.rmSync(root, { recursive: true, force: true });
    }
    fs.rmSync(candidateMetadataPath(candidateId), { force: true });
    throw error;
  } finally {
    fs.rmSync(indexPath, { force: true });
  }
}

export function resolveVerificationCandidate(candidateId: string): ResolvedVerificationCandidate {
  const normalizedId = requireCandidateId(candidateId);
  const record = readRecord(normalizedId);
  if (!record) {
    throw createApiError(404, 'VERIFICATION_CANDIDATE_NOT_FOUND', 'Verification candidate was not found or has already been released.');
  }
  const root = candidateRoot(normalizedId);
  if (!fs.existsSync(root)) {
    throw createApiError(410, 'VERIFICATION_CANDIDATE_MISSING', 'Verification candidate snapshot is no longer available.');
  }
  return { ...publicIdentity(record), root, sourceRoot: path.resolve(record.sourceRoot) };
}

export function isVerificationCandidateCurrent(
  repoRoot: string,
  candidate: Pick<VerificationCandidateIdentity, 'repoRevision'>,
  commandConfigFingerprint?: string,
) {
  try {
    const root = path.resolve(repoRoot);
    if (getRepoRevisionForRoot(root).token !== candidate.repoRevision) return false;
    if (commandConfigFingerprint) {
      return getProjectCommandConfigSnapshot(root).fingerprint === commandConfigFingerprint;
    }
    return true;
  } catch {
    return false;
  }
}

export function releaseVerificationCandidate(candidateId: string) {
  const normalizedId = requireCandidateId(candidateId);
  const record = readRecord(normalizedId);
  if (!record) return false;
  const root = candidateRoot(normalizedId);
  const sourceRoot = path.resolve(record.sourceRoot);
  removeInstalledDependencyBridge(root);
  if (fs.existsSync(sourceRoot)) {
    runGit(sourceRoot, ['worktree', 'remove', '--force', root], { allowFailure: true, timeoutMs: 60_000 });
    runGit(sourceRoot, ['worktree', 'prune'], { allowFailure: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(candidateMetadataPath(normalizedId), { force: true });
  return true;
}
