import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { createApiError } from './api';
import { resolveProjectRoot, resolveSafePath } from './localFileService';

const MAX_DIFF_BYTES = 100_000;
const MAX_LOG_COUNT = 500;

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

  const output = runGit(['status', '--porcelain'], root);
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const files = lines.map((line) => ({
    path: line.slice(3),
    staged: line[0] !== ' ' && line[0] !== '?',
    status: line.slice(0, 2).trim(),
  }));

  return { root, count: files.length, files };
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
