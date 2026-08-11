import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDevFlowWorkspacesDir } from '../../lib/devFlowPaths';
import { createApiError } from './api';
import type { GitWorkflowPolicy } from '../../types.js';
import { validateGitWorkflowPolicy } from './projectGitWorkflowPolicyService';

export type SessionWorkspaceState = 'ready' | 'active' | 'integration-required';

export type SessionWorkspace = {
  workspaceId: string;
  sessionIdHash: string;
  projectId: string;
  projectRoot: string;
  root: string;
  branch: string;
  baseBranch: string;
  baseRevision: string;
  gitWorkflowPolicy?: GitWorkflowPolicy;
  taskDisplayId?: string;
  taskRootLeaf?: string;
  state: SessionWorkspaceState;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const activeWorkspaceRefs = new Map<string, number>();
const memoryRegistry = new Map<string, SessionWorkspace>();
const workspaceLifecycleCounters = {
  created: 0,
  reused: 0,
  cleaned: 0,
  cleanupBlocked: 0,
};

function safeSegment(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return normalized || 'workspace';
}

function taskNumberFolder(value: unknown) {
  const match = String(value || '').trim().match(/(\d+)$/);
  return match?.[1] || null;
}
function normalizedTaskDisplayId(value: unknown) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function workspaceIdentityForSession(sessionId: string, taskDisplayId: string | null) {
  return taskDisplayId ? `${sessionId}\u0000task:${taskDisplayId}` : sessionId;
}

export function isSessionWorkspaceCompatibleWithTask(workspace: SessionWorkspace, taskDisplayId: unknown) {
  const expectedDisplayId = normalizedTaskDisplayId(taskDisplayId);
  if (!expectedDisplayId) return true;
  if (workspace.taskDisplayId && normalizedTaskDisplayId(workspace.taskDisplayId) !== expectedDisplayId) return false;
  const expectedRootLeaf = taskNumberFolder(expectedDisplayId);
  if (expectedRootLeaf && path.basename(path.resolve(workspace.root)) !== expectedRootLeaf) return false;
  if (workspace.taskRootLeaf && expectedRootLeaf && workspace.taskRootLeaf !== expectedRootLeaf) return false;
  return true;
}


function workspaceIdFor(projectId: string, sessionId: string) {
  const digest = crypto.createHash('sha256').update(`${projectId}\u0000${sessionId}`).digest('hex');
  return `ws_${digest.slice(0, 16)}`;
}

function sessionHash(sessionId: string) {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

function workspaceRegistryDir() {
  return path.join(getDevFlowWorkspacesDir(), 'registry');
}

function workspaceRootsDir() {
  return path.join(getDevFlowWorkspacesDir(), 'roots');
}

function metadataPath(workspaceId: string) {
  return path.join(workspaceRegistryDir(), `${safeSegment(workspaceId)}.json`);
}

function managedRootFor(projectId: string, workspaceId: string) {
  return path.join(workspaceRootsDir(), safeSegment(projectId), safeSegment(workspaceId));
}

function runGit(root: string, args: string[], allowFailure = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, timeout: 30_000 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw createApiError(500, 'WORKSPACE_GIT_FAILED', `Git workspace command failed: ${result.stderr?.trim() || result.error?.message || args.join(' ')}`, {
      details: { args, status: result.status },
    });
  }
  return result;
}

function ensureRepository(root: string) {
  const result = runGit(root, ['rev-parse', '--show-toplevel'], true);
  if (result.error || result.status !== 0) {
    throw createApiError(400, 'WORKSPACE_REPO_INVALID', `Project root '${root}' is not a Git repository.`);
  }
  return path.resolve((result.stdout || '').trim());
}

function branchExists(root: string, branch: string) {
  const result = runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], true);
  return result.status === 0;
}

function currentBranch(root: string) {
  return (runGit(root, ['branch', '--show-current']).stdout || '').trim() || 'HEAD';
}

function currentHead(root: string) {
  return (runGit(root, ['rev-parse', 'HEAD']).stdout || '').trim();
}

function isAncestor(root: string, ancestor: string, descendant: string) {
  return runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant], true).status === 0;
}

function patchEquivalent(root: string, baseHead: string, sourceHead: string) {
  const result = runGit(root, ['cherry', baseHead, sourceHead], true);
  if (result.status !== 0) return false;
  const rows = (result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.length > 0 && rows.every((line) => line.startsWith('- '));
}

function checkedOutBranches(root: string) {
  const result = runGit(root, ['worktree', 'list', '--porcelain'], true);
  const branches = new Set<string>();
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    const match = line.match(/^branch refs\/heads\/(.+)$/);
    if (match) branches.add(match[1]);
  }
  return branches;
}

function managedBranchPrefix(projectId: string) {
  return `devflow/ws/${safeSegment(projectId)}/`;
}

function workspaceBranchFor(projectId: string, workspaceIdentity: string, taskRootLeaf: string | null) {
  return taskRootLeaf || `${managedBranchPrefix(projectId)}${sessionHash(workspaceIdentity)}`;
}

function isManagedBranchForWorkspace(projectId: string, branch: string, taskRootLeaf?: string | null) {
  return branch.startsWith(managedBranchPrefix(projectId)) || Boolean(taskRootLeaf && branch === taskRootLeaf);
}

function getManagedBranchDisposition(
  projectRoot: string,
  projectId: string,
  branch: string,
  baseBranch: string,
  options: { allowCheckedOut?: boolean; taskRootLeaf?: string | null } = {},
) {
  if (!isManagedBranchForWorkspace(projectId, branch, options.taskRootLeaf) || !branchExists(projectRoot, branch)) return { safe: false as const, reason: 'not-managed-or-missing' as const };
  if (!options.allowCheckedOut && checkedOutBranches(projectRoot).has(branch)) return { safe: false as const, reason: 'checked-out' as const };
  const baseHeadResult = runGit(projectRoot, ['rev-parse', baseBranch], true);
  const sourceHeadResult = runGit(projectRoot, ['rev-parse', branch], true);
  if (baseHeadResult.status !== 0 || sourceHeadResult.status !== 0) return { safe: false as const, reason: 'unresolvable' as const };
  const baseHead = (baseHeadResult.stdout || '').trim();
  const sourceHead = (sourceHeadResult.stdout || '').trim();
  if (isAncestor(projectRoot, sourceHead, baseHead)) return { safe: true as const, reason: 'merged' as const, sourceHead, baseHead };
  if (patchEquivalent(projectRoot, baseHead, sourceHead)) return { safe: true as const, reason: 'patch-equivalent' as const, sourceHead, baseHead };
  return { safe: false as const, reason: 'unique-commits' as const, sourceHead, baseHead };
}

function removeManagedBranchIfSafe(workspace: SessionWorkspace) {
  const disposition = getManagedBranchDisposition(workspace.projectRoot, workspace.projectId, workspace.branch, workspace.baseBranch, { taskRootLeaf: workspace.taskRootLeaf });
  if (!disposition.safe) return { removed: false, disposition: disposition.reason };
  const result = runGit(workspace.projectRoot, ['branch', '-D', workspace.branch], true);
  return result.status === 0
    ? { removed: true, disposition: disposition.reason }
    : { removed: false, disposition: 'delete-failed' as const };
}

function canonicalContainment(candidate: string) {
  const rootsBase = path.resolve(workspaceRootsDir());
  fs.mkdirSync(rootsBase, { recursive: true });
  const resolved = path.resolve(candidate);
  const baseWithSep = rootsBase.endsWith(path.sep) ? rootsBase : `${rootsBase}${path.sep}`;
  if (resolved === rootsBase || !resolved.startsWith(baseWithSep)) {
    throw createApiError(403, 'WORKSPACE_PATH_ESCAPE', 'Resolved workspace path is outside the DevFlow-managed workspace area.');
  }
  if (fs.existsSync(resolved)) {
    const realBase = fs.realpathSync.native(rootsBase);
    const realCandidate = fs.realpathSync.native(resolved);
    const realBaseWithSep = realBase.endsWith(path.sep) ? realBase : `${realBase}${path.sep}`;
    if (realCandidate === realBase || !realCandidate.startsWith(realBaseWithSep)) {
      throw createApiError(403, 'WORKSPACE_PATH_ESCAPE', 'Workspace real path escapes the DevFlow-managed workspace area.');
    }
  }
  return resolved;
}

function writeMetadata(workspace: SessionWorkspace) {
  fs.mkdirSync(workspaceRegistryDir(), { recursive: true });
  const target = metadataPath(workspace.workspaceId);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
  memoryRegistry.set(workspace.workspaceId, workspace);
}

function readMetadata(workspaceId: string) {
  const cached = memoryRegistry.get(workspaceId);
  if (cached) return cached;
  const target = metadataPath(workspaceId);
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as SessionWorkspace;
    if (parsed.workspaceId !== workspaceId) return null;
    memoryRegistry.set(workspaceId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function getSessionWorkspaceMetadataForRecovery(workspaceId: string) {
  const workspace = readMetadata(String(workspaceId || '').trim());
  return workspace ? { ...workspace } : null;
}

function touch(workspace: SessionWorkspace) {
  const now = Date.now();
  const next: SessionWorkspace = {
    ...workspace,
    lastUsedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DEFAULT_TTL_MS).toISOString(),
  };
  writeMetadata(next);
  return next;
}

function validateReusableWorkspace(workspace: SessionWorkspace, projectRoot: string) {
  if (path.resolve(workspace.projectRoot) !== path.resolve(projectRoot)) return false;
  const root = canonicalContainment(workspace.root);
  if (!fs.existsSync(root)) return false;
  const topLevel = runGit(root, ['rev-parse', '--show-toplevel'], true);
  if (topLevel.status !== 0) return false;
  if (path.resolve((topLevel.stdout || '').trim()) !== path.resolve(root)) return false;
  return currentBranch(root) === workspace.branch;
}

export function createOrReuseSessionWorkspace(
  project: { id: string; localPath?: string | null; gitWorkflowPolicy?: unknown },
  sessionId: string,
  options: { taskDisplayId?: string | null } = {},
) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) throw createApiError(400, 'SESSION_ID_REQUIRED', 'sessionId is required to create an isolated workspace.');
  if (!project?.id) throw createApiError(400, 'PROJECT_ID_REQUIRED', 'project.id is required to create an isolated workspace.');
  const projectRoot = ensureRepository(path.resolve(String(project.localPath || '')));
  const taskDisplayId = normalizedTaskDisplayId(options.taskDisplayId);
  const workspaceIdentity = workspaceIdentityForSession(cleanSessionId, taskDisplayId);
  const workspaceId = workspaceIdFor(project.id, workspaceIdentity);
  const existing = readMetadata(workspaceId);
  if (existing && validateReusableWorkspace(existing, projectRoot)) {
    if (taskDisplayId && !isSessionWorkspaceCompatibleWithTask(existing, taskDisplayId)) {
      throw createApiError(409, 'WORKSPACE_TASK_MISMATCH', 'Existing managed workspace does not belong to the requested task identity.', {
        affectedId: workspaceId,
        details: { taskDisplayId, root: existing.root },
      });
    }
    workspaceLifecycleCounters.reused += 1;
    return touch(existing);
  }

  const taskRootLeaf = taskNumberFolder(taskDisplayId);
  const rootLeaf = taskRootLeaf || workspaceId;
  const root = canonicalContainment(managedRootFor(project.id, rootLeaf));
  const baseBranch = currentBranch(projectRoot);
  const baseRevision = currentHead(projectRoot);
  const branch = workspaceBranchFor(project.id, workspaceIdentity, taskRootLeaf);

  fs.mkdirSync(path.dirname(root), { recursive: true });
  runGit(projectRoot, ['worktree', 'prune'], true);
  if (fs.existsSync(root)) {
    const entries = fs.readdirSync(root);
    if (entries.length > 0) {
      throw createApiError(409, 'WORKSPACE_ROOT_OCCUPIED', 'Managed workspace root already exists and is not a reusable Git worktree.', { affectedId: workspaceId });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (branchExists(projectRoot, branch)) {
    if (taskRootLeaf) {
      throw createApiError(409, 'WORKSPACE_BRANCH_COLLISION', `Task workspace branch '${branch}' already exists without compatible managed workspace ownership.`, {
        affectedId: workspaceId,
        details: { branch, taskDisplayId, taskRootLeaf },
      });
    }
    const add = runGit(projectRoot, ['worktree', 'add', root, branch], true);
    if (add.status !== 0) {
      throw createApiError(409, 'WORKSPACE_BRANCH_IN_USE', `Workspace branch '${branch}' already exists or is checked out elsewhere.`, {
        affectedId: workspaceId,
        details: add.stderr?.trim(),
      });
    }
  } else {
    runGit(projectRoot, ['worktree', 'add', '-b', branch, root, baseRevision]);
  }

  canonicalContainment(root);
  const now = Date.now();
  const workspace: SessionWorkspace = {
    workspaceId,
    sessionIdHash: sessionHash(cleanSessionId),
    projectId: project.id,
    projectRoot,
    root,
    branch,
    baseBranch,
    baseRevision,
    gitWorkflowPolicy: validateGitWorkflowPolicy(project.gitWorkflowPolicy),
    ...(taskDisplayId ? { taskDisplayId, taskRootLeaf: taskRootLeaf || rootLeaf } : {}),
    state: 'ready',
    createdAt: new Date(now).toISOString(),
    lastUsedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DEFAULT_TTL_MS).toISOString(),
  };
  writeMetadata(workspace);
  workspaceLifecycleCounters.created += 1;
  return workspace;
}

export function resolveSessionWorkspace(workspaceId: string) {
  const workspace = readMetadata(String(workspaceId || '').trim());
  if (!workspace) return null;
  if (!validateReusableWorkspace(workspace, workspace.projectRoot)) return null;
  return touch(workspace);
}

export function resolveSessionWorkspaceForRecovery(workspaceId: string) {
  const workspace = readMetadata(String(workspaceId || '').trim());
  if (!workspace) return null;
  const root = canonicalContainment(workspace.root);
  if (!fs.existsSync(root)) return null;
  const workspaceTopLevel = runGit(root, ['rev-parse', '--show-toplevel'], true);
  if (workspaceTopLevel.status !== 0 || path.resolve((workspaceTopLevel.stdout || '').trim()) !== path.resolve(root)) return null;
  const projectTopLevel = runGit(workspace.projectRoot, ['rev-parse', '--show-toplevel'], true);
  if (projectTopLevel.status !== 0 || path.resolve((projectTopLevel.stdout || '').trim()) !== path.resolve(workspace.projectRoot)) return null;
  return touch(workspace);
}

export function acquireSessionWorkspace(workspaceId: string) {
  const workspace = resolveSessionWorkspace(workspaceId);
  if (!workspace) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
  activeWorkspaceRefs.set(workspaceId, (activeWorkspaceRefs.get(workspaceId) || 0) + 1);
  if (workspace.state !== 'active') writeMetadata({ ...workspace, state: 'active' });
  return workspace;
}

export function releaseSessionWorkspace(workspaceId: string) {
  const next = Math.max(0, (activeWorkspaceRefs.get(workspaceId) || 0) - 1);
  if (next === 0) activeWorkspaceRefs.delete(workspaceId);
  else activeWorkspaceRefs.set(workspaceId, next);
  const workspace = readMetadata(workspaceId);
  if (workspace && next === 0 && workspace.state === 'active') writeMetadata({ ...workspace, state: 'ready' });
}

export function cleanupSessionWorkspace(workspaceId: string, options: { force?: boolean } = {}) {
  const workspace = readMetadata(String(workspaceId || '').trim());
  if (!workspace) return { removed: false, reason: 'not-found' };
  if (!options.force && (activeWorkspaceRefs.get(workspaceId) || 0) > 0) {
    workspaceLifecycleCounters.cleanupBlocked += 1;
    throw createApiError(409, 'WORKSPACE_ACTIVE', 'Workspace is active and cannot be removed by normal cleanup.', { affectedId: workspaceId });
  }
  const root = canonicalContainment(workspace.root);
  if (fs.existsSync(root) && !options.force) {
    const dirty = (runGit(root, ['status', '--porcelain', '--untracked-files=all']).stdout || '').trim();
    if (dirty) {
      workspaceLifecycleCounters.cleanupBlocked += 1;
      throw createApiError(409, 'WORKSPACE_DIRTY', 'Workspace is dirty and cannot be removed by normal cleanup.', { affectedId: workspaceId, details: dirty });
    }
    if (workspace.state === 'integration-required') {
      workspaceLifecycleCounters.cleanupBlocked += 1;
      throw createApiError(409, 'WORKSPACE_INTEGRATION_REQUIRED', 'Workspace still requires integration before cleanup.', { affectedId: workspaceId });
    }
  }
  if (!options.force) {
    const branchDisposition = getManagedBranchDisposition(workspace.projectRoot, workspace.projectId, workspace.branch, workspace.baseBranch, {
      allowCheckedOut: true,
      taskRootLeaf: workspace.taskRootLeaf,
    });
    if (!branchDisposition.safe) {
      workspaceLifecycleCounters.cleanupBlocked += 1;
      throw createApiError(409, 'WORKSPACE_UNINTEGRATED_COMMITS', 'Workspace branch still contains unique or unverifiable commits and cannot be removed by normal cleanup.', {
        affectedId: workspaceId,
        details: { branch: workspace.branch, disposition: branchDisposition.reason },
      });
    }
  }
  if (fs.existsSync(root)) {
    const result = runGit(workspace.projectRoot, ['worktree', 'remove', ...(options.force ? ['--force'] : []), root], true);
    if (result.status !== 0) {
      workspaceLifecycleCounters.cleanupBlocked += 1;
      throw createApiError(409, 'WORKSPACE_REMOVE_FAILED', 'Git refused to remove the workspace.', { affectedId: workspaceId, details: result.stderr?.trim() });
    }
  }
  const branchCleanup = removeManagedBranchIfSafe(workspace);
  fs.rmSync(metadataPath(workspaceId), { force: true });
  memoryRegistry.delete(workspaceId);
  activeWorkspaceRefs.delete(workspaceId);
  workspaceLifecycleCounters.cleaned += 1;
  return { removed: true, workspaceId, branch: workspace.branch, branchRemoved: branchCleanup.removed, branchDisposition: branchCleanup.disposition };
}

export function markSessionWorkspaceIntegrationRequired(workspaceId: string, required = true) {
  const workspace = readMetadata(workspaceId);
  if (!workspace) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
  const next = { ...workspace, state: required ? 'integration-required' as const : 'ready' as const };
  writeMetadata(next);
  return next;
}

export function markSessionWorkspaceIntegrated(workspaceId: string, integratedRevision: string) {
  const workspace = readMetadata(workspaceId);
  if (!workspace) throw createApiError(404, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, { affectedId: workspaceId });
  const nextRevision = String(integratedRevision || '').trim();
  if (!nextRevision) throw createApiError(400, 'WORKSPACE_INTEGRATED_REVISION_REQUIRED', 'Integrated revision is required when advancing the workspace baseline.', { affectedId: workspaceId });
  const next = { ...workspace, state: 'ready' as const, baseRevision: nextRevision };
  writeMetadata(next);
  return next;
}

export function cleanupManagedWorkspaceBranches(
  project: { id: string; localPath?: string | null },
  options: { baseBranch?: string; dryRun?: boolean } = {},
) {
  if (!project?.id) throw createApiError(400, 'PROJECT_ID_REQUIRED', 'project.id is required to clean managed workspace branches.');
  const projectRoot = ensureRepository(path.resolve(String(project.localPath || '')));
  const baseBranch = String(options.baseBranch || currentBranch(projectRoot)).trim();
  const prefix = managedBranchPrefix(project.id);
  const refs = runGit(projectRoot, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`], true);
  const branches = (refs.stdout || '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const removed: Array<{ branch: string; disposition: string }> = [];
  const preserved: Array<{ branch: string; disposition: string }> = [];
  for (const branchName of branches) {
    const disposition = getManagedBranchDisposition(projectRoot, project.id, branchName, baseBranch);
    if (!disposition.safe) {
      preserved.push({ branch: branchName, disposition: disposition.reason });
      continue;
    }
    if (options.dryRun) {
      removed.push({ branch: branchName, disposition: disposition.reason });
      continue;
    }
    const deletion = runGit(projectRoot, ['branch', '-D', branchName], true);
    if (deletion.status === 0) removed.push({ branch: branchName, disposition: disposition.reason });
    else preserved.push({ branch: branchName, disposition: 'delete-failed' });
  }
  return { projectId: project.id, baseBranch, dryRun: options.dryRun === true, removed, preserved };
}

export function getSessionWorkspaceMetrics() {
  const states = new Map<string, SessionWorkspaceState>();
  const registryDir = workspaceRegistryDir();
  if (fs.existsSync(registryDir)) {
    for (const entry of fs.readdirSync(registryDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(registryDir, entry.name), 'utf8')) as SessionWorkspace;
        if (parsed?.workspaceId && parsed?.state) states.set(parsed.workspaceId, parsed.state);
      } catch {
        // Ignore corrupt/stale registry entries in aggregate diagnostics.
      }
    }
  }
  for (const [workspaceId, workspace] of memoryRegistry) states.set(workspaceId, workspace.state);
  return {
    knownWorkspaces: states.size,
    activeWorkspaces: activeWorkspaceRefs.size,
    integrationRequired: Array.from(states.values()).filter((state) => state === 'integration-required').length,
    ...workspaceLifecycleCounters,
  };
}

export function resetSessionWorkspaceRuntimeForTests() {
  memoryRegistry.clear();
  activeWorkspaceRefs.clear();
  workspaceLifecycleCounters.created = 0;
  workspaceLifecycleCounters.reused = 0;
  workspaceLifecycleCounters.cleaned = 0;
  workspaceLifecycleCounters.cleanupBlocked = 0;
}
