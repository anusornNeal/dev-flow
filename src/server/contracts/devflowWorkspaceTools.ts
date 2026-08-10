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
    name: 'cleanup_session_workspace',
    description: 'Remove a clean, inactive, integration-safe managed session worktree. Normal cleanup refuses dirty/active/integration-required workspaces.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/cleanup', body: args }),
  },
];
