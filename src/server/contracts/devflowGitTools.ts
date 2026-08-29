import { projectIdentifierProperties, withQuery, type DevFlowToolDefinition } from './devflowContractCore';

export const gitToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'get_git_log',
    description: 'List recent git commits with optional filters.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, limit: { type: 'number', description: 'Maximum number of commits returned (default 20, max 500).' }, author: { type: 'string', description: 'Filter by commit author.' }, since: { type: 'string', description: 'Only commits after this date (ISO 8601 or git-parseable).' }, until: { type: 'string', description: 'Only commits before this date (ISO 8601 or git-parseable).' }, grep: { type: 'string', description: 'Filter commits with message matching pattern.' }, path: { type: 'string', description: 'Relative file or directory path to limit log to.' } } },
    outputSchema: { type: 'object' }, lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/git/log', args) }),
  },
  {
    name: 'get_git_diff', description: 'Show git diff between commits or working tree changes.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, commit1: { type: 'string', description: 'First commit hash for comparison.' }, commit2: { type: 'string', description: 'Second commit hash for comparison.' }, path: { type: 'string', description: 'Relative file or directory path to limit diff to.' } } },
    outputSchema: { type: 'object' }, lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/git/diff', args) }),
  },
  {
    name: 'get_git_show', description: 'Show detailed information for a single commit.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, commit: { type: 'string', description: 'Commit hash.' }, path: { type: 'string', description: 'Relative file or directory path to limit output to.' }, responseMode: { type: 'string', enum: ['compact', 'standard', 'debug'], description: 'Agent default is compact and caps returned patch content to 4 KB.' }, maxDiffBytes: { type: 'number', description: 'Maximum patch bytes before mode cap, bounded by DevFlow.' } }, required: ['commit'] },
    outputSchema: { type: 'object' }, lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/git/show', { ...args, responseMode: args.responseMode || 'compact' }) }),
  },
  {
    name: 'get_git_status', description: 'Show working-tree status. Use mode="expanded" for status buckets, line totals, rename details, and top-directory counts.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, mode: { type: 'string', enum: ['compact', 'expanded'], description: 'compact returns changed files; expanded returns the former change-summary detail.' } } }, outputSchema: { type: 'object' }, lightweight: true,
    buildHttpRequest: ({ mode, ...args }) => ({ method: 'GET', path: withQuery(mode === 'expanded' ? '/api/git/change-summary' : '/api/git/status', args) }),
  },
  {
    name: 'get_change_summary', description: 'Summarize expanded tracked and untracked changes with status buckets, line totals, rename details, and top-directory counts.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties } }, outputSchema: { type: 'object' }, lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/git/change-summary', args) }),
  },
  {
    name: 'get_git_branch', description: 'List local git branches.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties } }, outputSchema: { type: 'object' }, lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/git/branch', args) }),
  },
  {
    name: 'ensure_git_branch', executionPolicy: { mode: 'job', jobKind: 'repo-command' }, description: 'Safely create and/or switch to a local git branch with working-tree guards and dry-run preview.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, branch: { type: 'string', description: 'Target local branch name.' }, baseBranch: { type: 'string', description: 'Base branch or revision. Defaults to the active branch.' }, createIfMissing: { type: 'boolean', description: 'Create the target branch when it does not exist. Defaults to true.' }, switch: { type: 'boolean', description: 'Switch to the target branch. Defaults to true.' }, dryRun: { type: 'boolean', description: 'Preview branch creation/switching without changing the repository.' } }, required: ['branch'] },
    outputSchema: { type: 'object' }, buildHttpRequest: (args) => ({ method: 'POST', path: '/api/git/branch/ensure', body: args }),
  },
  {
    name: 'push_git_branch', executionPolicy: { mode: 'job', jobKind: 'repo-command' }, description: 'Preview or publish the active local branch to a validated git remote without history rewriting.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, remote: { type: 'string', description: 'Remote name. Defaults to origin.' }, branch: { type: 'string', description: 'Branch to publish. Defaults to the active branch and must match it.' }, setUpstream: { type: 'boolean', description: 'Configure the remote tracking branch when publishing.' }, dryRun: { type: 'boolean', description: 'Preview commits and remote target without publishing.' }, forceFresh: { type: 'boolean', description: 'Bypass reusable fresh remote evidence before push safety checks.' } } },
    outputSchema: { type: 'object' }, buildHttpRequest: (args) => ({ method: 'POST', path: '/api/git/push', body: args }),
  },
  {
    name: 'get_git_sync_status', description: 'Compare the active local branch with its remote branch, including heads, tracking state, ahead/behind, divergence, publication state, and working-tree cleanliness.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, remote: { type: 'string', description: 'Remote name. Defaults to origin.' }, fetch: { type: 'boolean', description: 'Fetch the remote before calculating synchronization state.' }, forceFresh: { type: 'boolean', description: 'Bypass reusable fresh remote evidence and force a new remote fetch.' } } },
    outputSchema: { type: 'object' }, lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/git/sync-status', args) }),
  },
  {
    name: 'create_pull_request', description: 'Preview or create a GitHub pull request from a clean published branch. Can build the body from task requirements, verification evidence, commits, and change summary. Never merges automatically.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, taskId: { type: 'string', description: 'Optional DevFlow task id/displayId used for title/body evidence.' }, remote: { type: 'string', description: 'Git remote name. Defaults to origin.' }, head: { type: 'string', description: 'Head branch. Defaults to the active published branch.' }, base: { type: 'string', description: 'Base branch. Required.' }, title: { type: 'string', description: 'Pull-request title. Defaults to task title.' }, body: { type: 'string', description: 'Explicit pull-request body.' }, bodyFromTask: { type: 'boolean', description: 'Build the body from task and Git evidence when no explicit body is supplied.' }, draft: { type: 'boolean', description: 'Create a draft pull request. Defaults to true.' }, dryRun: { type: 'boolean', description: 'Validate and preview without calling GitHub.' }, forceFresh: { type: 'boolean', description: 'Force a fresh remote fetch before validating published-head safety.' } }, required: ['base'] },
    outputSchema: { type: 'object' }, buildHttpRequest: (args) => ({ method: 'POST', path: '/api/github/pull-requests', body: args }),
  },
  {
    name: 'plan_task_commit', description: 'Build a read-only task-aware local commit plan from execution ownership. Returns hard safety blockers separately from truthful verification debt and whether a scoped commit is safe.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, taskId: { type: 'string', description: 'DevFlow task id/displayId whose execution ownership defines commit scope.' } }, required: ['taskId', 'workspaceId'] },
    outputSchema: { type: 'object' }, lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/git/task-commit/plan', args) }),
  },
  {
    name: 'adopt_task_execution_owned_changes',
    description: 'Audited task-scoped recovery that adopts explicit dirty/unowned files into the exact active replacement execution after preserved-WIP recovery. Every file requires an exact current revision guard; task/workspace/execution identity and claimed scope remain authoritative.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        taskId: { type: 'string', description: 'Exact DevFlow task id/displayId that owns the selected workspace.' },
        executionSessionId: { type: 'string', description: 'Exact active replacement execution session that will own the adopted files.' },
        files: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', minLength: 1, maxLength: 500, description: 'Repository-relative dirty/unowned path inside the active task claim scope.' },
              expectedRevision: { type: 'string', minLength: 1, maxLength: 256, description: 'Exact current file revision captured before adoption.' },
            },
            required: ['path', 'expectedRevision'],
            additionalProperties: false,
          },
          description: 'Explicit revision-guarded dirty/unowned files to adopt.',
        },
        reason: { type: 'string', minLength: 10, maxLength: 500, description: 'Bounded audit reason for adopting preserved WIP into the replacement execution.' },
      },
      required: ['taskId', 'workspaceId', 'executionSessionId', 'files', 'reason'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/git/task-commit/adopt-owned-changes', body: args }),
  },
  {
    name: 'reconcile_task_owned_revision_drift',
    description: 'Audited task-scoped recovery for already-owned files whose current revision drifted from the last known owned revision. Requires exact task/workspace/execution authority, prior/current revision guards, and bounded audit provenance; successful reconciliation invalidates prior verification authority.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        taskId: { type: 'string', description: 'Exact DevFlow task id/displayId that owns the selected workspace.' },
        executionSessionId: { type: 'string', description: 'Exact active execution session id that owns the selected task workspace.' },
        files: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Repository-relative path already owned by this execution.' },
              expectedKnownRevision: { type: 'string', description: 'Exact prior owned revision reported by commit-plan ownership drift.' },
              expectedCurrentRevision: { type: 'string', description: 'Exact current revision reported by commit-plan ownership drift.' },
            },
            required: ['path', 'expectedKnownRevision', 'expectedCurrentRevision'],
          },
          description: 'Explicit already-owned drift entries to reconcile atomically.',
        },
        reason: { type: 'string', description: 'Bounded audit reason explaining why the owned revision changed outside normal mutation recording.' },
        provenance: { type: 'string', description: 'Bounded provenance for the recovery evidence, such as the missed mutation/tool path or operator source.' },
      },
      required: ['taskId', 'workspaceId', 'executionSessionId', 'files', 'reason', 'provenance'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/git/task-commit/reconcile-owned-revisions', body: args }),
  },
  {
    name: 'commit_task_owned_changes', executionPolicy: { mode: 'job', jobKind: 'repo-command' }, description: 'Commit only files owned by the selected task execution session when hard ownership, concurrency, path, and Git safety checks pass. Missing, failed, or stale verification remains truthful non-blocking debt and is preserved automatically.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, taskId: { type: 'string', description: 'DevFlow task id/displayId whose execution ownership defines commit scope.' }, message: { type: 'string', description: 'Conventional commit input such as fix(scope): description. DevFlow normalizes it through the task/project commit policy and adds the authoritative task/ticket prefix by default.' }, dryRun: { type: 'boolean', description: 'Preview the scoped commit without creating it.' } }, required: ['taskId', 'workspaceId', 'message'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/git/task-commit/commit', body: args }),
  },
  {
    name: 'commit_git_changes', executionPolicy: { mode: 'job', jobKind: 'repo-command' }, description: 'Safely create a local git commit in the resolved project repository. This tool must never push, amend, reset, checkout, rebase, or perform remote operations.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, message: { type: 'string', description: 'Commit message. Required.' }, stageAll: { type: 'boolean', description: 'Stage all working tree changes before committing.' }, files: { type: 'array', items: { type: 'string' }, description: 'Specific files to stage before committing.' }, dryRun: { type: 'boolean', description: 'Return a preview/status summary without creating the commit.' } }, required: ['message'] },
    outputSchema: { type: 'object' }, buildHttpRequest: (args) => ({ method: 'POST', path: '/api/git/commit', body: args }),
  },
];
