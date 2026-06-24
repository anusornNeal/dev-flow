import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { createApiError } from './api';
import { resolveProjectRoot, resolveSafePath } from './localFileService';

const MAX_DIFF_BYTES = 100_000;
const MAX_LOG_COUNT = 500;
const MAX_COMMIT_MESSAGE_BYTES = 4_000;

function ensureGitRepo(root: string) {
  const gitDir = path.join(root, '.git');
  if (!fs.existsSync(gitDir)) {
    throw createApiError(400, 'NOT_GIT_REPO', `Project root '${root}' is not a git repository.`);
  }
}

function runGit(args: string[], root: string): string {
  const result = spawnSync('git', ['--no-pager', ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
  });

  if (result.error) {
    throw createApiError(500, 'GIT_EXEC_ERROR', `Failed to run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw createApiError(500, 'GIT_ERROR', `Git command failed: ${result.stderr?.trim() || 'unknown error'}`, { details: result.stderr });
  }

  return result.stdout || '';
}

function normalizeGitPath(filePath: string) {
  return filePath.replace(/\\/g, '/');
}

function parsePorcelainStatus(output: string) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  return lines.map((line) => ({
    path: line.slice(3),
    normalizedPath: normalizeGitPath(line.slice(3)),
    staged: line[0] !== ' ' && line[0] !== '?',
    status: line.slice(0, 2).trim(),
  }));
}

function getStatusFiles(root: string) {
  return parsePorcelainStatus(runGit(['status', '--porcelain'], root));
}

function getBranchName(root: string) {
  return runGit(['branch', '--show-current'], root).trim() || 'HEAD';
}

function getStagedFiles(root: string) {
  return runGit(['diff', '--cached', '--name-only'], root)
    .trim()
    .split(/\r?\n/)
    .map((line) => normalizeGitPath(line.trim()))
    .filter(Boolean);
}

function getGitPath(root: string, gitPath: string) {
  return runGit(['rev-parse', '--git-path', gitPath], root).trim();
}

function ensureNoInProgressOperation(root: string) {
  const guardedPaths = [
    'MERGE_HEAD',
    'REBASE_HEAD',
    'CHERRY_PICK_HEAD',
    'BISECT_LOG',
    'sequencer',
    'rebase-apply',
    'rebase-merge',
  ];

  for (const gitPath of guardedPaths) {
    const resolved = path.resolve(root, getGitPath(root, gitPath));
    if (fs.existsSync(resolved)) {
      throw createApiError(409, 'GIT_OPERATION_IN_PROGRESS', `Cannot commit while git operation '${gitPath}' is in progress. Resolve it in a terminal first.`, { affectedId: gitPath });
    }
  }
}

function resolveCommitFiles(root: string, args: Record<string, any>) {
  const rawFiles = Array.isArray(args.files) ? args.files : [];
  return rawFiles
    .map((file) => String(file || '').trim())
    .filter(Boolean)
    .map((file) => {
      const resolvedPath = resolveSafePath(root, file);
      return normalizeGitPath(path.relative(root, resolvedPath));
    });
}

function ensureSelectedFilesAreChanged(root: string, files: string[]) {
  if (files.length === 0) return;
  const changed = new Set(getStatusFiles(root).map((file) => file.normalizedPath));
  const missing = files.filter((file) => !changed.has(file));
  if (missing.length > 0) {
    throw createApiError(400, 'SELECTED_FILES_NOT_CHANGED', 'One or more selected files do not have git changes.', { details: { files: missing } });
  }
}

function ensureNoUnselectedStagedFiles(root: string, selectedFiles: string[]) {
  if (selectedFiles.length === 0) return;
  const selected = new Set(selectedFiles);
  const stagedBefore = getStagedFiles(root);
  const unselected = stagedBefore.filter((file) => !selected.has(file));
  if (unselected.length > 0) {
    throw createApiError(409, 'UNSELECTED_STAGED_FILES', 'There are already staged files outside the selected file list. Commit or unstage them first, or use stageAll.', { details: { files: unselected } });
  }
}

function toStatusSummary(root: string) {
  const files = getStatusFiles(root);
  return {
    count: files.length,
    stagedCount: files.filter((file) => file.staged).length,
    files: files.map((file) => ({ path: file.path, staged: file.staged, status: file.status })),
  };
}

export function getGitLog(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);

  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(MAX_LOG_COUNT, Number(args.limit))) : 20;
  const gitArgs = ['log', `-${limit}`, '--format=%H%x00%aI%x00%an%x00%s'];

  if (typeof args.author === 'string' && args.author.trim()) {
    gitArgs.push('--author', args.author.trim());
  }
  if (typeof args.since === 'string' && args.since.trim()) {
    gitArgs.push('--since', args.since.trim());
  }
  if (typeof args.until === 'string' && args.until.trim()) {
    gitArgs.push('--until', args.until.trim());
  }
  if (typeof args.grep === 'string' && args.grep.trim()) {
    gitArgs.push('--grep', args.grep.trim());
  }

  const filePath = typeof args.path === 'string' ? args.path.trim() : '';
  if (filePath) {
    const resolvedPath = resolveSafePath(root, filePath);
    const relativePath = path.relative(root, resolvedPath);
    gitArgs.push('--', relativePath);
  }

  const output = runGit(gitArgs, root);
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const commits = lines.map((line) => {
    const [hash, date, author, ...messageParts] = line.split('\x00');
    return { hash, date, author, message: messageParts.join(' ') };
  });

  return { root, count: commits.length, commits };
}

export function getGitDiff(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);

  const gitArgs = ['diff'];

  const commit1 = typeof args.commit1 === 'string' ? args.commit1.trim() : '';
  const commit2 = typeof args.commit2 === 'string' ? args.commit2.trim() : '';

  if (commit1) gitArgs.push(commit1);
  if (commit2) gitArgs.push(commit2);

  const filePath = typeof args.path === 'string' ? args.path.trim() : '';
  if (filePath) {
    const resolvedPath = resolveSafePath(root, filePath);
    const relativePath = path.relative(root, resolvedPath);
    gitArgs.push('--', relativePath);
  }

  const output = runGit(gitArgs, root);
  const truncated = output.length > MAX_DIFF_BYTES ? output.slice(0, MAX_DIFF_BYTES) + '\n... (truncated)' : output;
  const fileChangeLines = output.split(/\r?\n/).filter((l) => l.startsWith('diff --git'));

  return { root, diff: truncated, filesChanged: fileChangeLines.length };
}

export function getGitShow(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);

  const commit = typeof args.commit === 'string' ? args.commit.trim() : '';
  if (!commit) {
    throw createApiError(400, 'COMMIT_REQUIRED', 'commit is required.');
  }

  const gitArgs = ['show', '--format=%H%x00%aI%x00%an%x00%s', commit];

  const filePath = typeof args.path === 'string' ? args.path.trim() : '';
  if (filePath) {
    const resolvedPath = resolveSafePath(root, filePath);
    const relativePath = path.relative(root, resolvedPath);
    gitArgs.push('--', relativePath);
  }

  const output = runGit(gitArgs, root);
  const nullIndex = output.indexOf('\x00');
  if (nullIndex === -1) {
    return { root, commit: commit, diff: output };
  }

  const headerLine = output.slice(0, output.indexOf('\n'));
  const [hash, date, author, ...messageParts] = headerLine.split('\x00');
  const diff = output.slice(output.indexOf('\n') + 1);
  const truncated = diff.length > MAX_DIFF_BYTES ? diff.slice(0, MAX_DIFF_BYTES) + '\n... (truncated)' : diff;

  return {
    root,
    commit: { hash, date, author, message: messageParts.join(' '), diff: truncated },
  };
}

export function getGitStatus(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);

  const files = getStatusFiles(root);
  return {
    root,
    count: files.length,
    files: files.map((file) => ({ path: file.path, staged: file.staged, status: file.status })),
  };
}

export function getGitBranch(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);

  const output = runGit(['branch', '--list'], root);
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  let current = '';
  const branches: string[] = [];

  for (const line of lines) {
    const name = line.replace(/^\*\s*/, '').trim();
    if (line.startsWith('*')) {
      current = name;
    }
    branches.push(name);
  }

  return { root, current, branches };
}

export function commitGitChanges(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);
  ensureNoInProgressOperation(root);

  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (!message) {
    throw createApiError(400, 'COMMIT_MESSAGE_REQUIRED', 'A non-empty commit message is required.');
  }
  if (Buffer.byteLength(message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) {
    throw createApiError(400, 'COMMIT_MESSAGE_TOO_LARGE', `Commit message must be ${MAX_COMMIT_MESSAGE_BYTES} bytes or less.`);
  }

  const selectedFiles = resolveCommitFiles(root, args);
  const stageAll = args.stageAll === true || String(args.stageAll).toLowerCase() === 'true';
  const dryRun = args.dryRun === true || String(args.dryRun).toLowerCase() === 'true';
  if (!stageAll && selectedFiles.length === 0) {
    throw createApiError(400, 'COMMIT_SELECTION_REQUIRED', 'Set stageAll=true or provide a non-empty files array.');
  }

  const beforeStatus = toStatusSummary(root);
  if (beforeStatus.count === 0) {
    if (dryRun) {
      return {
        root,
        ok: false,
        code: 'NO_CHANGES_TO_COMMIT',
        message: 'There are no local git changes to commit.',
        dryRun: true,
        hash: null,
        commitHash: null,
        branch: getBranchName(root),
        changedFiles: [],
        changedFileCount: 0,
        beforeStatus,
        afterStatus: beforeStatus,
      };
    }
    throw createApiError(400, 'NO_CHANGES_TO_COMMIT', 'There are no local git changes to commit.');
  }

  if (dryRun) {
    let previewFiles = beforeStatus.files.map((file) => normalizeGitPath(file.path));
    if (!stageAll) {
      ensureSelectedFilesAreChanged(root, selectedFiles);
      ensureNoUnselectedStagedFiles(root, selectedFiles);
      previewFiles = selectedFiles;
    }

    return {
      root,
      dryRun: true,
      hash: null,
      commitHash: null,
      branch: getBranchName(root),
      message,
      changedFiles: previewFiles,
      changedFileCount: previewFiles.length,
      beforeStatus,
      afterStatus: beforeStatus,
    };
  }

  if (stageAll) {
    runGit(['add', '-A'], root);
  } else {
    ensureSelectedFilesAreChanged(root, selectedFiles);
    ensureNoUnselectedStagedFiles(root, selectedFiles);
    runGit(['add', '--', ...selectedFiles], root);
  }

  const stagedFiles = getStagedFiles(root);
  if (stagedFiles.length === 0) {
    throw createApiError(400, 'NO_STAGED_CHANGES', 'No changes were staged for commit.');
  }

  runGit(['commit', '-m', message], root);

  const hash = runGit(['rev-parse', 'HEAD'], root).trim();
  const branch = getBranchName(root);
  const afterStatus = toStatusSummary(root);

  return {
    root,
    dryRun: false,
    hash,
    commitHash: hash,
    branch,
    message,
    changedFiles: stagedFiles,
    changedFileCount: stagedFiles.length,
    beforeStatus,
    afterStatus,
  };
}
