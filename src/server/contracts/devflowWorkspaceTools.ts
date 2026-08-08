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
    description: 'Integrate committed local work from an isolated workspace into its recorded local base branch. Never pushes or fetches; real conflicts return structured INTEGRATION_CONFLICT data.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/integrate', body: args }),
  },
  {
    name: 'abort_workspace_integration',
    description: 'Abort a conflicted local workspace integration and restore the recorded clean base HEAD while preserving the source workspace and commits.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/integration/abort', body: args }),
  },
  {
    name: 'retry_workspace_integration',
    description: 'Retry/finalize a previously conflicted local workspace integration after deliberate resolution. Never chooses ours/theirs automatically.',
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
