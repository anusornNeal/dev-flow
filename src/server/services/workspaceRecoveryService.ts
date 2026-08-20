import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApiError } from './api';
import {
  getSessionWorkspaceMetadataForRecovery,
  markSessionWorkspaceIntegrated,
  withSessionWorkspaceLifecycleCleanupGuard,
} from './sessionWorkspaceService';

export type WorkspaceRecoveryDisposition =
  | 'already-integrated'
  | 'patch-equivalent'
  | 'committed-not-integrated'
  | 'needs-recovery'
  | 'stale-registry';

export type WorkspaceRecoveryInspection = {
  workspaceId: string;
  projectId?: string;
  state?: string;
  branch?: string;
  baseBranch?: string;
  disposition: WorkspaceRecoveryDisposition;
  dirtyFiles: string[];
  sourceCommits: string[];
  uniqueCommits: string[];
  baseHead?: string;
  sourceHead?: string;
  reason?: string;
};

function runGit(root: string, args: string[], allowFailure = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, timeout: 30_000 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw createApiError(500, 'WORKSPACE_RECOVERY_GIT_FAILED', result.stderr?.trim() || result.error?.message || `git ${args.join(' ')} failed`, {
      details: { args, status: result.status },
    });
  }
  const rawStdout = result.stdout || '';
  return {
    status: result.status ?? -1,
    stdout: rawStdout.trim(),
    rawStdout,
    stderr: (result.stderr || '').trim(),
  };
}

function normalizePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^"|"$/g, '');
}

function dirtyPaths(root: string) {
  const output = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']).rawStdout.replace(/\r?\n$/, '');
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const raw = line.slice(3).trim();
    const renamed = raw.includes(' -> ') ? raw.split(' -> ').at(-1)! : raw;
    return normalizePath(renamed);
  }).filter(Boolean).sort();
}

function sourceCommits(root: string, baseRevision: string, sourceHead: string) {
  const output = runGit(root, ['rev-list', '--reverse', `${baseRevision}..${sourceHead}`], true).stdout;
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function cherryRows(root: string, baseHead: string, sourceHead: string) {
  const result = runGit(root, ['cherry', baseHead, sourceHead], true);
  if (result.status !== 0) return [];
  return result.stdout ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

function isAncestor(root: string, ancestor: string, descendant: string) {
  return runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant], true).status === 0;
}

function isGitWorktree(root: string) {
  if (!fs.existsSync(root)) return false;
  const result = runGit(root, ['rev-parse', '--show-toplevel'], true);
  return result.status === 0 && path.resolve(result.stdout) === path.resolve(root);
}

function fileContentMatches(leftRoot: string, rightRoot: string, relativePath: string) {
  const left = path.resolve(leftRoot, relativePath);
  const right = path.resolve(rightRoot, relativePath);
  const leftExists = fs.existsSync(left) && fs.statSync(left).isFile();
  const rightExists = fs.existsSync(right) && fs.statSync(right).isFile();
  if (!leftExists || !rightExists) return leftExists === rightExists;
  return fs.readFileSync(left).equals(fs.readFileSync(right));
}

function commitChangedFiles(root: string, commit: string) {
  const result = runGit(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit], true);
  return new Set((result.stdout || '').split(/\r?\n/).filter(Boolean).map(normalizePath));
}

export function inspectWorkspaceRecovery(workspaceId: string): WorkspaceRecoveryInspection {
  const cleanId = String(workspaceId || '').trim();
  if (!cleanId) throw createApiError(400, 'WORKSPACE_ID_REQUIRED', 'workspaceId is required for recovery inspection.');
  const metadata = getSessionWorkspaceMetadataForRecovery(cleanId);
  if (!metadata) {
    return { workspaceId: cleanId, disposition: 'stale-registry', dirtyFiles: [], sourceCommits: [], uniqueCommits: [], reason: 'metadata-missing' };
  }
  const common = {
    workspaceId: cleanId,
    projectId: metadata.projectId,
    state: metadata.state,
    branch: metadata.branch,
    baseBranch: metadata.baseBranch,
  };
  if (!isGitWorktree(metadata.root) || !isGitWorktree(metadata.projectRoot)) {
    return { ...common, disposition: 'stale-registry', dirtyFiles: [], sourceCommits: [], uniqueCommits: [], reason: 'workspace-root-or-project-root-invalid' };
  }
  const baseHeadResult = runGit(metadata.projectRoot, ['rev-parse', metadata.baseBranch], true);
  const sourceHeadResult = runGit(metadata.root, ['rev-parse', 'HEAD'], true);
  if (baseHeadResult.status !== 0 || sourceHeadResult.status !== 0) {
    return { ...common, disposition: 'stale-registry', dirtyFiles: [], sourceCommits: [], uniqueCommits: [], reason: 'branch-head-unresolvable' };
  }
  const baseHead = baseHeadResult.stdout;
  const sourceHead = sourceHeadResult.stdout;
  const dirtyFiles = dirtyPaths(metadata.root);
  const commits = sourceCommits(metadata.root, metadata.baseRevision, sourceHead);
  const rows = cherryRows(metadata.root, baseHead, sourceHead);
  const uniqueCommits = rows.filter((line) => line.startsWith('+ ')).map((line) => line.slice(2).trim());
  if (dirtyFiles.length > 0) {
    return { ...common, disposition: 'needs-recovery', dirtyFiles, sourceCommits: commits, uniqueCommits, baseHead, sourceHead, reason: 'workspace-dirty' };
  }
  if (isAncestor(metadata.projectRoot, sourceHead, baseHead)) {
    return { ...common, disposition: 'already-integrated', dirtyFiles, sourceCommits: commits, uniqueCommits: [], baseHead, sourceHead };
  }
  if (rows.length > 0 && rows.every((line) => line.startsWith('- '))) {
    return { ...common, disposition: 'patch-equivalent', dirtyFiles, sourceCommits: commits, uniqueCommits: [], baseHead, sourceHead };
  }
  return { ...common, disposition: 'committed-not-integrated', dirtyFiles, sourceCommits: commits, uniqueCommits, baseHead, sourceHead };
}

export function finalizeSupersededWorkspace(
  workspaceId: string,
  options: { supersededByCommit: string; temporaryPaths?: string[] },
) {
  const metadata = getSessionWorkspaceMetadataForRecovery(String(workspaceId || '').trim());
  if (!metadata) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
  if (!isGitWorktree(metadata.root) || !isGitWorktree(metadata.projectRoot)) {
    return { status: 'needs-recovery' as const, inspection: inspectWorkspaceRecovery(workspaceId), unsafeFiles: [] as string[] };
  }
  const supersededByCommit = String(options?.supersededByCommit || '').trim();
  if (!supersededByCommit) throw createApiError(400, 'SUPERSEDING_COMMIT_REQUIRED', 'supersededByCommit is required.');
  const baseHead = runGit(metadata.projectRoot, ['rev-parse', metadata.baseBranch]).stdout;
  const commitResult = runGit(metadata.projectRoot, ['rev-parse', `${supersededByCommit}^{commit}`], true);
  if (commitResult.status !== 0 || !isAncestor(metadata.projectRoot, commitResult.stdout, baseHead)) {
    throw createApiError(409, 'SUPERSEDING_COMMIT_NOT_IN_BASE', 'The supplied superseding commit is not contained in the current local base branch.', {
      affectedId: workspaceId,
      details: { supersededByCommit, baseBranch: metadata.baseBranch },
    });
  }

  return withSessionWorkspaceLifecycleCleanupGuard(workspaceId, ({ workspace: guardedMetadata, cleanup }) => {
    const temporary = new Set((options.temporaryPaths || []).map(normalizePath));
    const supersedingFiles = commitChangedFiles(guardedMetadata.projectRoot, commitResult.stdout);
    const dirty = dirtyPaths(guardedMetadata.root);
    const unsafeFiles = dirty.filter((file) => !temporary.has(file) && (!supersedingFiles.has(file) || !fileContentMatches(guardedMetadata.root, guardedMetadata.projectRoot, file)));
    if (unsafeFiles.length > 0) {
      return { status: 'needs-recovery' as const, inspection: inspectWorkspaceRecovery(workspaceId), unsafeFiles };
    }

    for (const file of dirty) {
      const restore = runGit(guardedMetadata.root, ['restore', '--staged', '--worktree', '--', file], true);
      if (restore.status !== 0) runGit(guardedMetadata.root, ['clean', '-f', '--', file], true);
    }
    const remaining = dirtyPaths(guardedMetadata.root);
    if (remaining.length > 0) {
      return { status: 'needs-recovery' as const, inspection: inspectWorkspaceRecovery(workspaceId), unsafeFiles: remaining };
    }

    const cleanInspection = inspectWorkspaceRecovery(workspaceId);
    if (!['already-integrated', 'patch-equivalent'].includes(cleanInspection.disposition)) {
      return { status: 'needs-recovery' as const, inspection: cleanInspection, unsafeFiles: [] as string[] };
    }
    markSessionWorkspaceIntegrated(workspaceId, baseHead);
    const cleanupResult = cleanup();
    return {
      status: 'cleaned' as const,
      disposition: cleanInspection.disposition,
      supersededByCommit: commitResult.stdout,
      discardedFiles: dirty,
      cleanup: cleanupResult,
    };
  });
}
