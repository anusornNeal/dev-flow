import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createApiError } from './api';

function ensureGitRepo(root: string) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    throw createApiError(400, 'NOT_GIT_REPO', `Project root '${root}' is not a git repository.`);
  }
}

function runGit(args: string[], root: string, timeoutMs = 15_000) {
  const result = spawnSync('git', ['--no-pager', ...args], { cwd: root, encoding: 'utf8', shell: false, timeout: timeoutMs });
  if (result.error) throw createApiError(500, 'GIT_EXEC_ERROR', `Failed to run git: ${result.error.message}`);
  if (result.status !== 0) throw createApiError(500, 'GIT_ERROR', `Git command failed: ${result.stderr?.trim() || 'unknown error'}`, { details: result.stderr });
  return result.stdout || '';
}

function normalizeGitPath(filePath: string) { return filePath.replace(/\\/g, '/'); }

function parsePorcelainStatus(output: string) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => ({
    path: line.slice(3),
    normalizedPath: normalizeGitPath(line.slice(3)),
    staged: line[0] !== ' ' && line[0] !== '?',
    status: line.slice(0, 2).trim(),
  }));
}

export function getChangedGitFilesForRoot(root: string) {
  ensureGitRepo(root);
  return parsePorcelainStatus(runGit(['status', '--porcelain', '--untracked-files=all'], root))
    .map((file) => ({ path: file.normalizedPath, staged: file.staged, status: file.status }));
}

export function getGitWorkspaceStatusForRoot(root: string) {
  ensureGitRepo(root);
  const output = runGit(['status', '--porcelain=v1', '--branch'], root);
  const lines = output.split(/\r?\n/).filter(Boolean);
  const branchLine = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3).trim() : '';
  const branch = (branchLine.split('...')[0] || branchLine.split(' ')[0] || 'HEAD').trim() || 'HEAD';
  const files = parsePorcelainStatus(lines.join('\n')).map((file) => ({ path: file.normalizedPath, staged: file.staged, status: file.status }));
  return { root, branch, files };
}

export function getGitWorkspaceSnapshotForRoot(root: string) {
  ensureGitRepo(root);
  const output = runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], root);
  let branch = 'HEAD';
  let head = 'unborn';
  const files: Array<{ path: string; staged: boolean; status: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length).trim();
      head = value === '(initial)' ? 'unborn' : value;
      continue;
    }
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim();
      branch = value === '(detached)' ? 'HEAD' : value || 'HEAD';
      continue;
    }
    if (line.startsWith('? ')) {
      files.push({ path: normalizeGitPath(line.slice(2).trim()), staged: false, status: '??' });
      continue;
    }
    if (line.startsWith('! ')) continue;
    if (line.startsWith('1 ') || line.startsWith('u ')) {
      const parts = line.split(' ');
      const xy = parts[1] || '..';
      const filePath = parts.slice(line.startsWith('1 ') ? 8 : 10).join(' ');
      const x = xy[0] === '.' ? ' ' : xy[0];
      const y = xy[1] === '.' ? ' ' : xy[1];
      files.push({ path: normalizeGitPath(filePath), staged: x !== ' ', status: `${x}${y}` });
      continue;
    }
    if (line.startsWith('2 ')) {
      const tabIndex = line.indexOf('\t');
      const primary = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
      const parts = primary.split(' ');
      const xy = parts[1] || '..';
      const filePath = parts.slice(9).join(' ');
      const x = xy[0] === '.' ? ' ' : xy[0];
      const y = xy[1] === '.' ? ' ' : xy[1];
      files.push({ path: normalizeGitPath(filePath), staged: x !== ' ', status: `${x}${y}` });
    }
  }
  return { root, branch, head, files };
}

export function getGitCommitEvidenceForRoot(root: string, revision = 'HEAD') {
  ensureGitRepo(root);
  const metadata = runGit(['show', '-s', '--format=%H%x00%P%x00%s', revision], root).trim();
  const [commit = '', parentsRaw = '', subject = ''] = metadata.split('\u0000');
  if (!commit) throw createApiError(409, 'GIT_COMMIT_EVIDENCE_MISSING', `Commit evidence for '${revision}' could not be resolved.`);
  const files = runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', commit], root)
    .split(/\r?\n/)
    .map((entry) => normalizeGitPath(entry.trim()))
    .filter(Boolean)
    .sort();
  return {
    commit,
    parents: parentsRaw.split(/\s+/).filter(Boolean),
    subject,
    files,
  };
}
