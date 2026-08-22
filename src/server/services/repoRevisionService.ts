// DVF-0685: canonical fingerprints must stay portable across managed worktrees and the project root.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getGitWorkspaceSnapshotForRoot } from './gitService';

const MAX_HASH_FILE_BYTES = 2 * 1024 * 1024;
const DEPENDENCY_IDENTITY_PATHS = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'deno.lock',
  'gradle.properties', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'gradle/wrapper/gradle-wrapper.properties',
  'Gemfile.lock', 'Podfile.lock', 'Package.resolved', 'pyproject.toml', 'poetry.lock', 'requirements.txt', 'Cargo.lock', 'go.sum',
] as const;

export type RepoRevisionChangedFile = {
  path: string;
  workingPath: string;
  status: string;
  staged: boolean;
  fingerprint: string;
};

export type RepoRevision = {
  token: string;
  head: string;
  treeId: string | null;
  branch: string;
  changedFiles: RepoRevisionChangedFile[];
};

function resolveWorkingPath(statusPath: string) {
  const normalized = statusPath.replace(/\\/g, '/');
  const renameSeparator = ' -> ';
  if (!normalized.includes(renameSeparator)) return normalized;
  return normalized.split(renameSeparator).pop() || normalized;
}

function canonicalGitFingerprints(root: string, relativePaths: string[]) {
  const fingerprints = new Map<string, string>();
  const safePaths = relativePaths.filter((relativePath) => {
    if (!relativePath || relativePath.includes('\n') || relativePath.includes('\r')) return false;
    const fullPath = path.resolve(root, relativePath);
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
  });
  if (safePaths.length === 0) return fingerprints;
  const result = spawnSync('git', ['hash-object', '--filters', '--stdin-paths'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    input: `${safePaths.join('\n')}\n`,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return fingerprints;
  const hashes = String(result.stdout || '').trim().split(/\r?\n/);
  if (hashes.length !== safePaths.length || hashes.some((hash) => !/^[a-f0-9]{40,64}$/i.test(hash))) return fingerprints;
  safePaths.forEach((relativePath, index) => fingerprints.set(relativePath, `git:${hashes[index].toLowerCase()}`));
  return fingerprints;
}

function fingerprintChangedFile(root: string, statusPath: string) {
  const relativePath = resolveWorkingPath(statusPath);
  const fullPath = path.resolve(root, relativePath);
  if (!fs.existsSync(fullPath)) return 'missing';

  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) return `non-file:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  if (stat.size > MAX_HASH_FILE_BYTES) return `large:${stat.size}:${Math.trunc(stat.mtimeMs)}`;

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
  return `${stat.size}:${sha256}`;
}

export function buildRepoEvidenceIdentity(input: {
  repoRevision?: string | null;
  filePath: string;
  fileRevision?: string | null;
}) {
  const normalizedPath = input.filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const digest = crypto.createHash('sha256');
  digest.update(String(input.repoRevision || 'unknown-repo'));
  digest.update('\0');
  digest.update(normalizedPath);
  digest.update('\0');
  digest.update(String(input.fileRevision || 'unknown-file'));
  return `${normalizedPath}:${digest.digest('hex').slice(0, 20)}`;
}

export type RepoAffectedInputIdentity = {
  mode: 'full' | 'scoped';
  fingerprint: string;
  paths: string[];
};

function normalizeScopedPath(root: string, value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalizedRoot = path.resolve(root);
  const absolutePath = path.resolve(normalizedRoot, value);
  const relativePath = path.relative(normalizedRoot, absolutePath).replace(/\\/g, '/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) return null;
  return relativePath;
}

export function buildRepoAffectedInputIdentity(root: string, repoRevision: RepoRevision, affectedInputPaths?: unknown): RepoAffectedInputIdentity {
  if (!Array.isArray(affectedInputPaths) || affectedInputPaths.length === 0) {
    return { mode: 'full', fingerprint: repoRevision.token, paths: [] };
  }
  const normalized = affectedInputPaths.map((entry) => normalizeScopedPath(root, entry));
  if (normalized.some((entry) => !entry)) {
    return { mode: 'full', fingerprint: repoRevision.token, paths: [] };
  }
  const paths = Array.from(new Set(normalized as string[])).sort();
  const canonical = canonicalGitFingerprints(root, paths);
  const digest = crypto.createHash('sha256');
  for (const relativePath of paths) {
    digest.update('\0');
    digest.update(relativePath);
    digest.update('\0');
    digest.update(canonical.get(relativePath) || fingerprintChangedFile(root, relativePath));
  }
  return { mode: 'scoped', fingerprint: `scoped:${digest.digest('hex')}`, paths };
}

export function getRepoDependencyFingerprint(root: string) {
  const normalizedRoot = path.resolve(root);
  const presentPaths = DEPENDENCY_IDENTITY_PATHS.filter((relativePath) => fs.existsSync(path.resolve(normalizedRoot, relativePath)));
  const canonical = canonicalGitFingerprints(normalizedRoot, [...presentPaths]);
  const entries = presentPaths.map((relativePath) => ({
    path: relativePath,
    fingerprint: canonical.get(relativePath) || fingerprintChangedFile(normalizedRoot, relativePath),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function gitTreeIdentity(root: string, head: string) {
  if (!head) return null;
  const result = spawnSync('git', ['rev-parse', `${head}^{tree}`], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  });
  const treeId = String(result.stdout || '').trim().toLowerCase();
  return result.status === 0 && /^[a-f0-9]{40,64}$/.test(treeId) ? treeId : null;
}

export function getRepoRevisionForRoot(root: string): RepoRevision {
  const normalizedRoot = path.resolve(root);
  const workspace = getGitWorkspaceSnapshotForRoot(normalizedRoot);
  const head = workspace.head;
  const changedFiles = workspace.files
    .map((entry) => ({
      path: entry.path.replace(/\\/g, '/'),
      workingPath: resolveWorkingPath(entry.path),
      status: entry.status,
      staged: entry.staged,
      fingerprint: fingerprintChangedFile(normalizedRoot, entry.path),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const digest = crypto.createHash('sha256');
  digest.update(head);
  for (const entry of changedFiles) {
    digest.update('\0');
    digest.update(entry.path);
    digest.update('\0');
    digest.update(entry.status);
    digest.update(entry.staged ? '\x01' : '\x00');
    digest.update(entry.fingerprint);
  }

  return {
    token: `${head.slice(0, 12)}:${digest.digest('hex').slice(0, 24)}`,
    head,
    treeId: gitTreeIdentity(normalizedRoot, head),
    branch: workspace.branch,
    changedFiles,
  };
}
