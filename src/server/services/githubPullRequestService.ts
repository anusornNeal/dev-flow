import type { AppState } from '../types';
import { createApiError } from './api';
import { getGitLog, getGitSyncStatus, getChangeSummary } from './gitService';
import { getProject, getProjects } from '../repositories/projectRepository';
import { getTasks } from '../repositories/taskRepository';
import { getSettings } from '../repositories/settingsRepository';

interface PullRequestDependencies {
  fetchImpl: typeof fetch;
  getProject: (id: string) => any | undefined;
  getProjects: () => any[];
  getTask: (identifier: string) => any | undefined;
  getSettings: () => any;
  getSyncStatus: (state: AppState, args: Record<string, any>) => any;
  getChangeSummary: (state: AppState, args: Record<string, any>) => any;
  getGitLog: (state: AppState, args: Record<string, any>) => any;
}

export interface PullRequestResult {
  dryRun: boolean;
  created: boolean;
  provider: 'github';
  owner: string;
  repository: string;
  remote: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  commit: string;
  trackingBranch: string | null;
  changeSummary: any;
  commits: any[];
  number?: number;
  url?: string;
  state?: string;
}

const defaultDependencies: PullRequestDependencies = {
  fetchImpl: fetch,
  getProject,
  getProjects,
  getTask: (identifier) => getTasks().find((task: any) => task.id === identifier || task.displayId === identifier),
  getSettings,
  getSyncStatus: getGitSyncStatus,
  getChangeSummary,
  getGitLog,
};

function requiredText(value: unknown, code: string, message: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw createApiError(400, code, message);
  return text;
}

function booleanFlag(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || String(value).toLowerCase() === 'true';
}

function resolveProject(args: Record<string, any>, deps: PullRequestDependencies) {
  if (typeof args.projectId === 'string' && args.projectId.trim()) {
    const project = deps.getProject(args.projectId.trim());
    if (!project) {
      throw createApiError(404, 'PROJECT_NOT_FOUND', `Project '${args.projectId.trim()}' was not found.`, { affectedId: args.projectId.trim() });
    }
    return project;
  }

  const projectName = typeof args.projectName === 'string' ? args.projectName.trim() : '';
  const repo = typeof args.repo === 'string' ? args.repo.trim() : '';
  const repoUrl = typeof args.repoUrl === 'string' ? args.repoUrl.trim() : '';
  const localPath = typeof args.localPath === 'string' ? args.localPath.trim() : '';
  const candidates = deps.getProjects().filter((project: any) =>
    (projectName && project.name === projectName)
    || (repo && (project.repoUrl === repo || project.name === repo))
    || (repoUrl && project.repoUrl === repoUrl)
    || (localPath && project.localPath === localPath));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw createApiError(409, 'PROJECT_AMBIGUOUS', 'More than one project matches the supplied repository identifier. Use projectId.', {
      details: candidates.map((project: any) => ({ id: project.id, name: project.name })),
    });
  }
  throw createApiError(400, 'PROJECT_REQUIRED', 'projectId or another unique project identifier is required.');
}

function parseGithubRepository(repoUrl: string) {
  const normalized = repoUrl.trim().replace(/\\/g, '/');
  let owner = '';
  let repo = '';

  const scpMatch = normalized.match(/^[^@\s]+@github\.com:([^/\s]+)\/(.+)$/i);
  if (scpMatch) {
    owner = scpMatch[1];
    repo = scpMatch[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw createApiError(400, 'UNSUPPORTED_REPOSITORY_HOST', 'Pull-request creation currently supports GitHub repository URLs only.', {
        details: { repoUrl },
      });
    }
    if (parsed.hostname.toLowerCase() !== 'github.com') {
      throw createApiError(400, 'UNSUPPORTED_REPOSITORY_HOST', `Repository host '${parsed.hostname}' is not supported for pull-request creation.`, {
        details: { repoUrl },
      });
    }
    const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (segments.length < 2) {
      throw createApiError(400, 'INVALID_GITHUB_REPOSITORY', 'GitHub repository URL must include owner and repository names.', {
        details: { repoUrl },
      });
    }
    owner = segments[0];
    repo = segments[1];
  }

  repo = repo.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw createApiError(400, 'INVALID_GITHUB_REPOSITORY', 'GitHub owner or repository name contains unsupported characters.', {
      details: { owner, repo },
    });
  }
  return { owner, repo };
}

function buildPullRequestBody(task: any, sync: any, changeSummary: any, log: any) {
  const sections: string[] = [];
  if (task?.description) sections.push(`## Summary\n\n${String(task.description).trim()}`);
  if (task?.acceptanceCriteria) sections.push(`## Acceptance criteria\n\n${String(task.acceptanceCriteria).trim()}`);

  const checks = Array.isArray(task?.verificationEvidence) ? task.verificationEvidence : [];
  if (checks.length > 0) {
    sections.push(`## Verification\n\n${checks.map((check: any) => {
      const status = check.status === 'passed' ? 'x' : ' ';
      const summary = check.summary ? ` — ${check.summary}` : '';
      return `- [${status}] \`${check.command}\`${summary}`;
    }).join('\n')}`);
  }

  const commits = Array.isArray(log?.commits) ? log.commits : [];
  if (commits.length > 0) {
    sections.push(`## Commits\n\n${commits.slice(0, 20).map((commit: any) => `- \`${String(commit.hash || '').slice(0, 12)}\` ${commit.message || ''}`.trim()).join('\n')}`);
  }

  sections.push([
    '## Change summary',
    '',
    `- Branch: \`${sync.branch}\``,
    `- Commit: \`${sync.localHead}\``,
    `- Files changed: ${Number(changeSummary?.expandedFileCount || 0)}`,
    `- Lines: +${Number(changeSummary?.linesAdded || 0)} / -${Number(changeSummary?.linesDeleted || 0)}`,
  ].join('\n'));

  return sections.join('\n\n');
}

function validatePublishedHead(sync: any) {
  if (!sync?.workingTreeClean) {
    throw createApiError(409, 'PULL_REQUEST_DIRTY_TREE', 'Commit local changes before creating a pull request.', {
      details: { nextTool: 'commit_git_changes' },
    });
  }
  if (sync?.diverged || (sync?.behind ?? 0) > 0) {
    throw createApiError(409, 'PULL_REQUEST_BRANCH_NOT_CURRENT', 'The local branch is behind or diverged from its remote branch. Resolve the branch state before creating a pull request.', {
      details: { ahead: sync?.ahead, behind: sync?.behind, diverged: sync?.diverged },
    });
  }
  if (!sync?.pushed || sync?.localHead !== sync?.remoteHead || (sync?.ahead ?? 0) > 0) {
    throw createApiError(409, 'PULL_REQUEST_HEAD_NOT_PUBLISHED', 'The active branch HEAD is not published. Use push_git_branch and confirm get_git_sync_status before creating a pull request.', {
      details: { nextTool: 'push_git_branch', localHead: sync?.localHead, remoteHead: sync?.remoteHead, ahead: sync?.ahead },
    });
  }
  if (!sync?.trackingBranch) {
    throw createApiError(409, 'PULL_REQUEST_UPSTREAM_MISSING', 'The active branch has no upstream tracking branch. Publish it with push_git_branch setUpstream=true.', {
      details: { nextTool: 'push_git_branch' },
    });
  }
}

export async function createPullRequest(
  state: AppState,
  args: Record<string, any>,
  dependencyOverrides: Partial<PullRequestDependencies> = {},
): Promise<PullRequestResult> {
  const deps: PullRequestDependencies = { ...defaultDependencies, ...dependencyOverrides };
  const project = resolveProject(args, deps);
  const repository = parseGithubRepository(requiredText(project.repoUrl, 'PROJECT_REPOSITORY_REQUIRED', 'The selected project has no repository URL.'));
  const remote = typeof args.remote === 'string' && args.remote.trim() ? args.remote.trim() : 'origin';
  const sync = deps.getSyncStatus(state, { projectId: project.id, remote, fetch: true });
  validatePublishedHead(sync);

  const head = typeof args.head === 'string' && args.head.trim() ? args.head.trim() : sync.branch;
  const base = requiredText(args.base, 'PULL_REQUEST_BASE_REQUIRED', 'base is required for pull-request creation.');
  if (head === base) {
    throw createApiError(400, 'PULL_REQUEST_SAME_BRANCH', 'Pull-request head and base branches must be different.', {
      details: { head, base },
    });
  }
  if (head !== sync.branch) {
    throw createApiError(409, 'PULL_REQUEST_HEAD_NOT_ACTIVE', `Requested head '${head}' is not the active published branch '${sync.branch}'.`, {
      details: { head, activeBranch: sync.branch },
    });
  }

  const taskIdentifier = typeof args.taskId === 'string' ? args.taskId.trim() : '';
  const task = taskIdentifier ? deps.getTask(taskIdentifier) : undefined;
  if (taskIdentifier && !task) {
    throw createApiError(404, 'TASK_NOT_FOUND', `Task '${taskIdentifier}' was not found.`, { affectedId: taskIdentifier });
  }
  if (task && task.projectId && task.projectId !== project.id) {
    throw createApiError(409, 'TASK_PROJECT_MISMATCH', 'The selected task does not belong to the selected project.', {
      details: { taskProjectId: task.projectId, projectId: project.id },
    });
  }

  const title = typeof args.title === 'string' && args.title.trim()
    ? args.title.trim()
    : task?.title
      ? String(task.title).trim()
      : '';
  if (!title) {
    throw createApiError(400, 'PULL_REQUEST_TITLE_REQUIRED', 'title is required when no task title is available.');
  }

  const changeSummary = deps.getChangeSummary(state, { projectId: project.id });
  const log = deps.getGitLog(state, { projectId: project.id, limit: 20 });
  const bodyFromTask = booleanFlag(args.bodyFromTask, Boolean(task));
  const body = typeof args.body === 'string' && args.body.trim()
    ? args.body.trim()
    : bodyFromTask
      ? buildPullRequestBody(task, sync, changeSummary, log)
      : '';
  const draft = booleanFlag(args.draft, true);
  const dryRun = booleanFlag(args.dryRun);
  const preview: PullRequestResult = {
    dryRun,
    created: false,
    provider: 'github',
    owner: repository.owner,
    repository: repository.repo,
    remote,
    head,
    base,
    title,
    body,
    draft,
    commit: sync.localHead,
    trackingBranch: sync.trackingBranch,
    changeSummary,
    commits: Array.isArray(log?.commits) ? log.commits : [],
  };
  if (dryRun) return preview;

  const settings = deps.getSettings() || {};
  const token = typeof settings.githubToken === 'string' && settings.githubToken.trim()
    ? settings.githubToken.trim()
    : typeof process.env.GITHUB_TOKEN === 'string' && process.env.GITHUB_TOKEN.trim()
      ? process.env.GITHUB_TOKEN.trim()
      : '';
  if (!token) {
    throw createApiError(401, 'GITHUB_TOKEN_MISSING', 'GitHub credentials are missing. Configure a GitHub token in DevFlow settings or the GITHUB_TOKEN environment variable.', {
      details: { nextAction: 'Configure GitHub credentials, then retry create_pull_request.' },
    });
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls`;
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ title, head, base, body, draft }),
    });
  } catch (error) {
    throw createApiError(502, 'GITHUB_PR_REQUEST_FAILED', 'GitHub pull-request request failed before a response was received.', {
      retryable: true,
      details: error instanceof Error ? error.message : String(error),
    });
  }

  let payload: any = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw createApiError(response.status || 502, 'GITHUB_PR_CREATE_FAILED', payload?.message || 'GitHub rejected the pull-request creation request.', {
      retryable: response.status >= 500,
      details: { status: response.status, errors: payload?.errors, documentationUrl: payload?.documentation_url },
    });
  }

  return {
    ...preview,
    dryRun: false,
    created: true,
    number: payload.number,
    url: payload.html_url,
    state: payload.state,
    draft: payload.draft,
    head: payload.head?.ref || head,
    base: payload.base?.ref || base,
  };
}
