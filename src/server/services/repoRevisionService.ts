import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getGitWorkspaceSnapshotForRoot } from './gitService';

const MAX_HASH_FILE_BYTES = 2 * 1024 * 1024;

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
  branch: string;
  changedFiles: RepoRevisionChangedFile[];
};

function resolveWorkingPath(statusPath: string) {
  const normalized = statusPath.replace(/\\/g, '/');
  const renameSeparator = ' -> ';
  if (!normalized.includes(renameSeparator)) return normalized;
  return normalized.split(renameSeparator).pop() || normalized;
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
    branch: workspace.branch,
    changedFiles,
  };
}
