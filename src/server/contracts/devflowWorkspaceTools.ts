import { projectIdentifierProperties, type DevFlowToolDefinition } from './devflowContractCore';

export const workspaceToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'prepare_session_workspace',
    description: 'Create or reuse one isolated local Git worktree for an opaque caller session. DevFlow owns the physical path; callers should persist only workspaceId.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        sessionId: { type: 'string', description: 'Opaque caller session id used to deterministically create/reuse an isolated workspace.' },
      },
      required: ['sessionId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/prepare', body: args }),
  },
  {
    name: 'integrate_workspace',
    description: 'Integrate committed workspace work using the project Git workflow policy. Defaults to rebase + fast-forward; explicit merge policy preserves merge topology. Never pushes or fetches, and conflicts remain isolated from the shared base until resolution.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' }, taskId: { type: 'string', description: 'Optional DevFlow task id/displayId used to resolve ticket-aware merge-message context.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/integrate', body: args }),
  },
  {
    name: 'abort_workspace_integration',
    description: 'Abort a conflicted workspace integration (rebase or explicit merge) and restore the original source HEAD while leaving the shared base untouched.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/integration/abort', body: args }),
  },
  {
    name: 'retry_workspace_integration',
    description: 'Continue/finalize a deliberately resolved workspace integration according to its recorded strategy, then safely apply it to the recorded local base. Never chooses conflict resolutions automatically.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/integration/retry', body: args }),
  },
  {
    name: 'inspect_workspace_recovery',
    description: 'Inspect one managed workspace for dirty, stale, unique-commit, already-integrated, or patch-equivalent recovery state without mutating Git.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/recovery/inspect', body: args }),
  },
  {
    name: 'finalize_superseded_workspace',
    description: 'Discard only dirty workspace files proven equivalent to a supplied commit already contained in the local base, plus explicitly-declared temporary paths, then safely clean the workspace. Ambiguous work is preserved.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' }, supersededByCommit: { type: 'string', description: 'Local commit already contained in the base branch that supersedes this workspace work.' }, temporaryPaths: { type: 'array', items: { type: 'string' }, description: 'Explicit temporary paths allowed to be discarded during superseded cleanup.' } }, required: ['workspaceId', 'supersededByCommit'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/recovery/finalize-superseded', body: args }),
  },
  {
    name: 'cleanup_managed_workspace_branches',
    description: 'Dry-run or remove only DevFlow-managed local workspace branches that are merged or patch-equivalent to the selected local base. Checked-out, unique, and unverifiable branches are preserved. Never pushes or fetches.',
    inputSchema: { type: 'object', properties: { ...projectIdentifierProperties, baseBranch: { type: 'string', description: 'Local base branch. Defaults to the active branch.' }, dryRun: { type: 'boolean', description: 'Preview safe branch removals without changing Git.' } } },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/branches/cleanup', body: args }),
  },
  {
    name: 'finalize_task_workspace',
    description: 'Resume or complete one durable local-only task finalization operation. The operation freezes task/workspace/execution/candidate identity, integrates exactly once, persists verification and Git evidence, terminalizes execution, projects task done, then performs cleanup. Retry with operationId after interruptions. Never pushes or fetches.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' },
        taskId: { type: 'string', description: 'DevFlow task id/displayId to finalize.' },
        operationId: { type: 'string', description: 'Optional durable finalization operation id returned by a prior attempt. Supplying it resumes exactly that frozen operation and refuses identity drift.' },
        checks: { type: 'array', description: 'Verification evidence. Required when starting a new finalization and when satisfying a verification-pending continuation; may be omitted when resuming later phases because the operation persists prior submitted checks.', items: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed', 'not-run'] }, scope: { type: 'string', enum: ['targeted', 'broad', 'full'], description: 'Verification coverage scope for combined-state finalization.' }, repoRevision: { type: 'string', description: 'Exact integrated Git revision this verification check was run against.' }, summary: { type: 'string' }, output: { type: 'string' }, recordedAt: { type: 'string' } }, required: ['command', 'status'] } },
        requireChecklistComplete: { type: 'boolean', description: 'Require every checklist item complete before finalization. Defaults to true.' },
      },
      required: ['workspaceId', 'taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/finalize-task', body: args }),
  },
  {
    name: 'cleanup_session_workspace',
    description: 'Remove a clean, inactive, integration-safe managed session worktree. Normal cleanup refuses dirty/active/integration-required workspaces.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/cleanup', body: args }),
  },
];
