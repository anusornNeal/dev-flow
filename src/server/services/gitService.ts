import { execFile, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { createApiError } from './api';
import { resolveProjectRoot, resolveSafePath } from './localFileService';
import { resolveSessionWorkspaceByRoot } from './sessionWorkspaceService';
import { invalidateRepoReadCaches } from './repoCacheInvalidationService';
import { recordGitRemoteEvidence } from './gitRemoteEvidenceService';
import {
  normalizeRepoIdentity,
  observeRemoteBranch,
  readAheadBehind,
  readPushCommits,
  readRemoteUrl,
  readTrackingBranch,
  resolveRemoteName,
  validateRemoteMatchesProject,
} from './gitRemoteService';
import { getChangedGitFilesForRoot, getGitWorkspaceSnapshotForRoot, getGitWorkspaceStatusForRoot } from './gitLocalService';
export { clearGitRemoteEvidenceCache, getGitRemoteEvidenceMetrics } from './gitRemoteEvidenceService';
export { getChangedGitFilesForRoot, getGitWorkspaceSnapshotForRoot, getGitWorkspaceStatusForRoot } from './gitLocalService';
import { getProject } from '../repositories/projectRepository';
import { assertTaskMutationWorkspaceBinding } from './executionSessionService.js';

const MAX_DIFF_BYTES = 100_000;
const MAX_LOG_COUNT = 500;
const MAX_COMMIT_MESSAGE_BYTES = 4_000;

function ensureGitRepo(root: string) {
  const gitDir = path.join(root, '.git');
  if (!fs.existsSync(gitDir)) {
    throw createApiError(400, 'NOT_GIT_REPO', `Project root '${root}' is not a git repository.`);
  }
}

function runGitResult(args: string[], root: string, timeoutMs = 15_000) {
  const result = spawnSync('git', ['--no-pager', ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: timeoutMs,
  });

  return result;
}

function runGit(args: string[], root: string, timeoutMs = 15_000): string {
  const result = runGitResult(args, root, timeoutMs);

  if (result.error) {
    throw createApiError(500, 'GIT_EXEC_ERROR', `Failed to run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw createApiError(500, 'GIT_ERROR', `Git command failed: ${result.stderr?.trim() || 'unknown error'}`, { details: result.stderr });
  }

  return result.stdout || '';
}

function runGitAsync(args: string[], root: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || 'unknown error').trim();
        reject(createApiError(500, 'GIT_EXEC_ERROR', `Failed to run git: ${message}`, { details: stderr || undefined }));
        return;
      }
      resolve(stdout || '');
    });
  });
}

function flag(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || String(value).toLowerCase() === 'true';
}

function gitSucceeded(args: string[], root: string) {
  const result = runGitResult(args, root);
  if (result.error) {
    throw createApiError(500, 'GIT_EXEC_ERROR', `Failed to run git: ${result.error.message}`);
  }
  return result.status === 0;
}

function requireText(value: unknown, code: string, message: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw createApiError(400, code, message);
  return text;
}

function validateBranchName(root: string, branch: string) {
  const result = runGitResult(['check-ref-format', '--branch', branch], root);
  if (result.error || result.status !== 0) {
    throw createApiError(400, 'INVALID_GIT_BRANCH', `Branch '${branch}' is not a valid git branch name.`, {
      affectedId: branch,
      details: result.stderr?.trim() || undefined,
    });
  }
}

function localBranchExists(root: string, branch: string) {
  return gitSucceeded(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root);
}

function commitExists(root: string, revision: string) {
  return gitSucceeded(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], root);
}

function normalizeGitPath(filePath: string) {
  return filePath.replace(/\\/g, '/');
}

function getRelativeGitPath(root: string, filePath: string) {
  const resolvedPath = resolveSafePath(root, filePath);
  return normalizeGitPath(path.relative(root, resolvedPath));
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
  return parsePorcelainStatus(runGit(['status', '--porcelain', '--untracked-files=all'], root));
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

const GIT_OPERATION_MARKERS = [
  { kind: 'merge', paths: ['MERGE_HEAD'] },
  { kind: 'rebase', paths: ['REBASE_HEAD', 'rebase-apply', 'rebase-merge'] },
  { kind: 'cherry-pick', paths: ['CHERRY_PICK_HEAD'] },
  { kind: 'revert', paths: ['REVERT_HEAD'] },
  { kind: 'bisect', paths: ['BISECT_LOG'] },
  { kind: 'sequencer', paths: ['sequencer'] },
] as const;

const UNMERGED_STATUS_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function getGitOperationState(root: string, files: Array<{ path: string; status: string }> = getChangedGitFilesForRoot(root)) {
  const markers = GIT_OPERATION_MARKERS.flatMap((operation) => operation.paths.map((marker) => ({ kind: operation.kind, marker })));
  const resolvedPaths = runGit(['rev-parse', ...markers.flatMap((entry) => ['--git-path', entry.marker])], root)
    .split(/\r?\n/)
    .filter(Boolean);
  let active: { kind: string; marker: string } | null = null;
  for (let index = 0; index < markers.length; index += 1) {
    const resolvedPath = resolvedPaths[index];
    if (!resolvedPath || !fs.existsSync(path.resolve(root, resolvedPath))) continue;
    active = markers[index];
    break;
  }

  const unmergedPaths = files
    .filter((file) => UNMERGED_STATUS_CODES.has(String(file.status || '').trim()))
    .map((file) => normalizeGitPath(file.path))
    .sort();
  const blocked = Boolean(active || unmergedPaths.length > 0);
  return {
    blocked,
    code: blocked ? 'GIT_OPERATION_IN_PROGRESS' : null,
    kind: active?.kind || (unmergedPaths.length > 0 ? 'unmerged' : null),
    marker: active?.marker || null,
    unmergedPathCount: unmergedPaths.length,
    unmergedPaths,
  };
}

function ensureNoInProgressOperation(root: string) {
  const operation = getGitOperationState(root);
  if (!operation.blocked) return;
  const affectedId = operation.marker || operation.kind || 'unmerged';
  throw createApiError(409, 'GIT_OPERATION_IN_PROGRESS', `Cannot commit while git operation '${affectedId}' is in progress. Resolve or abort it first.`, {
    affectedId,
    details: { kind: operation.kind, unmergedPathCount: operation.unmergedPathCount, unmergedPaths: operation.unmergedPaths },
  });
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
    files: files.map((file) => ({ path: file.normalizedPath, staged: file.staged, status: file.status })),
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
    gitArgs.push('--', getRelativeGitPath(root, filePath));
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
    gitArgs.push('--', getRelativeGitPath(root, filePath));
  }

  const output = runGit(gitArgs, root);
  const responseMode = args.responseMode === 'compact' || args.responseMode === 'debug' ? args.responseMode : 'standard';
  const requestedMaxBytes = Number.isFinite(Number(args.maxDiffBytes))
    ? Math.max(1, Math.min(MAX_DIFF_BYTES, Number(args.maxDiffBytes)))
    : MAX_DIFF_BYTES;
  const maxBytes = responseMode === 'compact' ? Math.min(4_000, requestedMaxBytes) : requestedMaxBytes;
  const outputBytes = Buffer.byteLength(output, 'utf8');
  let diff = output;
  let truncated = false;
  if (outputBytes > maxBytes) {
    diff = Buffer.from(output, 'utf8').subarray(0, maxBytes).toString('utf8') + '\n... (truncated)';
    truncated = true;
  }
  const fileChangeLines = output.split(/\r?\n/).filter((l) => l.startsWith('diff --git'));

  return {
    root,
    diff,
    filesChanged: fileChangeLines.length,
    responseMode,
    truncated,
    diffBytes: outputBytes,
    returnedBytes: Buffer.byteLength(diff, 'utf8'),
  };
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
  if (filePath) gitArgs.push('--', getRelativeGitPath(root, filePath));

  const output = runGit(gitArgs, root);
  const responseMode = args.responseMode === 'compact' || args.responseMode === 'debug' ? args.responseMode : 'standard';
  const requestedMaxBytes = Number.isFinite(Number(args.maxDiffBytes))
    ? Math.max(1, Math.min(MAX_DIFF_BYTES, Number(args.maxDiffBytes)))
    : MAX_DIFF_BYTES;
  const maxBytes = responseMode === 'compact' ? Math.min(4_000, requestedMaxBytes) : requestedMaxBytes;
  const firstLineEnd = output.indexOf('\n');
  const headerLine = firstLineEnd >= 0 ? output.slice(0, firstLineEnd) : output;
  const [hash, date, author, ...messageParts] = headerLine.split('\x00');
  const rawDiff = firstLineEnd >= 0 ? output.slice(firstLineEnd + 1) : '';
  const diffBytes = Buffer.byteLength(rawDiff, 'utf8');
  const isTruncated = diffBytes > maxBytes;
  const diff = isTruncated
    ? `${Buffer.from(rawDiff, 'utf8').subarray(0, maxBytes).toString('utf8')}\n... (truncated)`
    : rawDiff;
  const returnedBytes = Buffer.byteLength(diff, 'utf8');

  return {
    root,
    responseMode,
    truncated: isTruncated,
    diffBytes,
    returnedBytes,
    omittedBytes: Math.max(0, diffBytes - Math.min(diffBytes, maxBytes)),
    commit: { hash: hash || commit, date: date || '', author: author || '', message: messageParts.join(' '), diff },
  };
}

type ChangeSummaryFile = {
  path: string;
  from?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
  linesAdded: number;
  linesDeleted: number;
};

function parsePorcelainStatusZ(output: string): ChangeSummaryFile[] {
  const tokens = output.split('\0');
  const files: ChangeSummaryFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const record = tokens[index++];
    if (!record) continue;
    const code = record.slice(0, 2);
    const filePath = normalizeGitPath(record.slice(3));
    if (!filePath) continue;
    const staged = code[0] !== ' ' && code[0] !== '?';
    const isRename = /[RC]/.test(code);
    const originalPath = isRename && index < tokens.length
      ? normalizeGitPath(tokens[index++] || '')
      : undefined;
    let status: ChangeSummaryFile['status'];
    if (code === '??') status = 'untracked';
    else if (/U|AA|DD/.test(code)) status = 'conflicted';
    else if (isRename) status = 'renamed';
    else if (code.includes('D')) status = 'deleted';
    else if (code.includes('A')) status = 'added';
    else status = 'modified';
    files.push({
      path: filePath,
      ...(originalPath ? { from: originalPath } : {}),
      status,
      staged,
      linesAdded: 0,
      linesDeleted: 0,
    });
  }
  return files;
}

function parseNumstat(output: string) {
  const stats = new Map<string, { added: number; deleted: number }>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [addedRaw, deletedRaw, ...pathParts] = line.split('\t');
    const filePath = normalizeGitPath(pathParts.join('\t'));
    if (!filePath) continue;
    const added = addedRaw === '-' ? 0 : Number(addedRaw || 0);
    const deleted = deletedRaw === '-' ? 0 : Number(deletedRaw || 0);
    const current = stats.get(filePath) || { added: 0, deleted: 0 };
    current.added += Number.isFinite(added) ? added : 0;
    current.deleted += Number.isFinite(deleted) ? deleted : 0;
    stats.set(filePath, current);
  }
  return stats;
}

function mergeNumstat(target: Map<string, { added: number; deleted: number }>, source: Map<string, { added: number; deleted: number }>) {
  for (const [filePath, value] of source.entries()) {
    const current = target.get(filePath) || { added: 0, deleted: 0 };
    target.set(filePath, { added: current.added + value.added, deleted: current.deleted + value.deleted });
  }
}

function countUntrackedLines(root: string, relativePath: string) {
  const absolutePath = resolveSafePath(root, relativePath);
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) return 0;
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.includes(0)) return 0;
  const content = buffer.toString('utf8');
  if (!content) return 0;
  const newlines = (content.match(/\n/g) || []).length;
  return newlines + (content.endsWith('\n') ? 0 : 1);
}

function getTopDirectory(filePath: string) {
  const normalized = normalizeGitPath(filePath);
  const separator = normalized.indexOf('/');
  return separator === -1 ? '(root)' : normalized.slice(0, separator);
}

export function getChangeSummary(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);

  const porcelain = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  const files = parsePorcelainStatusZ(porcelain);
  const lineStats = parseNumstat(runGit(['diff', '--numstat'], root));
  mergeNumstat(lineStats, parseNumstat(runGit(['diff', '--cached', '--numstat'], root)));

  for (const file of files) {
    const direct = lineStats.get(file.path);
    const renameFallback = file.from ? lineStats.get(file.from) : undefined;
    const stats = direct || renameFallback;
    if (stats) {
      file.linesAdded = stats.added;
      file.linesDeleted = stats.deleted;
    } else if (file.status === 'untracked') {
      file.linesAdded = countUntrackedLines(root, file.path);
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const topDirectories: Record<string, number> = {};
  for (const file of files) {
    const directory = getTopDirectory(file.path);
    topDirectories[directory] = (topDirectories[directory] || 0) + 1;
  }

  return {
    root,
    statusEntries: files.length,
    expandedFileCount: files.length,
    added: files.filter((file) => file.status === 'added').length,
    modified: files.filter((file) => file.status === 'modified').length,
    deleted: files.filter((file) => file.status === 'deleted').length,
    renamed: files.filter((file) => file.status === 'renamed').length,
    untracked: files.filter((file) => file.status === 'untracked').length,
    conflicted: files.filter((file) => file.status === 'conflicted').length,
    linesAdded: files.reduce((total, file) => total + file.linesAdded, 0),
    linesDeleted: files.reduce((total, file) => total + file.linesDeleted, 0),
    topDirectories,
    files,
  };
}

export function getGitStatus(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  const files = getChangedGitFilesForRoot(root);
  return {
    root,
    count: files.length,
    files,
    operation: getGitOperationState(root, files),
  };
}

function parseGitBranches(root: string, output: string) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  let current = '';
  const branches: string[] = [];

  for (const line of lines) {
    const name = line.replace(/^\*\s*/, '').trim();
    if (line.startsWith('*')) current = name;
    branches.push(name);
  }

  return { root, current, branches };
}

export function getGitBranch(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);
  return parseGitBranches(root, runGit(['branch', '--list'], root));
}

export async function getGitBranchAsync(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);
  return parseGitBranches(root, await runGitAsync(['branch', '--list'], root));
}

export function commitGitChanges(
  state: AppState,
  args: Record<string, any>,
  options: { taskAware?: boolean } = {},
) {  assertTaskMutationWorkspaceBinding(args);

  const root = resolveProjectRoot(state, args);
  const managedWorkspace = resolveSessionWorkspaceByRoot(root);
  if (managedWorkspace?.taskDisplayId && options.taskAware !== true) {
    throw createApiError(409, 'TASK_BOUND_GENERIC_COMMIT_FORBIDDEN', 'Generic commit_git_changes cannot commit inside a task-bound managed workspace. Use commit_task_owned_changes so ownership and the project task-commit policy are enforced.', {
      affectedId: managedWorkspace.workspaceId,
      details: { workspaceId: managedWorkspace.workspaceId, taskDisplayId: managedWorkspace.taskDisplayId, nextTool: 'commit_task_owned_changes' },
    });
  }
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

  const cacheInvalidation = invalidateRepoReadCaches(root, 'commitGitChanges');
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
    cacheInvalidation,
  };
}

export function ensureGitBranch(state: AppState, args: Record<string, any>) {  assertTaskMutationWorkspaceBinding(args);

  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);
  ensureNoInProgressOperation(root);

  const targetBranch = requireText(args.branch, 'GIT_BRANCH_REQUIRED', 'branch is required.');
  validateBranchName(root, targetBranch);
  const currentBranchBefore = getBranchName(root);
  const baseBranch = typeof args.baseBranch === 'string' && args.baseBranch.trim()
    ? args.baseBranch.trim()
    : currentBranchBefore;
  validateBranchName(root, baseBranch);

  const targetExists = localBranchExists(root, targetBranch);
  const baseExists = localBranchExists(root, baseBranch) || commitExists(root, baseBranch);
  if (!baseExists) {
    throw createApiError(400, 'GIT_BASE_NOT_FOUND', `Base branch or revision '${baseBranch}' does not exist.`, { affectedId: baseBranch });
  }

  const createIfMissing = flag(args.createIfMissing, true);
  const shouldSwitch = flag(args.switch, true);
  const dryRun = flag(args.dryRun);
  const status = toStatusSummary(root);
  const workingTreeClean = status.count === 0;
  const wouldCreate = !targetExists;
  const wouldSwitch = shouldSwitch && currentBranchBefore !== targetBranch;

  if (wouldCreate && !createIfMissing) {
    throw createApiError(404, 'GIT_BRANCH_NOT_FOUND', `Branch '${targetBranch}' does not exist and createIfMissing is false.`, { affectedId: targetBranch });
  }
  if (!workingTreeClean && targetExists && wouldSwitch) {
    throw createApiError(409, 'GIT_DIRTY_SWITCH_BLOCKED', `Cannot switch to existing branch '${targetBranch}' while the working tree has changes.`, {
      affectedId: targetBranch,
      details: status,
    });
  }
  if (!workingTreeClean && wouldCreate && baseBranch !== currentBranchBefore) {
    throw createApiError(409, 'GIT_DIRTY_BASE_BLOCKED', `A dirty working tree can create a new branch only from the current HEAD.`, {
      affectedId: baseBranch,
      details: { currentBranch: currentBranchBefore, baseBranch },
    });
  }

  const head = runGit(['rev-parse', 'HEAD'], root).trim();
  if (dryRun) {
    return {
      root,
      dryRun: true,
      currentBranchBefore,
      targetBranch,
      baseBranch,
      targetExists,
      wouldCreate,
      wouldSwitch,
      created: false,
      switched: false,
      workingTreeClean,
      head,
      status,
    };
  }

  let created = false;
  let switched = false;
  if (wouldCreate) {
    if (shouldSwitch) {
      runGit(['switch', '-c', targetBranch, baseBranch], root);
      switched = true;
    } else {
      runGit(['branch', targetBranch, baseBranch], root);
    }
    created = true;
  } else if (wouldSwitch) {
    runGit(['switch', targetBranch], root);
    switched = true;
  }

  const currentBranchAfter = getBranchName(root);
  const cacheInvalidation = invalidateRepoReadCaches(root, 'ensureGitBranch');
  return {
    root,
    dryRun: false,
    currentBranchBefore,
    currentBranchAfter,
    targetBranch,
    baseBranch,
    targetExists,
    wouldCreate,
    wouldSwitch,
    created,
    switched,
    workingTreeClean,
    head: runGit(['rev-parse', 'HEAD'], root).trim(),
    status: toStatusSummary(root),
    cacheInvalidation,
  };
}

export function getGitSyncStatus(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);

  const branch = getBranchName(root);
  if (branch === 'HEAD') {
    throw createApiError(409, 'GIT_DETACHED_HEAD', 'Git sync status requires an active local branch.');
  }
  const remote = resolveRemoteName(args.remote);
  const remoteUrl = readRemoteUrl(root, remote);
  validateRemoteMatchesProject(args, remoteUrl);

  const localHead = runGit(['rev-parse', 'HEAD'], root).trim();
  const remoteObservation = observeRemoteBranch(root, remote, remoteUrl, branch, localHead, args);
  const remoteHead = remoteObservation.remoteHead;
  const trackingBranch = readTrackingBranch(root);
  const relation = readAheadBehind(root, localHead, remoteHead);
  const status = toStatusSummary(root);

  return {
    root,
    branch,
    remote,
    remoteUrl,
    trackingBranch,
    upstreamConfigured: Boolean(trackingBranch),
    localHead,
    remoteHead,
    ahead: relation.ahead,
    behind: relation.behind,
    diverged: relation.diverged,
    pushed: Boolean(remoteHead && remoteHead === localHead),
    workingTreeClean: status.count === 0,
    status,
    ...remoteObservation,
  };
}

export function pushGitBranch(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  ensureGitRepo(root);
  ensureNoInProgressOperation(root);

  const currentBranch = getBranchName(root);
  if (currentBranch === 'HEAD') {
    throw createApiError(409, 'GIT_DETACHED_HEAD', 'Cannot publish from a detached HEAD.');
  }
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : currentBranch;
  validateBranchName(root, branch);
  if (branch !== currentBranch) {
    throw createApiError(409, 'GIT_BRANCH_NOT_ACTIVE', `Requested branch '${branch}' is not the active branch '${currentBranch}'.`, {
      affectedId: branch,
    });
  }

  const status = toStatusSummary(root);
  if (status.count > 0) {
    throw createApiError(409, 'GIT_PUSH_DIRTY_TREE', 'Commit or remove local changes before publishing the branch.', { details: status });
  }

  const remote = resolveRemoteName(args.remote);
  const remoteUrl = readRemoteUrl(root, remote);
  validateRemoteMatchesProject(args, remoteUrl);

  const localHead = runGit(['rev-parse', 'HEAD'], root).trim();
  const remoteObservation = observeRemoteBranch(root, remote, remoteUrl, branch, localHead, { ...args, fetch: true });
  const remoteHeadBefore = remoteObservation.remoteHead;
  const relation = readAheadBehind(root, localHead, remoteHeadBefore);
  if (relation.diverged) {
    throw createApiError(409, 'GIT_BRANCH_DIVERGED', `Local '${branch}' and '${remote}/${branch}' have diverged.`, {
      details: { localHead, remoteHead: remoteHeadBefore, ahead: relation.ahead, behind: relation.behind },
    });
  }
  if ((relation.behind || 0) > 0) {
    throw createApiError(409, 'GIT_REMOTE_AHEAD', `Remote '${remote}/${branch}' contains commits that are not in the local branch.`, {
      details: { localHead, remoteHead: remoteHeadBefore, ahead: relation.ahead, behind: relation.behind },
    });
  }

  const commits = readPushCommits(root, localHead, remoteHeadBefore);
  const setUpstream = flag(args.setUpstream, !readTrackingBranch(root));
  const dryRun = flag(args.dryRun);
  if (dryRun) {
    return {
      root,
      dryRun: true,
      remote,
      remoteUrl,
      branch,
      localHead,
      remoteHeadBefore,
      remoteHeadAfter: remoteHeadBefore,
      ahead: relation.ahead,
      behind: relation.behind,
      diverged: relation.diverged,
      commits,
      pushed: remoteHeadBefore === localHead,
      setUpstream,
      workingTreeClean: true,
      ...remoteObservation,
    };
  }

  if (remoteHeadBefore !== localHead) {
    const pushArgs = ['push'];
    if (setUpstream) pushArgs.push('-u');
    pushArgs.push(remote, `${branch}:${branch}`);
    const result = runGitResult(pushArgs, root, 120_000);
    if (result.error || result.status !== 0) {
      throw createApiError(502, 'GIT_PUSH_FAILED', `Failed to publish '${branch}' to '${remote}'.`, {
        details: result.stderr?.trim() || result.error?.message,
      });
    }
  }

  const remoteHeadAfter = localHead;
  const cacheInvalidation = invalidateRepoReadCaches(root, 'pushGitBranch');
  const nowMs = Number.isFinite(Number(args.nowMs)) ? Number(args.nowMs) : Date.now();
  const finalEvidence = recordGitRemoteEvidence(root, remote, normalizeRepoIdentity(remoteUrl), branch, localHead, remoteHeadAfter, nowMs);
  return {
    root,
    dryRun: false,
    remote,
    remoteUrl,
    branch,
    localHead,
    remoteHeadBefore,
    remoteHeadAfter,
    commits,
    pushed: true,
    setUpstream,
    trackingBranch: readTrackingBranch(root),
    workingTreeClean: true,
    cacheInvalidation,
    remoteFetchPerformed: remoteObservation.remoteFetchPerformed,
    remoteEvidenceReused: remoteObservation.remoteEvidenceReused,
    remoteFetchDurationMs: remoteObservation.remoteFetchDurationMs,
    remoteEvidenceObservedAt: new Date(finalEvidence.observedAtMs).toISOString(),
    remoteEvidenceAgeMs: 0,
  };
}
